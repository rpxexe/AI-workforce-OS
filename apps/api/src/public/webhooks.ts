// Phase 17: outgoing webhooks.
//
//   scan     events are derived from rows that already record each fact (like the usage meter): conversations, messages,
//            workflow runs, handoffs, calls, releases and customer memory, in workspaces with an enabled endpoint
//            subscribed to the event. Each endpoint has a cursor (`scannedAt`): a scan reads from the cursor minus an
//            overlap (rows committed late), at most 7 days back, so an API that was down catches up. Each event becomes
//            one WebhookDelivery per endpoint with id "<event>:<source id>[:<time>]", unique per endpoint, so scanning
//            again (any process, any number of times) never queues an event twice.
//   deliver  due deliveries are claimed (lockedUntil, SKIP LOCKED), signed (Standard Webhooks: HMAC-SHA256 of
//            "<webhook-id>.<webhook-timestamp>.<body>"; during a secret rotation with both secrets), POSTed through
//            safeFetch (public https, no redirects) with a 10 s timeout; any 2xx succeeds, anything else is retried on
//            BACKOFF, then marked failed. Every attempt is logged on the row. `webhook-id` is the event id on every attempt.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { Prisma, prisma } from "@workforce/database";
import { openCredentials } from "@workforce/providers";
import { EVALUATION_CHANNEL, WEBHOOK_EVENT_DATA, WEBHOOK_TEST_EVENT, type WebhookAttempt, type WebhookEventType } from "@workforce/shared";
import type { FastifyBaseLogger } from "fastify";
import { conversationInclude, executionInclude, toCall, toConversation, toCustomer, toExecution, toHandoff, toMessage } from "./serialize.ts";

/** Seconds to wait after attempt n (1-based) failed; one more attempt than entries, about 3 days in all. */
const BACKOFF_S = [60, 5 * 60, 30 * 60, 2 * 3600, 5 * 3600, 10 * 3600, 24 * 3600];
export const MAX_ATTEMPTS = BACKOFF_S.length + 1;
const TIMEOUT_MS = 10_000;
/** Each scan reads again this far behind an endpoint's cursor, for rows whose transaction committed after their timestamp. */
const OVERLAP = Prisma.sql`interval '10 minutes'`;
/** Events older than this are not sent to an endpoint that was off (or an API that was down) for longer. */
const MAX_CATCH_UP = Prisma.sql`interval '7 days'`;
const SCAN_LIMIT = 500;
const LOG_KEEP = 20;

/**
 * Without an organization (the server's timer): every organization except the test suite's throwaway ones (testing.ts
 * `newOrg`; a Clerk id never has a second underscore). Tests share the development database and deliver their own, so a
 * running dev server must not claim them.
 */
const orgFilter = (column: Prisma.Sql, organizationId: string | null) =>
  organizationId ? Prisma.sql`AND ${column} = ${organizationId}` : Prisma.sql`AND NOT starts_with(${column}, 'org_test_')`;

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString("base64")}`;

/** The `webhook-signature` header value (Standard Webhooks, v1) for one secret. */
export const signWebhook = (secret: string, id: string, timestamp: number, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(secret.replace(/^whsec_/, ""), "base64")).update(`${id}.${timestamp}.${body}`).digest("base64")}`;

type Found = { endpointId: string; type: WebhookEventType; sourceId: string; key: string; org: string; ws: string; at: Date };

export function webhookService(deps: {
  secret: string | null;
  previousSecret?: string | null;
  /** safeFetch on the server; tests pass a fake. */
  fetch: typeof fetch;
  log: FastifyBaseLogger;
}) {
  const openSecret = (sealed: string) => {
    if (!deps.secret) throw new Error("AI_CREDENTIALS_KEY is not set, so webhook secrets cannot be opened");
    return openCredentials(sealed, { current: deps.secret, previous: deps.previousSecret }).credentials.secret!;
  };

  /** Finds new events and queues them per endpoint; `organizationId` limits it to one organization (tests). Returns the deliveries added. */
  async function scan(organizationId: string | null = null) {
    const started = new Date();
    const org = orgFilter(Prisma.sql`"organizationId"`, organizationId);
    const rows = await prisma.$queryRaw<Found[]>`
      WITH e AS (
        SELECT id, "organizationId", "workspaceId", events,
               greatest("createdAt", coalesce("scannedAt" - ${OVERLAP}, "createdAt"), ${started}::timestamp - ${MAX_CATCH_UP}) AS since
        FROM "WebhookEndpoint" WHERE enabled ${org}),
      ws AS (SELECT "organizationId", "workspaceId", min(since) AS since FROM e GROUP BY 1, 2),
      ev AS (
        SELECT 'conversation.started' AS type, c.id AS "sourceId", 'conversation.started:' || c.id AS key, c."organizationId" AS org, c."workspaceId" AS ws, c."createdAt" AS at
        FROM "Conversation" c JOIN ws USING ("organizationId", "workspaceId")
        WHERE c.channel <> ${EVALUATION_CHANNEL} AND c."createdAt" >= ws.since
        UNION ALL
        SELECT 'conversation.completed', c.id, 'conversation.completed:' || c.id || ':' || floor(extract(epoch FROM c."resolvedAt") * 1000)::text,
               c."organizationId", c."workspaceId", c."resolvedAt"
        FROM "Conversation" c JOIN ws USING ("organizationId", "workspaceId")
        WHERE c.channel <> ${EVALUATION_CHANNEL} AND c.status = 'RESOLVED' AND c."resolvedAt" >= ws.since
        UNION ALL
        SELECT t.type, m.id, t.type || ':' || m.id, c."organizationId", c."workspaceId", m."createdAt"
        FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
        JOIN ws ON ws."organizationId" = c."organizationId" AND ws."workspaceId" = c."workspaceId"
        CROSS JOIN LATERAL (SELECT CASE WHEN m.role = 'USER' THEN 'message.received' ELSE 'message.sent' END AS type) t
        WHERE c.channel <> ${EVALUATION_CHANNEL} AND m."createdAt" >= ws.since
        UNION ALL
        SELECT 'workflow.started', x.id, 'workflow.started:' || x.id, x."organizationId", x."workspaceId", x."createdAt"
        FROM "WorkflowExecution" x JOIN ws USING ("organizationId", "workspaceId")
        WHERE x."createdAt" >= ws.since
        UNION ALL
        -- A retried run can finish again: its new finishing time makes it a new event.
        SELECT t.type, x.id, t.type || ':' || x.id || ':' || floor(extract(epoch FROM x."finishedAt") * 1000)::text, x."organizationId", x."workspaceId", x."finishedAt"
        FROM "WorkflowExecution" x JOIN ws USING ("organizationId", "workspaceId")
        CROSS JOIN LATERAL (SELECT CASE WHEN x.status = 'COMPLETED' THEN 'workflow.completed' ELSE 'workflow.failed' END AS type) t
        WHERE x.status IN ('COMPLETED', 'FAILED') AND x."finishedAt" >= ws.since
        UNION ALL
        SELECT 'human.handoff', h.id, 'human.handoff:' || h.id, h."organizationId", h."workspaceId", h."requestedAt"
        FROM "Handoff" h JOIN ws USING ("organizationId", "workspaceId") JOIN "Conversation" c ON c.id = h."conversationId"
        WHERE c.channel <> ${EVALUATION_CHANNEL} AND h."requestedAt" >= ws.since
        UNION ALL
        SELECT 'call.completed', c.id, 'call.completed:' || c.id, c."organizationId", c."workspaceId", c."endedAt"
        FROM "Call" c JOIN ws USING ("organizationId", "workspaceId")
        WHERE c.status IN ('COMPLETED', 'BUSY', 'NO_ANSWER', 'FAILED', 'CANCELED') AND c."endedAt" >= ws.since
        UNION ALL
        SELECT 'employee.published', r.id, 'employee.published:' || r.id, r."organizationId", r."workspaceId", r."createdAt"
        FROM "EmployeeRelease" r JOIN ws USING ("organizationId", "workspaceId")
        WHERE r."createdAt" >= ws.since
        UNION ALL
        -- One event per customer for the changes a scan finds (memory and profile rows); later changes are a new event.
        SELECT 'customer.updated', u."customerId", 'customer.updated:' || u."customerId" || ':' || floor(extract(epoch FROM max(u.at)) * 1000)::text,
               cu."organizationId", cu."workspaceId", max(u.at)
        FROM (SELECT "customerId", "updatedAt" AS at FROM "CustomerMemory" WHERE "updatedAt" >= (SELECT min(since) FROM ws)
              UNION ALL SELECT "customerId", "updatedAt" FROM "CustomerProfile" WHERE "updatedAt" >= (SELECT min(since) FROM ws)) u
        JOIN "Customer" cu ON cu.id = u."customerId" JOIN ws ON ws."organizationId" = cu."organizationId" AND ws."workspaceId" = cu."workspaceId"
        WHERE u.at >= ws.since
        GROUP BY u."customerId", cu."organizationId", cu."workspaceId"
      )
      SELECT e.id AS "endpointId", ev.*
      FROM ev JOIN e ON e."organizationId" = ev.org AND e."workspaceId" = ev.ws AND ev.type = ANY (e.events) AND ev.at >= e.since
      WHERE NOT EXISTS (SELECT 1 FROM "WebhookDelivery" d WHERE d."endpointId" = e.id AND d."eventId" = ev.key)
      ORDER BY ev.at, ev.key
      LIMIT ${SCAN_LIMIT}`;

    let count = 0;
    if (rows.length > 0) {
      const ids = (types: WebhookEventType[]) => [...new Set(rows.filter((r) => types.includes(r.type)).map((r) => r.sourceId))];
      const [conversations, messages, executions, handoffs, calls, releases, customers] = await Promise.all([
        prisma.conversation.findMany({ where: { id: { in: ids(["conversation.started", "conversation.completed"]) } }, include: conversationInclude }),
        prisma.conversationMessage.findMany({ where: { id: { in: ids(["message.received", "message.sent"]) } } }),
        prisma.workflowExecution.findMany({ where: { id: { in: ids(["workflow.started", "workflow.completed", "workflow.failed"]) } }, include: executionInclude }),
        prisma.handoff.findMany({ where: { id: { in: ids(["human.handoff"]) } } }),
        prisma.call.findMany({ where: { id: { in: ids(["call.completed"]) } } }),
        prisma.employeeRelease.findMany({ where: { id: { in: ids(["employee.published"]) } } }),
        prisma.customer.findMany({ where: { id: { in: ids(["customer.updated"]) } }, include: { profile: true } }),
      ]);
      const data = new Map<string, unknown>([
        ...conversations.map((c) => [c.id, toConversation(c)] as const),
        ...messages.map((m) => [m.id, toMessage(m)] as const),
        ...executions.map((x) => [x.id, toExecution(x)] as const),
        ...handoffs.map((h) => [h.id, toHandoff(h)] as const),
        ...calls.map((c) => [c.id, toCall(c)] as const),
        ...releases.map(
          (r) =>
            [r.id, { employeeId: r.employeeId, version: r.version, previousVersion: r.previousVersion, action: r.action, releasedAt: r.createdAt.toISOString() }] as const,
        ),
        ...customers.map((c) => [c.id, toCustomer(c)] as const),
      ]);
      const deliveries = rows.flatMap((r) => {
        const object = data.get(r.sourceId);
        if (!object) return []; // deleted since
        // A workflow.started of a run that already finished still says what it was when it started.
        const shaped = r.type === "workflow.started" ? { ...(object as object), status: "queued", error: null, finishedAt: null } : object;
        const payload = { id: r.key, type: r.type, createdAt: r.at.toISOString(), workspaceId: r.ws, data: WEBHOOK_EVENT_DATA[r.type].parse(shaped) };
        // nextAttemptAt from this process's clock, the clock deliverDue compares with.
        return [{ organizationId: r.org, workspaceId: r.ws, endpointId: r.endpointId, eventId: r.key, event: r.type, payload: payload as Prisma.InputJsonValue, nextAttemptAt: started }];
      });
      count = (await prisma.webhookDelivery.createMany({ data: deliveries, skipDuplicates: true })).count;
    }
    // The cursor moves only after a scan that found everything; a full page leaves it for the next scan to continue.
    if (rows.length < SCAN_LIMIT)
      await prisma.webhookEndpoint.updateMany({
        where: { enabled: true, ...(organizationId ? { organizationId } : { NOT: { organizationId: { startsWith: "org_test_" } } }) },
        data: { scannedAt: started },
      });
    return count;
  }

  /** The signature header: the current secret, and the previous one while its rotation grace period runs. */
  const signatures = (endpoint: { encryptedSecret: string; previousEncryptedSecret: string | null; previousSecretExpiresAt: Date | null }, id: string, timestamp: number, body: string) => {
    const secrets = [endpoint.encryptedSecret];
    if (endpoint.previousEncryptedSecret && endpoint.previousSecretExpiresAt && endpoint.previousSecretExpiresAt > new Date()) secrets.push(endpoint.previousEncryptedSecret);
    return secrets.map((sealed) => signWebhook(openSecret(sealed), id, timestamp, body)).join(" ");
  };

  /** One attempt at a claimed delivery. */
  async function attempt(id: string) {
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id }, include: { endpoint: true } });
    if (!delivery || delivery.status !== "pending") return;
    const body = JSON.stringify(delivery.payload);
    const timestamp = Math.floor(Date.now() / 1000);
    const started = Date.now();
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      const res = await deps.fetch(delivery.endpoint.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "AIWorkforce-Webhooks/1",
          "webhook-id": delivery.eventId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signatures(delivery.endpoint, delivery.eventId, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      statusCode = res.status;
      await res.body?.cancel().catch(() => {});
      if (!res.ok) error = res.status >= 300 && res.status < 400 ? `Redirect (${res.status}) not followed` : `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error && err.name === "TimeoutError" ? `No answer within ${TIMEOUT_MS / 1000} s` : err instanceof Error ? err.message : String(err);
    }
    const attempts = delivery.attempts + 1;
    const done = error === null || attempts >= MAX_ATTEMPTS;
    const entry: WebhookAttempt = { at: new Date(started).toISOString(), statusCode, error, durationMs: Date.now() - started };
    await prisma.webhookDelivery.update({
      where: { id },
      data: {
        attempts,
        status: error === null ? "succeeded" : done ? "failed" : "pending",
        deliveredAt: error === null ? new Date() : null,
        nextAttemptAt: done ? null : new Date(Date.now() + BACKOFF_S[attempts - 1]! * 1000),
        lockedUntil: null,
        log: [...(delivery.log as WebhookAttempt[]), entry].slice(-LOG_KEEP),
      },
    });
  }

  /** Claims due deliveries and attempts them, in parallel. Returns how many were attempted. */
  async function deliverDue(organizationId: string | null = null, limit = 25) {
    const now = new Date();
    const org = orgFilter(Prisma.sql`d."organizationId"`, organizationId);
    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "WebhookDelivery" SET "lockedUntil" = ${new Date(now.getTime() + 60_000)}
      WHERE id IN (
        SELECT d.id FROM "WebhookDelivery" d JOIN "WebhookEndpoint" w ON w.id = d."endpointId"
        WHERE d.status = 'pending' AND d."nextAttemptAt" <= ${now} AND w.enabled ${org}
          AND (d."lockedUntil" IS NULL OR d."lockedUntil" < ${now})
        ORDER BY d."nextAttemptAt" LIMIT ${limit}
        FOR UPDATE OF d SKIP LOCKED)
      RETURNING id`;
    await Promise.all(
      claimed.map(({ id }) => attempt(id).catch((err: unknown) => deps.log.error({ err, deliveryId: id }, "Webhook delivery failed unexpectedly"))),
    );
    return claimed.length;
  }

  /**
   * Sends a test event to one endpoint now, whatever it subscribes to (even when turned off), and returns the delivery
   * with its first attempt. A failure is retried like any delivery.
   */
  async function sendTest(endpoint: { id: string; organizationId: string; workspaceId: string }) {
    const eventId = `${WEBHOOK_TEST_EVENT}:${randomUUID()}`;
    const payload = {
      id: eventId,
      type: WEBHOOK_TEST_EVENT,
      createdAt: new Date().toISOString(),
      workspaceId: endpoint.workspaceId,
      data: { endpointId: endpoint.id, message: "A test event from AI Workforce. Answer with any 2xx." },
    };
    const delivery = await prisma.webhookDelivery.create({
      data: { organizationId: endpoint.organizationId, workspaceId: endpoint.workspaceId, endpointId: endpoint.id, eventId, event: WEBHOOK_TEST_EVENT, payload, lockedUntil: new Date(Date.now() + 60_000) },
    });
    await attempt(delivery.id);
    return delivery.id;
  }

  /** Rounds until nothing more is due, at most `rounds` (the Inngest schedule's drain). */
  async function tick(organizationId: string | null = null, rounds = 1) {
    await scan(organizationId);
    let sent = 0;
    for (let i = 0; i < rounds; i++) {
      const n = await deliverDue(organizationId);
      sent += n;
      if (n < 25) break;
    }
    return sent;
  }

  return { scan, deliverDue, sendTest, tick };
}
export type WebhookService = ReturnType<typeof webhookService>;
