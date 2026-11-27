// Phase 17: what the dashboard manages for the public API: API keys (create, edit, rotate, revoke) and webhook endpoints
// (create, edit, rotate the signing secret, send a test event) with their delivery log; every change is in the developer
// audit log. Signed-in organization members read keys and endpoints, admins write and read the audit log; everything is
// the session's organization.
import { prisma, type Prisma } from "@workforce/database";
import { sealCredentials } from "@workforce/providers";
import {
  createApiKeySchema,
  deliveriesQuerySchema,
  rotateApiKeySchema,
  rotateWebhookSecretSchema,
  updateApiKeySchema,
  updateWebhookEndpointSchema,
  webhookEndpointSchema,
  type ApiKeyInfo,
  type CreatedApiKey,
  type CreatedWebhookEndpoint,
  type DeveloperAuditEntry,
  type WebhookAttempt,
  type WebhookDeliveryPage,
  type WebhookDeliveryRecord,
  type WebhookEndpointInfo,
  type WebhookEventType,
} from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertPublicBaseUrl } from "../ai.ts";
import { guards, httpError, type Authenticate, type Member } from "../auth.ts";
import { decodeCursor, keysetAfter, keysetPage, pagingContext } from "../cursor.ts";
import { keyInclude, newKey, statusOf, toApiKeyInfo } from "./keys.ts";
import { newWebhookSecret, type WebhookService } from "./webhooks.ts";

const idParams = z.object({ id: z.string().min(1) });
const WEEK_MS = 7 * 86_400_000;

const endpointInclude = { workspace: { select: { name: true } } } satisfies Prisma.WebhookEndpointInclude;
type EndpointRow = Prisma.WebhookEndpointGetPayload<{ include: typeof endpointInclude }>;

const toDelivery = (d: Prisma.WebhookDeliveryGetPayload<object>): WebhookDeliveryRecord => ({
  id: d.id,
  endpointId: d.endpointId,
  eventId: d.eventId,
  event: d.event as WebhookEventType,
  status: d.status as WebhookDeliveryRecord["status"],
  attempts: d.attempts,
  nextAttemptAt: d.status === "pending" ? (d.nextAttemptAt?.toISOString() ?? null) : null,
  deliveredAt: d.deliveredAt?.toISOString() ?? null,
  createdAt: d.createdAt.toISOString(),
  log: d.log as WebhookAttempt[],
  payload: d.payload,
});

export function developerRoutes(app: FastifyInstance, authenticate: Authenticate, deps: { secret: string | null; webhooks: Pick<WebhookService, "sendTest"> }) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const { secret } = deps;

  /** One audit row; details name things, never secrets. */
  const audit = (auth: Member, action: string, targetId: string, detail: Prisma.InputJsonObject = {}) =>
    prisma.developerAuditLog.create({ data: { organizationId: auth.organizationId, actorId: auth.userId, action, targetId, detail } });

  const findKey = async (auth: Member, id: string) => {
    const key = await prisma.apiKey.findFirst({ where: { id, organizationId: auth.organizationId }, include: keyInclude });
    if (!key) throw httpError(404, "API key not found");
    return key;
  };

  app.get("/developer/api-keys", async (req): Promise<ApiKeyInfo[]> => {
    const { organizationId } = member(req);
    // shortcut: newest 200 keys, revoked ones included; page when organizations keep more
    const keys = await prisma.apiKey.findMany({ where: { organizationId }, include: keyInclude, orderBy: { createdAt: "desc" }, take: 200 });
    return keys.map(toApiKeyInfo);
  });

  app.post("/developer/api-keys", async (req, reply): Promise<CreatedApiKey> => {
    const auth = admin(req);
    const body = createApiKeySchema.parse(req.body);
    const { workspaceId } = await inWorkspace(auth, body.workspaceId);
    const { prefix, hash, secret: plain } = newKey();
    const key = await prisma.apiKey.create({
      data: {
        organizationId: auth.organizationId,
        workspaceId,
        name: body.name,
        scopes: [...new Set(body.scopes)],
        prefix,
        hash,
        createdBy: auth.userId,
        rateLimitPerMinute: body.rateLimitPerMinute,
        allowedIps: body.allowedIps,
        ...(body.expiresInDays && { expiresAt: new Date(Date.now() + body.expiresInDays * 86_400_000) }),
      },
      include: keyInclude,
    });
    await audit(auth, "api_key.create", key.id, { name: key.name, workspaceId, scopes: key.scopes, allowedIps: key.allowedIps, expiresAt: key.expiresAt?.toISOString() ?? null });
    reply.code(201);
    return { key: toApiKeyInfo(key), secret: plain };
  });

  app.patch("/developer/api-keys/:id", async (req): Promise<ApiKeyInfo> => {
    const auth = admin(req);
    const key = await findKey(auth, idParams.parse(req.params).id);
    const body = updateApiKeySchema.parse(req.body);
    if (statusOf(key) === "revoked") throw httpError(409, "Revoked keys cannot be changed");
    const updated = await prisma.apiKey.update({ where: { id: key.id }, data: body, include: keyInclude });
    await audit(auth, "api_key.update", key.id, body);
    return toApiKeyInfo(updated);
  });

  // A new key with the same name, workspace, scopes and settings; the old one keeps working for the grace period, then stops.
  app.post("/developer/api-keys/:id/rotate", async (req, reply): Promise<CreatedApiKey> => {
    const auth = admin(req);
    const old = await findKey(auth, idParams.parse(req.params).id);
    const { expireOldInHours } = rotateApiKeySchema.parse(req.body ?? {});
    if (old.replacedById || old.revokedAt || (old.expiresAt && old.expiresAt <= new Date())) throw httpError(409, "Only active keys can be rotated");
    const { prefix, hash, secret: plain } = newKey();
    const now = Date.now();
    const key = await prisma.$transaction(async (tx) => {
      const created = await tx.apiKey.create({
        data: {
          organizationId: old.organizationId,
          workspaceId: old.workspaceId,
          name: old.name,
          scopes: old.scopes,
          prefix,
          hash,
          createdBy: auth.userId,
          rateLimitPerMinute: old.rateLimitPerMinute,
          allowedIps: old.allowedIps,
        },
        include: keyInclude,
      });
      // Conditional on still being current, so two rotations at once cannot both replace it.
      const graceEnds = new Date(now + expireOldInHours * 3_600_000);
      const { count } = await tx.apiKey.updateMany({
        where: { id: old.id, revokedAt: null, replacedById: null },
        data: {
          replacedById: created.id,
          ...(expireOldInHours === 0
            ? { revokedAt: new Date(now), revokedBy: auth.userId }
            : // A key that expires anyway keeps its earlier end.
              { expiresAt: old.expiresAt && old.expiresAt < graceEnds ? old.expiresAt : graceEnds }),
        },
      });
      if (count === 0) throw httpError(409, "This key was rotated or revoked meanwhile");
      return created;
    });
    await audit(auth, "api_key.rotate", old.id, { newKeyId: key.id, expireOldInHours });
    reply.code(201);
    return { key: toApiKeyInfo(key), secret: plain };
  });

  app.delete("/developer/api-keys/:id", async (req): Promise<ApiKeyInfo> => {
    const auth = admin(req);
    const key = await findKey(auth, idParams.parse(req.params).id);
    if (key.revokedAt) return toApiKeyInfo(key);
    const revoked = await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date(), revokedBy: auth.userId }, include: keyInclude });
    await audit(auth, "api_key.revoke", key.id, { name: key.name });
    return toApiKeyInfo(revoked);
  });

  // ---- Webhooks ----

  const endpointInfo = async (endpoints: EndpointRow[]): Promise<WebhookEndpointInfo[]> => {
    const counts = await prisma.webhookDelivery.groupBy({
      by: ["endpointId", "status"],
      where: { endpointId: { in: endpoints.map((e) => e.id) }, status: { in: ["pending", "failed"] }, createdAt: { gte: new Date(Date.now() - WEEK_MS) } },
      _count: { _all: true },
    });
    const count = (id: string, status: string) => counts.find((c) => c.endpointId === id && c.status === status)?._count._all ?? 0;
    const now = new Date();
    return endpoints.map((e) => ({
      id: e.id,
      url: e.url,
      description: e.description,
      workspaceId: e.workspaceId,
      workspaceName: e.workspace.name,
      events: e.events as WebhookEventType[],
      enabled: e.enabled,
      createdAt: e.createdAt.toISOString(),
      pending: count(e.id, "pending"),
      failed: count(e.id, "failed"),
      previousSecretUntil: e.previousEncryptedSecret && e.previousSecretExpiresAt && e.previousSecretExpiresAt > now ? e.previousSecretExpiresAt.toISOString() : null,
    }));
  };

  const findEndpoint = async (auth: Member, id: string) => {
    const endpoint = await prisma.webhookEndpoint.findFirst({ where: { id, organizationId: auth.organizationId }, include: endpointInclude });
    if (!endpoint) throw httpError(404, "Webhook endpoint not found");
    return endpoint;
  };

  const needSecret = () => {
    if (!secret) throw httpError(503, "AI_CREDENTIALS_KEY is not set on the server (32+ random characters), so webhook secrets cannot be stored");
    return secret;
  };

  /** The server sends to this address, so it must be public (checked again on every send, by safeFetch). */
  const checkUrl = async (url: string) => {
    try {
      await assertPublicBaseUrl(url);
    } catch (err) {
      throw Object.assign(err as Error, { issues: [{ path: "url", message: (err as Error).message }] });
    }
  };

  app.get("/developer/webhooks", async (req): Promise<WebhookEndpointInfo[]> => {
    const { organizationId } = member(req);
    return endpointInfo(await prisma.webhookEndpoint.findMany({ where: { organizationId }, include: endpointInclude, orderBy: { createdAt: "asc" } }));
  });

  app.post("/developer/webhooks", async (req, reply): Promise<CreatedWebhookEndpoint> => {
    const auth = admin(req);
    const body = webhookEndpointSchema.parse(req.body);
    const { workspaceId } = await inWorkspace(auth, body.workspaceId);
    const key = needSecret();
    await checkUrl(body.url);
    const plain = newWebhookSecret();
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        organizationId: auth.organizationId,
        workspaceId,
        url: body.url,
        description: body.description,
        events: [...new Set(body.events)],
        encryptedSecret: sealCredentials({ secret: plain }, key),
        createdBy: auth.userId,
      },
      include: endpointInclude,
    });
    await audit(auth, "webhook.create", endpoint.id, { url: endpoint.url, workspaceId, events: endpoint.events });
    reply.code(201);
    return { endpoint: (await endpointInfo([endpoint]))[0]!, secret: plain };
  });

  app.patch("/developer/webhooks/:id", async (req): Promise<WebhookEndpointInfo> => {
    const auth = admin(req);
    const endpoint = await findEndpoint(auth, idParams.parse(req.params).id);
    const body = updateWebhookEndpointSchema.parse(req.body);
    if (body.url) await checkUrl(body.url);
    const updated = await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: { ...body, ...(body.events && { events: [...new Set(body.events)] }) },
      include: endpointInclude,
    });
    await audit(auth, "webhook.update", endpoint.id, body);
    return (await endpointInfo([updated]))[0]!;
  });

  // A new signing secret, shown once. The old one keeps signing next to it (two signatures per request) for the grace period.
  app.post("/developer/webhooks/:id/rotate-secret", async (req): Promise<CreatedWebhookEndpoint> => {
    const auth = admin(req);
    const endpoint = await findEndpoint(auth, idParams.parse(req.params).id);
    const { keepOldForHours } = rotateWebhookSecretSchema.parse(req.body ?? {});
    const plain = newWebhookSecret();
    const updated = await prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        encryptedSecret: sealCredentials({ secret: plain }, needSecret()),
        previousEncryptedSecret: keepOldForHours > 0 ? endpoint.encryptedSecret : null,
        previousSecretExpiresAt: keepOldForHours > 0 ? new Date(Date.now() + keepOldForHours * 3_600_000) : null,
      },
      include: endpointInclude,
    });
    await audit(auth, "webhook.rotate_secret", endpoint.id, { keepOldForHours });
    return { endpoint: (await endpointInfo([updated]))[0]!, secret: plain };
  });

  // Sends a webhook.test event now and answers with the delivery and its first attempt.
  app.post("/developer/webhooks/:id/test", async (req): Promise<WebhookDeliveryRecord> => {
    const auth = admin(req);
    const endpoint = await findEndpoint(auth, idParams.parse(req.params).id);
    needSecret();
    const id = await deps.webhooks.sendTest(endpoint);
    await audit(auth, "webhook.test", endpoint.id);
    return toDelivery(await prisma.webhookDelivery.findUniqueOrThrow({ where: { id } }));
  });

  app.delete("/developer/webhooks/:id", async (req, reply) => {
    const auth = admin(req);
    const endpoint = await findEndpoint(auth, idParams.parse(req.params).id);
    await prisma.webhookEndpoint.delete({ where: { id: endpoint.id } }); // its deliveries and log go with it
    await audit(auth, "webhook.delete", endpoint.id, { url: endpoint.url });
    return reply.code(204).send();
  });

  app.get("/developer/webhooks/:id/deliveries", async (req): Promise<WebhookDeliveryPage> => {
    const auth = member(req);
    const endpoint = await findEndpoint(auth, idParams.parse(req.params).id);
    const { status, event, limit, cursor } = deliveriesQuerySchema.parse(req.query);
    // A log: cursor pages over the (endpointId, createdAt) index and no count, so a page costs the same at any depth.
    const context = pagingContext(endpoint.id, status, event);
    const rows = await prisma.webhookDelivery.findMany({
      where: { endpointId: endpoint.id, ...(status && { status }), ...(event && { event }), ...keysetAfter("createdAt", decodeCursor(cursor, context, "date")) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const { page, nextCursor } = keysetPage(rows, limit, (r) => r.createdAt, context);
    return { data: page.map(toDelivery), nextCursor };
  });

  // Sends a delivery again (a failed one, or a succeeded one the receiver lost), with a fresh set of attempts. Same event id.
  app.post("/developer/webhook-deliveries/:id/redeliver", async (req): Promise<WebhookDeliveryRecord> => {
    const auth = admin(req);
    const { id } = idParams.parse(req.params);
    const { count } = await prisma.webhookDelivery.updateMany({
      where: { id, organizationId: auth.organizationId, status: { not: "pending" } },
      data: { status: "pending", attempts: 0, nextAttemptAt: new Date(), lockedUntil: null, deliveredAt: null },
    });
    const delivery = await prisma.webhookDelivery.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!delivery) throw httpError(404, "Delivery not found");
    if (count === 0) throw httpError(409, "This delivery is already waiting to be sent");
    await audit(auth, "webhook.redeliver", delivery.endpointId, { deliveryId: id, eventId: delivery.eventId });
    return toDelivery(delivery);
  });

  app.get("/developer/audit", async (req): Promise<DeveloperAuditEntry[]> => {
    const { organizationId } = admin(req);
    // shortcut: newest 100 entries; page when people need older ones
    const rows = await prisma.developerAuditLog.findMany({ where: { organizationId }, orderBy: { createdAt: "desc" }, take: 100 });
    return rows.map((r) => ({ id: r.id, actorId: r.actorId, action: r.action, targetId: r.targetId, detail: r.detail as Record<string, unknown>, createdAt: r.createdAt.toISOString() }));
  });
}
