// Phase 14 settings: an organization's provider connections (connect, configure, test, set default, disable, delete,
// rotate), the registry, the audit log, provider metrics, and employee/workflow overrides. Members read; admins write.
// Secrets are write-only: responses carry hints (last 4 characters), never a value.
import { prisma, Prisma } from "@workforce/database";
import { hintOf, registryEntry, sealCredentials, testConnection } from "@workforce/providers";
import {
  ADMIN_ROLE,
  checkFields,
  CONNECTION_STATUSES,
  createConnectionSchema,
  PROVIDER_CATALOG,
  PROVIDER_TYPES,
  providerMeta,
  providerOverridesSchema,
  rotateCredentialsSchema,
  updateConnectionSchema,
  type ModelTarget,
  type OverridableType,
  type ProviderAuditEntry,
  type ProviderConnectionInfo,
  type ProviderMetric,
  type ProviderOverrides,
  type ProviderSettings,
  type ProviderType,
  type TestConnectionResult,
} from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertPublicBaseUrl } from "../ai.ts";
import { guards, httpError, type Authenticate } from "../auth.ts";
import { employeeParams, within } from "../employees.ts";
import type { ConnectionRow, PlatformProviders, ProviderService } from "./service.ts";

const idParams = z.object({ id: z.string().min(1) });
const statusBody = z.object({ status: z.enum(CONNECTION_STATUSES) });
const daysQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const workflowParams = z.object({ workspaceId: z.string().min(1), id: z.string().min(1) });

/** Test Connection calls the provider (and may cost a little): at most this many per organization per minute. */
const TESTS_PER_MINUTE = 10;

/** Where a connection's webhooks live: what the admin enters in the provider's console. */
export function webhookUrlsOf(row: Pick<ConnectionRow, "id" | "providerType" | "providerId">, publicUrl: string | null): Record<string, string> | null {
  if (!publicUrl) return null;
  const base = publicUrl.replace(/\/+$/, "");
  if (row.providerType === "telephony")
    return { voice: `${base}/voice/${row.providerId}/c/${row.id}/inbound`, status: `${base}/voice/${row.providerId}/c/${row.id}/status` };
  if (row.providerType === "messaging") {
    const name = row.providerId.replace(/_whatsapp$/, "");
    return { webhook: `${base}/channels/whatsapp/${name}/c/${row.id}/webhook` };
  }
  if (row.providerType === "email" && row.providerId === "resend") return { webhook: `${base}/channels/email/resend/c/${row.id}/webhook` };
  return null;
}

export const toConnection = (row: ConnectionRow, admin: boolean, publicUrl: string | null): ProviderConnectionInfo => ({
  id: row.id,
  providerType: row.providerType as ProviderType,
  providerId: row.providerId,
  displayName: row.displayName,
  configuration: row.configuration as Record<string, unknown>,
  credentialHints: row.credentialHints as Record<string, string>,
  status: row.status as ProviderConnectionInfo["status"],
  isDefault: row.isDefault,
  lastTestedAt: row.lastTestedAt?.toISOString() ?? null,
  lastTestStatus: row.lastTestStatus as ProviderConnectionInfo["lastTestStatus"],
  lastTestError: row.lastTestError,
  rotatedAt: row.rotatedAt?.toISOString() ?? null,
  webhookUrls: admin ? webhookUrlsOf(row, publicUrl) : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const hintsOf = (credentials: Record<string, string>) => Object.fromEntries(Object.entries(credentials).filter(([, v]) => v).map(([k, v]) => [k, hintOf(v)]));
const nonEmpty = (credentials: Record<string, string>) => Object.fromEntries(Object.entries(credentials).filter(([, v]) => v.trim() !== ""));

/** Addresses the server will call must be public https (checked again on every request by safeFetch). */
async function assertPublicFields(type: ProviderType, id: string, configuration: Record<string, unknown>) {
  const meta = providerMeta(type, id);
  for (const field of meta?.configFields ?? []) {
    const value = configuration[field.key];
    if (field.kind === "url" && typeof value === "string" && value) await assertPublicBaseUrl(value);
  }
  if (type === "email" && id === "smtp" && typeof configuration.host === "string" && configuration.host)
    await assertPublicBaseUrl(`https://${configuration.host.replace(/[/:].*$/, "")}`);
}

const fieldIssues = (issues: { path: string; message: string }[]) => {
  if (issues.length === 0) return;
  const err = httpError(400, "Validation failed") as Error & { issues?: unknown };
  err.issues = issues;
  throw err;
};

/** Where a connection is in use; deleting it would break these. */
async function usesOf(organizationId: string, row: ConnectionRow): Promise<string[]> {
  const uses: string[] = [];
  if (row.providerType === "llm") {
    const policies = await prisma.aiModelPolicy.findMany({ where: { organizationId } });
    for (const p of policies) if ([p.primary, ...(p.fallbacks as ModelTarget[])].some((t) => (t as ModelTarget).credentialId === row.id)) uses.push(`the ${p.task} model policy`);
  }
  if (["llm", "stt", "tts", "email"].includes(row.providerType)) {
    const type = row.providerType as OverridableType;
    const [employees, workflows] = await Promise.all([
      prisma.aiEmployee.findMany({ where: { organizationId }, select: { id: true, providerOverrides: true, versions: { orderBy: { number: "desc" }, take: 1, select: { name: true } } } }),
      prisma.workflow.findMany({ where: { organizationId, deletedAt: null }, select: { name: true, providerOverrides: true } }),
    ]);
    for (const e of employees) if ((e.providerOverrides as ProviderOverrides)[type]?.connectionId === row.id) uses.push(`employee ${e.versions[0]?.name ?? e.id}`);
    for (const w of workflows) if ((w.providerOverrides as ProviderOverrides)[type]?.connectionId === row.id) uses.push(`workflow ${w.name}`);
  }
  if (row.providerType === "telephony") {
    const numbers = await prisma.phoneNumber.findMany({ where: { organizationId, connectionId: row.id }, select: { number: true } });
    uses.push(...numbers.map((n) => `phone number ${n.number}`));
  }
  if (row.providerType === "messaging") {
    const channels = await prisma.employeeChannel.findMany({ where: { organizationId, kind: "whatsapp" }, select: { address: true, config: true } });
    for (const c of channels) if ((c.config as { connectionId?: string }).connectionId === row.id) uses.push(`WhatsApp number ${c.address}`);
  }
  if (row.providerType === "storage") {
    const files = await prisma.knowledgeDocument.count({ where: { organizationId, storageConnectionId: row.id } });
    if (files > 0) uses.push(`${files} knowledge file${files === 1 ? "" : "s"}`);
  }
  return uses;
}

/** The connections an override may name must be the organization's own, of the right type, and active. */
async function assertOverrides(organizationId: string, overrides: ProviderOverrides) {
  for (const [type, target] of Object.entries(overrides) as [OverridableType, { connectionId: string | null } | undefined][]) {
    if (!target?.connectionId) continue;
    const row = await prisma.providerConnection.findFirst({ where: { id: target.connectionId, organizationId, providerType: type, status: "active" } });
    if (!row) throw httpError(400, `The ${type} override names a connection this organization does not have (or it is disabled)`);
  }
}

export function providerRoutes(
  app: FastifyInstance,
  authenticate: Authenticate,
  deps: { service: ProviderService; secret: string | null; platform: PlatformProviders & { llm: string }; publicUrl: string | null },
) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const needSecret = () => {
    if (!deps.secret) throw httpError(503, "AI_CREDENTIALS_KEY is not set on the server (32+ random characters), so credentials cannot be stored");
    return deps.secret;
  };
  const audit = (organizationId: string, actorId: string, row: Pick<ConnectionRow, "id" | "providerType" | "providerId">, action: string, detail: Record<string, unknown> = {}) =>
    prisma.providerAuditLog.create({
      data: { organizationId, connectionId: row.id, providerType: row.providerType, providerId: row.providerId, action, actorId, detail: detail as Prisma.InputJsonValue },
    });
  const owned = async (organizationId: string, id: string) => {
    const row = await prisma.providerConnection.findFirst({ where: { id, organizationId } });
    if (!row) throw httpError(404, "Connection not found");
    return row;
  };

  // ---- Registry and settings ----

  app.get("/providers/registry", async (req) => {
    member(req);
    return PROVIDER_CATALOG;
  });

  app.get("/providers/settings", async (req): Promise<ProviderSettings> => {
    const auth = member(req);
    const rows = await prisma.providerConnection.findMany({ where: { organizationId: auth.organizationId }, orderBy: { createdAt: "asc" } });
    const p = deps.platform;
    const platform = Object.fromEntries(PROVIDER_TYPES.map((t) => [t, [] as string[]])) as Record<ProviderType, string[]>;
    platform.llm = [p.llm];
    if (p.stt) platform.stt = [p.stt.name];
    if (p.tts) platform.tts = [p.tts.name];
    platform.telephony = p.telephony.map((t) => t.name);
    platform.messaging = p.whatsapp.map((w) => `${w.name}_whatsapp`.replace("meta_whatsapp", "meta_whatsapp"));
    if (p.email) platform.email = ["resend"];
    return { connections: rows.map((r) => toConnection(r, auth.role === ADMIN_ROLE, deps.publicUrl)), platform, canStoreKeys: deps.secret !== null };
  });

  // ---- Connections ----

  app.post("/providers/connections", async (req, reply): Promise<ProviderConnectionInfo> => {
    const auth = admin(req);
    const secret = needSecret();
    const body = createConnectionSchema.parse(req.body);
    const meta = providerMeta(body.providerType, body.providerId);
    if (!meta) throw httpError(400, `Unknown ${body.providerType} provider "${body.providerId}"`);
    if (meta.status !== "supported" || !registryEntry(body.providerType, body.providerId)) throw httpError(400, `${meta.name} is coming soon and cannot be connected yet`);
    const credentials = nonEmpty(body.credentials);
    fieldIssues(checkFields(meta, credentials, body.configuration));
    await assertPublicFields(body.providerType, body.providerId, body.configuration);
    try {
      const row = await prisma.providerConnection.create({
        data: {
          organizationId: auth.organizationId,
          providerType: body.providerType,
          providerId: body.providerId,
          displayName: body.displayName,
          encryptedCredentials: sealCredentials(credentials, secret),
          credentialHints: hintsOf(credentials),
          configuration: body.configuration as Prisma.InputJsonValue,
          createdBy: auth.userId,
        },
      });
      await audit(auth.organizationId, auth.userId, row, "create", { displayName: row.displayName });
      reply.code(201);
      return toConnection(row, true, deps.publicUrl);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw httpError(409, `A connection named "${body.displayName}" already exists`);
      throw err;
    }
  });

  app.patch("/providers/connections/:id", async (req): Promise<ProviderConnectionInfo> => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const body = updateConnectionSchema.parse(req.body);
    const row = await owned(auth.organizationId, id);
    const meta = providerMeta(row.providerType, row.providerId);
    if (body.configuration) {
      if (meta) fieldIssues(checkFields(meta, null, body.configuration));
      await assertPublicFields(row.providerType as ProviderType, row.providerId, body.configuration);
    }
    try {
      const updated = await prisma.providerConnection.update({
        where: { id },
        data: { displayName: body.displayName, ...(body.configuration && { configuration: body.configuration as Prisma.InputJsonValue }) },
      });
      await audit(auth.organizationId, auth.userId, row, "update", { fields: Object.keys(body) });
      return toConnection(updated, true, deps.publicUrl);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw httpError(409, `A connection named "${body.displayName}" already exists`);
      throw err;
    }
  });

  // New secrets for every field. The old ones are gone once this returns.
  app.post("/providers/connections/:id/rotate", async (req): Promise<ProviderConnectionInfo> => {
    const auth = admin(req);
    const secret = needSecret();
    const { id } = idParams.parse(req.params);
    const body = rotateCredentialsSchema.parse(req.body);
    const row = await owned(auth.organizationId, id);
    const meta = providerMeta(row.providerType, row.providerId);
    const credentials = nonEmpty(body.credentials);
    if (meta) fieldIssues(checkFields(meta, credentials, row.configuration as Record<string, unknown>).filter((i) => i.path.startsWith("credentials.")));
    const updated = await prisma.providerConnection.update({
      where: { id },
      data: {
        encryptedCredentials: sealCredentials(credentials, secret),
        credentialHints: hintsOf(credentials),
        rotatedAt: new Date(),
        lastTestedAt: null,
        lastTestStatus: null,
        lastTestError: null,
      },
    });
    await audit(auth.organizationId, auth.userId, row, "rotate", { fields: Object.keys(credentials) });
    return toConnection(updated, true, deps.publicUrl);
  });

  // shortcut: in-process limits and deduplication; with several API processes each keeps its own (a shared store when that matters)
  const testWindow = new Map<string, number[]>();
  const testing = new Map<string, Promise<TestConnectionResult>>();
  app.post("/providers/connections/:id/test", async (req): Promise<TestConnectionResult> => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const row = await owned(auth.organizationId, id);
    // A second press while a test runs gets the same answer, not a second call to the provider.
    const running = testing.get(id);
    if (running) return running;
    const now = Date.now();
    const recent = (testWindow.get(auth.organizationId) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= TESTS_PER_MINUTE) throw httpError(429, `At most ${TESTS_PER_MINUTE} connection tests a minute; try again shortly`);
    testWindow.set(auth.organizationId, [...recent, now]);
    const run = (async () => {
      const result = await testConnection(row.providerType as ProviderType, row.providerId, deps.service.conn(row));
      await prisma.providerConnection.update({
        where: { id },
        data: { lastTestedAt: new Date(result.testedAt), lastTestStatus: result.ok ? "ok" : "failed", lastTestError: result.error },
      });
      await audit(auth.organizationId, auth.userId, row, "test", { ok: result.ok, auth: result.auth, config: result.config, latencyMs: result.latencyMs });
      return result;
    })();
    testing.set(id, run);
    try {
      return await run;
    } finally {
      testing.delete(id);
    }
  });

  app.post("/providers/connections/:id/default", async (req): Promise<ProviderConnectionInfo> => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const row = await owned(auth.organizationId, id);
    if (row.status !== "active") throw httpError(409, "Enable the connection before making it the default");
    const [, updated] = await prisma.$transaction([
      prisma.providerConnection.updateMany({ where: { organizationId: auth.organizationId, providerType: row.providerType, isDefault: true }, data: { isDefault: false } }),
      prisma.providerConnection.update({ where: { id }, data: { isDefault: true } }),
    ]);
    await audit(auth.organizationId, auth.userId, row, "set_default");
    return toConnection(updated, true, deps.publicUrl);
  });

  // Disabled connections are skipped everywhere (overrides fall through to the next level) until enabled again.
  app.post("/providers/connections/:id/status", async (req): Promise<ProviderConnectionInfo> => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const { status } = statusBody.parse(req.body);
    const row = await owned(auth.organizationId, id);
    const updated = await prisma.providerConnection.update({ where: { id }, data: { status, ...(status === "disabled" && { isDefault: false }) } });
    await audit(auth.organizationId, auth.userId, row, status === "disabled" ? "disable" : "enable");
    return toConnection(updated, true, deps.publicUrl);
  });

  app.delete("/providers/connections/:id", async (req, reply) => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const row = await owned(auth.organizationId, id);
    const uses = await usesOf(auth.organizationId, row);
    if (uses.length > 0) throw httpError(409, `In use by ${uses.slice(0, 5).join(", ")}${uses.length > 5 ? ` and ${uses.length - 5} more` : ""}. Change those first.`);
    await prisma.providerConnection.delete({ where: { id } });
    await audit(auth.organizationId, auth.userId, row, "delete", { displayName: row.displayName });
    return reply.code(204).send();
  });

  // ---- Audit and metrics ----

  app.get("/providers/audit", async (req): Promise<ProviderAuditEntry[]> => {
    const auth = admin(req);
    const rows = await prisma.providerAuditLog.findMany({ where: { organizationId: auth.organizationId }, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((r) => ({ ...r, detail: r.detail as Record<string, unknown>, createdAt: r.createdAt.toISOString() }));
  });

  app.get("/providers/metrics", async (req): Promise<{ days: number; providers: ProviderMetric[] }> => {
    const { organizationId } = member(req);
    const { days } = daysQuery.parse(req.query);
    const since = new Date(Date.now() - days * 86_400_000);
    // One pass over the period: a fallback is any attempt after the first of its request.
    const providers = await prisma.$queryRaw<ProviderMetric[]>`
      SELECT "providerType", "provider",
        count(*)::int AS "requests",
        (count(*) FILTER (WHERE NOT "success"))::int AS "failures",
        (count(*) FILTER (WHERE "errorKind" = 'timeout'))::int AS "timeouts",
        (count(*) FILTER (WHERE "attempt" > 1))::int AS "fallbacks",
        round(coalesce(avg("latencyMs"), 0))::int AS "avgLatencyMs",
        coalesce(sum("costUsd"), 0)::float8 AS "costUsd",
        coalesce(sum("characters"), 0)::int AS "characters",
        coalesce(sum("seconds"), 0)::float8 AS "seconds"
      FROM "AiUsage"
      WHERE "organizationId" = ${organizationId} AND "createdAt" >= ${since}
      GROUP BY "providerType", "provider"
      ORDER BY "requests" DESC`;
    return { days, providers };
  });

  // ---- Overrides ----

  app.get("/workspaces/:workspaceId/employees/:id/providers", async (req): Promise<ProviderOverrides> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const row = await prisma.aiEmployee.findFirst({ where: { id, ...within(scope) }, select: { providerOverrides: true } });
    if (!row) throw httpError(404, "Employee not found");
    return row.providerOverrides as ProviderOverrides;
  });

  app.put("/workspaces/:workspaceId/employees/:id/providers", async (req): Promise<ProviderOverrides> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const body = providerOverridesSchema.parse(req.body);
    await assertOverrides(scope.organizationId, body);
    const { count } = await prisma.aiEmployee.updateMany({ where: { id, ...within(scope) }, data: { providerOverrides: body as Prisma.InputJsonValue } });
    if (count === 0) throw httpError(404, "Employee not found");
    return body;
  });

  app.get("/workspaces/:workspaceId/workflows/:id/providers", async (req): Promise<ProviderOverrides> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const row = await prisma.workflow.findFirst({ where: { id, ...within(scope), deletedAt: null }, select: { providerOverrides: true } });
    if (!row) throw httpError(404, "Workflow not found");
    return row.providerOverrides as ProviderOverrides;
  });

  app.put("/workspaces/:workspaceId/workflows/:id/providers", async (req): Promise<ProviderOverrides> => {
    const { workspaceId, id } = workflowParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const body = providerOverridesSchema.parse(req.body);
    await assertOverrides(scope.organizationId, body);
    const { count } = await prisma.workflow.updateMany({ where: { id, ...within(scope), deletedAt: null }, data: { providerOverrides: body as Prisma.InputJsonValue } });
    if (count === 0) throw httpError(404, "Workflow not found");
    return body;
  });
}
