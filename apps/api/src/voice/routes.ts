import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { prisma, type Prisma } from "@workforce/database";
import type { MemoryService } from "@workforce/memory";
import {
  addPhoneNumberSchema,
  DEFAULT_INBOUND_GREETING,
  DEFAULT_OUTBOUND_GREETING,
  placeCallSchema,
  type CallDetail,
  type PlaceCall,
  type CallSummary,
  type PhoneNumberInfo,
} from "@workforce/shared";
import type { STTProvider } from "@workforce/stt";
import { ENDED_STATUSES, TelephonyError, type TelephonyProvider } from "@workforce/telephony";
import type { ToolExecutor } from "@workforce/tools";
import type { TTSProvider } from "@workforce/tts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { guards, httpError, type Authenticate } from "../auth.ts";
import { employeeParams, within } from "../employees.ts";
import { runCallSession, streamToken, type VoiceLimits } from "./session.ts";

/** Everything voice needs from outside. Missing pieces make voice routes answer 503, naming them. */
export type VoiceConfig = {
  /** Every configured phone provider. Each number belongs to one; its webhooks live under /voice/<name>/. */
  telephony: TelephonyProvider[];
  stt: STTProvider | null;
  tts: TTSProvider | null;
  /** https URL the provider reaches this API at (an ngrok tunnel in development). */
  publicUrl: string | null;
  /** Signs media stream tokens; a provider secret by default. */
  secret: string | null;
  limits: VoiceLimits;
};

type Ai = {
  provider: () => AIProvider;
  embedder: () => EmbeddingProvider;
  memory: (provider: AIProvider, timeoutMs: number) => MemoryService;
  tools: ToolExecutor;
  timeoutMs: number;
};

const workspaceParams = z.object({ workspaceId: z.string().min(1) });
const providerParams = z.object({ provider: z.string().min(1) });
const numberParams = workspaceParams.extend({ numberId: z.string().min(1) });
const callParams = workspaceParams.extend({ callId: z.string().min(1) });
const statusQuery = z.object({ callId: z.string().min(1).optional() });
const callsQuery = z.object({ employeeId: z.string().min(1).optional() });

type Tenant = { organizationId: string; workspaceId: string };

const fill = (template: string, name: string) => template.replaceAll("{name}", name);

const toNumber = (n: Prisma.PhoneNumberGetPayload<object>): PhoneNumberInfo => ({
  id: n.id,
  number: n.number,
  employeeId: n.employeeId,
  greeting: n.greeting,
  createdAt: n.createdAt.toISOString(),
});

const toSummary = (c: Prisma.CallGetPayload<object>): CallSummary => ({
  id: c.id,
  employeeId: c.employeeId,
  direction: c.direction,
  status: c.status,
  from: c.from,
  to: c.to,
  conversationId: c.conversationId,
  customerId: c.customerId,
  error: c.error,
  createdAt: c.createdAt.toISOString(),
  answeredAt: c.answeredAt?.toISOString() ?? null,
  endedAt: c.endedAt?.toISOString() ?? null,
  durationSec: c.durationSec,
});

export function voiceRoutes(app: FastifyInstance, authenticate: Authenticate, voice: VoiceConfig, ai: Ai) {
  const { member, admin, inWorkspace } = guards(authenticate);

  /** The configured voice pieces, or 503 naming what is missing. */
  const ready = () => {
    const missing = [
      voice.telephony.length === 0 && "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN (or TELNYX_API_KEY / TELNYX_APP_ID)",
      !voice.stt && "DEEPGRAM_API_KEY",
      !voice.tts && "ELEVENLABS_API_KEY",
      !voice.publicUrl && "PUBLIC_URL",
    ].filter(Boolean);
    if (voice.telephony.length === 0 || !voice.stt || !voice.tts || !voice.publicUrl || !voice.secret)
      throw httpError(503, `Voice is not configured. Missing in .env: ${missing.join(", ")}`);
    const publicUrl = voice.publicUrl.replace(/\/+$/, "");
    return {
      providers: voice.telephony,
      stt: voice.stt,
      tts: voice.tts,
      publicUrl,
      secret: voice.secret,
      /** The webhook and stream addresses of one provider. */
      urls: (telephony: TelephonyProvider) => ({
        streamUrl: `${publicUrl.replace(/^http/, "ws")}/voice/${telephony.name}/stream`,
        statusUrl: `${publicUrl}/voice/${telephony.name}/status`,
        inboundUrl: `${publicUrl}/voice/${telephony.name}/inbound`,
      }),
    };
  };
  /** The configured provider a number or webhook belongs to. */
  const providerOf = (v: ReturnType<typeof ready>, name: string) => {
    const telephony = v.providers.find((p) => p.name === name);
    if (!telephony) throw httpError(503, `The ${name} phone provider is not configured`);
    return telephony;
  };

  /** The published version that answers calls, or null if the employee cannot take calls. */
  const liveVersion = async (employeeId: string) => {
    const employee = await prisma.aiEmployee.findUnique({ where: { id: employeeId }, include: { publishedVersion: true } });
    return employee?.status === "ACTIVE" && employee.publishedVersion ? employee.publishedVersion : null;
  };

  // ---- Provider webhooks and the media stream (public, signature-checked) ----

  void app.register(async (hooks) => {
    // Kept raw: some providers sign the exact body.
    hooks.addContentTypeParser(["application/x-www-form-urlencoded", "application/json"], { parseAs: "string" }, (_req, body, done) =>
      done(null, body),
    );
    const verified = (req: FastifyRequest) => {
      const v = ready();
      const telephony = providerOf(v, providerParams.parse(req.params).provider);
      const rawBody = typeof req.body === "string" ? req.body : "";
      const params = Object.fromEntries(new URLSearchParams(rawBody));
      // Signed over the exact URL the provider called.
      if (!telephony.verifyWebhook({ url: v.publicUrl + req.url, params, rawBody, headers: req.headers }))
        throw httpError(403, "Invalid webhook signature");
      return { v, telephony, params };
    };

    hooks.post("/voice/:provider/inbound", async (req, reply) => {
      const { v, telephony, params } = verified(req);
      reply.type("text/xml");
      const { CallSid: sid = "", From: from = "", To: to = "" } = params;
      const number = await prisma.phoneNumber.findUnique({ where: { number: to } });
      if (!number || number.provider !== telephony.name) return telephony.sayAndHangUp("This number is not in service.");
      const version = await liveVersion(number.employeeId);
      if (!version) return telephony.sayAndHangUp("Sorry, no one is available to take your call right now. Please try again later.");

      // The provider retries webhooks; one call row per call.
      let call = await prisma.call.findUnique({ where: { providerCallId: sid } });
      if (!call) {
        const scope = { organizationId: number.organizationId, workspaceId: number.workspaceId };
        const customerId = from ? await ai.memory(ai.provider(), ai.timeoutMs).identify(scope, from) : null;
        call = await prisma.call.create({
          data: {
            ...scope,
            employeeId: number.employeeId,
            employeeVersion: version.number,
            customerId,
            direction: "INBOUND",
            status: "RINGING",
            from,
            to,
            provider: telephony.name,
            providerCallId: sid,
            greeting: fill(number.greeting, version.name),
            participants: {
              create: [
                { role: "CUSTOMER", phoneNumber: from, customerId },
                { role: "EMPLOYEE", phoneNumber: to, employeeId: number.employeeId },
              ],
            },
          },
        });
      }
      return telephony.connectToStream(v.urls(telephony).streamUrl, { callId: call.id, token: streamToken(v.secret, call.id) });
    });

    hooks.post("/voice/:provider/status", async (req, reply) => {
      const { telephony, params } = verified(req);
      const { providerCallId, status, durationSec } = telephony.statusOf(params);
      let call = providerCallId ? await prisma.call.findUnique({ where: { providerCallId } }) : null;
      // An outbound call whose provider did not return its id when placed: the first callback names it.
      const { callId } = statusQuery.parse(req.query);
      if (!call && callId && providerCallId) {
        const placed = await prisma.call.findFirst({ where: { id: callId, provider: telephony.name, providerCallId: null } });
        if (placed) call = await prisma.call.update({ where: { id: placed.id }, data: { providerCallId } });
      }
      if (call && status && !ENDED_STATUSES.includes(call.status)) {
        const ended = ENDED_STATUSES.includes(status);
        await prisma.call.update({
          where: { id: call.id },
          data: {
            status,
            ...(status === "IN_PROGRESS" && !call.answeredAt && { answeredAt: new Date() }),
            ...(ended && { endedAt: call.endedAt ?? new Date() }),
            ...(durationSec !== null && { durationSec }),
          },
        });
      } else if (call && durationSec !== null) {
        // The session may have marked it ended first; the provider's duration is the one billed.
        await prisma.call.update({ where: { id: call.id }, data: { durationSec } });
      }
      return reply.code(204).send();
    });
  });

  app.get("/voice/:provider/stream", { websocket: true }, (socket, req) => {
    let v: ReturnType<typeof ready>;
    let telephony: TelephonyProvider;
    try {
      v = ready();
      telephony = providerOf(v, providerParams.parse(req.params).provider);
    } catch {
      socket.close();
      return;
    }
    runCallSession(socket, { ...ai, telephony, stt: v.stt, tts: v.tts, secret: v.secret, limits: voice.limits, log: req.log });
  });

  // ---- Dashboard ----

  const employeeIn = async (scope: Tenant, employeeId: string) => {
    const employee = await prisma.aiEmployee.findFirst({ where: { id: employeeId, ...within(scope) }, select: { id: true } });
    if (!employee) throw httpError(404, "Employee not found");
  };
  const telephonyError = (err: unknown) => {
    if (err instanceof TelephonyError) return httpError(502, err.message);
    throw err;
  };

  app.get("/workspaces/:workspaceId/phone-numbers", async (req): Promise<PhoneNumberInfo[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const numbers = await prisma.phoneNumber.findMany({ where: within(scope), orderBy: { createdAt: "asc" } });
    return numbers.map(toNumber);
  });

  // Assigns a number the provider account owns to an employee, and points the number at us.
  app.post("/workspaces/:workspaceId/phone-numbers", async (req, reply): Promise<PhoneNumberInfo> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const body = addPhoneNumberSchema.parse(req.body);
    await employeeIn(scope, body.employeeId);
    if (await prisma.phoneNumber.findUnique({ where: { number: body.number } }))
      throw httpError(409, "This number is already assigned to an employee");
    const v = ready();
    // The first configured provider whose account owns the number takes it.
    // shortcut: no provider choice in the request; add one with the provider settings page
    let owner: { telephony: TelephonyProvider; providerNumberId: string } | undefined;
    const refusals: string[] = [];
    for (const telephony of v.providers) {
      const urls = v.urls(telephony);
      try {
        const { providerNumberId } = await telephony.configureNumber(body.number, { voiceUrl: urls.inboundUrl, statusCallbackUrl: urls.statusUrl });
        owner = { telephony, providerNumberId };
        break;
      } catch (err) {
        if (!(err instanceof TelephonyError)) throw err;
        refusals.push(err.message);
      }
    }
    if (!owner) throw httpError(502, refusals.join(". "));
    const created = await prisma.phoneNumber.create({
      data: {
        ...within(scope),
        employeeId: body.employeeId,
        number: body.number,
        provider: owner.telephony.name,
        providerNumberId: owner.providerNumberId,
        greeting: body.greeting ?? DEFAULT_INBOUND_GREETING,
        createdBy: scope.userId,
      },
    });
    reply.code(201);
    return toNumber(created);
  });

  // Points the number at the current PUBLIC_URL again (a new ngrok address, for example).
  app.post("/workspaces/:workspaceId/phone-numbers/:numberId/reconnect", async (req): Promise<PhoneNumberInfo> => {
    const { workspaceId, numberId } = numberParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const number = await prisma.phoneNumber.findFirst({ where: { id: numberId, ...within(scope) } });
    if (!number) throw httpError(404, "Phone number not found");
    const v = ready();
    const telephony = providerOf(v, number.provider);
    const urls = v.urls(telephony);
    await telephony.configureNumber(number.number, { voiceUrl: urls.inboundUrl, statusCallbackUrl: urls.statusUrl }).catch((err: unknown) => {
      throw telephonyError(err);
    });
    return toNumber(number);
  });

  // Stops answering the number. The provider keeps pointing it here; calls get "not in service".
  app.delete("/workspaces/:workspaceId/phone-numbers/:numberId", async (req, reply) => {
    const { workspaceId, numberId } = numberParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const { count } = await prisma.phoneNumber.deleteMany({ where: { id: numberId, ...within(scope) } });
    if (count === 0) throw httpError(404, "Phone number not found");
    return reply.code(204).send();
  });

  /**
   * Places an outbound call with the employee's published version. The caller has authorized the
   * tenant ids; `createdBy` is null for calls placed by a workflow. A workflow step passes an
   * `idempotencyKey`, and placing again with the same key returns the first call instead of dialing.
   */
  const placeCall = async (scope: Tenant & { createdBy: string | null; idempotencyKey?: string }, id: string, body: PlaceCall) => {
    if (scope.idempotencyKey) {
      const earlier = await prisma.call.findFirst({ where: { idempotencyKey: scope.idempotencyKey, ...within(scope) } });
      if (earlier?.providerCallId) return earlier;
      if (earlier?.status === "FAILED") throw httpError(409, earlier.error ?? "The call could not be placed");
      // The row exists but the provider never confirmed: the earlier try stopped while dialing.
      if (earlier)
        throw httpError(409, "An earlier try stopped while placing this call, so it may have been placed. Check the employee's calls, then retry the run.");
    }
    await employeeIn(scope, id);
    const version = await liveVersion(id);
    if (!version) throw httpError(409, "Publish this employee and make sure it is active before it makes calls");
    const from = await prisma.phoneNumber.findFirst({
      where: { employeeId: id, ...within(scope), ...(body.phoneNumberId && { id: body.phoneNumberId }) },
      orderBy: { createdAt: "asc" },
    });
    if (!from) throw httpError(400, "Give this employee a phone number before it makes calls");
    const v = ready();
    const telephony = providerOf(v, from.provider);
    const urls = v.urls(telephony);

    const customerId = await ai.memory(ai.provider(), ai.timeoutMs).identify(scope, body.to);
    const call = await prisma.call.create({
      data: {
        ...within(scope),
        employeeId: id,
        employeeVersion: version.number,
        customerId,
        direction: "OUTBOUND",
        status: "QUEUED",
        from: from.number,
        to: body.to,
        provider: telephony.name,
        greeting: fill(body.greeting ?? DEFAULT_OUTBOUND_GREETING, version.name),
        createdBy: scope.createdBy,
        idempotencyKey: scope.idempotencyKey,
        participants: {
          create: [
            { role: "CUSTOMER", phoneNumber: body.to, customerId },
            { role: "EMPLOYEE", phoneNumber: from.number, employeeId: id },
          ],
        },
      },
    });
    try {
      const { providerCallId } = await telephony.placeCall({
        to: body.to,
        from: from.number,
        streamUrl: urls.streamUrl,
        parameters: { callId: call.id, token: streamToken(v.secret, call.id) },
        statusCallbackUrl: `${urls.statusUrl}?callId=${call.id}`,
        timeLimitSec: Math.round(voice.limits.maxCallMs / 1000) + 60,
      });
      return await prisma.call.update({ where: { id: call.id }, data: { providerCallId } });
    } catch (err) {
      await prisma.call.update({
        where: { id: call.id },
        data: { status: "FAILED", endedAt: new Date(), error: err instanceof Error ? err.message : "The call could not be placed" },
      });
      throw telephonyError(err);
    }
  };

  app.post("/workspaces/:workspaceId/employees/:id/calls", async (req, reply): Promise<CallSummary> => {
    const { workspaceId, id } = employeeParams.parse(req.params);
    const scope = await inWorkspace(admin(req), workspaceId);
    const body = placeCallSchema.parse(req.body);
    const placed = await placeCall({ ...within(scope), createdBy: scope.userId }, id, body);
    reply.code(201);
    return toSummary(placed);
  });

  app.get("/workspaces/:workspaceId/calls", async (req): Promise<CallSummary[]> => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const { employeeId } = callsQuery.parse(req.query);
    const scope = await inWorkspace(member(req), workspaceId);
    const calls = await prisma.call.findMany({
      where: { ...within(scope), employeeId },
      orderBy: { createdAt: "desc" },
      // shortcut: newest 50 only, add a cursor when a call history page is built
      take: 50,
    });
    return calls.map(toSummary);
  });

  app.get("/workspaces/:workspaceId/calls/:callId", async (req): Promise<CallDetail> => {
    const { workspaceId, callId } = callParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);
    const call = await prisma.call.findFirst({
      where: { id: callId, ...within(scope) },
      include: { participants: true, transcript: { orderBy: { offsetMs: "asc" } } },
    });
    if (!call) throw httpError(404, "Call not found");
    return {
      ...toSummary(call),
      employeeVersion: call.employeeVersion,
      participants: call.participants.map((p) => ({ role: p.role, phoneNumber: p.phoneNumber, customerId: p.customerId, employeeId: p.employeeId })),
      transcript: call.transcript.map((t) => ({ speaker: t.speaker, text: t.text, offsetMs: t.offsetMs, interrupted: t.interrupted })),
    };
  });

  return { placeCall };
}
