"use client";

import { EVAL_DIMENSION_LABELS, type ImprovementSummary } from "@workforce/shared";
import { Lightbulb, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StageBadge } from "@/components/improvements/meta";
import { timeAgo } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";
import { TablePager, usePaged } from "@/components/table-pager";

/** How long the list is refreshed after asking for an analysis (it runs in the background). */
const WATCH_MS = 60_000;

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: ImprovementSummary[] = Array.from({ length: 4 }, (_, i) => ({
  id: `sample-${i}`,
  employee: { id: "sample-employee", name: "Support assistant" },
  baseVersion: 3,
  proposedVersion: 4,
  dimension: "grounding",
  title: "Answer delivery questions from the shipping policy",
  kpi: "pass_rate",
  stage: "tested",
  approval: "pending",
  failures: 12,
  createdAt: "2026-01-01T00:00:00.000Z",
}));

export default withWorkspace(function ImprovementsPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const api = useApi();
  const path = `/workspaces/${workspace.id}/improvements`;
  const { data, error, reload } = useApiQuery<ImprovementSummary[]>(path);
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(reload, 5000);
    const stop = setTimeout(() => setWatching(false), WATCH_MS);
    return () => (clearInterval(timer), clearTimeout(stop));
  }, [watching, reload]);

  const analyze = async () => {
    try {
      await api(`${path}/analyze`, { method: "POST", toast: "Analysis started" });
      setWatching(true);
    } catch {
      // The toast in useApi shows why it failed.
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Improvements"
        description="Changes suggested from repeated evaluation failures. Nothing reaches customers until a person tests, approves and rolls it out."
      >
        {isAdmin && (
          <Button onClick={analyze} disabled={watching}>
            <Search aria-hidden />
            {watching ? "Looking for patterns" : "Find improvements"}
          </Button>
        )}
      </PageHeader>
      {watching && (
        <Alert role="status">
          <AlertDescription>
            Looking for evaluators that keep failing on live versions. New suggestions appear here as they are written; this also runs every morning.
          </AlertDescription>
        </Alert>
      )}

      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="improvements-list" label="Loading improvements">
          {(data) => <SuggestionList data={data} />}
        </Skullet>
      )}
    </div>
  );
});

function SuggestionList({ data }: { data: ImprovementSummary[] }) {
  const suggestions = usePaged(data, 20);
  return data.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No suggestions yet"
          description="A suggestion is written when an evaluator fails at least 3 conversations (and 20% of them) on an employee's live version in the last 14 days."
        />
      ) : (
      <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Suggestion</TableHead>
              <TableHead className="hidden md:table-cell">Employee</TableHead>
              <TableHead className="hidden sm:table-cell">Failing on</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead className="hidden lg:table-cell">Found</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {suggestions.rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link href={`/improvements/${s.id}`} className="font-medium underline-offset-2 hover:underline">
                    {s.title}
                  </Link>
                  <span className="block text-xs text-muted-foreground md:hidden">
                    {s.employee.name} v{s.baseVersion}
                  </span>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  {s.employee.name} <span className="text-muted-foreground tabular-nums">v{s.baseVersion}{s.proposedVersion !== null && ` → v${s.proposedVersion}`}</span>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">
                  {EVAL_DIMENSION_LABELS[s.dimension]} · {s.failures} failures
                </TableCell>
                <TableCell>
                  <StageBadge stage={s.stage} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">{timeAgo(s.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <TablePager {...suggestions.pager} />
      </>
      );
}
