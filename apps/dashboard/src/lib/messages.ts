import type { ConversationMessage, NewMessages } from "@workforce/shared";
import type { useApi } from "@/lib/api";

/** Both lists as one, oldest first (time, then id, as the server orders them); a message in both appears once, as in `b`. */
export function mergeMessages(a: ConversationMessage[], b: ConversationMessage[]) {
  const byId = new Map(a.map((m) => [m.id, m]));
  for (const m of b) byId.set(m.id, m);
  return [...byId.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
}

/**
 * Follows `<conversation path>/messages/new` from `after` until nothing more is new, so a poll that found more than
 * one window of new messages misses none. Returns them, oldest first, and where the next poll continues.
 */
export async function catchUp(api: ReturnType<typeof useApi>, conversationPath: string, after: string) {
  const messages: ConversationMessage[] = [];
  let cursor = after;
  for (let more = true; more; ) {
    const page = await api<NewMessages>(`${conversationPath}/messages/new?limit=100&after=${encodeURIComponent(cursor)}`);
    messages.push(...page.data);
    ({ cursor, more } = page);
  }
  return { messages, cursor };
}
