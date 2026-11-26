"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";

/** The tabs of each top-level page, so the pages and the command menu agree on their names and order. */
export const PAGE_TABS = {
  "/analytics": [
    { value: "overview", label: "Overview" },
    { value: "handoffs", label: "Handoffs" },
    { value: "replies", label: "Reply times" },
    { value: "intelligence", label: "Conversation intelligence" },
  ],
  "/quality": [
    { value: "overview", label: "Overview" },
    { value: "failures", label: "Failures" },
    { value: "evaluators", label: "Evaluators" },
    { value: "datasets", label: "Datasets" },
  ],
  "/model-routing": [
    { value: "policies", label: "Policies" },
    { value: "usage", label: "Usage" },
  ],
  "/billing": [
    { value: "plan", label: "Plan" },
    { value: "usage", label: "Usage" },
    { value: "invoices", label: "Invoices" },
    { value: "limits", label: "Limits" },
  ],
} as const satisfies Record<string, readonly { value: string; label: string }[]>;
export type TabbedPage = keyof typeof PAGE_TABS;
type TabOf<P extends TabbedPage> = (typeof PAGE_TABS)[P][number]["value"];

// The tab lives in `?tab=`; it is written with history.replaceState, which Next keeps in sync, and announced here.
const EVENT = "tabchange";
const subscribe = (notify: () => void) => {
  window.addEventListener("popstate", notify);
  window.addEventListener(EVENT, notify);
  return () => {
    window.removeEventListener("popstate", notify);
    window.removeEventListener(EVENT, notify);
  };
};
const readTab = () => new URLSearchParams(window.location.search).get("tab");

/** Sets `?tab=` on the current page without a navigation. */
function writeTab(tab: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("tab", tab);
  window.history.replaceState(window.history.state, "", url);
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Opens `href` (a page, maybe with `?tab=`): on the page already open it only switches the tab, so nothing reloads.
 * Returns false when it is another page, for the caller to navigate.
 */
export function switchTabInPlace(href: string) {
  const url = new URL(href, window.location.origin);
  const tab = url.searchParams.get("tab");
  if (url.pathname !== window.location.pathname || tab === null) return false;
  writeTab(tab);
  return true;
}

/**
 * The page's current tab from `?tab=` (the first tab when missing or unknown) and a setter that keeps the URL in
 * step, so a tab can be linked, bookmarked and reopened. Alt+1…9 switches to the nth tab.
 */
export function usePageTab<P extends TabbedPage>(page: P) {
  const tabs = PAGE_TABS[page] as readonly { value: TabOf<P>; label: string }[];
  const raw = useSyncExternalStore(subscribe, readTab, () => null);
  const tab = tabs.find((t) => t.value === raw)?.value ?? tabs[0]!.value;
  const setTab = useCallback((next: string) => writeTab(next), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const index = /^Digit([1-9])$/.exec(e.code)?.[1];
      const target = index === undefined ? undefined : tabs[Number(index) - 1];
      if (!target) return;
      e.preventDefault();
      writeTab(target.value);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs]);

  return [tab, setTab] as const;
}
