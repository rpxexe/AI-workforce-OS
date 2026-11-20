// Phase 14: which connection serves a request, and the adapter built from it. Resolution, per type:
//   workflow override -> employee override -> organization default -> platform (.env)
// The first level that exists serves the request; the levels after it that the organization set up are its fallbacks.
// The platform is a fallback only when chosen explicitly (an override naming it), as in Phase 13: an organization that
// brought its own account may not want its data sent elsewhere, nor the platform to pay.
import type { WhatsAppProvider } from "@workforce/channels";
import type { ChannelSender } from "@workforce/channels";
import { prisma, type Prisma } from "@workforce/database";
import {
  fallbackEmail,
  fallbackSTT,
  fallbackTTS,
  openCredentials,
  registryEntry,
  sealCredentials,
  type AttemptRecord,
  type Conn,
  type ObjectStorage,
  type Target,
} from "@workforce/providers";
import { providerOverridesSchema, type OverridableType, type ProviderOverrides, type ProviderType } from "@workforce/shared";
import type { STTProvider } from "@workforce/stt";
import type { TelephonyProvider } from "@workforce/telephony";
import { safeFetch } from "@workforce/tools";
import type { TTSProvider } from "@workforce/tts";
import type { FastifyBaseLogger } from "fastify";
import { httpError } from "../auth.ts";

export type ConnectionRow = Prisma.ProviderConnectionGetPayload<object>;

/** Who is asking: the tenant, and the employee and workflow whose overrides apply. */
export type ProviderScope = { organizationId: string; workspaceId?: string | null; employeeId?: string | null; workflowId?: string | null };

/** What the server's .env provides when an organization has nothing of its own. */
export type PlatformProviders = {
  stt: STTProvider | null;
  tts: TTSProvider | null;
  telephony: TelephonyProvider[];
  whatsapp: WhatsAppProvider[];
  email: ChannelSender | null;
  emailFrom: string | null;
};

export type ProviderServiceDeps = {
  /** AI_CREDENTIALS_KEY; null: connections cannot be stored or opened. */
  secret: string | null;
  /** AI_CREDENTIALS_KEY_PREVIOUS while rotating the server secret. */
  previousSecret?: string | null;
  platform: PlatformProviders;
  /** The network adapters use for vendors' fixed addresses (tests pass a fake). */
  fetch?: typeof fetch;
  /** For addresses admins typed; defaults to safeFetch (public https, pinned DNS, no redirects). */
  userFetch?: typeof fetch;
  log: FastifyBaseLogger;
};

const overridesOf = (value: unknown): ProviderOverrides => {
  const parsed = providerOverridesSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : {};
};

export function providerService(deps: ProviderServiceDeps) {
  const vendorFetch = deps.fetch ?? fetch;
  const userFetch = deps.userFetch ?? safeFetch;

  /** Opens a row's secrets. Rows sealed under the previous server secret (or Phase 13's format) are sealed again. */
  const conn = (row: ConnectionRow): Conn => {
    if (!deps.secret) throw httpError(503, "AI_CREDENTIALS_KEY is not set on the server, so connections cannot be read");
    let opened: ReturnType<typeof openCredentials>;
    try {
      opened = openCredentials(row.encryptedCredentials, { current: deps.secret, previous: deps.previousSecret });
    } catch {
      throw httpError(503, `The credentials of "${row.displayName}" cannot be read: the server secret changed since they were saved. Rotate them.`);
    }
    if (opened.stale)
      void prisma.providerConnection
        .updateMany({ where: { id: row.id, encryptedCredentials: row.encryptedCredentials }, data: { encryptedCredentials: sealCredentials(opened.credentials, deps.secret) } })
        .catch((err: unknown) => deps.log.warn({ err, connectionId: row.id }, "Re-sealing credentials failed"));
    return { credentials: opened.credentials, configuration: row.configuration as Record<string, unknown>, fetch: vendorFetch, userFetch };
  };

  const active = (organizationId: string, type: ProviderType, id: string) =>
    prisma.providerConnection.findFirst({ where: { id, organizationId, providerType: type, status: "active" } });

  const defaultOf = (organizationId: string, type: ProviderType) =>
    prisma.providerConnection.findFirst({ where: { organizationId, providerType: type, status: "active", isDefault: true } });

  /** The overrides that apply to a request, workflow first. */
  const overrides = async (scope: ProviderScope) => {
    const [workflow, employee] = await Promise.all([
      scope.workflowId ? prisma.workflow.findFirst({ where: { id: scope.workflowId, organizationId: scope.organizationId }, select: { providerOverrides: true } }) : null,
      scope.employeeId ? prisma.aiEmployee.findFirst({ where: { id: scope.employeeId, organizationId: scope.organizationId }, select: { providerOverrides: true } }) : null,
    ]);
    return [workflow && overridesOf(workflow.providerOverrides), employee && overridesOf(employee.providerOverrides)].filter((o): o is ProviderOverrides => o !== null);
  };

  /**
   * The resolution chain for a type: each level that exists, in priority order, as connection rows (null = platform).
   * Overrides naming a disabled or deleted connection are skipped: disabling is how an admin stops a connection's use.
   */
  async function levels<T extends OverridableType>(type: T, scope: ProviderScope) {
    const chain: { row: ConnectionRow | null; override?: NonNullable<ProviderOverrides[T]> }[] = [];
    for (const o of await overrides(scope)) {
      const target = o[type] as NonNullable<ProviderOverrides[T]> | undefined;
      if (!target) continue;
      if (target.connectionId === null) chain.push({ row: null, override: target });
      else {
        const row = await active(scope.organizationId, type, target.connectionId);
        if (row) chain.push({ row, override: target });
        else deps.log.warn({ type, connectionId: target.connectionId }, "An override names a connection that is disabled or gone; skipped");
      }
    }
    const fallback = await defaultOf(scope.organizationId, type);
    if (fallback) chain.push({ row: fallback });
    if (chain.length === 0) chain.push({ row: null });
    return chain;
  }

  /** Writes one usage row per attempt; never fails the caller. */
  const recorder =
    (scope: ProviderScope, providerType: ProviderType, task: string) =>
    (r: AttemptRecord) => {
      prisma.aiUsage
        .create({
          data: {
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId ?? null,
            employeeId: scope.employeeId ?? null,
            workflowId: scope.workflowId ?? null,
            providerType,
            task,
            operation: r.operation,
            requestId: r.requestId,
            attempt: r.attempt,
            provider: r.provider,
            model: r.model,
            credentialId: r.connectionId,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: r.costUsd,
            latencyMs: r.latencyMs,
            success: r.success,
            errorKind: r.errorKind,
            error: r.error,
            characters: r.characters ?? null,
            seconds: r.seconds ?? null,
          },
        })
        .catch((err: unknown) => deps.log.warn({ err, providerType }, "Recording provider usage failed"));
    };

  const costOf = (row: ConnectionRow) => {
    const v = (row.configuration as { costPerUnit?: unknown }).costPerUnit;
    return typeof v === "number" ? v : null;
  };

  /** A target built from a row through the registry, or null when the row's provider is not buildable (coming soon, removed). */
  function targetOf<T>(row: ConnectionRow, build: (c: Conn) => T, model: string): Target<T> {
    const c = conn(row);
    return { key: `${row.id}:${model}`, provider: row.providerId, connectionId: row.id, value: build(c), costPerUnit: costOf(row), model, secrets: Object.values(c.credentials) };
  }

  const configString = (row: ConnectionRow, key: string) => {
    const v = (row.configuration as Record<string, unknown>)[key];
    return typeof v === "string" ? v : "";
  };

  return {
    platform: deps.platform,
    conn,
    levels,
    recorder,

    /** Speech recognition for a request (calls: live; WhatsApp voice notes: files), with fallback. null: none configured. */
    async stt(scope: ProviderScope, task = "voice"): Promise<STTProvider | null> {
      const targets: Target<STTProvider>[] = [];
      for (const { row } of await levels("stt", scope)) {
        if (!row) {
          if (deps.platform.stt) targets.push({ key: "platform", provider: deps.platform.stt.name, connectionId: null, value: deps.platform.stt });
          continue;
        }
        const entry = registryEntry("stt", row.providerId);
        if (entry) targets.push(targetOf(row, (c) => entry.build(c), configString(row, "model")));
      }
      return targets.length > 0 ? fallbackSTT(targets, recorder(scope, "stt", task)) : null;
    },

    /** Speech synthesis for a request, with fallback before the first audio. null: none configured. */
    async tts(scope: ProviderScope, task = "voice"): Promise<TTSProvider | null> {
      const targets: Target<TTSProvider>[] = [];
      for (const { row, override } of await levels("tts", scope)) {
        const voice = (override as { voice?: string } | undefined)?.voice;
        if (!row) {
          if (deps.platform.tts) targets.push({ key: "platform", provider: deps.platform.tts.name, connectionId: null, value: deps.platform.tts });
          continue;
        }
        const entry = registryEntry("tts", row.providerId);
        if (entry) targets.push(targetOf(row, (c) => entry.build(c, voice), voice || configString(row, "voice")));
      }
      return targets.length > 0 ? fallbackTTS(targets, recorder(scope, "tts", task)) : null;
    },

    /** The sender for a request's email and the From address to use when the message has none (tools, workflows, handoffs). */
    async email(scope: ProviderScope, task = "email"): Promise<{ sender: ChannelSender; from: string | null; provider: string } | null> {
      const targets: Target<ChannelSender>[] = [];
      let from: string | null = null;
      for (const { row } of await levels("email", scope)) {
        if (!row) {
          if (deps.platform.email) {
            targets.push({ key: "platform", provider: "resend", connectionId: null, value: deps.platform.email });
            from ??= deps.platform.emailFrom;
          }
          continue;
        }
        const entry = registryEntry("email", row.providerId);
        if (!entry) continue;
        targets.push(targetOf(row, (c) => entry.build(c), ""));
        from ??= configString(row, "from") || null;
      }
      if (targets.length === 0) return null;
      return { sender: fallbackEmail(targets, recorder(scope, "email", task)), from, provider: targets[0]!.provider };
    },

    /** The organization's default storage. Not overridable and no fallback: files must stay where they were written. */
    async storage(organizationId: string): Promise<{ connectionId: string; storage: ObjectStorage } | null> {
      const row = await defaultOf(organizationId, "storage");
      const entry = row && registryEntry("storage", row.providerId);
      return row && entry ? { connectionId: row.id, storage: entry.build(conn(row)) } : null;
    },

    /** A storage connection by id (reading a file written there before the default changed). Disabled ones still read. */
    async storageById(organizationId: string, id: string): Promise<ObjectStorage> {
      const row = await prisma.providerConnection.findFirst({ where: { id, organizationId, providerType: "storage" } });
      const entry = row && registryEntry("storage", row.providerId);
      if (!row || !entry) throw httpError(409, "The storage connection holding this file was deleted");
      return entry.build(conn(row));
    },

    /** The organization's default connection of a type (telephony numbers, WhatsApp channels without one chosen). */
    defaultOf,

    /**
     * A telephony provider: the organization's connection, or (null id) the platform's account of that provider.
     * Webhooks name both in their path; an unknown or disabled connection is refused.
     */
    async telephony(name: string, connectionId: string | null): Promise<TelephonyProvider> {
      if (!connectionId) {
        const platform = deps.platform.telephony.find((p) => p.name === name);
        if (!platform) throw httpError(503, `The ${name} phone provider is not configured on the server`);
        return platform;
      }
      const row = await prisma.providerConnection.findFirst({ where: { id: connectionId, providerType: "telephony", providerId: name, status: "active" } });
      const entry = row && registryEntry("telephony", row.providerId);
      if (!row || !entry) throw httpError(404, "Unknown phone connection");
      return entry.build(conn(row));
    },

    /** A WhatsApp provider: the organization's messaging connection, or (null id) the platform's account. */
    async whatsapp(name: string, connectionId: string | null, webhookUrl?: string): Promise<WhatsAppProvider | null> {
      if (!connectionId) return deps.platform.whatsapp.find((p) => p.name === name) ?? null;
      const row = await prisma.providerConnection.findFirst({ where: { id: connectionId, providerType: "messaging", status: "active" } });
      const entry = row && registryEntry("messaging", row.providerId);
      if (!row || !entry) return null;
      const provider = entry.build(conn(row), webhookUrl);
      return provider.name === name ? provider : null;
    },
  };
}

export type ProviderService = ReturnType<typeof providerService>;

/** WhatsApp provider names (the channel's `provider` setting) for each messaging catalog id. */
export const WHATSAPP_OF: Record<string, string> = { meta_whatsapp: "meta", twilio_whatsapp: "twilio", telnyx_whatsapp: "telnyx" };
