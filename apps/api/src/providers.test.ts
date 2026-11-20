// No database needed: a local server stands in for OpenRouter.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { AIProviderError, providerFromEnv, type ProviderEvent } from "@workforce/ai-provider";

let server: Server;
let respond: (status: number) => string | null = () => null;
let received:
  | { authorization?: string; body: { model: string; stream: boolean; messages: unknown[]; tools?: unknown[] } }
  | undefined;

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
    { type: "done", inputTokens: 9, outputTokens: 2, provider: "openrouter", model: "vendor/model" },
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

test("openrouter tool calls: tools are sent, streamed call fragments are joined, results go back as tool messages", async () => {
  const data = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;
  const fragment = (index: number, fn: object, id?: string) => ({ choices: [{ delta: { tool_calls: [{ index, id, function: fn }] } }] });
  respond = () =>
    "200 " +
    data({ choices: [{ delta: { content: "Booking." } }] }) +
    data(fragment(0, { name: "calendar_book_meeting", arguments: "" }, "call_a")) +
    data(fragment(0, { arguments: '{"date":"2026-11-18",' })) +
    data(fragment(0, { arguments: '"time":"15:00"}' })) +
    data(fragment(1, { name: "send_email", arguments: "not json" }, "call_b")) +
    data({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 7 } }) +
    "data: [DONE]\n\n";

  const events: ProviderEvent[] = [];
  const request = {
    system: "Be brief.",
    messages: [
      { role: "user" as const, content: "Book it" },
      {
        role: "assistant" as const,
        content: "",
        toolCalls: [{ id: "call_0", name: "calendar_book_meeting", input: { date: "2026-11-17" } }],
      },
      { role: "tool" as const, results: [{ callId: "call_0", content: '{"status":"conflict"}', isError: false }] },
    ],
    tools: [{ name: "calendar_book_meeting", description: "Book", inputSchema: { type: "object" } }],
    signal: AbortSignal.timeout(5000),
  };
  for await (const event of providerFromEnv(env()).stream(request)) events.push(event);

  assert.deepEqual(events, [
    { type: "text", text: "Booking." },
    {
      type: "done",
      inputTokens: 5,
      outputTokens: 7,
      toolCalls: [
        { id: "call_a", name: "calendar_book_meeting", input: { date: "2026-11-18", time: "15:00" } },
        // Unparseable arguments are passed on as text, for the executor's validation to refuse.
        { id: "call_b", name: "send_email", input: "not json" },
      ],
      provider: "openrouter",
      model: "openrouter/auto",
    },
  ]);
  assert.deepEqual(received?.body.tools, [
    { type: "function", function: { name: "calendar_book_meeting", description: "Book", parameters: { type: "object" } } },
  ]);
  assert.deepEqual(received?.body.messages.slice(2), [
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_0", type: "function", function: { name: "calendar_book_meeting", arguments: '{"date":"2026-11-17"}' } }],
    },
    { role: "tool", tool_call_id: "call_0", content: '{"status":"conflict"}' },
  ]);

  // Arguments cut off by the output limit are never run.
  respond = () => "200 " + data(fragment(0, { name: "x", arguments: '{"a":' }, "c")) + data({ choices: [{ delta: {}, finish_reason: "length" }] });
  assert.equal(await kindOf(run()), "invalid");
});
