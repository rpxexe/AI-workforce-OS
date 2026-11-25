// One live phone call. The voice channel has no brain of its own: every caller turn goes through
// `runTurn`, exactly like test chat, with the same employee, knowledge, memory and tools.
//
//   phone audio -> STT -> caller turn -> runTurn (LLM, tools) -> text -> Speaker (TTS) -> phone
import { createHmac, timingSafeEqual } from "node:crypto";
import { runTurn, type HandoffNotice, type HeldNotice } from "@workforce/agent-runtime";
import type { AIProvider, EmbeddingProvider, Route } from "@workforce/ai-provider";
import { prisma } from "@workforce/database";
import type { MemoryService } from "@workforce/memory";
import type { UsageLimiter } from "@workforce/shared";
import type { STTEvent, STTProvider, STTStream } from "@workforce/stt";
import type { MediaEvent, TelephonyProvider } from "@workforce/telephony";
import { ENDED_STATUSES } from "@workforce/telephony";
import { toolRegistry, type ToolExecutor } from "@workforce/tools";
import type { TTSProvider } from "@workforce/tts";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";
import { recordMessage } from "../channels/service.ts";
import { configOf } from "../employees.ts";
import { Speaker } from "./speaker.ts";

export type VoiceLimits = {
  /** Silence before "Are you still there?", and again before hanging up. */
  idleMs: number;
  /** Calls are ended after this long. */
  maxCallMs: number;
};

export type SessionDeps = {
  telephony: TelephonyProvider;
  /** The telephony connection the stream's URL names (null: the platform's account); it must be the call's. */
  connectionId: string | null;
  /** Speech for this call, resolved per call: workflow, employee, organization default, platform (Phase 14). */
  speech: (scope: { organizationId: string; workspaceId: string; employeeId: string; workflowId: string | null }) => Promise<{ stt: STTProvider | null; tts: TTSProvider | null }>;
  /** A provider bound to a route (tenant and task): the model router. */
  provider: (route: Route) => AIProvider;
  embedder: () => EmbeddingProvider;
  /** Customer memory for a tenant; extraction runs on the tenant's "memory" model. */
  memory: (scope: { organizationId: string; workspaceId: string }) => MemoryService;
  tools: ToolExecutor;
  timeoutMs: number;
  onHandoff?: (notice: HandoffNotice) => void;
  onHeld?: (notice: HeldNotice) => void;
  planLimits?: UsageLimiter;
  /** Where the provider reaches us (no trailing slash): the transfer result webhook is built from it. */
  publicUrl: string;
  secret: string;
  limits: VoiceLimits;
  log: FastifyBaseLogger;
};

// shortcut: fixed lines exist in English, Hindi and Hinglish; other languages hear English until they get their own
const LINES_EN = {
  apology: "Sorry, I had trouble with that. Could you say it again?",
  stillThere: "Are you still there?",
  idleGoodbye: "I haven't heard anything for a while, so I'll end the call now. Goodbye.",
  timeLimit: "We've reached the time limit for this call. Goodbye.",
  cannotHear: "Sorry, I'm having trouble hearing you right now. Please call again later.",
  withPerson: "A member of our team is handling this now and will get back to you shortly. Goodbye.",
  connecting: "I'm connecting you now. Please hold.",
  transferFailed: "Sorry, I couldn't connect you. A member of our team will call you back shortly. Goodbye.",
};
const LINES_BY_LANGUAGE: Record<string, typeof LINES_EN> = {
  hi: {
    apology: "माफ़ कीजिए, मुझे समझने में दिक्कत हुई। क्या आप दोबारा बोल सकते हैं?",
    stillThere: "क्या आप लाइन पर हैं?",
    idleGoodbye: "काफ़ी देर से कुछ सुनाई नहीं दिया, इसलिए कॉल समाप्त की जा रही है। नमस्ते।",
    timeLimit: "इस कॉल का समय पूरा हो गया है। नमस्ते।",
    cannotHear: "माफ़ कीजिए, अभी मुझे आपकी आवाज़ ठीक से सुनाई नहीं दे रही। कृपया थोड़ी देर बाद फिर कॉल करें।",
    withPerson: "हमारी टीम का एक सदस्य इसे देख रहा है और जल्द ही आपसे संपर्क करेगा। नमस्ते।",
    connecting: "आपको अभी जोड़ा जा रहा है। कृपया लाइन पर बने रहें।",
    transferFailed: "माफ़ कीजिए, आपको जोड़ा नहीं जा सका। हमारी टीम का एक सदस्य जल्द ही आपको वापस कॉल करेगा। नमस्ते।",
  },
  "hi-en": {
    apology: "Sorry, mujhe samajhne mein dikkat hui. Kya aap dobara bol sakte hain?",
    stillThere: "Kya aap line par hain?",
    idleGoodbye: "Kaafi der se kuch sunai nahi diya, isliye call end ki ja rahi hai. Thank you.",
    timeLimit: "Is call ka time limit pura ho gaya hai. Thank you.",
    cannotHear: "Sorry, abhi aapki awaaz theek se nahi aa rahi. Please thodi der baad phir call kijiye.",
    withPerson: "Hamari team ka ek member ise dekh raha hai aur jaldi aapse contact karega. Thank you.",
    connecting: "Aapko abhi connect kiya ja raha hai. Please line par bane rahiye.",
    transferFailed: "Sorry, aapko connect nahi kiya ja saka. Hamari team ka ek member jaldi aapko call back karega. Thank you.",
  },
};

/** The stream token proves a media stream belongs to a call we set up (Twilio does not sign the socket). */
export const streamToken = (secret: string, callId: string) => createHmac("sha256", secret).update(`stream:${callId}`).digest("hex");

const tokenValid = (secret: string, callId: string, token: string) => {
  const expected = Buffer.from(streamToken(secret, callId));
  const given = Buffer.from(token);
  return expected.length === given.length && timingSafeEqual(expected, given);
};

const joined = (...parts: string[]) => parts.filter(Boolean).join(" ");

export function runCallSession(socket: WebSocket, deps: SessionDeps) {
  const { telephony, log } = deps;
  let live: Awaited<ReturnType<typeof startCall>> | undefined;
  let stopped = false;

  socket.on("message", (data) => {
    const event = telephony.parseMedia(data.toString());
    if (event.type === "start") {
      startCall(event, socket, deps).then(
        (call) => {
          live = call;
          if (stopped) void call.finish();
        },
        (err: unknown) => {
          log.error({ err }, "Call stream could not start");
          // Closing the stream makes the provider play the fallback message and hang up.
          socket.close();
        },
      );
    } else if (event.type === "stop") {
      stopped = true;
      void live?.finish();
    } else live?.handle(event);
  });
  socket.on("close", () => {
    stopped = true;
    void live?.finish();
  });
  socket.on("error", (err) => log.warn({ err }, "Call stream socket error"));
}

async function startCall(event: Extract<MediaEvent, { type: "start" }>, socket: WebSocket, deps: SessionDeps) {
  const { telephony, log } = deps;
  const callId = event.parameters.callId ?? "";
  if (!tokenValid(deps.secret, callId, event.parameters.token ?? "")) throw new Error("Invalid stream token");

  const call = await prisma.call.findUnique({
    where: { id: callId },
    include: {
      employee: {
        include: {
          knowledgeSources: { select: { sourceId: true } },
          tools: { select: { tool: true } },
        },
      },
    },
  });
  if (!call) throw new Error(`Call ${callId} not found`);
  if (call.providerCallId && call.providerCallId !== event.providerCallId) throw new Error("Stream belongs to another call");
  if ((call.connectionId ?? null) !== deps.connectionId) throw new Error("Stream came in on another phone connection");
  // The version that was live when the call came in.
  const version = await prisma.aiEmployeeVersion.findUnique({
    where: { employeeId_number: { employeeId: call.employeeId, number: call.employeeVersion } },
  });
  if (!version) throw new Error("The call's employee version is missing");

  const employee = configOf(version);
  const LINES = LINES_BY_LANGUAGE[employee.language] ?? LINES_EN;
  const scope = { organizationId: call.organizationId, workspaceId: call.workspaceId };
  // Phone calls have their own task, so an organization can route them to a fast model.
  const overrides = { employeeId: call.employeeId, workflowId: call.workflowId };
  const provider = deps.provider({ ...scope, ...overrides, task: "voice" });
  const { stt: listener, tts } = await deps.speech({ ...scope, ...overrides });
  // Closing the stream makes the provider play its fallback line and hang up.
  if (!listener?.open || !tts) throw new Error("No live speech recognition or speech synthesis is configured for this call");
  const sourceIds = call.employee.knowledgeSources.map((k) => k.sourceId);
  const knowledge = sourceIds.length > 0 ? { embedder: deps.embedder(), sourceIds } : undefined;
  const specs = toolRegistry.specs(call.employee.tools.map((t) => t.tool));
  const tools = specs.length > 0 ? { executor: deps.tools, specs } : undefined;
  const memory = deps.memory(scope);

  const answeredAt = call.answeredAt ?? new Date();
  await prisma.call.update({
    where: { id: call.id },
    data: {
      status: "IN_PROGRESS",
      streamId: event.streamId,
      answeredAt,
      providerCallId: call.providerCallId ?? event.providerCallId,
    },
  });
  const providerCallId = call.providerCallId ?? event.providerCallId;
  const offset = () => Date.now() - answeredAt.getTime();

  const send = (message: string) => {
    if (socket.readyState === socket.OPEN) socket.send(message);
  };
  const out = {
    audio: (chunk: Buffer) => send(telephony.audioMessage(event.streamId, chunk)),
    mark: (name: string) => send(telephony.markMessage(event.streamId, name)),
    clear: () => send(telephony.clearMessage(event.streamId)),
  };
  const speakers = new Set<Speaker>();
  const newSpeaker = () => {
    const speaker = new Speaker(tts, employee.language, out, (err) => log.warn({ err, callId }, "Speech synthesis failed"));
    speakers.add(speaker);
    void speaker.played.then(() => speakers.delete(speaker));
    return speaker;
  };
  const line = (speaker: "CUSTOMER" | "EMPLOYEE", text: string, offsetMs: number, interrupted = false) => {
    if (!text) return;
    prisma.callTranscript
      .create({ data: { callId: call.id, speaker, text, offsetMs, interrupted } })
      .catch((err: unknown) => log.error({ err, callId }, "Saving a transcript line failed"));
  };

  // Each exchange also goes to the channel message log, like messages on every other channel.
  const callerNumber = call.direction === "INBOUND" ? call.from : call.to;
  const ourNumber = call.direction === "INBOUND" ? call.to : call.from;
  const logTurn = (heard: string, reply: string | null, error: string | null, latencyMs: number) => {
    const base = { ...scope, employeeId: call.employeeId, channel: "voice", customerId: call.customerId, conversationId };
    void recordMessage(log, {
      ...base,
      direction: "INBOUND",
      // No reply and no error: people have the conversation, the employee stayed silent.
      status: error ? "FAILED" : reply === null ? "HELD" : "ANSWERED",
      error,
      from: callerNumber,
      to: ourNumber,
      text: heard,
    });
    if (reply !== null)
      void recordMessage(log, { ...base, direction: "OUTBOUND", status: "SENT", from: ourNumber, to: callerNumber, text: reply, attempts: 1, latencyMs });
  };

  let conversationId = call.conversationId ?? undefined;
  /** The reply being written, if any. `saved` once runTurn stored the exchange. */
  let turn: { abort: AbortController; userText: string; saved: boolean } | undefined;
  /** What the caller said in a turn that was cut off before it was saved; prepended to the next. */
  let carried = "";
  let finished = false;
  let idleStage = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const speaking = () => [...speakers].some((s) => s.active);

  /** Says a fixed line (greeting, prompts) and records it. */
  const speakLine = async (text: string) => {
    const speaker = newSpeaker();
    const at = offset();
    speaker.push(text);
    speaker.end();
    await speaker.played;
    line("EMPLOYEE", speaker.spoken, at, speaker.interrupted);
  };

  const hangUp = () => {
    if (!providerCallId) return;
    telephony.endCall(providerCallId).catch((err: unknown) => log.error({ err, callId }, "Hanging up failed"));
  };

  // Live transfer: after a handoff the provider dials the employee's transfer number, which ends this stream.
  // How the dial ends comes to POST /voice/<provider>/transfer (routes.ts), which also plays the fallback.
  const transferTo = employee.escalation.transferNumber;
  let transferred = false;
  /** Hands the caller to a person; without a transfer number, or if the provider refuses, hangs up for a callback. */
  const handOver = async () => {
    if (!transferTo || !providerCallId) return hangUp();
    const handoff = conversationId ? await prisma.handoff.findFirst({ where: { conversationId, endedAt: null }, select: { id: true } }) : null;
    // The audit row exists before the provider is asked, so every attempt is on record.
    const attempt = await prisma.callTransfer.create({
      data: { ...scope, callId: call.id, conversationId, handoffId: handoff?.id, to: transferTo },
      select: { id: true },
    });
    log.info({ callId, transferId: attempt.id }, "Transferring the call");
    // Set first: the provider may close our stream before its API call returns, and finish() must not end the call.
    transferred = true;
    try {
      await telephony.transferCall(providerCallId, transferTo, `${deps.publicUrl}/voice/${telephony.name}${deps.connectionId ? `/c/${deps.connectionId}` : ""}/transfer?transferId=${attempt.id}`);
    } catch (err) {
      transferred = false;
      log.error({ err, callId, transferId: attempt.id }, "Transferring the call failed");
      await prisma.callTransfer
        .update({ where: { id: attempt.id }, data: { status: "FAILED", error: err instanceof Error ? err.message : String(err), endedAt: new Date() } })
        .catch((e: unknown) => log.error({ err: e, callId }, "Recording a failed transfer failed"));
      await speakLine(LINES.transferFailed);
      hangUp();
    }
  };

  const waitForCaller = () => {
    clearTimeout(idleTimer);
    if (finished) return;
    idleTimer = setTimeout(() => {
      if (turn || speaking()) return waitForCaller();
      idleStage++;
      if (idleStage === 1) void speakLine(LINES.stillThere).then(waitForCaller);
      else void speakLine(LINES.idleGoodbye).then(hangUp);
    }, deps.limits.idleMs);
  };
  const heardCaller = () => {
    idleStage = 0;
    clearTimeout(idleTimer);
  };

  /** The caller talks over the employee: stop speaking, and drop a reply not yet saved. */
  const interrupt = () => {
    if (turn) {
      if (!turn.saved) carried = joined(carried, turn.userText);
      turn.abort.abort();
      turn = undefined;
    }
    for (const speaker of speakers) speaker.interrupt();
  };

  const respond = async (heard: string) => {
    interrupt();
    heardCaller();
    const userText = joined(carried, heard);
    carried = "";
    line("CUSTOMER", heard, offset());

    const current = { abort: new AbortController(), userText, saved: false };
    turn = current;
    const speaker = newSpeaker();
    const at = offset();
    const turnStarted = Date.now();
    let replyText = "";
    // After a handoff the call is transferred to a person, or the employee hangs up and a person calls back.
    let handedOff = false;
    for await (const result of runTurn({
      provider,
      ...scope,
      employeeId: call.employeeId,
      userId: "voice",
      employee,
      employeeVersion: call.employeeVersion,
      conversationId,
      knowledge,
      customer: call.customerId
        ? { id: call.customerId, memory, onError: (err) => log.error({ err, callId }, "Updating customer memory failed") }
        : undefined,
      tools,
      channel: "voice",
      userMessage: userText,
      timeoutMs: deps.timeoutMs,
      signal: current.abort.signal,
      onHandoff: deps.onHandoff,
      onHeld: deps.onHeld,
      planLimits: deps.planLimits,
    })) {
      if (result.type === "text") {
        speaker.push(result.text);
        replyText += result.text;
      } else if (result.type === "held") {
        current.saved = true;
        handedOff = true;
        logTurn(userText, null, null, Date.now() - turnStarted);
        speaker.push(transferTo ? LINES.connecting : LINES.withPerson);
      } else if (result.type === "done") {
        current.saved = true;
        if (result.handoff) {
          handedOff = true;
          if (transferTo) speaker.push(` ${LINES.connecting}`);
        }
        if (!conversationId) {
          conversationId = result.conversation.id;
          await prisma.call.update({ where: { id: call.id }, data: { conversationId } });
        }
        logTurn(userText, replyText, null, Date.now() - turnStarted);
      } else {
        log.error({ err: result.cause, kind: result.kind, callId }, "Voice turn failed");
        logTurn(userText, null, result.message, Date.now() - turnStarted);
        speaker.push(` ${LINES.apology}`);
      }
    }
    if (turn === current) turn = undefined;
    speaker.end();
    await speaker.played;
    line("EMPLOYEE", speaker.spoken, at, speaker.interrupted);
    if (handedOff && !speaker.interrupted) return handOver();
    if (!turn && !speaking()) waitForCaller();
  };

  const onSpeech = (e: STTEvent) => {
    if (finished) return;
    if (e.type === "partial") {
      heardCaller();
      // Real words, not noise, while the employee is talking or thinking: barge-in.
      if (/[\p{L}\p{N}]/u.test(e.text) && (turn || speaking())) interrupt();
    } else if (e.type === "turn") {
      respond(e.text).catch((err: unknown) => log.error({ err, callId }, "Voice turn crashed"));
    } else {
      log.error({ err: e.error, callId }, "Speech recognition failed");
      void speakLine(LINES.cannotHear).then(hangUp);
    }
  };

  let stt: STTStream | undefined;
  try {
    stt = listener.open({ language: employee.language, onEvent: onSpeech });
  } catch (err) {
    log.error({ err, callId }, "Speech recognition could not start");
    void speakLine(LINES.cannotHear).then(hangUp);
  }
  const maxTimer = setTimeout(() => void speakLine(LINES.timeLimit).then(hangUp), deps.limits.maxCallMs);
  void speakLine(call.greeting).then(() => {
    if (!turn && !speaking()) waitForCaller();
  });

  return {
    handle(e: MediaEvent) {
      if (e.type === "audio") stt?.send(e.audio);
      else if (e.type === "mark") for (const speaker of speakers) speaker.heard(e.name);
    },

    /** The call ended (hang-up or stream closed). Runs once. */
    async finish() {
      if (finished) return;
      finished = true;
      clearTimeout(idleTimer);
      clearTimeout(maxTimer);
      stt?.close();
      interrupt();
      // A transferred call goes on with the person; the provider's status callback records its end.
      if (transferred) return;
      try {
        const now = await prisma.call.findUnique({ where: { id: call.id }, select: { status: true, endedAt: true, durationSec: true } });
        if (!now) return;
        await prisma.call.update({
          where: { id: call.id },
          data: {
            // The provider's status callback may already have said how it ended.
            status: ENDED_STATUSES.includes(now.status) ? now.status : "COMPLETED",
            endedAt: now.endedAt ?? new Date(),
            durationSec: now.durationSec ?? Math.round(offset() / 1000),
          },
        });
      } catch (err) {
        log.error({ err, callId }, "Recording the end of the call failed");
      }
    },
  };
}
