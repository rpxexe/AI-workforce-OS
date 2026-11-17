// Calls the real AI provider configured in .env, so it costs a little money and is skipped
// unless asked for:  LIVE_AI=1 pnpm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type EmployeeDetail,
  type KnowledgeMatch,
  type KnowledgeSource,
  type KnowledgeSourceDetail,
  type Workspace,
} from "@workforce/shared";
import { buildApp } from "./app.ts";
import { adminOf, deleteOrgs, headerAuth, newOrg } from "./testing.ts";

test("live: the configured provider answers a test chat message", { skip: process.env.LIVE_AI !== "1" }, async (t) => {
  const org = newOrg();
  const app = await buildApp({ authenticate: headerAuth, logger: false });
  t.after(async () => {
    await deleteOrgs(org);
    await app.close();
  });
  const call = (method: "GET" | "POST", url: string, payload?: object) =>
    app.inject({ method, url, headers: adminOf(org), payload });

  const [workspace] = (await call("GET", "/workspaces")).json<Workspace[]>();
  assert.ok(workspace);
  const employees = `/workspaces/${workspace.id}/employees`;
  const employee = (
    await call("POST", employees, {
      ...defaultEmployeeConfig(),
      name: "Ava",
      role: "Support agent",
      systemInstructions: "Answer in one short sentence.",
    })
  ).json<EmployeeDetail>();

  const res = await call("POST", `${employees}/${employee.id}/messages`, { message: "Say hello and tell me your name." });
  assert.equal(res.statusCode, 200, res.payload);
  const last = res.payload
    .split("\n\n")
    .filter(Boolean)
    .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent)
    .at(-1);
  assert.ok(last?.type === "done", `the turn failed: ${JSON.stringify(last)}`);
  const reply = last.messages[1];
  t.diagnostic(`provider=${process.env.AI_PROVIDER || "openrouter"} model=${reply.model}`);
  t.diagnostic(`reply: ${reply.content}`);
  t.diagnostic(`tokens: ${reply.inputTokens} in / ${reply.outputTokens} out`);
  assert.ok(reply.content.trim().length > 0);
});

test(
  "live: an employee answers a pricing question from an uploaded PDF",
  { skip: process.env.LIVE_AI !== "1" },
  async (t) => {
    const org = newOrg();
    const app = await buildApp({ authenticate: headerAuth, logger: false });
    t.after(async () => {
      await deleteOrgs(org);
      await app.close();
    });
    const call = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
      app.inject({ method, url, headers: adminOf(org), payload });

    const [workspace] = (await call("GET", "/workspaces")).json<Workspace[]>();
    assert.ok(workspace);
    const ws = `/workspaces/${workspace.id}`;
    const employee = (
      await call("POST", `${ws}/employees`, { ...defaultEmployeeConfig(), name: "Ava", role: "Sales assistant" })
    ).json<EmployeeDetail>();
    const source = (await call("POST", `${ws}/knowledge/sources`, { name: "Pricing" })).json<KnowledgeSource>();

    const uploaded = await app.inject({
      method: "POST",
      url: `${ws}/knowledge/sources/${source.id}/documents?name=pricing.pdf`,
      headers: { ...adminOf(org), "content-type": "application/octet-stream" },
      payload: readFileSync(new URL("./fixtures/pricing.pdf", import.meta.url)),
    });
    assert.equal(uploaded.statusCode, 201, uploaded.payload);
    let document: KnowledgeSourceDetail["documents"][number] | undefined;
    for (let i = 0; i < 120 && document?.status !== "READY" && document?.status !== "FAILED"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      [document] = (await call("GET", `${ws}/knowledge/sources/${source.id}`)).json<KnowledgeSourceDetail>().documents;
    }
    assert.equal(document?.status, "READY", `processing failed: ${document?.error}`);
    t.diagnostic(`document: ${document?.name} ${document?.status}, ${document?.chunkCount} chunks`);

    const matches = (await call("POST", `${ws}/knowledge/search`, { query: "enterprise plan price" })).json<KnowledgeMatch[]>();
    t.diagnostic(`search top match: score ${matches[0]?.score.toFixed(3)}, page ${matches[0]?.page}`);
    assert.match(matches[0]?.content ?? "", /499/);

    await call("PUT", `${ws}/employees/${employee.id}/knowledge`, { sourceIds: [source.id] });
    const res = await call("POST", `${ws}/employees/${employee.id}/messages`, { message: "What is the enterprise plan price?" });
    const last = res.payload
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent)
      .at(-1);
    assert.ok(last?.type === "done", `the turn failed: ${JSON.stringify(last)}`);
    const reply = last.messages[1];
    t.diagnostic(`reply: ${reply.content}`);
    t.diagnostic(`sources: ${JSON.stringify(reply.sources)}`);
    assert.match(reply.content, /499/);
    assert.equal(reply.sources[0]?.documentName, "pricing.pdf");
  },
);
