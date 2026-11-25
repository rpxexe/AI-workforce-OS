import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesSearch, openConversations, resolveTab, summarizeEmployees } from "./helpers.ts";

test("resolveTab falls back to overview for a missing or unknown tab", () => {
  assert.equal(resolveTab(null), "overview");
  assert.equal(resolveTab(""), "overview");
  assert.equal(resolveTab("bogus"), "overview");
  assert.equal(resolveTab("channels"), "channels");
});

test("matchesSearch ignores case and surrounding spaces, and an empty query matches", () => {
  const e = { name: "Asha", role: "Customer support agent" };
  assert.equal(matchesSearch(e, "  SUPPORT "), true);
  assert.equal(matchesSearch(e, "asha"), true);
  assert.equal(matchesSearch(e, "billing"), false);
  assert.equal(matchesSearch(e, ""), true);
});

test("summarizeEmployees counts drafts independently of status", () => {
  assert.deepEqual(
    summarizeEmployees([
      { status: "ACTIVE", publishedVersion: 1 },
      { status: "PAUSED", publishedVersion: null },
      { status: "ACTIVE", publishedVersion: null },
    ]),
    { active: 2, paused: 1, draft: 2 },
  );
});

test("openConversations adds ai_active, reopened, human_active and waiting only", () => {
  assert.equal(openConversations({ ai_active: 3, reopened: 5, human_active: 2, waiting: 1, resolved: 9 }), 11);
  assert.equal(openConversations({}), 0);
});
