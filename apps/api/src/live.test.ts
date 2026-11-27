// Calls the real AI provider configured in .env, so it costs a little money and is skipped
// unless asked for:  LIVE_AI=1 pnpm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { prisma } from "@workforce/database";
import { localTime, zonedTime } from "@workforce/tools";
import {
  defaultEmployeeConfig,
  type ChatStreamEvent,
  type CustomerDetail,
  type CustomerPage,
  type EmployeeDetail,
  type KnowledgeMatch,
  type KnowledgeSource,
  type KnowledgeDocument,
  type KnowledgeDocumentPage,
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
    let document: KnowledgeDocument | undefined;
    for (let i = 0; i < 120 && document?.status !== "READY" && document?.status !== "FAILED"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      [document] = (await call("GET", `${ws}/knowledge/sources/${source.id}/documents`)).json<KnowledgeDocumentPage>().data;
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

test(
  "live: an employee remembers a customer in a later conversation",
  { skip: process.env.LIVE_AI !== "1" },
  async (t) => {
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
    const ws = `/workspaces/${workspace.id}`;
    const employee = (
      await call("POST", `${ws}/employees`, { ...defaultEmployeeConfig(), name: "Ava", role: "Sales assistant" })
    ).json<EmployeeDetail>();
    // Each message starts a new conversation with the same customer.
    const say = async (message: string) => {
      const res = await call("POST", `${ws}/employees/${employee.id}/messages`, { customer: "rahul@example.com", message });
      const last = res.payload
        .split("\n\n")
        .filter(Boolean)
        .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent)
        .at(-1);
      assert.ok(last?.type === "done", `the turn failed: ${JSON.stringify(last)}`);
      return last.messages[1].content;
    };

    await say("My name is Rahul. I am interested in the enterprise plan and my budget is around 50,000.");
    // Extraction runs after the reply; wait for it to land.
    let customer: CustomerDetail | undefined;
    for (let i = 0; i < 120 && !customer?.conversations[0]?.summary; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const [summary] = (await call("GET", `${ws}/customers`)).json<CustomerPage>().data;
      if (summary) customer = (await call("GET", `${ws}/customers/${summary.id}`)).json<CustomerDetail>();
    }
    const facts = Object.fromEntries((customer?.memories ?? []).map((m) => [m.key, m.value]));
    t.diagnostic(`stored: ${JSON.stringify(facts)}`);
    t.diagnostic(`summary: ${customer?.conversations[0]?.summary}`);
    assert.match(facts.name ?? "", /rahul/i);
    assert.ok(Object.values(facts).some((v) => /enterprise/i.test(v)), "interest not stored");
    assert.ok(Object.values(facts).includes("50000"), "budget not stored as 50000");

    const reply = await say("Hi, do you remember my name and budget?");
    t.diagnostic(`reply in a new conversation: ${reply}`);
    assert.match(reply, /Rahul/);
    assert.match(reply, /50[,.]?000/);
  },
);

test(
  'live: "Book me a meeting tomorrow at 3 PM" books it through the calendar tool',
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

    const timezone = "Asia/Kolkata";
    const [workspace] = (await call("GET", "/workspaces")).json<Workspace[]>();
    assert.ok(workspace);
    const ws = `/workspaces/${workspace.id}`;
    const employee = (
      await call("POST", `${ws}/employees`, {
        ...defaultEmployeeConfig(timezone),
        name: "Ava",
        role: "Sales assistant",
        systemInstructions: "When a customer asks for a meeting at a specific time, book it right away with a sensible title.",
      })
    ).json<EmployeeDetail>();
    const granted = await call("PUT", `${ws}/employees/${employee.id}/tools`, { tools: [{ name: "calendar_book_meeting" }] });
    assert.equal(granted.statusCode, 200, granted.payload);

    const res = await call("POST", `${ws}/employees/${employee.id}/messages`, { message: "Book me a meeting tomorrow at 3 PM." });
    const last = res.payload
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as ChatStreamEvent)
      .at(-1);
    assert.ok(last?.type === "done", `the turn failed: ${JSON.stringify(last)}`);
    const reply = last.messages[1];
    t.diagnostic(`model: ${reply.model}`);
    t.diagnostic(`tools: ${JSON.stringify(reply.tools)}`);
    t.diagnostic(`reply: ${reply.content}`);
    const audit = await prisma.toolExecution.findMany({ where: { organizationId: org }, orderBy: { createdAt: "asc" } });
    for (const row of audit) t.diagnostic(`audit: ${row.status} ${JSON.stringify(row.input)} -> ${JSON.stringify(row.output ?? row.error)}`);

    const tomorrow = localTime(new Date(Date.now() + 24 * 3600_000), timezone).slice(0, 10);
    const event = await prisma.calendarEvent.findFirst({ where: { organizationId: org } });
    assert.ok(event, "no meeting was booked");
    assert.equal(event.startsAt.toISOString(), zonedTime(tomorrow, "15:00", timezone)?.toISOString());
    assert.ok(reply.tools.some((x) => x.tool === "calendar_book_meeting" && x.status === "SUCCEEDED"));
    assert.match(reply.content, /3(:00)?\s*(PM|p\.m\.)|15:00/i);
  },
);
