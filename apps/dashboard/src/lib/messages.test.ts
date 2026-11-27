import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConversationMessage, NewMessages } from "@workforce/shared";
import { catchUp, mergeMessages } from "./messages.ts";

const m = (id: string, createdAt: string, content = id) => ({ id, createdAt, content }) as ConversationMessage;

test("mergeMessages: one list, oldest first, ties by id, a repeated message once in its newer copy", () => {
  const a = [m("b", "2026-01-01T00:00:02.000Z"), m("c", "2026-01-01T00:00:03.000Z")];
  const b = [m("a", "2026-01-01T00:00:02.000Z"), m("c", "2026-01-01T00:00:03.000Z", "edited"), m("d", "2026-01-01T00:00:04.000Z")];
  const merged = mergeMessages(a, b);
  assert.deepEqual(merged.map((x) => x.id), ["a", "b", "c", "d"]);
  assert.equal(merged[2]?.content, "edited");
});

test("catchUp follows the cursor until nothing more is new", async () => {
  const pages: Record<string, NewMessages> = {
    p0: { data: [m("1", "2026-01-01T00:00:01.000Z")], cursor: "p1", more: true },
    p1: { data: [m("2", "2026-01-01T00:00:02.000Z")], cursor: "p2", more: false },
  };
  const asked: string[] = [];
  const api = (async (path: string) => {
    asked.push(path);
    return pages[new URL(path, "http://x").searchParams.get("after") ?? ""];
  }) as Parameters<typeof catchUp>[0];
  const result = await catchUp(api, "/c", "p0");
  assert.deepEqual([result.messages.map((x) => x.id), result.cursor, asked.length], [["1", "2"], "p2", 2]);
});
