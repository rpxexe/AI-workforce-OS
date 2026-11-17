// Needs the database from .env to be running (pnpm infra:up && pnpm db:migrate).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { HealthResponse, Workspace } from "@workforce/shared";
import { adminOf, deleteOrgs, memberOf, newOrg, testApp } from "./testing.ts";

const orgA = newOrg();
const orgB = newOrg();
let app: Awaited<ReturnType<typeof testApp>>;

before(async () => {
  app = await testApp();
});
after(async () => {
  await deleteOrgs(orgA, orgB);
  await app.close();
});

test("GET /health is public and reports the database", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json<HealthResponse>(), { status: "ok", db: true });
});

test("tenant routes reject callers who are signed out or have no organization", async () => {
  const signedOut = await app.inject({ method: "GET", url: "/workspaces" });
  assert.equal(signedOut.statusCode, 401);

  const noOrg = await app.inject({ method: "GET", url: "/workspaces", headers: { "x-test-user": "user_1" } });
  assert.equal(noOrg.statusCode, 403);
});

test("an organization's first request provisions exactly one default workspace", async () => {
  // Five at once: the dashboard can fire parallel requests on first load.
  const responses = await Promise.all(
    Array.from({ length: 5 }, () => app.inject({ method: "GET", url: "/workspaces", headers: memberOf(orgA) })),
  );
  for (const res of responses) assert.equal(res.statusCode, 200);

  const workspaces = (await app.inject({ method: "GET", url: "/workspaces", headers: memberOf(orgA) })).json<Workspace[]>();
  assert.deepEqual(
    workspaces.map((w) => w.name),
    ["Default"],
  );
});

test("only admins create workspaces, and names are unique per organization", async () => {
  const create = (headers: Record<string, string>, name: unknown) =>
    app.inject({ method: "POST", url: "/workspaces", headers, payload: { name } });

  assert.equal((await create(memberOf(orgA), "Support")).statusCode, 403);
  assert.equal((await create(adminOf(orgA), "")).statusCode, 400);
  assert.equal((await create(adminOf(orgA), "Support")).statusCode, 201);
  assert.equal((await create(adminOf(orgA), "Support")).statusCode, 409);
});

test("workspaces are isolated between organizations", async () => {
  const list = async (org: string) =>
    (await app.inject({ method: "GET", url: "/workspaces", headers: adminOf(org) })).json<Workspace[]>();

  const a = await list(orgA);
  const b = await list(orgB);
  assert.deepEqual(a.map((w) => w.name).sort(), ["Default", "Support"]);
  assert.deepEqual(
    b.map((w) => w.name),
    ["Default"],
  );
  // Same name in two organizations is allowed; the rows are different.
  assert.ok(!a.some((w) => b.some((other) => other.id === w.id)));
});
