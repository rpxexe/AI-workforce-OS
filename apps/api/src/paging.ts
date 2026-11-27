import { httpError } from "./auth.ts";

// List pages sorted newest first by a timestamp that changes (lastSeenAt, updatedAt). Prisma's `cursor: { id }`
// re-reads the cursor row's current timestamp, so a row seen or edited between pages jumped the list back to the
// top, and a deleted one ended it. The cursor carries the last row's own values instead.

export const cursorOf = (at: Date, id: string) => `${at.toISOString()}~${id}`;

/** Rows strictly after the cursor in (field desc, id desc) order; {} without a cursor, 400 for a malformed one. */
export function after<F extends string>(field: F, cursor: string | undefined) {
  if (!cursor) return {};
  const [iso = "", id = ""] = cursor.split("~");
  const at = new Date(iso);
  if (!id || Number.isNaN(at.getTime())) throw httpError(400, "Invalid cursor");
  return { OR: [{ [field]: { lt: at } }, { [field]: at, id: { lt: id } }] } as { OR: ({ [K in F]: Date | { lt: Date } } & { id?: { lt: string } })[] };
}
