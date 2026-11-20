"use client";

import { EVAL_DIMENSION_LABELS, type ImprovementSummary } from "@workforce/shared";
import { Lightbulb, Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { StageBadge } from "@/components/improvements/meta";
import { timeAgo } from "@/components/inbox/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

/** How long the list is refreshed after asking for an analysis (it runs in the background). */
const WATCH_MS = 60_000;

export default withWorkspace(function ImprovementsPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const api = useApi();
  const path = `/workspaces/${workspace.id}/improvements`;
  const { data, error, reload } = useApiQuery<ImprovementSummary[]>(path);
  const [watching, setWatching] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(reload, 5000);
    const stop = setTimeout(() => setWatching(false), WATCH_MS);
    return () => (clearInterval(timer), clearTimeout(stop));
  }, [watching, reload]);

  const analyze = async () => {
    setActionError(undefined);
    try {
      await api(`${path}/analyze`, { method: "POST" });
      setWatching(true);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong. Try again.");
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
        <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm" role="status">
          Looking for evaluators that keep failing on live versions. New suggestions appear here as they are written; this also runs every morning.
        </p>
      )}
      {actionError && <ErrorState message={actionError} />}

      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : data.length === 0 ? (
        <EmptyState
          icon={Lightbulb}
          title="No suggestions yet"
          description="A suggestion is written when an evaluator fails at least 3 conversations (and 20% of them) on an employee's live version in the last 14 days."
        />
      ) : (
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
            {data.map((s) => (
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
      )}
    </div>
  );
});
