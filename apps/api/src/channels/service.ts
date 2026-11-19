// The channel pipeline. Every messaging channel ends up here, in the common model:
//
//   InboundMessage -> audit row (deduplicated) -> one at a time per customer -> customer (memory)
//   -> conversation (continued or new) -> files read -> runTurn (the published employee)
//   -> reply split to the channel's limits -> ChannelSender -> audit rows with delivery state
//
// Like voice, channels have no logic of their own for answers: `runTurn` writes every reply.
import { runTurn, type TurnInput } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider } from "@workforce/ai-provider";
import { ChannelError, splitText, taggedAddress, type ChannelSender, type DeliveryUpdate, type InboundMessage, type WhatsAppProvider } from "@workforce/channels";
import { prisma, type Prisma } from "@workforce/database";
import { parseDocument } from "@workforce/knowledge";
import type { MemoryService } from "@workforce/memory";
import {
  CHANNEL_CAPABILITIES,
  knowledgeKindOf,
  MAX_UPLOAD_BYTES,
  type ChannelKind,
  type ChannelMedia,
  type ChannelMessageStatus,
  type KnowledgeKind,
  type WhatsAppProviderName,
} from "@workforce/shared";
import type { STTProvider } from "@workforce/stt";
import { toolRegistry, type ToolExecutor } from "@workforce/tools";
import type { FastifyBaseLogger } from "fastify";
import { configOf } from "../employees.ts";

export type Ai = {
  provider: () => AIProvider;
  embedder: () => EmbeddingProvider;
  memory: (provider: AIProvider, timeoutMs: number) => MemoryService;
  tools: ToolExecutor;
  timeoutMs: number;
};

export type ChannelRow = Prisma.EmployeeChannelGetPayload<object>;

/** A conversation on a chat channel continues while the customer writes again within this long (WhatsApp's own service window). */
export const SESSION_MS = 24 * 60 * 60_000;
/** Inbound messages per customer per channel per minute; more are logged and not answered. */
export const RATE_LIMIT_PER_MINUTE = 20;
/** Characters of a document the customer sends that the employee reads. */
const DOCUMENT_CHARS = 8000;

const LINES = {
  apology: "Sorry, I had trouble answering that. Please try again in a moment.",
  unsupported: "Sorry, I can only read text, voice messages and documents here. Could you write your question instead?",
};

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Which provider carries a WhatsApp channel (settings saved before providers existed are Meta's). */
export const whatsappProviderOf = (channel: ChannelRow) => ((channel.config as { provider?: string }).provider ?? "meta") as WhatsAppProviderName;

/** Documents sent without a file name (Twilio, Telnyx) are recognised by their type. */
const DOCUMENT_KINDS: Record<string, KnowledgeKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "text/plain": "txt",
  "text/csv": "csv",
};

/** The employee's published version and what it works with, or null when it does not answer customers. */
export async function liveEmployee(employeeId: string) {
  const employee = await prisma.aiEmployee.findUnique({
    where: { id: employeeId },
    include: { publishedVersion: true, knowledgeSources: { select: { sourceId: true } }, tools: { select: { tool: true } } },
  });
  if (employee?.status !== "ACTIVE" || !employee.publishedVersion) return null;
  return {
    version: employee.publishedVersion,
    sourceIds: employee.knowledgeSources.map((k) => k.sourceId),
    tools: employee.tools.map((t) => t.tool),
  };
}
export type LiveEmployee = NonNullable<Awaited<ReturnType<typeof liveEmployee>>>;

/** Writes one audit row; a failure is logged, never thrown, so logging cannot break a reply. */
export async function recordMessage(log: FastifyBaseLogger, data: Prisma.ChannelMessageUncheckedCreateInput) {
  log.info(
    { channel: data.channel, direction: data.direction, status: data.status, employeeId: data.employeeId, latencyMs: data.latencyMs },
    "channel message",
  );
  return prisma.channelMessage.create({ data, select: { id: true } }).catch((err: unknown) => {
    log.error({ err }, "Recording a channel message failed");
    return null;
  });
}

export async function updateMessage(log: FastifyBaseLogger, id: string, data: Prisma.ChannelMessageUncheckedUpdateInput) {
  if (data.status) log.info({ messageId: id, status: data.status, error: data.error }, "channel message");
  await prisma.channelMessage.update({ where: { id }, data }).catch((err: unknown) => log.error({ err }, "Updating a channel message failed"));
}

/** Whether the customer has sent more than the limit on this channel in the last minute (this message included). */
export async function overLimit(channelId: string, customerFrom: string) {
  const recent = await prisma.channelMessage.count({
    where: { channelId, from: customerFrom, direction: "INBOUND", createdAt: { gte: new Date(Date.now() - 60_000) } },
  });
  return recent > RATE_LIMIT_PER_MINUTE;
}

const RANK: Partial<Record<ChannelMessageStatus, number>> = { PENDING: 0, SENT: 1, DELIVERED: 2, READ: 3 };

export function channelService(deps: {
  ai: Ai;
  stt: STTProvider | null;
  whatsapp: WhatsAppProvider[];
  email: ChannelSender;
  log: FastifyBaseLogger;
  /** Queues the answering of a recorded message (a background job). Jobs with the same `queueKey` run one at a time, in order. */
  enqueue: (job: { messageId: string; queueKey: string }) => Promise<void>;
}) {
  const { ai, log } = deps;
  /** The provider carrying a WhatsApp channel's number, if the server has its credentials. */
  const whatsappOf = (channel: ChannelRow) => deps.whatsapp.find((p) => p.name === whatsappProviderOf(channel));

  /** The conversation a new message on `channel` belongs to: the customer's recent one, or none (start a new one). */
  const findConversation = async (channel: ChannelRow, customerId: string, thread: Pick<InboundMessage, "inReplyTo" | "threadTag"> = {}) => {
    if (channel.kind === "email") {
      // Email threads continue when the customer replies to one of our emails, however long after: our replies
      // go out with Reply-To support+<conversation id>@..., and the test-mode hook matches In-Reply-To.
      const { inReplyTo, threadTag } = thread;
      if (threadTag) {
        const tagged = await prisma.conversation.findFirst({
          where: { id: threadTag, employeeId: channel.employeeId, channel: "email", customer: { customerId } },
          select: { id: true },
        });
        if (tagged) return tagged.id;
      }
      if (!inReplyTo) return undefined;
      const sent = await prisma.channelMessage.findFirst({
        where: { channelId: channel.id, direction: "OUTBOUND", providerMessageId: inReplyTo, customerId },
        select: { conversationId: true },
      });
      return sent?.conversationId ?? undefined;
    }
    const recent = await prisma.conversation.findFirst({
      where: {
        organizationId: channel.organizationId,
        workspaceId: channel.workspaceId,
        employeeId: channel.employeeId,
        channel: channel.kind,
        customer: { customerId },
        updatedAt: { gte: new Date(Date.now() - SESSION_MS) },
      },
      orderBy: { updatedAt: "desc" },
      select: { id: true },
    });
    return recent?.id;
  };

  /** Everything `runTurn` needs to answer `customerId` on `channel`, except the message. Throws if the AI provider is not configured. */
  const turnInput = (channel: ChannelRow, live: LiveEmployee, customerId: string, conversationId: string | undefined) => {
    const provider = ai.provider();
    // The channel may allow fewer tools than are granted; the executor refuses any other.
    const allowed = channel.allowedTools as string[] | null;
    const specs = toolRegistry.specs(live.tools.filter((t) => !allowed || allowed.includes(t)));
    return {
      provider,
      organizationId: channel.organizationId,
      workspaceId: channel.workspaceId,
      employeeId: channel.employeeId,
      userId: channel.kind,
      employee: configOf(live.version),
      employeeVersion: live.version.number,
      conversationId,
      knowledge: live.sourceIds.length > 0 ? { embedder: ai.embedder(), sourceIds: live.sourceIds } : undefined,
      customer: {
        id: customerId,
        memory: ai.memory(provider, ai.timeoutMs),
        onError: (err: unknown) => log.error({ err, channel: channel.kind }, "Updating customer memory failed"),
      },
      tools: specs.length > 0 ? { executor: ai.tools, specs } : undefined,
      channel: channel.kind,
      timeoutMs: ai.timeoutMs,
    } satisfies Omit<TurnInput, "userMessage">;
  };

  /** Turns the files in a message into text the employee can read: voice notes transcribed, documents extracted, the rest described. */
  const readMedia = async (channel: ChannelRow, inbound: InboundMessage, language: string) => {
    const provider = whatsappOf(channel);
    const parts: string[] = [];
    const media: ChannelMedia[] = [];
    for (const m of inbound.media) {
      const record: ChannelMedia = { kind: m.kind, mimeType: m.mimeType, ...(m.filename && { filename: m.filename }), ...(m.caption && { caption: m.caption }) };
      const caption = m.caption ? ` with the caption "${m.caption}"` : "";
      const kind = m.filename ? knowledgeKindOf(m.filename) : DOCUMENT_KINDS[m.mimeType.split(";")[0]?.trim() ?? ""];
      try {
        if (!provider) throw new Error(`The ${whatsappProviderOf(channel)} WhatsApp provider is not configured`);
        if (m.kind === "audio") {
          if (!deps.stt?.transcribe) {
            record.note = "Not transcribed: speech recognition (DEEPGRAM_API_KEY) is not configured";
            parts.push(`[The customer sent a voice message${caption}, which you cannot listen to.]`);
          } else {
            const file = await provider.downloadMedia(m, channel.address, MAX_UPLOAD_BYTES);
            record.sizeBytes = file.data.length;
            const transcript = await deps.stt.transcribe(file.data, { mimeType: file.mimeType, language });
            record.note = transcript ? `Transcript: ${transcript}` : "No words were heard";
            parts.push(transcript ? `[Voice message${caption}, transcribed]: ${transcript}` : "[The customer sent a voice message with no audible words.]");
          }
        } else if (m.kind === "document" && kind) {
          const file = await provider.downloadMedia(m, channel.address, MAX_UPLOAD_BYTES);
          record.sizeBytes = file.data.length;
          const text = (await parseDocument(kind, file.data)).map((s) => [s.header, s.text].filter(Boolean).join("\n")).join("\n\n").trim();
          const shown = text.slice(0, DOCUMENT_CHARS);
          record.note = `Read ${text.length} characters`;
          parts.push(
            `[The customer sent the document "${m.filename}"${caption}. Its text${shown.length < text.length ? " (beginning only)" : ""}:]\n${shown || "(no text found)"}`,
          );
        } else {
          // shortcut: images and videos are described, not seen; pass them to a vision model when the providers take images
          record.note = "Not read: the employee cannot see this kind of file";
          parts.push(`[The customer sent ${m.kind === "image" ? "an image" : `a ${m.kind}`}${m.filename ? ` named "${m.filename}"` : ""}${caption}, which you cannot see.]`);
        }
      } catch (err) {
        record.note = `Could not be read: ${errorText(err)}`;
        parts.push(`[The customer sent a ${m.kind}${caption} that could not be opened.]`);
      }
      media.push(record);
    }
    return { text: media.length > 0 ? parts.join("\n") : inbound.text, media };
  };

  const senderFor = (channel: ChannelRow): ChannelSender | null =>
    channel.kind === "whatsapp" ? (whatsappOf(channel) ?? null) : channel.kind === "email" ? deps.email : null;

  /** Sends a reply (split to the channel's limit) and records each part with its delivery state. Stops at the first failure. */
  const send = async (
    channel: ChannelRow,
    to: string,
    text: string,
    context: { customerId: string; conversationId?: string; startedAt: number; subject?: string; inReplyTo?: string; fromName?: string },
  ) => {
    const sender = senderFor(channel);
    for (const part of splitText(text, CHANNEL_CAPABILITIES[channel.kind as ChannelKind]?.maxChars ?? null)) {
      const row = await recordMessage(log, {
        organizationId: channel.organizationId,
        workspaceId: channel.workspaceId,
        employeeId: channel.employeeId,
        channelId: channel.id,
        channel: channel.kind,
        direction: "OUTBOUND",
        status: "PENDING",
        customerId: context.customerId,
        conversationId: context.conversationId,
        from: channel.address,
        to,
        text: part,
      });
      try {
        if (!sender) throw new ChannelError(`The ${channel.kind === "whatsapp" ? `${whatsappProviderOf(channel)} WhatsApp provider` : channel.kind} is not configured on the server`);
        const sent = await sender.send({
          address: channel.address,
          to,
          text: part,
          subject: context.subject,
          inReplyTo: context.inReplyTo,
          fromName: context.fromName,
          ...(channel.kind === "email" && context.conversationId && { replyTo: taggedAddress(channel.address, context.conversationId) }),
          idempotencyKey: row?.id,
        });
        if (row)
          await updateMessage(log, row.id, {
            status: "SENT",
            providerMessageId: sent.providerMessageId,
            attempts: sent.attempts,
            latencyMs: Date.now() - context.startedAt,
          });
      } catch (err) {
        log.error({ err, channel: channel.kind }, "Sending a reply failed");
        if (row) await updateMessage(log, row.id, { status: "FAILED", error: errorText(err), attempts: err instanceof ChannelError ? err.attempts : 1 });
        return;
      }
    }
  };

  /** Answers one inbound message. Runs one at a time per customer and channel, so replies keep their order. */
  const answer = async (channel: ChannelRow, inbound: InboundMessage, rowId: string) => {
    const startedAt = Date.now();
    const scope = { organizationId: channel.organizationId, workspaceId: channel.workspaceId };
    const reject = (error: string) => updateMessage(log, rowId, { status: "REJECTED", error });

    if (!channel.enabled) return reject("The channel is turned off");
    if (await overLimit(channel.id, inbound.from)) return reject(`Rate limited: more than ${RATE_LIMIT_PER_MINUTE} messages in a minute`);
    const live = await liveEmployee(channel.employeeId);
    if (!live) return reject("The employee is not published, or is paused");

    let provider: AIProvider;
    try {
      provider = ai.provider();
    } catch (err) {
      log.error({ err }, "AI provider is misconfigured");
      return updateMessage(log, rowId, { status: "FAILED", error: "The AI provider is not configured correctly on the server" });
    }
    const customerId = await ai.memory(provider, ai.timeoutMs).identify(scope, inbound.from);
    await updateMessage(log, rowId, { customerId });
    if (channel.kind === "whatsapp")
      whatsappOf(channel)
        ?.markRead?.(channel.address, inbound.providerMessageId)
        .catch((err: unknown) => log.warn({ err }, "Marking a WhatsApp message read failed"));

    const subject = inbound.subject !== undefined ? (/^re:/i.test(inbound.subject) ? inbound.subject : `Re: ${inbound.subject}`.trim()) : undefined;
    const reply = { customerId, startedAt, subject, inReplyTo: inbound.channel === "email" ? inbound.providerMessageId : undefined, fromName: live.version.name };
    // The inbound row settles last, after any reply is handed to the channel: RECEIVED means "still being answered".
    if (inbound.unsupported) {
      await send(channel, inbound.from, LINES.unsupported, reply);
      return reject(`Unsupported message type: ${inbound.unsupported}`);
    }
    const { text, media } = await readMedia(channel, inbound, live.version.language);
    if (media.length > 0) await updateMessage(log, rowId, { media: media as Prisma.InputJsonValue });
    if (!text.trim()) return reject("The message was empty");

    const conversationId = await findConversation(channel, customerId, inbound);
    let input: ReturnType<typeof turnInput>;
    try {
      input = turnInput(channel, live, customerId, conversationId);
    } catch (err) {
      log.error({ err }, "AI provider is misconfigured");
      return updateMessage(log, rowId, { status: "FAILED", error: "The AI provider is not configured correctly on the server" });
    }
    let replyText = "";
    for await (const event of runTurn({ ...input, userMessage: text })) {
      if (event.type === "text") replyText += event.text;
      else if (event.type === "done") {
        await send(channel, inbound.from, replyText, { ...reply, conversationId: event.conversation.id });
        return updateMessage(log, rowId, { status: "ANSWERED", conversationId: event.conversation.id });
      } else {
        log.error({ err: event.cause, kind: event.kind, channel: channel.kind }, "Channel turn failed");
        await send(channel, inbound.from, LINES.apology, { ...reply, conversationId });
        return updateMessage(log, rowId, { status: "FAILED", error: event.message });
      }
    }
  };

  return {
    findConversation,
    turnInput,

    /**
     * Takes an inbound message for `channel`: records it (a message seen before is ignored, since
     * providers retry webhooks) and queues the job that answers it.
     */
    async receive(channel: ChannelRow, inbound: InboundMessage) {
      const { count } = await prisma.channelMessage.createMany({
        data: [
          {
            organizationId: channel.organizationId,
            workspaceId: channel.workspaceId,
            employeeId: channel.employeeId,
            channelId: channel.id,
            channel: channel.kind,
            direction: "INBOUND",
            status: "RECEIVED",
            providerMessageId: inbound.providerMessageId,
            from: inbound.from,
            to: channel.address,
            text: inbound.text,
            ...(inbound.media.length > 0 && { media: inbound.media.map(({ kind, mimeType, filename, caption }) => ({ kind, mimeType, filename, caption })) }),
            payload: inbound as unknown as Prisma.InputJsonValue,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) return log.info({ providerMessageId: inbound.providerMessageId }, "Duplicate channel message ignored");
      const row = await prisma.channelMessage.findUniqueOrThrow({
        where: { channel_direction_providerMessageId: { channel: channel.kind, direction: "INBOUND", providerMessageId: inbound.providerMessageId } },
        select: { id: true },
      });
      log.info({ channel: channel.kind, direction: "INBOUND", status: "RECEIVED", employeeId: channel.employeeId }, "channel message");
      await deps.enqueue({ messageId: row.id, queueKey: `${channel.id}:${inbound.from}` });
    },

    /**
     * The background job: answers a recorded inbound message. Only a message still RECEIVED is
     * answered, so a job delivered twice does not answer twice.
     */
    async answerRecorded(messageId: string) {
      const row = await prisma.channelMessage.findUnique({ where: { id: messageId } });
      if (!row || row.status !== "RECEIVED" || !row.channelId || !row.payload) return;
      const channel = await prisma.employeeChannel.findUnique({ where: { id: row.channelId } });
      if (!channel) return updateMessage(log, row.id, { status: "REJECTED", error: "The channel was removed" });
      const inbound = row.payload as unknown as InboundMessage;
      await answer(channel, { ...inbound, receivedAt: new Date(inbound.receivedAt) }, row.id);
    },

    /** A delivery receipt. States only move forward (receipts can arrive out of order); FAILED always wins. */
    async delivery(channel: ChannelKind, update: DeliveryUpdate) {
      const where = { channel, direction: "OUTBOUND" as const, providerMessageId: update.providerMessageId };
      if (update.status === "FAILED") {
        await prisma.channelMessage.updateMany({ where: { ...where, status: { not: "FAILED" } }, data: { status: "FAILED", error: update.error ?? "Delivery failed" } });
        log.warn({ channel, providerMessageId: update.providerMessageId, error: update.error }, "Channel message delivery failed");
        return;
      }
      const rank = RANK[update.status] ?? 0;
      const lower = (Object.keys(RANK) as ChannelMessageStatus[]).filter((s) => (RANK[s] ?? 0) < rank);
      await prisma.channelMessage.updateMany({ where: { ...where, status: { in: lower } }, data: { status: update.status } });
    },
  };
}

export type ChannelService = ReturnType<typeof channelService>;
