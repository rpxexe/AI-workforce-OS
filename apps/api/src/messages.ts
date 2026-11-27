// A conversation's messages in windows, for the inbox and the test chat: the newest ones, earlier pages by cursor
// (?cursor=, walking back), and what came after a position (?after=, walking forward) for polling. Every cursor is tied
// to its conversation; callers check the conversation belongs to the caller's tenant before calling these.
import { toMessage } from "@workforce/agent-runtime";
import { prisma, type Prisma } from "@workforce/database";
import type { MessagePage, NewMessages } from "@workforce/shared";
import { z } from "zod";
import { cursorQuery, decodeCursor, encodeCursor, keysetAfter, keysetPage, pagingContext, type KeysetPosition } from "./cursor.ts";

/** Messages in a conversation detail; earlier ones page by cursor. */
export const NEWEST_MESSAGES = 100;

/** ?limit= and ?cursor= (from olderCursor, then each page's nextCursor). */
export const olderMessagesQuery = z.object(cursorQuery);
/** ?after= (from newestCursor, then each call's cursor) and ?limit=. */
export const newMessagesQuery = z.object({ limit: cursorQuery.limit, after: z.string().min(1).max(1000) });
/** The detail's optional ?after=: its messages are then only the ones after it. */
export const detailQuery = z.object({ after: z.string().min(1).max(1000).optional() });

type Conversation = { id: string; workspaceId: string };
type Row = Prisma.ConversationMessageGetPayload<object>;

const contextOf = (c: Conversation) => pagingContext(c.workspaceId, c.id, "messages");
const newestFirst = [{ createdAt: "desc" }, { id: "desc" }] satisfies Prisma.ConversationMessageOrderByWithRelationInput[];
const oldestFirst = [{ createdAt: "asc" }, { id: "asc" }] satisfies Prisma.ConversationMessageOrderByWithRelationInput[];
/** Before any message: where ?after= starts for a conversation with none yet. */
const START: KeysetPosition = { value: new Date(0), id: "0" };
const cursorAt = (c: Conversation, m: Row | undefined) => encodeCursor(m ? { value: m.createdAt, id: m.id } : START, contextOf(c));

/** The newest messages (rows, oldest first), the cursor for the ones before them, and where ?after= continues. */
export async function newestMessages(c: Conversation) {
  const rows = await prisma.conversationMessage.findMany({ where: { conversationId: c.id }, orderBy: newestFirst, take: NEWEST_MESSAGES + 1 });
  const { page, nextCursor } = keysetPage(rows, NEWEST_MESSAGES, (m) => m.createdAt, contextOf(c));
  const rowsOldestFirst = page.reverse();
  return { rows: rowsOldestFirst, olderCursor: nextCursor, newestCursor: cursorAt(c, rowsOldestFirst.at(-1)) };
}

/** Messages after the position (oldest first, at most `limit`), where the next call continues, and whether more follow. 400 for a foreign cursor. */
export async function newerMessages(c: Conversation, after: string, limit: number) {
  const position = decodeCursor(after, contextOf(c), "date");
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId: c.id, ...keysetAfter("createdAt", position, "asc") },
    orderBy: oldestFirst,
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  return { rows: page, cursor: page.length > 0 ? cursorAt(c, page.at(-1)) : after, more: rows.length > limit };
}

/** The window a detail carries: the newest messages, or with ?after= only the ones after it (`caughtUp` false: call …/messages/new for the rest). */
export async function messageWindow(c: Conversation, after: string | undefined) {
  const newest = await newestMessages(c);
  const newer = after === undefined ? undefined : await newerMessages(c, after, NEWEST_MESSAGES);
  return {
    /** The newest rows, whatever the window: the insight reads them. */
    newestRows: newest.rows,
    window: {
      messages: (newer?.rows ?? newest.rows).map(toMessage),
      olderCursor: newer ? null : newest.olderCursor,
      newestCursor: newer?.cursor ?? newest.newestCursor,
      caughtUp: !newer?.more,
    },
  };
}

/** GET …/messages: one page of earlier messages, oldest first. */
export async function olderMessages(c: Conversation, query: unknown): Promise<MessagePage> {
  const { limit, cursor } = olderMessagesQuery.parse(query);
  const context = contextOf(c);
  const rows = await prisma.conversationMessage.findMany({
    where: { conversationId: c.id, ...keysetAfter("createdAt", decodeCursor(cursor, context, "date")) },
    orderBy: newestFirst,
    take: limit + 1,
  });
  const { page, nextCursor } = keysetPage(rows, limit, (m) => m.createdAt, context);
  return { data: page.reverse().map(toMessage), nextCursor };
}

/** GET …/messages/new: what came after ?after=. */
export async function newMessages(c: Conversation, query: unknown): Promise<NewMessages> {
  const { limit, after } = newMessagesQuery.parse(query);
  const { rows, cursor, more } = await newerMessages(c, after, limit);
  return { data: rows.map(toMessage), cursor, more };
}
