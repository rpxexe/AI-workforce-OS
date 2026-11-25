"use client";

// Live chat notifications: one event stream per signed-in tab (GET /workspaces/:id/events), turned into
// toasts with an Open button, a short sound, desktop notifications while the tab is in the background,
// the waiting count on Conversations in the sidebar, and that count in the browser tab title.
import { useAuth } from "@clerk/nextjs";
import type { InboxResponse, LiveEvent } from "@workforce/shared";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { toast } from "sonner";
import { API_URL, useApiQuery } from "@/lib/api";
import { useMembers } from "@/lib/members";
import { useWorkspaces } from "@/lib/workspace";

const DESKTOP_ASKED = "workforce:desktop-alerts-asked";
/** Counts are refreshed by events; this is only the fallback when the stream is down. */
const COUNTS_FALLBACK_MS = 60_000;

const LiveContext = createContext<{ waiting: number }>({ waiting: 0 });

/** How many conversations wait for a person, unassigned (the Conversations badge). */
export const useWaitingCount = () => useContext(LiveContext).waiting;

/** A short two-note chime made with Web Audio, so there is no sound file to ship. */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + i * 0.12;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.15, start + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.25);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    });
    setTimeout(() => void ctx.close(), 800);
  } catch {
    // No audio (blocked until the person interacts with the page, or unsupported): the toast still shows.
  }
}

/** Reads the event stream until it ends; throws when it cannot connect. */
async function readEvents(url: string, token: string | null, signal: AbortSignal, onEvent: (e: LiveEvent) => void) {
  const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal });
  if (!res.ok || !res.body) throw new Error(`Live events refused (${res.status})`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += value;
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)) as LiveEvent);
  }
}

export function LiveNotifications({ children }: { children: ReactNode }) {
  const { getToken, userId } = useAuth();
  const { workspace } = useWorkspaces();
  const { nameOf } = useMembers();
  const router = useRouter();
  const pathname = usePathname();
  const workspaceId = workspace?.id;

  const counts = useApiQuery<InboxResponse>(workspaceId ? `/workspaces/${workspaceId}/inbox?view=queue` : null);
  const waiting = counts.data?.counts.queue ?? 0;

  // The handler reads the latest values without reconnecting the stream on every render.
  const latest = useRef({ userId, nameOf, pathname, router, reload: counts.reload });
  useEffect(() => {
    latest.current = { userId, nameOf, pathname, router, reload: counts.reload };
  });

  const alert = useCallback((conversationId: string, title: string, description: string, kind: "warning" | "info") => {
    const { pathname, router } = latest.current;
    const href = `/conversations/${conversationId}`;
    // Already looking at it: the conversation page shows the change itself.
    if (pathname === href) return;
    const open = () => router.push(href);
    toast[kind](title, { description, action: { label: "Open", onClick: open }, duration: 10_000 });
    chime();
    if (document.hidden && "Notification" in window && Notification.permission === "granted") {
      const n = new Notification(title, { body: description, tag: conversationId });
      n.onclick = () => {
        window.focus();
        open();
        n.close();
      };
    }
  }, []);

  const handle = useCallback(
    (event: LiveEvent) => {
      const { userId, nameOf, reload } = latest.current;
      switch (event.type) {
        case "handoff":
          reload();
          alert(
            event.conversationId,
            event.reminder ? `Still waiting for a person (${event.waitingMinutes} min)` : `${event.employeeName} needs a person`,
            event.reason,
            "warning",
          );
          break;
        case "customer_message":
          // Unassigned ones are covered by the handoff alert and the badge; tell only the person handling it.
          if (event.assignedTo !== null && event.assignedTo === userId) alert(event.conversationId, "New message from a customer", event.preview, "info");
          break;
        case "assigned":
          reload();
          if (event.assignedTo === userId) alert(event.conversationId, "A conversation was assigned to you", `By ${nameOf(event.by)}`, "info");
          break;
        case "inbox_changed":
          reload();
          break;
      }
    },
    [alert],
  );

  // One stream per tab; reconnects with a growing delay (1 s up to 30 s) after it drops.
  useEffect(() => {
    if (!workspaceId) return;
    const controller = new AbortController();
    let delay = 1000;
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          await readEvents(`${API_URL}/workspaces/${workspaceId}/events`, await getToken(), controller.signal, (e) => {
            delay = 1000;
            handle(e);
          });
        } catch {
          // Dropped or refused: wait and try again.
        }
        if (controller.signal.aborted) return;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
        latest.current.reload(); // catch up on what happened while disconnected
      }
    })();
    return () => controller.abort();
  }, [workspaceId, getToken, handle]);

  useEffect(() => {
    const timer = setInterval(() => latest.current.reload(), COUNTS_FALLBACK_MS);
    return () => clearInterval(timer);
  }, []);

  // "(3) Conversations": Next.js sets the title per page, so the count is re-applied after it changes.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\) /, "");
    document.title = waiting > 0 ? `(${waiting}) ${base}` : base;
  }, [waiting, pathname]);

  // Desktop notifications need permission, which browsers only let a click ask for: offer it once.
  useEffect(() => {
    if (!workspaceId || !("Notification" in window) || Notification.permission !== "default") return;
    try {
      if (localStorage.getItem(DESKTOP_ASKED)) return;
      localStorage.setItem(DESKTOP_ASKED, "1");
    } catch {
      return;
    }
    toast("Get desktop alerts", {
      description: "Know when a conversation needs a person, even when this tab is in the background.",
      action: { label: "Turn on", onClick: () => void Notification.requestPermission() },
      duration: 15_000,
    });
  }, [workspaceId]);

  return <LiveContext.Provider value={{ waiting }}>{children}</LiveContext.Provider>;
}
