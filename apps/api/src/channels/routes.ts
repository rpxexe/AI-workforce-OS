import { randomBytes, timingSafeEqual } from "node:crypto";
import { toInboundEmail, type WhatsAppProvider } from "@workforce/channels";
import { Prisma, prisma } from "@workforce/database";
import {
  ADMIN_ROLE,
  channelConfigSchemas,
  inboundEmailSchema,
  listChannelMessagesQuery,
  MESSAGING_CHANNELS,
  setChannelSchema,
  WHATSAPP_PROVIDERS,
  type ChannelKind,
  type ChannelMedia,
  type ChannelMessageRecord,
  type EmployeeChannelInfo,
  type EmployeeChannels,
  type MessagingChannel,
  type ToolName,
  type WhatsAppProviderName,
} from "@workforce/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "../auth.ts";
import { employeeParams, within } from "../employees.ts";
import { whatsappProviderOf, type ChannelRow, type ChannelService } from "./service.ts";

const channelParams = employeeParams.extend({ kind: z.enum(MESSAGING_CHANNELS) });
const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const emailHookParams = z.object({ channelId: z.string().min(1), token: z.string().min(1) });
const providerParams = z.object({ provider: z.enum(WHATSAPP_PROVIDERS) });
/** What each WhatsApp provider needs in .env. */
const MISSING: Record<WhatsAppProviderName, string> = {
  meta: "META_WHATSAPP_ACCESS_TOKEN, META_APP_SECRET, META_WHATSAPP_VERIFY_TOKEN",
  twilio: "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN",
  telnyx: "TELNYX_API_KEY, TELNYX_PUBLIC_KEY",
};

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Where the outside world reaches this API: PUBLIC_URL, or the address the dashboard used. */
const baseUrl = (publicUrl: string | null, req: FastifyRequest) => (publicUrl ?? `${req.protocol}://${req.host}`).replace(/\/+$/, "");

const toInfo = (c: ChannelRow, admin: boolean, base: string): EmployeeChannelInfo => {
  const kind = c.kind as MessagingChannel;
  return {
    kind,
    enabled: c.enabled,
    allowedTools: c.allowedTools as ToolName[] | null,
    config: c.config as Record<string, unknown>,
    address: c.address,
    secret: admin && kind !== "whatsapp" ? c.secret : null,
    url:
      kind === "web_chat"
        ? `${base}/widget.js`
        : kind === "whatsapp"
          ? `${base}/channels/whatsapp/${whatsappProviderOf(c)}/webhook`
          : admin
            ? `${base}/hooks/email/${c.id}/${c.secret}`
            : null,
    previewUrl: kind === "web_chat" ? `${base}/chat/${c.address}/demo` : null,
    updatedAt: c.updatedAt.toISOString(),
  };
};

export const toRecord = (m: Prisma.ChannelMessageGetPayload<object>): ChannelMessageRecord => ({
  id: m.id,
  channel: m.channel as ChannelKind,
  direction: m.direction,
  status: m.status,
  employeeId: m.employeeId,
  customerId: m.customerId,
  conversationId: m.conversationId,
  providerMessageId: m.providerMessageId,
  from: m.from,
  to: m.to,
  text: m.text,
  media: (m.media as ChannelMedia[] | null) ?? [],
  error: m.error,
  attempts: m.attempts,
  latencyMs: m.latencyMs,
  createdAt: m.createdAt.toISOString(),
  updatedAt: m.updatedAt.toISOString(),
});

export function channelRoutes(
  app: FastifyInstance,
  authenticate: Authenticate,
  deps: { service: ChannelService; whatsapp: WhatsAppProvider[]; publicUrl: string | null },
) {
  const { member, admin, inWorkspace } = guards(authenticate);
  const { service, whatsapp } = deps;

  // ---- Provider webhooks (public, verified) ----

  void app.register(async (hooks) => {
    // Kept raw: providers sign the exact body (Twilio signs the form fields, parsed from it).
    hooks.addContentTypeParser(["application/json", "application/x-www-form-urlencoded"], { parseAs: "string" }, (_req, body, done) => done(null, body));

    /** The configured provider named in the URL, or 503 naming what to add to .env. */
    const providerFor = (req: FastifyRequest) => {
      const { provider: name } = providerParams.parse(req.params);
      const provider = whatsapp.find((p) => p.name === name);
      if (!provider) throw httpError(503, `WhatsApp through ${name} is not configured. Missing in .env: ${MISSING[name]}`);
      return provider;
    };

    // Meta's subscription handshake. Twilio and Telnyx have none.
    hooks.get("/channels/whatsapp/:provider/webhook", async (req, reply) => {
      const provider = providerFor(req);
      if (!provider.verifySubscription) throw httpError(404, "Not found");
      const challenge = provider.verifySubscription(req.query as Record<string, unknown>);
      if (challenge === null) throw httpError(403, "Verify token does not match");
      return reply.type("text/plain").send(challenge);
    });

    hooks.post("/channels/whatsapp/:provider/webhook", async (req, reply) => {
      const provider = providerFor(req);
      const parsed = provider.parseWebhook({
        // Signed over the exact public URL the provider called (Twilio).
        url: baseUrl(deps.publicUrl, req) + req.url,
        rawBody: typeof req.body === "string" ? req.body : "",
        headers: req.headers,
      });
      if (!parsed) throw httpError(403, "Invalid webhook signature");
      // Answered after the reply: providers retry webhooks that are slow to answer. Retries are deduplicated.
      void (async () => {
        for (const update of parsed.statuses) await service.delivery("whatsapp", update);
        await Promise.all(
          parsed.messages.map(async (inbound) => {
            const channel = await prisma.employeeChannel.findUnique({ where: { kind_address: { kind: "whatsapp", address: inbound.address } } });
            if (!channel) return req.log.warn({ provider: provider.name, address: inbound.address }, "No employee answers this WhatsApp number");
            if (whatsappProviderOf(channel) !== provider.name)
              return req.log.warn({ provider: provider.name, address: inbound.address }, "This WhatsApp number is set up for another provider");
            await service.receive(channel, inbound);
          }),
        );
      })().catch((err: unknown) => req.log.error({ err }, "Handling a WhatsApp webhook failed"));
      return reply.code(200).type(provider.ack.contentType).send(provider.ack.body);
    });
  });

  // An inbound-email service (or a forwarding script) posts each email here, in our JSON shape.
  app.post("/hooks/email/:channelId/:token", async (req, reply) => {
    const { channelId, token } = emailHookParams.parse(req.params);
    const channel = await prisma.employeeChannel.findFirst({ where: { id: channelId, kind: "email" } });
    if (!channel || !same(token, channel.secret)) throw httpError(404, "Not found");
    const inbound = toInboundEmail(inboundEmailSchema.parse(req.body), channel.address);
    if (!inbound) throw httpError(400, "The sender's address could not be read");
    service.receive(channel, inbound).catch((err: unknown) => req.log.error({ err }, "Handling an inbound email failed"));
    return reply.code(202).send({ accepted: true });
  });

  // ---- Dashboard ----

  const base = "/workspaces/:workspaceId/employees/:id/channels";
  const employeeIn = async (scope: { organizationId: string; workspaceId: string }, id: string) => {
    const employee = await prisma.aiEmployee.findFirst({ where: { id, ...within(scope) }, select: { id: true } });
    if (!employee) throw httpError(404, "Employee not found");
  };

  app.get(base, async (req): Promise<EmployeeChannels> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    await employeeIn(scope, id);
    const rows = await prisma.employeeChannel.findMany({ where: { employeeId: id, ...within(scope) }, orderBy: { createdAt: "asc" } });
    const url = baseUrl(deps.publicUrl, req);
    return { channels: rows.map((c) => toInfo(c, scope.role === ADMIN_ROLE, url)), whatsappProviders: whatsapp.map((p) => p.name), emailTestMode: true };
  });

  // Creates or replaces the employee's settings for one channel.
  app.put(`${base}/:kind`, async (req): Promise<EmployeeChannelInfo> => {
    const { workspaceId, id, kind } = channelParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    await employeeIn(scope, id);
    const body = setChannelSchema.parse(req.body);
    const config = channelConfigSchemas[kind].parse(body.config);
    const existing = await prisma.employeeChannel.findUnique({ where: { employeeId_kind: { employeeId: id, kind } } });
    const address =
      "phoneNumberId" in config ? config.phoneNumberId : "number" in config ? config.number : "address" in config ? config.address : (existing?.address ?? `wc_${randomBytes(12).toString("base64url")}`);
    const data = {
      address,
      enabled: body.enabled,
      config: config as Prisma.InputJsonValue,
      allowedTools: body.allowedTools ?? Prisma.DbNull,
    };
    try {
      const saved = existing
        ? await prisma.employeeChannel.update({ where: { id: existing.id }, data })
        : await prisma.employeeChannel.create({
            data: { ...data, ...within(scope), employeeId: id, kind, secret: randomBytes(32).toString("hex"), createdBy: scope.userId },
          });
      return toInfo(saved, true, baseUrl(deps.publicUrl, req));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")
        throw httpError(409, kind === "whatsapp" ? "Another employee already answers this WhatsApp number" : "Another employee already uses this address");
      throw err;
    }
  });

  // Stops answering on the channel. Its message log stays.
  app.delete(`${base}/:kind`, async (req, reply) => {
    const { workspaceId, id, kind } = channelParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { count } = await prisma.employeeChannel.deleteMany({ where: { employeeId: id, kind, ...within(scope) } });
    if (count === 0) throw httpError(404, "Channel not found");
    return reply.code(204).send();
  });

  app.get("/workspaces/:workspaceId/channel-messages", async (req): Promise<ChannelMessageRecord[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const filters = listChannelMessagesQuery.parse(req.query);
    const scope = await inWorkspace(member(req), workspaceId);
    const rows = await prisma.channelMessage.findMany({
      where: { ...within(scope), ...filters },
      orderBy: { createdAt: "desc" },
      // shortcut: newest 100 only, add a cursor when the log needs paging
      take: 100,
    });
    return rows.map(toRecord);
  });
}
