"use client";

import {
  NODE_LABELS,
  type WorkflowDetail,
  type WorkflowExecutionDetail,
  type WorkflowExecutionSummary,
  type WorkflowStepExecution,
} from "@workforce/shared";
import { Hand, Play, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyState, ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { RunStatusBadge, formatTime } from "@/components/workflows/meta";
import { WorkflowCanvas } from "@/components/workflows/workflow-canvas";
import { useApi, useApiQuery } from "@/lib/api";
import { TablePager, usePaged } from "@/components/table-pager";

const ACTIVE = ["QUEUED", "RUNNING", "WAITING"];

/** Reloads every 2 seconds while `active`. */
function usePolling(active: boolean, reload: () => void) {
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [active, reload]);
}

function Json({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </pre>
  );
}

function RunDetail({ workspaceId, executionId, isAdmin }: { workspaceId: string; executionId: string; isAdmin: boolean }) {
  const api = useApi();
  const path = `/workspaces/${workspaceId}/workflow-executions/${executionId}`;
  const { data, error, reload, setData } = useApiQuery<WorkflowExecutionDetail>(path);
  usePolling(data !== undefined && ACTIVE.includes(data.status), reload);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <Skeleton className="h-64 w-full" />;

  const act = async (action: "retry" | "resume") => {
    try {
      setData(
        await api<WorkflowExecutionDetail>(`${path}/${action}`, {
          method: "POST",
          toast: action === "retry" ? "Run retried from the failed step" : "Run continued",
        }),
      );
    } catch {
      // The toast in useApi shows why it failed.
    }
  };
  // The latest attempt at each node decides its colour on the canvas.
  const statuses: Record<string, WorkflowStepExecution["status"]> = {};
  for (const step of data.steps) statuses[step.nodeId] = step.status;
  const names = new Map(data.definition.nodes.map((n) => [n.id, n.name]));
  const waitingForPerson = data.status === "WAITING" && data.runAt === null;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <RunStatusBadge status={data.status} />
        <span className="text-sm text-muted-foreground">
          v{data.version} · started {formatTime(data.createdAt)}
          {data.status === "WAITING" && data.runAt && ` · next check ${formatTime(data.runAt)}`}
        </span>
        <div className="ml-auto flex gap-2">
          {isAdmin && data.status === "FAILED" && (
            <Button size="sm" onClick={() => act("retry")}>
              <RotateCcw aria-hidden />
              Retry from failed step
            </Button>
          )}
          {isAdmin && waitingForPerson && (
            <Button size="sm" onClick={() => act("resume")}>
              <Hand aria-hidden />
              Continue
            </Button>
          )}
        </div>
      </div>
      {data.error && <ErrorState message={data.error} />}
      <WorkflowCanvas definition={data.definition} statuses={statuses} readOnly className="h-[320px]" />
      <ol className="flex flex-col gap-2">
        {data.steps.map((step) => (
          <li key={step.id}>
            <Card size="sm">
              <CardContent>
                <Collapsible>
                  <CollapsibleTrigger className="flex w-full cursor-pointer flex-wrap items-center gap-2 rounded-sm text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    <span className="font-medium">{names.get(step.nodeId) ?? step.nodeId}</span>
                    <span className="text-muted-foreground">{NODE_LABELS[step.nodeType]}</span>
                    {step.attempt > 1 && <span className="text-muted-foreground">attempt {step.attempt}</span>}
                    <span className="ml-auto">
                      <RunStatusBadge status={step.status} />
                    </span>
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-3 flex flex-col gap-2 text-xs">
                    {step.error && <p className="text-destructive">{step.error}</p>}
                    {step.input !== null && (
                      <>
                        <span className="text-muted-foreground">Settings used</span>
                        <Json value={step.input} />
                      </>
                    )}
                    {step.output !== null && (
                      <>
                        <span className="text-muted-foreground">Result</span>
                        <Json value={step.output} />
                      </>
                    )}
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">Trigger data</span>
        <Json value={data.input} />
      </div>
    </div>
  );
}

/** Starting runs, the run history, and what happened in each run. */
export function WorkflowRuns({ workspaceId, workflow, isAdmin }: { workspaceId: string; workflow: WorkflowDetail; isAdmin: boolean }) {
  const api = useApi();
  const path = `/workspaces/${workspaceId}/workflows/${workflow.id}/executions`;
  const { data, error, reload } = useApiQuery<WorkflowExecutionSummary[]>(path);
  const runs = usePaged(data ?? [], 20);
  const [input, setInput] = useState("{\n}");
  const [selected, setSelected] = useState<string>();
  const [runError, setRunError] = useState<string>();
  const [starting, setStarting] = useState(false);
  usePolling(data?.some((e) => ACTIVE.includes(e.status)) ?? false, reload);

  const start = async () => {
    setRunError(undefined);
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      return setRunError("The trigger data must be a JSON object.");
    }
    setStarting(true);
    try {
      const run = await api<WorkflowExecutionSummary>(path, { method: "POST", body: { input: parsed }, toast: "Run started" });
      setSelected(run.id);
      reload();
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <div className="flex flex-col gap-4">
        {isAdmin && (
          <Card>
            <CardContent className="flex flex-col gap-2">
              <Label htmlFor="run-input">Trigger data (JSON)</Label>
              <Textarea id="run-input" rows={5} className="font-mono text-xs" value={input} onChange={(e) => setInput(e.target.value)} />
              <p className="text-xs text-muted-foreground">
                {workflow.status === "ACTIVE"
                  ? `Runs the published version (v${workflow.publishedVersion}).`
                  : workflow.status === "PAUSED"
                    ? "The workflow is paused. Resume it to run it."
                    : "Publish the workflow to run it."}
              </p>
              {runError && <p className="text-sm text-destructive">{runError}</p>}
              <Button className="w-fit" onClick={start} disabled={starting || workflow.status !== "ACTIVE"}>
                <Play aria-hidden />
                Run now
              </Button>
            </CardContent>
          </Card>
        )}
        {error ? (
          <ErrorState message={error.message} onRetry={reload} />
        ) : !data ? (
          <Skeleton className="h-32 w-full" />
        ) : data.length === 0 ? (
          <EmptyState icon={Play} title="No runs yet" description="Runs appear here when the workflow is started." />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Version</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.rows.map((run) => (
                  <TableRow key={run.id} data-state={run.id === selected ? "selected" : undefined} className="cursor-pointer" onClick={() => setSelected(run.id)}>
                    <TableCell>
                      <Button type="button" variant="link" className="h-auto p-0 font-normal text-foreground" onClick={() => setSelected(run.id)}>
                        {formatTime(run.createdAt)}
                      </Button>
                      <span className="block text-xs text-muted-foreground">{run.startedBy === "webhook" ? "Webhook" : run.startedBy.startsWith("api:") ? "API" : "Manual"}</span>
                    </TableCell>
                    <TableCell>
                      <RunStatusBadge status={run.status} />
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">v{run.version}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <TablePager {...runs.pager} className="px-4 pb-3" />
          </Card>
        )}

      </div>
      <div>
        {selected ? (
          <RunDetail key={selected} workspaceId={workspaceId} executionId={selected} isAdmin={isAdmin} />
        ) : (
          <p className="text-sm text-muted-foreground">Choose a run to see each step.</p>
        )}
      </div>
    </div>
  );
}
