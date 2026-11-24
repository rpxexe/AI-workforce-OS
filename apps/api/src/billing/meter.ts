// The usage meter: copies billable facts from the rows that record them into the usage ledger (UsageEvent).
//
//   AiUsage (LLM, STT, TTS, email, telephony attempts) -> provider        cost, and the amount billed
//   Conversation (not regression replays)              -> conversation
//   ConversationMessage, ASSISTANT                      -> message
//   Call with its duration, settled 10 minutes          -> voice_minutes   priced per minute on the platform's lines
//   ToolExecution that ran (succeeded or failed)        -> tool_call
//   WorkflowExecution                                   -> workflow_run
//
// Each ledger id is "<sourceType>:<sourceId>" and every insert is ON CONFLICT DO NOTHING, so metering the same
// rows again (a retry, the sweep after a limit check, two API processes) never counts anything twice. Rows are
// never updated: what was billed stays explained by the row it came from.
import { Prisma, prisma } from "@workforce/database";
import { EVALUATION_CHANNEL } from "@workforce/shared";

/** USD unit prices for the platform's own providers when they report no cost; null: unknown (not billed). */
export type UnitPrices = { sttPerMinute: number | null; ttsPer1kChars: number | null; callPerMinute: number | null; emailPerSend: number | null };
export type MeterConfig = { markup: number; prices: UnitPrices };

// A call's duration can still change right after it ends (the provider's billed length replaces our estimate).
const CALL_SETTLE_MS = 10 * 60_000;

/** Meters everything recorded since `since`, for one organization or (null) all of them. Returns the rows added. */
export async function meter(organizationId: string | null, since: Date, { markup, prices }: MeterConfig) {
  const org = (column: Prisma.Sql) => (organizationId ? Prisma.sql`AND ${column} = ${organizationId}` : Prisma.empty);
  const multiplier = 1 + markup;
  const columns = Prisma.sql`("id", "organizationId", "workspaceId", "kind", "quantity", "sourceType", "sourceId", "costUsd", "amountUsd", "detail", "occurredAt")`;
  const counts = await Promise.all([
    prisma.$executeRaw`
      INSERT INTO "UsageEvent" ${columns}
      SELECT 'ai_usage:' || u.id, u."organizationId", u."workspaceId", 'provider',
             CASE u."providerType" WHEN 'llm' THEN u."inputTokens" + u."outputTokens" WHEN 'tts' THEN COALESCE(u.characters, 0)
                  WHEN 'email' THEN 1 ELSE COALESCE(u.seconds, 0) END,
             'ai_usage', u.id, p.cost,
             -- Own keys are paid to the vendor directly; telephony is billed on the call's minutes instead.
             CASE WHEN u."credentialId" IS NOT NULL OR u."providerType" = 'telephony' THEN 0 ELSE p.cost * ${multiplier}::float8 END,
             jsonb_build_object('providerType', u."providerType", 'provider', u.provider, 'model', u.model, 'task', u.task,
                                'operation', u.operation, 'credentialId', u."credentialId", 'requestId', u."requestId",
                                'inputTokens', u."inputTokens", 'outputTokens', u."outputTokens", 'seconds', u.seconds,
                                'characters', u.characters, 'success', u.success, 'employeeId', u."employeeId", 'workflowId', u."workflowId"),
             u."createdAt"
      FROM "AiUsage" u
      CROSS JOIN LATERAL (SELECT COALESCE(u."costUsd", CASE WHEN u."credentialId" IS NULL THEN CASE u."providerType"
               WHEN 'stt' THEN u.seconds / 60.0 * ${prices.sttPerMinute}::float8
               WHEN 'tts' THEN u.characters / 1000.0 * ${prices.ttsPer1kChars}::float8
               WHEN 'email' THEN ${prices.emailPerSend}::float8 END END) AS cost) p
      WHERE u."createdAt" >= ${since} ${org(Prisma.sql`u."organizationId"`)}
      ON CONFLICT ("id") DO NOTHING`,
    prisma.$executeRaw`
      INSERT INTO "UsageEvent" ${columns}
      SELECT 'conversation:' || c.id, c."organizationId", c."workspaceId", 'conversation', 1, 'conversation', c.id, NULL, NULL,
             jsonb_build_object('channel', c.channel, 'employeeId', c."employeeId"), c."createdAt"
      FROM "Conversation" c
      WHERE c.channel <> ${EVALUATION_CHANNEL} AND c."createdAt" >= ${since} ${org(Prisma.sql`c."organizationId"`)}
      ON CONFLICT ("id") DO NOTHING`,
    prisma.$executeRaw`
      INSERT INTO "UsageEvent" ${columns}
      SELECT 'conversation_message:' || m.id, c."organizationId", c."workspaceId", 'message', 1, 'conversation_message', m.id, NULL, NULL,
             jsonb_build_object('conversationId', c.id, 'channel', c.channel, 'employeeId', c."employeeId", 'model', m.model), m."createdAt"
      FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE m.role = 'ASSISTANT' AND c.channel <> ${EVALUATION_CHANNEL} AND m."createdAt" >= ${since} ${org(Prisma.sql`c."organizationId"`)}
      ON CONFLICT ("id") DO NOTHING`,
    prisma.$executeRaw`
      INSERT INTO "UsageEvent" ${columns}
      SELECT 'call:' || c.id, c."organizationId", c."workspaceId", 'voice_minutes', m.minutes, 'call', c.id,
             CASE WHEN c."connectionId" IS NULL THEN m.minutes * ${prices.callPerMinute}::float8 END,
             CASE WHEN c."connectionId" IS NOT NULL THEN 0 ELSE m.minutes * ${prices.callPerMinute}::float8 * ${multiplier}::float8 END,
             jsonb_build_object('direction', c.direction, 'provider', c.provider, 'seconds', c."durationSec", 'connectionId', c."connectionId", 'employeeId', c."employeeId"),
             c."endedAt"
      FROM "Call" c
      CROSS JOIN LATERAL (SELECT CEIL(c."durationSec" / 60.0)::float8 AS minutes) m
      WHERE c."durationSec" IS NOT NULL AND c."endedAt" < ${new Date(Date.now() - CALL_SETTLE_MS)}
        AND c."createdAt" >= ${since}::timestamp - interval '1 hour' ${org(Prisma.sql`c."organizationId"`)}
      ON CONFLICT ("id") DO NOTHING`,
    prisma.$executeRaw`
      INSERT INTO "UsageEvent" ${columns}
      SELECT 'tool_execution:' || t.id, t."organizationId", t."workspaceId", 'tool_call', 1, 'tool_execution', t.id, NULL, NULL,
             jsonb_build_object('tool', t.tool, 'status', t.status, 'conversationId', t."conversationId", 'employeeId', t."employeeId"), t."createdAt"
      FROM "ToolExecution" t
      WHERE t.status IN ('SUCCEEDED', 'FAILED') AND t."createdAt" >= ${since} ${org(Prisma.sql`t."organizationId"`)}
      ON CONFLICT ("id") DO NOTHING`,
    prisma.$executeRaw`
      INSERT INTO "UsageEvent" ${columns}
      SELECT 'workflow_execution:' || w.id, w."organizationId", w."workspaceId", 'workflow_run', 1, 'workflow_execution', w.id, NULL, NULL,
             jsonb_build_object('workflowId', w."workflowId", 'startedBy', w."startedBy"), w."createdAt"
      FROM "WorkflowExecution" w
      WHERE w."createdAt" >= ${since} ${org(Prisma.sql`w."organizationId"`)}
      ON CONFLICT ("id") DO NOTHING`,
  ]);
  return counts.reduce((a, b) => a + b, 0);
}

/** Prices and markup from the server's environment: BILLING_MARKUP (a fraction; unset = 0) and BILLING_PRICE_* for the platform's providers. */
export function meterConfigFromEnv(env: Record<string, string | undefined> = process.env): MeterConfig {
  const num = (name: string) => {
    const v = env[name];
    return v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  return {
    markup: num("BILLING_MARKUP") ?? 0,
    prices: {
      sttPerMinute: num("BILLING_PRICE_STT_MINUTE"),
      ttsPer1kChars: num("BILLING_PRICE_TTS_1K_CHARS"),
      callPerMinute: num("BILLING_PRICE_CALL_MINUTE"),
      emailPerSend: num("BILLING_PRICE_EMAIL"),
    },
  };
}
