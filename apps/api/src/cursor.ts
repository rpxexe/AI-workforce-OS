import { createHash } from "node:crypto";
import { z } from "zod";
import { httpError } from "./auth.ts";

// Keyset ("seek") paging. A list is ordered by one column (a timestamp or a text) with the id as tie-breaker, and a
// page asks for rows strictly after the last row it was given. Rows added, deleted or moved elsewhere in the list
// between requests never shift the next page the way OFFSET did, and a page costs the same at row 10 or 100,000.
// It does not freeze the list: a row whose sort value changes moves to its new place.

/** A sort value: timestamps travel as ISO strings, texts as themselves. */
export type SortValue = Date | string;
/** Where the next page starts: the last row's sort value and id. */
export type KeysetPosition<V extends SortValue = SortValue> = { value: V; id: string };
/** What a cursor holds: the position, the value's kind, and which list (tenant, search, filter, order) it belongs to. */
export type CursorPayload = { v: string; k: "date" | "text"; id: string; c: string };

const payloadSchema = z.object({ v: z.string().max(500), k: z.enum(["date", "text"]), id: z.string().min(1).max(100), c: z.string().length(16) });

/** Query-string fields every cursor list accepts: ?limit= rows (default 20, at most 100) and ?cursor= from the last page. */
export const cursorQuery = {
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(1000).optional(),
};

/** A short fingerprint of everything that decides the list's rows and order; a cursor only works for the same one. */
export const pagingContext = (...parts: (string | boolean | undefined)[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 16);

/** Opaque, URL-safe cursor. Not signed: every query also filters on the caller's tenant, so an edited cursor only moves within lists the caller may read. */
export function encodeCursor(position: KeysetPosition, context: string) {
  const { value } = position;
  const payload: CursorPayload = { v: value instanceof Date ? value.toISOString() : value, k: value instanceof Date ? "date" : "text", id: position.id, c: context };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** The position after which the next page starts: undefined for the first page, 400 for a malformed or foreign cursor. */
export function decodeCursor(cursor: string | undefined, context: string, kind: "date"): KeysetPosition<Date> | undefined;
export function decodeCursor(cursor: string | undefined, context: string, kind: "text"): KeysetPosition<string> | undefined;
export function decodeCursor(cursor: string | undefined, context: string, kind: "date" | "text"): KeysetPosition | undefined {
  if (!cursor) return undefined;
  let payload: CursorPayload;
  try {
    payload = payloadSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw httpError(400, "Invalid cursor");
  }
  if (payload.c !== context) throw httpError(400, "This cursor belongs to another search or filter; start again from the first page");
  if (payload.k !== kind) throw httpError(400, "Invalid cursor");
  if (kind === "text") return { value: payload.v, id: payload.id };
  const at = new Date(payload.v);
  if (Number.isNaN(at.getTime())) throw httpError(400, "Invalid cursor");
  return { value: at, id: payload.id };
}

/**
 * Rows after the position in (field, id) order, both descending or both ascending, as a Prisma where clause.
 * The leading bound (lte/gte) lets an index on (…, field) start at the position; the OR breaks ties on the id.
 */
export function keysetAfter<F extends string>(field: F, after: KeysetPosition | undefined, order: "desc" | "asc" = "desc") {
  if (!after) return {};
  const [bound, strict] = order === "desc" ? (["lte", "lt"] as const) : (["gte", "gt"] as const);
  return {
    AND: [{ [field]: { [bound]: after.value } }, { OR: [{ [field]: { [strict]: after.value } }, { id: { [strict]: after.id } }] }],
  } as { AND: [Record<F, Record<string, SortValue>>, { OR: [Record<F, Record<string, SortValue>>, { id: Record<string, string> }] }] };
}

/** Keeps `limit` of the `limit + 1` rows fetched (the extra one says whether a next page exists) and makes its cursor. */
export function keysetPage<T extends { id: string }>(rows: T[], limit: number, valueOf: (row: T) => SortValue, context: string) {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { page, nextCursor: rows.length > limit && last ? encodeCursor({ value: valueOf(last), id: last.id }, context) : null };
}
