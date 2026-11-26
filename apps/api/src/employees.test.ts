// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { prisma } from "@workforce/database";
import {
  defaultEmployeeConfig,
  type ApiError,
  type EmployeeConfig,
  type EmployeeDetail,
  type EmployeePage,
  type EmployeeSummary,
  type Workspace,
} from "@workforce/shared";
import { adminOf, deleteOrgs, memberOf, newOrg, testApp } from "./testing.ts";

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof testApp>>;
let wsA: string;
let wsA2: string;
let wsB: string;

const config = (overrides: Partial<EmployeeConfig> = {}): EmployeeConfig => ({
  ...defaultEmployeeConfig(),
  name: "Ava",
  role: "Support agent",
  goals: ["Resolve billing questions"],
  ...overrides,
});

type Headers = Record<string, string>;
const call = (method: "GET" | "POST" | "PUT" | "PATCH", url: string, headers: Headers, payload?: object) =>
  app.inject({ method, url, headers, payload });
const employees = (ws: string) => `/workspaces/${ws}/employees`;

const createEmployee = async (overrides?: Partial<EmployeeConfig>) => {
  const res = await call("POST", employees(wsA), adminOf(orgA), config(overrides));
  assert.equal(res.statusCode, 201);
  return res.json<EmployeeDetail>();
};

before(async () => {
  app = await testApp();
  const defaultOf = async (org: string) => {
    const [first] = (await call("GET", "/workspaces", adminOf(org))).json<Workspace[]>();
    assert.ok(first);
    return first.id;
  };
  wsA = await defaultOf(orgA);
  wsB = await defaultOf(orgB);
  wsA2 = (await call("POST", "/workspaces", adminOf(orgA), { name: "Second" })).json<Workspace>().id;
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("create, read and list", async () => {
  const created = await createEmployee();
  assert.equal(created.status, "DRAFT");
  assert.equal(created.publishedVersion, null);
  assert.equal(created.versions.length, 1);
  assert.equal(created.versions[0]?.number, 1);
  assert.equal(created.versions[0]?.name, "Ava");
  assert.deepEqual(created.versions[0]?.workingHours, config().workingHours);

  const read = await call("GET", `${employees(wsA)}/${created.id}`, memberOf(orgA));
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json<EmployeeDetail>(), created);

  const list = (await call("GET", employees(wsA), memberOf(orgA))).json<EmployeeSummary[]>();
  const row = list.find((e) => e.id === created.id);
  assert.equal(row?.name, "Ava");
  assert.equal(row?.latestVersion, 1);
  assert.equal(row?.publishedVersion, null);
});

test("editing appends a version and never changes the published one", async () => {
  const { id } = await createEmployee();
  const url = `${employees(wsA)}/${id}`;

  await call("POST", `${url}/publish`, adminOf(orgA), { version: 1 });
  const edited = (await call("PUT", url, adminOf(orgA), config({ name: "Ava 2", personality: "Warm" }))).json<EmployeeDetail>();

  assert.equal(edited.versions.length, 2);
  assert.equal(edited.versions[0]?.number, 2);
  assert.equal(edited.versions[0]?.name, "Ava 2");
  // Production still points at version 1, and version 1 is byte-for-byte what was published.
  assert.equal(edited.publishedVersion, 1);
  assert.equal(edited.versions[1]?.name, "Ava");
  assert.equal(edited.versions[1]?.personality, "");
});

test("publishing moves the live pointer, and an older version can be republished", async () => {
  const { id } = await createEmployee();
  const url = `${employees(wsA)}/${id}`;
  await call("PUT", url, adminOf(orgA), config({ name: "Second draft" }));

  const first = (await call("POST", `${url}/publish`, adminOf(orgA), { version: 2 })).json<EmployeeDetail>();
  assert.equal(first.publishedVersion, 2);
  assert.equal(first.status, "ACTIVE", "first publish activates a draft");

  const rolledBack = (await call("POST", `${url}/publish`, adminOf(orgA), { version: 1 })).json<EmployeeDetail>();
  assert.equal(rolledBack.publishedVersion, 1);
  assert.equal(rolledBack.versions.length, 2, "rollback does not create or delete versions");

  assert.equal((await call("POST", `${url}/publish`, adminOf(orgA), { version: 99 })).statusCode, 404);
});

test("status: pause, resume, archive and restore", async () => {
  const { id } = await createEmployee();
  const url = `${employees(wsA)}/${id}`;
  const setStatus = (status: string) => call("PATCH", `${url}/status`, adminOf(orgA), { status });
  const listed = async (archived: boolean) =>
    (await call("GET", `${employees(wsA)}?archived=${archived}`, adminOf(orgA)))
      .json<EmployeeSummary[]>()
      .some((e) => e.id === id);

  assert.equal((await setStatus("ACTIVE")).statusCode, 409, "nothing published yet");
  assert.equal((await setStatus("DRAFT")).statusCode, 400, "draft cannot be set by hand");

  assert.equal((await setStatus("ARCHIVED")).json<EmployeeDetail>().status, "ARCHIVED");
  assert.equal(await listed(false), false);
  assert.equal(await listed(true), true);
  assert.equal((await setStatus("PAUSED")).json<EmployeeDetail>().status, "DRAFT", "unpublished restores to draft");

  await call("POST", `${url}/publish`, adminOf(orgA), { version: 1 });
  assert.equal((await setStatus("PAUSED")).json<EmployeeDetail>().status, "PAUSED");
  assert.equal((await setStatus("ACTIVE")).json<EmployeeDetail>().status, "ACTIVE");
});

test("duplicate copies the latest configuration into a new draft", async () => {
  const source = await createEmployee({ name: "Original", goals: ["A", "B"] });
  await call("POST", `${employees(wsA)}/${source.id}/publish`, adminOf(orgA), { version: 1 });

  const res = await call("POST", `${employees(wsA)}/${source.id}/duplicate`, adminOf(orgA));
  assert.equal(res.statusCode, 201);
  const copy = res.json<EmployeeDetail>();

  assert.notEqual(copy.id, source.id);
  assert.equal(copy.status, "DRAFT");
  assert.equal(copy.publishedVersion, null);
  assert.equal(copy.versions.length, 1);
  assert.equal(copy.versions[0]?.name, "Original (copy)");
  assert.deepEqual(copy.versions[0]?.goals, ["A", "B"]);
});

test("validation rejects bad input and names the fields", async () => {
  const bad = config({ name: "  ", goals: [""], language: "xx" as EmployeeConfig["language"] });
  bad.escalation = { ...bad.escalation, enabled: true, contactEmail: "" };
  bad.workingHours.days[0] = { day: "mon", enabled: true, start: "18:00", end: "09:00" };

  const res = await call("POST", employees(wsA), adminOf(orgA), bad);
  assert.equal(res.statusCode, 400);
  const paths = res.json<ApiError>().issues?.map((i) => i.path).sort();
  assert.deepEqual(paths, ["escalation.contactEmail", "goals.0", "language", "name", "workingHours.days.0.end"]);

  const stored = (await call("GET", employees(wsA), adminOf(orgA))).json<EmployeeSummary[]>();
  assert.ok(!stored.some((e) => e.name.trim() === ""), "nothing was saved");
});

test("authorization: signed-out is 401, members read but cannot change anything", async () => {
  const { id } = await createEmployee();
  const url = `${employees(wsA)}/${id}`;

  assert.equal((await call("GET", url, {})).statusCode, 401);
  assert.equal((await call("GET", url, { "x-test-user": "user_no_org" })).statusCode, 403);

  const member = memberOf(orgA);
  assert.equal((await call("GET", url, member)).statusCode, 200);
  assert.equal((await call("GET", employees(wsA), member)).statusCode, 200);

  const writes = await Promise.all([
    call("POST", employees(wsA), member, config()),
    call("PUT", url, member, config({ name: "Hijacked" })),
    call("POST", `${url}/publish`, member, { version: 1 }),
    call("PATCH", `${url}/status`, member, { status: "ARCHIVED" }),
    call("POST", `${url}/duplicate`, member),
  ]);
  assert.deepEqual(
    writes.map((r) => r.statusCode),
    [403, 403, 403, 403, 403],
  );

  const after = (await call("GET", url, member)).json<EmployeeDetail>();
  assert.equal(after.versions.length, 1);
  assert.equal(after.status, "DRAFT");
});

test("isolation: another organization or workspace cannot see or touch an employee", async () => {
  const { id } = await createEmployee({ name: "Private to A" });
  const outsider = adminOf(orgB);

  // Org B's admin, addressing A's workspace directly and smuggling A's id into their own workspace.
  for (const base of [employees(wsA), employees(wsB)]) {
    const url = `${base}/${id}`;
    const attempts = await Promise.all([
      call("GET", url, outsider),
      call("PUT", url, outsider, config({ name: "Hijacked" })),
      call("POST", `${url}/publish`, outsider, { version: 1 }),
      call("PATCH", `${url}/status`, outsider, { status: "ARCHIVED" }),
      call("POST", `${url}/duplicate`, outsider),
    ]);
    assert.deepEqual(
      attempts.map((r) => r.statusCode),
      [404, 404, 404, 404, 404],
      base,
    );
  }
  assert.equal((await call("GET", employees(wsA), outsider)).statusCode, 404);
  assert.equal((await call("POST", employees(wsA), outsider, config())).statusCode, 404);
  assert.deepEqual((await call("GET", employees(wsB), outsider)).json(), []);

  // Same organization, different workspace.
  assert.equal((await call("GET", `${employees(wsA2)}/${id}`, adminOf(orgA))).statusCode, 404);
  assert.deepEqual((await call("GET", employees(wsA2), adminOf(orgA))).json(), []);

  // Nothing changed, and nothing was created for org B.
  const intact = (await call("GET", `${employees(wsA)}/${id}`, adminOf(orgA))).json<EmployeeDetail>();
  assert.equal(intact.versions.length, 1);
  assert.equal(intact.versions[0]?.name, "Private to A");
  assert.equal(intact.status, "DRAFT");
  assert.equal(await prisma.aiEmployee.count({ where: { organizationId: orgB } }), 0);
});

test("paging: ?limit= returns pages newest first with a cursor, ?q= on the latest name or role, and counts by status", async () => {
  const ws = (await call("POST", "/workspaces", adminOf(orgA), { name: "Paging" })).json<Workspace>().id;
  const ids: string[] = [];
  for (const name of ["One", "Two", "Three", "Four", "Five"]) {
    const res = await call("POST", employees(ws), adminOf(orgA), config({ name, role: name === "Four" ? "Billing lead" : "Support agent" }));
    ids.unshift(res.json<EmployeeDetail>().id);
  }
  // Renamed: an older version's name no longer matches.
  await call("PUT", `${employees(ws)}/${ids[0]}`, adminOf(orgA), config({ name: "Fifth" }));
  await call("PATCH", `${employees(ws)}/${ids[1]}/status`, adminOf(orgA), { status: "ARCHIVED" });
  const page = async (query: string) => (await call("GET", `${employees(ws)}?${query}`, memberOf(orgA))).json<EmployeePage>();

  // Archiving touched ids[1] last, so the current tab is newest change first: Fifth (renamed), Three, Two, One.
  const first = await page("limit=2");
  assert.deepEqual(first.data.map((e) => e.name), ["Fifth", "Three"]);
  assert.deepEqual(first.counts, { DRAFT: 4, ACTIVE: 0, PAUSED: 0, ARCHIVED: 0 });
  const second = await page(`limit=2&cursor=${first.nextCursor}`);
  assert.deepEqual([second.data.map((e) => e.name), second.nextCursor], [["Two", "One"], null]);

  assert.deepEqual((await page("limit=10&q=five")).data, []);
  assert.deepEqual((await page("limit=10&q=fifth")).data.map((e) => e.name), ["Fifth"]);
  assert.deepEqual((await page("limit=10&q=billing&archived=true")).data.map((e) => e.name), ["Four"]);
  assert.deepEqual((await page("limit=10&archived=true")).counts.ARCHIVED, 1);

  // Without ?limit= the whole list comes back as before (pickers and the dashboard).
  assert.equal((await call("GET", employees(ws), memberOf(orgA))).json<EmployeeSummary[]>().length, 4);
  for (const bad of ["limit=0", "limit=101"]) assert.equal((await call("GET", `${employees(ws)}?${bad}`, memberOf(orgA))).statusCode, 400, bad);

  // Another organization: 404 on the workspace, an empty page in its own even with this cursor.
  assert.equal((await call("GET", `${employees(ws)}?limit=2`, adminOf(orgB))).statusCode, 404);
  const outside = (await call("GET", `${employees(wsB)}?limit=2&cursor=${ids[2]}`, adminOf(orgB))).json<EmployeePage>();
  assert.deepEqual([outside.data, outside.nextCursor, outside.counts.DRAFT], [[], null, 0]);
});

test("database: version numbers are unique per employee, and deleting an organization removes its data", async () => {
  const { id } = await createEmployee();
  const duplicateNumber = prisma.aiEmployeeVersion.create({
    data: { ...config(), employeeId: id, number: 1, createdBy: "user_admin" },
  });
  await assert.rejects(duplicateNumber, { code: "P2002" });

  assert.ok((await prisma.aiEmployee.count({ where: { organizationId: orgA } })) > 0);
  await deleteOrgs(orgA);
  assert.equal(await prisma.workspace.count({ where: { organizationId: orgA } }), 0);
  assert.equal(await prisma.aiEmployee.count({ where: { organizationId: orgA } }), 0);
  assert.equal(await prisma.aiEmployeeVersion.count({ where: { employeeId: id } }), 0);
});
