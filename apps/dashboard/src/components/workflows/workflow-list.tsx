"use client";

import type { WorkflowStatus, WorkflowSummary } from "@workforce/shared";
import { ChevronRight, CirclePause, CirclePlay, FilePen, Search, SearchX, Workflow } from "lucide-react";
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import { StatusBadge, formatDate, versionLabel } from "@/components/employees/meta";
import { EmptyState, StatTile } from "@/components/states";
import { TablePager, usePaged } from "@/components/table-pager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type Filter = "all" | WorkflowStatus;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "ACTIVE", label: "Active" },
  { value: "PAUSED", label: "Paused" },
  { value: "DRAFT", label: "Draft" },
];

/** Summary tiles, search, status filter and the paged list of workflows. */
export function WorkflowList({ data, isAdmin, newButton }: { data: WorkflowSummary[]; isAdmin: boolean; newButton: ReactNode }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const matches = data.filter(
    (w) =>
      (filter === "all" || w.status === filter) &&
      (!q || w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q)),
  );
  const workflows = usePaged(matches, 20, `${filter}:${q}`);

  if (data.length === 0) {
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

  const count = (status: WorkflowStatus) => data.filter((w) => w.status === status).length;
  const unpublished = data.filter((w) => w.publishedVersion !== w.latestVersion).length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Workflows" value={data.length} icon={Workflow} hint="In this workspace" />
        <StatTile label="Active" value={count("ACTIVE")} icon={CirclePlay} hint="Running on new triggers" />
        <StatTile label="Paused" value={count("PAUSED")} icon={CirclePause} hint="Not starting new runs" />
        <StatTile label="Unpublished changes" value={unpublished} icon={FilePen} hint="Latest version not live" />
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

      {matches.length === 0 ? (
        <EmptyState icon={SearchX} title="No workflows match" description="Try another search or status.">
          <Button
            variant="outline"
            onClick={() => {
              setQuery("");
              setFilter("all");
              // The Clear button unmounts with the empty state; keep keyboard focus in the search box.
              searchRef.current?.focus();
            }}
          >
            Clear filters
          </Button>
        </EmptyState>
      ) : (
        <Card className="gap-0 py-0">
          <ul className="divide-y">
            {workflows.rows.map((w) => (
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
                      <span className="hidden text-xs lg:inline">Updated {formatDate(w.updatedAt)}</span>
                      <ChevronRight className="size-4" aria-hidden />
                    </ItemActions>
                  </Link>
                </Item>
              </li>
            ))}
          </ul>
          <TablePager {...workflows.pager} className="border-t px-4 py-3" />
        </Card>
      )}
    </div>
  );
}
