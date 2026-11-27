import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorOf, firstPage, goTo, pageCount, settle } from "./cursor-pages.ts";

test("Next follows the shown page's cursor, one page at a time", () => {
  const two = goTo(firstPage, 1, "A");
  assert.deepEqual(two, { cursors: [null, "A"], page: 1 });
  assert.equal(cursorOf(two), "A");
  const three = goTo(two, 2, "B");
  assert.deepEqual([cursorOf(three), three.page], ["B", 2]);
  // No next page, or a jump past the next one: nothing happens.
  assert.equal(goTo(three, 3, null), three);
  assert.equal(goTo(three, 5, "C"), three);
});

test("Previous and First reopen the pages already visited with their own cursors", () => {
  const three = goTo(goTo(firstPage, 1, "A"), 2, "B");
  const back = goTo(three, 1, null);
  assert.deepEqual([cursorOf(back), back.cursors], ["A", [null, "A", "B"]]);
  assert.equal(cursorOf(goTo(three, 0, null)), null);
  assert.equal(goTo(three, -1, null).page, 0);
  // Going forward again from page 2 replaces what came after it: the list may have changed.
  assert.deepEqual(goTo(back, 2, "B2").cursors, [null, "A", "B2"]);
});

test("A search or filter change starts again from the first page with no cursor", () => {
  // The hook resets to firstPage when its reset key changes; the first page never carries a cursor.
  assert.equal(cursorOf(firstPage), null);
  assert.equal(firstPage.page, 0);
});

test("a page emptied by deletions steps back; page 1 stays", () => {
  const two = goTo(firstPage, 1, "A");
  assert.equal(settle(two, 0).page, 0);
  assert.equal(settle(two, 3), two);
  assert.equal(settle(firstPage, 0), firstPage);
});

test("the page count comes from the total when known, else from the pages reached", () => {
  const two = goTo(firstPage, 1, "A");
  assert.equal(pageCount(firstPage, 20, 95, "A"), 5);
  assert.equal(pageCount(two, 20, undefined, "B"), 3);
  assert.equal(pageCount(two, 20, undefined, null), 2);
  // A stale total never hides pages already reached.
  assert.equal(pageCount(two, 20, 10, "B"), 3);
  assert.equal(pageCount(firstPage, 20, 0, null), 1);
});
