// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
// Admin controls over customer memory: edit, delete, clear, export, their audit trail, roles and
// tenant isolation. Memory is written directly; how it is learned is covered by memory.test.ts.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "@workforce/database";
import { factWrites, identifyCustomer, parseExtraction } from "@workforce/memory";
import { defaultEmployeeConfig, type CustomerDetail, type CustomerExport, type CustomerPage, type EmployeeDetail, type Workspace } from "@workforce/shared";
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
    (await call("GET", `/workspaces/${wsA}/customers?q=${encodeURIComponent(q)}`, memberOf(orgA))).json<CustomerPage>().data.map((c) => c.name);

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

test("the list pages newest first by last seen, filters on the server, and counts the whole search", async () => {
  const scope = { organizationId: orgA, workspaceId: wsA };
  const day = 24 * 60 * 60 * 1000;
  // Seven people under one search term; the profile varies so every filter and count has something to find.
  const people = [
    { email: "a@paging.test", phone: null, company: "Acme", age: 0 },
    { email: null, phone: "+15550000001", company: null, age: 1 },
    { email: "c@paging.test", phone: "+15550000002", company: null, age: 2 },
    { email: null, phone: null, company: null, age: 3 },
    { email: "e@paging.test", phone: null, company: "Beta", age: 10 },
    { email: null, phone: "+15550000003", company: null, age: 20 },
    { email: null, phone: null, company: null, age: 30 },
  ];
  const ids: string[] = [];
  for (const [i, p] of people.entries()) {
    const c = await prisma.customer.create({
      data: {
        ...scope,
        externalId: `pager-${i}`,
        lastSeenAt: new Date(Date.now() - p.age * day),
        profile: { create: { name: `Pager ${i}`, email: p.email, phone: p.phone, company: p.company } },
      },
    });
    ids.push(c.id);
  }
  const list = async (query: string) => (await call("GET", `/workspaces/${wsA}/customers?q=pager${query}`, memberOf(orgA))).json<CustomerPage>();

  const first = await list("&limit=3");
  assert.deepEqual(first.data.map((c) => c.id), ids.slice(0, 3));
  assert.deepEqual(first.counts, { total: 7, seenThisWeek: 4, withEmail: 3, withPhone: 3, reachable: 5, withCompany: 2 });
  assert.equal(first.total, 7);
  assert.ok(first.nextCursor);
  const second = await list(`&limit=3&cursor=${first.nextCursor}`);
  assert.deepEqual(second.data.map((c) => c.id), ids.slice(3, 6));
  const third = await list(`&limit=3&cursor=${second.nextCursor}`);
  // End of the list: no cursor for a page after it.
  assert.deepEqual([third.data.map((c) => c.id), third.nextCursor, third.total], [ids.slice(6), null, 7]);
  assert.deepEqual(third.counts, first.counts);
  assert.equal((await list("&limit=7")).nextCursor, null);

  const ofFilter = async (filter: string) => (await list(`&filter=${filter}`)).data.map((c) => c.externalId);
  assert.deepEqual(await ofFilter("week"), ["pager-0", "pager-1", "pager-2", "pager-3"]);
  assert.deepEqual(await ofFilter("email"), ["pager-0", "pager-2", "pager-4"]);
  assert.deepEqual(await ofFilter("phone"), ["pager-1", "pager-2", "pager-5"]);
  const both = await list("&filter=phone&limit=2");
  assert.deepEqual([both.data.length, both.total, both.counts.total], [2, 3, 7]);
  // The cursor carries on inside the filter.
  const rest = await list(`&filter=phone&limit=2&cursor=${both.nextCursor}`);
  assert.deepEqual([rest.data.map((c) => c.externalId), rest.nextCursor], [["pager-5"], null]);

  // A cursor only continues the list it came from: another filter, search or workspace is refused, not mixed in.
  for (const other of [`&filter=email&cursor=${both.nextCursor}`, `x&filter=phone&cursor=${both.nextCursor}`])
    assert.equal((await call("GET", `/workspaces/${wsA}/customers?q=pager${other}`, memberOf(orgA))).statusCode, 400, other);

  // Search wildcards match themselves in the counts, as in the list.
  assert.equal((await list("%25&limit=1")).counts.total, 0);

  const forged = Buffer.from(JSON.stringify({ at: "not a date", id: ids[0], context: "x".repeat(16) })).toString("base64url");
  for (const bad of ["&limit=0", "&limit=101", "&filter=nope", "&cursor=nope", `&cursor=${forged}`])
    assert.equal((await call("GET", `/workspaces/${wsA}/customers?q=pager${bad}`, memberOf(orgA))).statusCode, 400, bad);
});

test("cursor pages survive rows added, removed and moved between requests, and ties on last seen", async () => {
  const scope = { organizationId: orgA, workspaceId: wsA };
  const at = new Date(Date.now() - 60 * 60 * 1000);
  // Six customers seen at the very same moment: the id decides their order.
  for (let i = 0; i < 6; i++)
    await prisma.customer.create({ data: { ...scope, externalId: `keyset-${i}`, lastSeenAt: at, profile: { create: { name: `Keyset ${i}` } } } });
  // The database's own id order (its collation, not JavaScript's sort).
  const ids = (await prisma.customer.findMany({ where: { ...scope, externalId: { startsWith: "keyset-" } }, orderBy: { id: "desc" } })).map((c) => c.id);
  const list = async (query: string) => (await call("GET", `/workspaces/${wsA}/customers?q=keyset${query}`, memberOf(orgA))).json<CustomerPage>();
  const walk = async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: CustomerPage = await list(`&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...page.data.map((c) => c.id));
      cursor = page.nextCursor;
    } while (cursor);
    return seen;
  };
  assert.deepEqual(await walk(), ids, "ties on lastSeenAt: every row once, in id order");

  // Inserted: a new customer seen just now goes to the top; the next page is unaffected (OFFSET repeated a row here).
  const first = await list("&limit=2");
  const added = await prisma.customer.create({ data: { ...scope, externalId: "keyset-new", profile: { create: { name: "Keyset new" } } } });
  assert.deepEqual((await list(`&limit=2&cursor=${first.nextCursor}`)).data.map((c) => c.id), ids.slice(2, 4));

  // Deleted: a customer already shown is removed; the next page still starts after the last one shown (OFFSET skipped one).
  await prisma.customer.delete({ where: { id: ids[0]! } });
  assert.deepEqual((await list(`&limit=2&cursor=${first.nextCursor}`)).data.map((c) => c.id), ids.slice(2, 4));

  // The cursor's own row deleted: the position is in the cursor, so paging still carries on.
  await prisma.customer.delete({ where: { id: ids[1]! } });
  assert.deepEqual((await list(`&limit=2&cursor=${first.nextCursor}`)).data.map((c) => c.id), ids.slice(2, 4));

  // Moved: a customer further down is seen again and goes to the top. Pages already shown are not repeated; it is at
  // the top of the list on the next first page (keyset paging does not freeze the list).
  const second = await list(`&limit=2&cursor=${first.nextCursor}`);
  await prisma.customer.update({ where: { id: ids[5]! }, data: { lastSeenAt: new Date() } });
  const third = await list(`&limit=2&cursor=${second.nextCursor}`);
  assert.deepEqual([third.data.map((c) => c.id), third.nextCursor], [[ids[4]], null]);
  assert.deepEqual((await list("&limit=2")).data.map((c) => c.id), [ids[5], added.id]);
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
  const outside = (await call("GET", `/workspaces/${wsB}/customers?q=Pia`, adminOf(orgB))).json<CustomerPage>();
  assert.deepEqual([outside.data, outside.counts.total], [[], 0]);
  assert.equal(outside.total, 0);

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
