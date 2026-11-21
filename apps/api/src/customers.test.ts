// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Admin controls over customer memory: edit, delete, clear, export, their audit trail, roles and
// tenant isolation. Memory is written directly; how it is learned is covered by memory.test.ts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "@workforce/database";
import { factWrites, identifyCustomer, parseExtraction } from "@workforce/memory";
import { defaultEmployeeConfig, type CustomerDetail, type CustomerExport, type CustomerSummary, type EmployeeDetail, type Workspace } from "@workforce/shared";
import { adminOf, deleteOrgs, memberOf, newOrg, testApp } from "./testing.ts";

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof testApp>>;
let wsA: string;
let wsB: string;
let employeeA: string;

type Headers = Record<string, string>;
const call = (method: "GET" | "PATCH" | "DELETE", url: string, headers: Headers, payload?: object) =>
  app.inject({ method, url, headers, ...(payload && { payload }) });
const detail = async (id: string) => (await call("GET", `/workspaces/${wsA}/customers/${id}`, memberOf(orgA))).json<CustomerDetail>();
const auditOf = (customerId: string) => prisma.customerAuditLog.findMany({ where: { customerId }, orderBy: { createdAt: "asc" } });

/** A customer in org A with identity and lead facts, and one summarized conversation. */
async function seedCustomer(externalId: string, name: string) {
  const scope = { organizationId: orgA, workspaceId: wsA };
  const customerId = await identifyCustomer(scope, externalId);
  const conversation = await prisma.conversation.create({
    data: { ...scope, employeeId: employeeA, channel: "whatsapp", title: "Pricing question", createdBy: "test" },
  });
  await prisma.customerConversation.create({ data: { conversationId: conversation.id, customerId, summary: `${name} asked about pricing.` } });
  await prisma.$transaction(
    factWrites(
      customerId,
      [
        { category: "identity", key: "name", value: name, confidence: 0.95 },
        { category: "identity", key: "email", value: `${name.toLowerCase()}@example.com` },
        { category: "lead", key: "budget", value: "50000", confidence: 0.7 },
      ],
      conversation.id,
    ),
  );
  return { customerId, conversationId: conversation.id };
}

before(async () => {
  app = await testApp();
  const firstWorkspace = async (org: string) => {
    const [ws] = (await call("GET", "/workspaces", adminOf(org))).json<Workspace[]>();
    assert.ok(ws);
    return ws.id;
  };
  wsA = await firstWorkspace(orgA);
  wsB = await firstWorkspace(orgB);
  const employee = await app.inject({
    method: "POST",
    url: `/workspaces/${wsA}/employees`,
    headers: adminOf(orgA),
    payload: { ...defaultEmployeeConfig(), name: "Ava", role: "Sales assistant" },
  });
  employeeA = employee.json<EmployeeDetail>().id;
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("extraction keeps a confidence between 0 and 1 and ignores anything else", () => {
  const { facts } = parseExtraction(
    JSON.stringify({
      memories: [
        { category: "identity", key: "name", value: "Rahul", confidence: 0.9 },
        { category: "lead", key: "budget", value: "50000", confidence: 7 },
        { category: "lead", key: "interest", value: "enterprise", confidence: "high" },
      ],
    }),
  );
  assert.deepEqual(facts, [
    { category: "identity", key: "name", value: "Rahul", confidence: 0.9 },
    { category: "lead", key: "budget", value: "50000" },
    { category: "lead", key: "interest", value: "enterprise" },
  ]);
});

test("the list searches name, email, phone, company and channel id", async () => {
  const { customerId } = await seedCustomer("+15550001111", "Priya");
  await seedCustomer("visitor-xyz", "Marco");
  const search = async (q: string) =>
    (await call("GET", `/workspaces/${wsA}/customers?q=${encodeURIComponent(q)}`, memberOf(orgA))).json<CustomerSummary[]>().map((c) => c.name);

  assert.deepEqual(await search("priya"), ["Priya"]);
  assert.deepEqual(await search("MARCO@EXAMPLE"), ["Marco"]);
  assert.deepEqual(await search("5550001"), ["Priya"]);
  assert.deepEqual(await search("nobody"), []);
  assert.equal((await search("")).length >= 2, true);

  const d = await detail(customerId);
  const name = d.memories.find((m) => m.key === "name");
  assert.equal(name?.confidence, 0.95);
  assert.equal(d.memories.find((m) => m.key === "email")?.confidence, null);
  assert.ok(name?.id && name.conversationId);
  assert.deepEqual(
    d.conversations.map((c) => [c.channel, c.status, c.summary]),
    [["whatsapp", "AI_ACTIVE", "Priya asked about pricing."]],
  );
});

test("an admin edits a memory: validated, profile kept in step, confidence 1, audited", async () => {
  const { customerId } = await seedCustomer("edit@example.com", "Edith");
  const name = (await detail(customerId)).memories.find((m) => m.key === "name");
  assert.ok(name);
  const url = `/workspaces/${wsA}/customers/${customerId}/memories/${name.id}`;

  assert.equal((await call("PATCH", url, memberOf(orgA), { value: "Edie" })).statusCode, 403);
  assert.equal((await call("PATCH", url, adminOf(orgA), { value: "  " })).statusCode, 400);
  assert.equal((await call("PATCH", url, adminOf(orgA), { value: "card 4111 1111 1111 1111" })).statusCode, 400);

  const res = await call("PATCH", url, adminOf(orgA), { value: "Edie" });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json<CustomerDetail["memories"][number]>().value, "Edie");
  const after = await detail(customerId);
  assert.equal(after.name, "Edie");
  assert.equal(after.memories.find((m) => m.key === "name")?.confidence, 1);

  const rows = await auditOf(customerId);
  assert.deepEqual(
    rows.map((r) => [r.action, r.actorId, r.detail]),
    [["memory_edit", "user_admin", { memoryId: name.id, key: "name" }]],
  );
});

test("an admin deletes one memory and the profile forgets it", async () => {
  const { customerId } = await seedCustomer("del@example.com", "Dana");
  const email = (await detail(customerId)).memories.find((m) => m.key === "email");
  assert.ok(email);
  const url = `/workspaces/${wsA}/customers/${customerId}/memories/${email.id}`;

  assert.equal((await call("DELETE", url, memberOf(orgA))).statusCode, 403);
  assert.equal((await call("DELETE", url, adminOf(orgA))).statusCode, 204);
  assert.equal((await call("DELETE", url, adminOf(orgA))).statusCode, 404);
  const after = await detail(customerId);
  assert.equal(after.email, null);
  assert.equal(after.name, "Dana");
  assert.deepEqual(after.memories.map((m) => m.key).sort(), ["budget", "name"]);
  assert.deepEqual((await auditOf(customerId)).map((r) => r.action), ["memory_delete"]);
});

test("clearing forgets facts, profile and summaries but keeps the conversations", async () => {
  const { customerId } = await seedCustomer("clear@example.com", "Cleo");
  const url = `/workspaces/${wsA}/customers/${customerId}/memories`;

  assert.equal((await call("DELETE", url, memberOf(orgA))).statusCode, 403);
  assert.equal((await call("DELETE", url, adminOf(orgA))).statusCode, 204);
  const after = await detail(customerId);
  assert.deepEqual(after.memories, []);
  assert.deepEqual([after.name, after.email], [null, null]);
  assert.deepEqual(after.conversations.map((c) => c.summary), [""]);

  const [row] = await auditOf(customerId);
  assert.deepEqual([row?.action, row?.detail], ["memory_clear", { memories: 3, summaries: 1 }]);
});

test("an admin exports profile, memories and summaries as a JSON download, audited", async () => {
  const { customerId, conversationId } = await seedCustomer("export@example.com", "Ezra");
  const url = `/workspaces/${wsA}/customers/${customerId}/export`;

  assert.equal((await call("GET", url, memberOf(orgA))).statusCode, 403);
  const res = await call("GET", url, adminOf(orgA));
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers["content-disposition"]), /attachment; filename="customer-.+\.json"/);
  const data = res.json<CustomerExport>();
  assert.equal(data.customer.name, "Ezra");
  assert.equal(data.customer.externalId, "export@example.com");
  assert.deepEqual(data.memories.map((m) => m.key).sort(), ["budget", "email", "name"]);
  assert.deepEqual(data.conversations.map((c) => [c.id, c.channel, c.summary]), [[conversationId, "whatsapp", "Ezra asked about pricing."]]);
  assert.deepEqual((await auditOf(customerId)).map((r) => [r.action, r.actorId]), [["export", "user_admin"]]);
});

test("another organization's customer is a 404 on every route and nothing changes", async () => {
  const { customerId } = await seedCustomer("private@example.com", "Pia");
  const memory = (await detail(customerId)).memories[0];
  assert.ok(memory);
  const routes = (ws: string) =>
    [
      ["GET", `/workspaces/${ws}/customers/${customerId}`],
      ["GET", `/workspaces/${ws}/customers/${customerId}/export`],
      ["PATCH", `/workspaces/${ws}/customers/${customerId}/memories/${memory.id}`],
      ["DELETE", `/workspaces/${ws}/customers/${customerId}/memories/${memory.id}`],
      ["DELETE", `/workspaces/${ws}/customers/${customerId}/memories`],
    ] as const;

  // Org B's admin, through their own workspace (customer not there) and through org A's (workspace not theirs).
  for (const ws of [wsB, wsA])
    for (const [method, url] of routes(ws)) {
      const res = await call(method, url, adminOf(orgB), method === "PATCH" ? { value: "hacked" } : undefined);
      assert.equal(res.statusCode, 404, `${method} ${url}`);
    }
  assert.deepEqual((await call("GET", `/workspaces/${wsB}/customers?q=Pia`, adminOf(orgB))).json(), []);

  // A memory id from another customer of the same organization is a 404 too.
  const other = await seedCustomer("other@example.com", "Otto");
  assert.equal(
    (await call("PATCH", `/workspaces/${wsA}/customers/${other.customerId}/memories/${memory.id}`, adminOf(orgA), { value: "x" })).statusCode,
    404,
  );

  const after = await detail(customerId);
  assert.equal(after.memories.length, 3);
  assert.equal(after.name, "Pia");
  assert.deepEqual(await auditOf(customerId), []);
});

test("signed-out callers are refused", async () => {
  assert.equal((await call("GET", `/workspaces/${wsA}/customers`, {})).statusCode, 401);
  assert.equal((await call("DELETE", `/workspaces/${wsA}/customers/x/memories`, {})).statusCode, 401);
});
