"use client";

import type { WorkflowExecutionStatus, WorkflowListSummary, WorkflowPage, WorkflowStatus } from "@workforce/shared";
import { ChevronRight, CirclePlay, FilePen, Hand, History, Search, SearchX, Webhook, Workflow } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Skeleton as Skullet } from "skullet/react";
import { StatusBadge, versionLabel } from "@/components/employees/meta";
import { timeAgo } from "@/components/inbox/meta";
import { EmptyState, ErrorState, StatTile } from "@/components/states";
import { TablePager, useCursorPaged } from "@/components/table-pager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApiQuery } from "@/lib/api";

type Filter = "all" | WorkflowStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
  { value: "DRAFT", label: "Draft" },
];

const RUN_LABEL: Record<WorkflowExecutionStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  WAITING: "Waiting",
  COMPLETED: "Completed",
  FAILED: "Failed",
};

// Stands in for the real data so Skullet can draw a skeleton the shape of the list; never shown as data.
export const SAMPLE_PAGE: WorkflowPage = {
  data: Array.from({ length: 5 }, (_, i) => ({
    id: `sample-${i}`,
    name: "New lead follow-up",
    description: "Call new leads and book a meeting",
    status: "ACTIVE",
    latestVersion: 2,
    publishedVersion: 2,
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: "2026-01-01T00:00:00.000Z",
    trigger: "manual",
    runCount: 12,
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunStatus: "COMPLETED",
  })),
  nextCursor: null,
};

/**
 * Summary tiles, search, status filter and the paged list of workflows. The server searches, filters, counts and
 * pages; a new `refresh` number (after a restore) loads the list and tiles again.
 */
export function WorkflowList({ workspaceId, isAdmin, newButton, refresh }: { workspaceId: string; isAdmin: boolean; newButton: ReactNode; refresh: number }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const searchRef = useRef<HTMLInputElement>(null);
  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const base = `/workspaces/${workspaceId}/workflows`;
  const q = search ? `q=${encodeURIComponent(search)}` : "";
  // Tiles once per search; the list one cursor page at a time, back to page 1 on a new search or status.
  const summary = useApiQuery<WorkflowListSummary>(`${base}/summary${q && `?${q}`}`, { keepPrevious: true });
  const paged = useCursorPaged(`${search}:${filter}`);
  const list = useApiQuery<WorkflowPage>(`${base}?${paged.query}${filter === "all" ? "" : `&status=${filter}`}${q && `&${q}`}`, {
    keepPrevious: true,
  });
  const s = summary.data;
  // While a page loads, `data` is still the previous one: its cursor must not open yet another page.
  const pager = paged.pager({
    total: s && (filter === "all" ? s.total : s.statuses[filter]),
    nextCursor: list.loading ? null : (list.data?.nextCursor ?? null),
    rows: list.loading ? 1 : (list.data?.data.length ?? 1),
  });
  const { reload: reloadSummary } = summary;
  const { reload: reloadList } = list;
  useEffect(() => {
    if (refresh === 0) return;
    reloadSummary();
    reloadList();
  }, [refresh, reloadSummary, reloadList]);

  const error = summary.error ?? list.error;
  if (error) {
    return (
      <ErrorState
        message={error.message}
        onRetry={() => {
          reloadSummary();
          reloadList();
        }}
      />
    );
  }

  if (s?.total === 0 && !search) {
    return (
      <EmptyState
        icon={Workflow}
        title="No workflows yet"
        description={
          isAdmin
            ? "Draw a journey: what starts it, what your AI employees do, and what happens next."
            : "An organization admin has not created any workflows in this workspace yet."
        }
      >
        {newButton}
      </EmptyState>
    );
  }

  const count = (pick: (s: WorkflowListSummary) => number) => (s ? pick(s).toLocaleString() : "—");

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Workflows" value={count((s) => s.total)} icon={Workflow} hint={search ? "Matching your search" : "In this workspace"} />
        <StatTile
          label="Active"
          value={count((s) => s.statuses.ACTIVE)}
          icon={CirclePlay}
          hint={s && `${s.statuses.PAUSED} paused, ${s.statuses.DRAFT} draft`}
        />
        <StatTile
          label="Runs"
          value={count((s) => s.runs)}
          icon={History}
          hint={s && (s.failing === 0 ? "No workflow's last run failed" : `${s.failing} last run failed`)}
        />
        <StatTile label="Unpublished changes" value={count((s) => s.unpublished)} icon={FilePen} hint="Latest version not live" />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <InputGroup className="sm:max-w-xs">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search workflows"
            aria-label="Search workflows by name or description"
            maxLength={100}
          />
        </InputGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
          aria-label="Filter by status"
        >
          {FILTERS.map((f) => (
            <ToggleGroupItem key={f.value} value={f.value}>
              {f.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <Skullet data={list.data} sample={SAMPLE_PAGE} id="workflows-list" label="Loading workflows">
        {(page) =>
          page.data.length === 0 ? (
            <EmptyState icon={SearchX} title="No workflows match" description="Try another search or status.">
              <Button
                variant="outline"
                onClick={() => {
                  setQuery("");
                  setSearch("");
                  setFilter("all");
                  // The Clear button unmounts with the empty state; keep keyboard focus in the search box.
                  searchRef.current?.focus();
                }}
              >
                Clear filters
              </Button>
            </EmptyState>
          ) : (
            <Card className={`gap-0 py-0 ${list.loading ? "opacity-60" : ""}`} aria-busy={list.loading}>
              <ul className="divide-y">
                {page.data.map((w) => (
                  <li key={w.id}>
                    <Item asChild className="rounded-none">
                      <Link href={`/workflows/${w.id}`}>
                        <ItemMedia variant="icon">
                          <Workflow aria-hidden />
                        </ItemMedia>
                        <ItemContent className="min-w-0">
                          <ItemTitle className="flex flex-wrap items-center gap-2">
                            <span className="truncate">{w.name}</span>
                            <StatusBadge status={w.status} />
                          </ItemTitle>
                          <ItemDescription className="truncate">{w.description || "No description"}</ItemDescription>
                        </ItemContent>
                        <ItemActions className="hidden gap-3 text-muted-foreground sm:flex">
                          <span className="flex gap-1.5" title={versionLabel(w.latestVersion, w.publishedVersion)}>
                            {w.publishedVersion !== null && <Badge className="tabular-nums">Live v{w.publishedVersion}</Badge>}
                            {w.latestVersion !== w.publishedVersion && (
                              <Badge variant="secondary" className="tabular-nums">
                                Draft v{w.latestVersion}
                              </Badge>
                            )}
                          </span>
                          {w.trigger && (
                            <Badge variant="outline" className="hidden md:inline-flex">
                              {w.trigger === "webhook" ? <Webhook aria-hidden /> : <Hand aria-hidden />}
                              {w.trigger === "webhook" ? "Webhook" : "Manual"}
                            </Badge>
                          )}
                          <span className="hidden flex-col items-end text-xs lg:flex">
                            <span className="tabular-nums">
                              {w.runCount.toLocaleString()} {w.runCount === 1 ? "run" : "runs"}
                            </span>
                            {w.lastRunAt && w.lastRunStatus ? (
                              <span className={w.lastRunStatus === "FAILED" ? "text-destructive" : undefined}>
                                {RUN_LABEL[w.lastRunStatus]} {timeAgo(w.lastRunAt)}
                              </span>
                            ) : (
                              <span>Never run</span>
                            )}
                          </span>
                          <ChevronRight className="size-4" aria-hidden />
                        </ItemActions>
                      </Link>
                    </Item>
                  </li>
                ))}
              </ul>
              <TablePager {...pager} className="border-t px-4 py-3" />
            </Card>
          )
        }
      </Skullet>
    </div>
  );
}
