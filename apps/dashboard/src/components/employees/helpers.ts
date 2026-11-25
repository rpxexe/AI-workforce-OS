// Plain functions with type-only imports, so Node can run helpers.test.ts directly.
import type { EmployeeStatus, InboxView } from "@workforce/shared";

export const EMPLOYEE_TABS = [
  { id: "overview", label: "Overview" },
  { id: "setup", label: "Setup" },
  { id: "knowledge", label: "Knowledge & tools" },
  { id: "channels", label: "Channels" },
  { id: "releases", label: "Releases" },
] as const;

export type EmployeeTab = (typeof EMPLOYEE_TABS)[number]["id"];

/** The tab named in the URL, or Overview when it names none we know. */
export function resolveTab(value: string | null): EmployeeTab {
  return EMPLOYEE_TABS.find((t) => t.id === value)?.id ?? "overview";
}

export function matchesSearch(e: { name: string; role: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || e.name.toLowerCase().includes(q) || e.role.toLowerCase().includes(q);
}

/** Draft means never published, whatever the status. */
export function summarizeEmployees(list: { status: EmployeeStatus; publishedVersion: number | null }[]) {
  return {
    active: list.filter((e) => e.status === "ACTIVE").length,
    paused: list.filter((e) => e.status === "PAUSED").length,
    draft: list.filter((e) => e.publishedVersion === null).length,
  };
}

export function openConversations(counts: Partial<Record<InboxView, number>>): number {
  // Reopened conversations are open and AI-answered too (AI_ANSWERS in @workforce/shared).
  return (counts.ai_active ?? 0) + (counts.reopened ?? 0) + (counts.human_active ?? 0) + (counts.waiting ?? 0);
}
