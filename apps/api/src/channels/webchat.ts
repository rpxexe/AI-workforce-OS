// The web chat widget: a script any website embeds, and the public endpoints it talks to.
//
//   <script src="<api>/widget.js" data-key="wc_..." async></script>
//   optional, to continue as a known customer: data-customer="+14155550100" data-customer-hash="<hex>"
//   where the hash is HMAC-SHA256(identity secret, customer), computed on the website's server.
//
// Visitors without a verified identity are anonymous ("visitor:<uuid>", kept in the browser), so a
// website can never claim someone else's phone number and read what the employee knows about them.
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { runTurn } from "@workforce/agent-runtime";
import { prisma } from "@workforce/database";
import { identifyCustomer } from "@workforce/memory";
import { channelConfigSchemas, chatMessageSchema, chatSessionSchema, normalizeCustomerId, type ChatStreamEvent } from "@workforce/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { httpError } from "../auth.ts";
import { liveEmployee, overLimit, recordMessage, updateMessage, RATE_LIMIT_PER_MINUTE, type ChannelService } from "./service.ts";

const WIDGET = readFileSync(new URL("./widget.js", import.meta.url), "utf8");
const SESSION_HOURS = 12;
const keyParams = z.object({ key: z.string().min(1).max(100) });

type Session = { c: string; u: string; x: string; e: number };

/** HMAC-SHA256 of the customer id with the channel's identity secret: what the website's server computes. */
export const identityHash = (secret: string, customer: string) => createHmac("sha256", secret).update(customer).digest("hex");

const mac = (secret: string, body: string) => createHmac("sha256", secret).update(`session:${body}`).digest("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

const signSession = (secret: string, session: Session) => {
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${body}.${mac(secret, body)}`;
};

const readSession = (secret: string, channelId: string, header: string | undefined): Session | null => {
  const [body = "", signature = ""] = (header ?? "").replace(/^Bearer /, "").split(".");
  if (!body || !same(signature, mac(secret, body))) return null;
  const session = JSON.parse(Buffer.from(body, "base64url").toString()) as Session;
  return session.c === channelId && session.e > Date.now() ? session : null;
};

const frame = (event: ChatStreamEvent) => `data: ${JSON.stringify(event)}\n\n`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function webChatRoutes(app: FastifyInstance, service: ChannelService) {
  /** The enabled web chat channel with this key, if the page asking is allowed to show it. */
  const channelFor = async (req: FastifyRequest) => {
    const { key } = keyParams.parse(req.params);
    const channel = await prisma.employeeChannel.findUnique({ where: { kind_address: { kind: "web_chat", address: key } } });
    if (!channel?.enabled) throw httpError(404, "This chat is not available");
    const config = channelConfigSchemas.web_chat.parse(channel.config);
    // Stops other websites embedding the widget (and spending on it). Requests without an Origin are not from a browser page.
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const host = URL.canParse(origin) ? new URL(origin).host : null;
      if (host !== req.host && !config.allowedOrigins.includes(origin.toLowerCase()))
        throw httpError(403, "This website is not allowed to show this chat");
    }
    return { channel, config };
  };

  app.get("/widget.js", async (_req, reply) =>
    reply.type("application/javascript; charset=utf-8").header("cache-control", "public, max-age=300").send(WIDGET),
  );

  // A page on the API that shows the widget, for trying the channel without a website.
  app.get("/chat/:key/demo", async (req, reply) => {
    const { channel } = await channelFor(req);
    const live = await liveEmployee(channel.employeeId);
    const name = escapeHtml(live?.version.name ?? "this employee");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Chat preview</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:32px 16px;color:#1f2328;background:#f6f7f9}main{max-width:640px;margin:0 auto}
@media (prefers-color-scheme:dark){body{color:#e6e6e6;background:#151718}}</style></head>
<body><main><h1>Chat preview</h1><p>This page shows the web chat widget for ${name}${live ? "" : " (not published or paused: it will not answer)"}.
Each visitor is anonymous unless your website vouches for them.</p></main>
<script src="/widget.js" data-key="${escapeHtml(channel.address)}" data-open="true" async></script></body></html>`);
  });

  // Starts (or resumes) a visitor's chat: who they are, the greeting, and the conversation so far.
  app.post("/chat/:key/session", async (req) => {
    const { channel, config } = await channelFor(req);
    const body = chatSessionSchema.parse(req.body ?? {});
    const live = await liveEmployee(channel.employeeId);
    if (!live) throw httpError(503, "No one is available to chat right now");

    let externalId: string;
    let visitorId: string | null = null;
    if (body.customer) {
      if (!body.customerHash || !same(body.customerHash, identityHash(channel.secret, body.customer)))
        throw httpError(403, "The visitor's identity could not be verified");
      externalId = normalizeCustomerId(body.customer);
    } else if (config.requireIdentity) throw httpError(403, "Sign in on this website to chat");
    else {
      visitorId = body.visitorId ?? randomUUID();
      externalId = `visitor:${visitorId}`;
    }
    const customerId = await identifyCustomer({ organizationId: channel.organizationId, workspaceId: channel.workspaceId }, externalId);
    const conversationId = await service.findConversation(channel, customerId);
    const history = conversationId
      ? await prisma.conversationMessage.findMany({
          where: { conversationId },
          orderBy: { createdAt: "desc" },
          take: 50,
          select: { role: true, content: true },
        })
      : [];
    return {
      token: signSession(channel.secret, { c: channel.id, u: customerId, x: externalId, e: Date.now() + SESSION_HOURS * 3_600_000 }),
      visitorId,
      verified: Boolean(body.customer),
      employee: { name: live.version.name },
      greeting: config.greeting,
      messages: history.reverse(),
    };
  });

  // One visitor message; the reply streams back as server-sent events, like test chat.
  app.post("/chat/:key/messages", async (req, reply) => {
    const { channel } = await channelFor(req);
    const session = readSession(channel.secret, channel.id, req.headers.authorization);
    if (!session) throw httpError(401, "Your chat session has expired. Reload the page to continue.");
    const { message } = chatMessageSchema.parse(req.body);
    const live = await liveEmployee(channel.employeeId);
    if (!live) throw httpError(503, "No one is available to chat right now");
    const startedAt = Date.now();

    const base = {
      organizationId: channel.organizationId,
      workspaceId: channel.workspaceId,
      employeeId: channel.employeeId,
      channelId: channel.id,
      channel: "web_chat",
      customerId: session.u,
    };
    const inbound = await recordMessage(req.log, { ...base, direction: "INBOUND", status: "RECEIVED", from: session.x, to: channel.address, text: message });
    const mark = async (data: Parameters<typeof updateMessage>[2]) => inbound && updateMessage(req.log, inbound.id, data);
    if (await overLimit(channel.id, session.x)) {
      await mark({ status: "REJECTED", error: `Rate limited: more than ${RATE_LIMIT_PER_MINUTE} messages in a minute` });
      throw httpError(429, "You are sending messages too quickly. Wait a minute and try again.");
    }
    const conversationId = await service.findConversation(channel, session.u);
    let input: ReturnType<ChannelService["turnInput"]>;
    try {
      input = service.turnInput(channel, live, session.u, conversationId);
    } catch (err) {
      req.log.error(err, "AI provider is misconfigured");
      await mark({ status: "FAILED", error: "The AI provider is not configured correctly on the server" });
      throw httpError(503, "The chat is not available right now");
    }

    const gone = new AbortController();
    reply.raw.on("close", () => gone.abort());
    const events = async function* () {
      let text = "";
      let ended = false;
      for await (const event of runTurn({ ...input, userMessage: message, signal: gone.signal })) {
        if (event.type === "text") {
          text += event.text;
          yield frame(event);
        } else if (event.type === "done") {
          ended = true;
          await mark({ status: "ANSWERED", conversationId: event.conversation.id });
          await recordMessage(req.log, {
            ...base,
            direction: "OUTBOUND",
            status: "SENT",
            conversationId: event.conversation.id,
            from: channel.address,
            to: session.x,
            text,
            attempts: 1,
            latencyMs: Date.now() - startedAt,
          });
          yield frame(event);
        } else {
          ended = true;
          req.log.error({ err: event.cause, kind: event.kind }, "Web chat turn failed");
          await mark({ status: "FAILED", error: event.message });
          yield frame({ type: "error", error: event.message });
        }
      }
      // The visitor left mid-reply: runTurn saved nothing.
      if (!ended && gone.signal.aborted) await mark({ status: "FAILED", error: "The visitor left before the reply finished" });
    };
    return reply.header("content-type", "text/event-stream").header("cache-control", "no-cache").send(Readable.from(events()));
  });
}
