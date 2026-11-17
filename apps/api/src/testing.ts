// Test support only: never imported by the server.
import { randomUUID } from "node:crypto";
import { prisma } from "@workforce/database";
import { buildApp } from "./app.ts";
import type { Authenticate } from "./auth.ts";

const header = (value: string | string[] | undefined) => (typeof value === "string" ? value : null);

/** Stands in for Clerk: the identity is whatever the test's headers say. */
export const headerAuth: Authenticate = (req) => ({
  userId: header(req.headers["x-test-user"]),
  orgId: header(req.headers["x-test-org"]),
  orgRole: header(req.headers["x-test-role"]),
});

export const testApp = () => buildApp({ authenticate: headerAuth, logger: false });

/** A throwaway organization id, unique per run so tests never collide with real data. */
export const newOrg = () => `org_test_${randomUUID()}`;

export const adminOf = (org: string) => ({ "x-test-user": "user_admin", "x-test-org": org, "x-test-role": "org:admin" });
export const memberOf = (org: string) => ({
  "x-test-user": "user_member",
  "x-test-org": org,
  "x-test-role": "org:member",
});

/** Cascades to the organization's workspaces, employees and versions. */
export const deleteOrgs = (...ids: string[]) => prisma.organization.deleteMany({ where: { id: { in: ids } } });
