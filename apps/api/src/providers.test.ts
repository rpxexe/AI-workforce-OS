// No database needed: a local server stands in for OpenRouter.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { AIProviderError, providerFromEnv, type ProviderEvent } from "@workforce/ai-provider";

let server: Server;
let respond: (status: number) => string | null = () => null;
let received: { authorization?: string; body: { model: string; stream: boolean; messages: unknown[] } } | undefined;

before(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    received = { authorization: req.headers.authorization, body: JSON.parse(raw) };
    const status = req.url === "/chat/completions" ? 200 : 404;
    const body = respond(status);
    res.writeHead(body === null ? status : Number(body.slice(0, 3)) || status, { "content-type": "text/event-stream" });
    res.end(body === null ? "" : body.slice(4));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
});
after(() => server.close());

const env = (extra: Record<string, string> = {}) => ({
  OPENROUTER_API_KEY: "test-key",
  OPENROUTER_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  ...extra,
});
const run = async (vars = env()) => {
  const events: ProviderEvent[] = [];
  const request = { system: "Be brief.", messages: [{ role: "user" as const, content: "Hi" }], signal: AbortSignal.timeout(5000) };
  for await (const event of providerFromEnv(vars).stream(request)) events.push(event);
  return events;
};
const kindOf = (attempt: Promise<unknown>) =>
  attempt.then(
    () => "no error",
    (err: unknown) => (err instanceof AIProviderError ? err.kind : `not an AIProviderError: ${String(err)}`),
  );

test("openrouter is the default provider and streams text, then usage", async () => {
  const data = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
  respond = () =>
    "200 " +
    ": OPENROUTER PROCESSING\n\n" +
    data({ choices: [{ delta: { content: "Hel" } }] }) +
    data({ choices: [{ delta: { content: "lo" }, finish_reason: "stop" }] }) +
    data({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } }) +
    "data: [DONE]\n\n";

  assert.deepEqual(await run(env({ AI_MODEL: "vendor/model" })), [
    { type: "text", text: "Hel" },
    { type: "text", text: "lo" },
    { type: "done", inputTokens: 9, outputTokens: 2 },
  ]);
  assert.equal(received?.authorization, "Bearer test-key");
  assert.equal(received?.body.model, "vendor/model");
  assert.equal(received?.body.stream, true);
  assert.deepEqual(received?.body.messages, [
    { role: "system", content: "Be brief." },
    { role: "user", content: "Hi" },
  ]);
});

test("openrouter failures become AIProviderError kinds", async () => {
  respond = () => '401 {"error":{"message":"No auth credentials found"}}';
  assert.equal(await kindOf(run()), "auth");
  respond = () => "402 {}";
  assert.equal(await kindOf(run()), "billing");
  respond = () => "429 {}";
  assert.equal(await kindOf(run()), "rate_limit");
  respond = () => "503 {}";
  assert.equal(await kindOf(run()), "unavailable");
  // A failure after the stream opened arrives as a chunk on a 200 response.
  respond = () => '200 data: {"error":{"code":429,"message":"upstream busy"},"choices":[]}\n\n';
  assert.equal(await kindOf(run()), "rate_limit");

  assert.equal(await kindOf(run({ ...env(), OPENROUTER_API_KEY: "" })), "auth");
  assert.equal(await kindOf(run({ ...env(), OPENROUTER_BASE_URL: "http://127.0.0.1:1" })), "unavailable");
  assert.throws(() => providerFromEnv({ AI_PROVIDER: "nope" }), /not supported/);
});
