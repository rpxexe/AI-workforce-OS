// Real-time notifications for people in the dashboard: an in-process event bus per workspace, streamed to
// signed-in members as server-sent events, plus who is answering each conversation (for the web chat widget).
//
// shortcut: in-process only, so every API instance has its own bus and presence. With more than one API
// instance, publish through Redis pub/sub (the dev stack already runs Redis) instead of the EventEmitter.
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { LiveEvent } from "@workforce/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { guards, type Authenticate } from "./auth.ts";

const workspaceParams = z.object({ workspaceId: z.string().min(1) });

/** Keeps idle connections (and proxies in between) open. */
const HEARTBEAT_MS = 25_000;
/** How long a typing ping counts as "typing". */
const TYPING_MS = 6_000;

export type LiveBus = ReturnType<typeof liveBus>;

export function liveBus() {
  const emitter = new EventEmitter();
  // Every open dashboard tab is a listener; the default limit of 10 is a leak warning, not a real limit.
  emitter.setMaxListeners(0);
  return {
    publish(workspaceId: string, event: LiveEvent) {
      emitter.emit(workspaceId, event);
    },
    subscribe(workspaceId: string, listener: (event: LiveEvent) => void) {
      emitter.on(workspaceId, listener);
      return () => void emitter.off(workspaceId, listener);
    },
  };
}

export type Presence = ReturnType<typeof agentPresence>;

/** Which person answers a conversation, and whether they are typing, as the widget shows it. */
export function agentPresence() {
  const agents = new Map<string, { name: string; typingUntil: number }>();
  return {
    /** Records the person's name; `typing` also marks them as typing for a few seconds. */
    touch(conversationId: string, name: string, typing: boolean) {
      const now = Date.now();
      agents.set(conversationId, { name: name || agents.get(conversationId)?.name || "", typingUntil: typing ? now + TYPING_MS : 0 });
    },
    /** The person answering, or null when nobody has written from the dashboard since the API started. */
    of(conversationId: string): { name: string | null; typing: boolean } | null {
      const agent = agents.get(conversationId);
      return agent ? { name: agent.name || null, typing: agent.typingUntil > Date.now() } : null;
    },
    forget(conversationId: string) {
      agents.delete(conversationId);
    },
  };
}

export function liveRoutes(app: FastifyInstance, authenticate: Authenticate, bus: LiveBus) {
  const { member, inWorkspace } = guards(authenticate);

  app.get("/workspaces/:workspaceId/events", async (req, reply) => {
    const { workspaceId } = workspaceParams.parse(req.params);
    const scope = await inWorkspace(member(req), workspaceId);

    const stream = new Readable({ read() {} });
    const send = (data: string) => stream.push(data);
    send(": connected\n\n");
    const unsubscribe = bus.subscribe(scope.workspaceId, (event) => send(`data: ${JSON.stringify(event)}\n\n`));
    const heartbeat = setInterval(() => send(": ping\n\n"), HEARTBEAT_MS);
    const stop = () => {
      clearInterval(heartbeat);
      unsubscribe();
      stream.push(null);
    };
    req.raw.on("close", stop);
    return reply.header("content-type", "text/event-stream").header("cache-control", "no-cache").header("x-accel-buffering", "no").send(stream);
  });
}
