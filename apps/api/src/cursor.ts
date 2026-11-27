import { createHash } from "node:crypto";
import { z } from "zod";
import { httpError } from "./auth.ts";

// Keyset ("seek") paging for lists sorted newest first by a timestamp, with the id as tie-breaker. A page asks for
// rows strictly after the last row it was given, so rows added, deleted or moved elsewhere in the list between
// requests never shift the next page the way OFFSET did. It does not freeze the list: a row whose timestamp
// changes moves to its new place (a customer seen again goes to the top).

/** What a cursor holds: the last row's sort value and id, and which list (workspace, search, filter) it belongs to. */
export type CursorPayload = { at: string; id: string; context: string };
export type KeysetPosition = { at: Date; id: string };

const payloadSchema = z.object({ at: z.iso.datetime(), id: z.string().min(1).max(100), context: z.string().length(16) });

/** A short fingerprint of everything that decides the list's rows and order; a cursor only works for the same one. */
export const pagingContext = (...parts: (string | undefined)[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 16);

/** Opaque, URL-safe cursor. Not signed: every query also filters on the caller's tenant, so an edited cursor can only move within lists the caller may read. */
export const encodeCursor = (position: KeysetPosition, context: string) =>
  Buffer.from(JSON.stringify({ at: position.at.toISOString(), id: position.id, context } satisfies CursorPayload)).toString("base64url");

/** The position after which the next page starts; undefined for the first page, 400 for a malformed or foreign cursor. */
export function decodeCursor(cursor: string | undefined, context: string): KeysetPosition | undefined {
  if (!cursor) return undefined;
  let payload: CursorPayload;
  try {
    payload = payloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw httpError(400, "Invalid cursor");
  }
  if (payload.context !== context) throw httpError(400, "This cursor belongs to another search or filter; start again from the first page");
  return { at: new Date(payload.at), id: payload.id };
}

/**
 * Rows after the position in (field desc, id desc) order, as a Prisma where clause. The leading `lte` lets the
 * (…, field) index bound the scan; the OR breaks ties on the id.
 */
export function keysetAfter<F extends string>(field: F, after: KeysetPosition | undefined) {
  if (!after) return {};
  return {
    AND: [{ [field]: { lte: after.at } }, { OR: [{ [field]: { lt: after.at } }, { id: { lt: after.id } }] }],
  } as { AND: [Record<F, { lte: Date }>, { OR: [Record<F, { lt: Date }>, { id: { lt: string } }] }] };
}

/** Trims the extra row fetched to learn whether there is another page, and makes the cursor for it. */
export function keysetPage<T extends { id: string }>(rows: T[], limit: number, at: (row: T) => Date, context: string) {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { page, nextCursor: rows.length > limit && last ? encodeCursor({ at: at(last), id: last.id }, context) : null };
}
