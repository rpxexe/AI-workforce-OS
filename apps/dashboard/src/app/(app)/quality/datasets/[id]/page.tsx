"use client";

import type { DatasetDetail, EmployeeSummary, EvalCaseInfo, EvalRunDetail } from "@workforce/shared";
import { ArrowLeft, Play, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { timeAgo } from "@/components/inbox/meta";
import { EvaluationStatus, formatScore, ResultBadge, ResultList } from "@/components/quality/meta";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const POLL_MS = 3000;
const LIVE = "live";

function CaseItem({ c, onDelete }: { c: EvalCaseInfo; onDelete?: () => void }) {
  const customer = c.messages.filter((m) => m.role === "customer");
  return (
    <li className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{c.name}</span>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          {c.source === "conversation" ? (
            <Link href={`/conversations/${c.conversationId}`} className="underline-offset-2 hover:underline">
              From a conversation
            </Link>
          ) : (
            "Written by hand"
          )}
          {onDelete && (
            <Button variant="ghost" size="icon" onClick={onDelete} aria-label={`Delete case ${c.name}`}>
              <Trash2 aria-hidden />
            </Button>
          )}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        {customer.length} customer {customer.length === 1 ? "message" : "messages"}: “{customer[0]?.content.slice(0, 120)}”
      </p>
      {c.expectations && <p className="text-sm">Expected: {c.expectations}</p>}
    </li>
  );
}

function RunResults({ workspaceId, runId, cases }: { workspaceId: string; runId: string; cases: EvalCaseInfo[] }) {
  const { data, error, reload } = useApiQuery<EvalRunDetail>(`/workspaces/${workspaceId}/eval-runs/${runId}`);
  const running = !data || data.status === "PENDING" || data.status === "RUNNING";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [running, reload]);
  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={2} />;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        {running ? `Replaying: ${data.evaluations.length} of ${data.total} cases done.` : `${data.passed} of ${data.total} cases passed · score ${formatScore(data.score)}`}
        {data.error && ` · ${data.error}`}
      </p>
      <ul className="flex flex-col gap-3">
        {data.evaluations.map((e) => (
          <li key={e.id} className="rounded-lg border p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <Link href={`/conversations/${e.conversationId}`} className="font-medium underline-offset-2 hover:underline">
                {cases.find((c) => c.id === e.caseId)?.name ?? "Deleted case"}
              </Link>
              <span className="flex items-center gap-2 text-sm">
                <span className="tabular-nums">{formatScore(e.score)}</span>
                <EvaluationStatus evaluation={e} />
              </span>
            </div>
            {e.error ? <p className="text-sm text-muted-foreground">{e.error}</p> : <ResultList results={e.results} />}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default withWorkspace(function DatasetPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const path = `/workspaces/${workspace.id}/datasets/${id}`;
  const { data, error, reload } = useApiQuery<DatasetDetail>(path);
  const { data: employees } = useApiQuery<EmployeeSummary[]>(`/workspaces/${workspace.id}/employees`);
  const [name, setName] = useState("");
  const [lines, setLines] = useState("");
  const [expectations, setExpectations] = useState("");
  const [employeeId, setEmployeeId] = useState<string>();
  const [version, setVersion] = useState<string>(LIVE);
  const [selectedRun, setSelectedRun] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={6} />;

  const act = async (label: string, work: () => Promise<void>) => {
    setBusy(label);
    setFailure(undefined);
    try {
      await work();
      return true;
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Something went wrong. Try again.");
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const addCase = async (event: FormEvent) => {
    event.preventDefault();
    const messages = lines
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((content) => ({ role: "customer", content }));
    const ok = await act("case", async () => {
      await api(`${path}/cases`, { method: "POST", body: { name, expectations, messages } });
      reload();
    });
    if (ok) {
      setName("");
      setLines("");
      setExpectations("");
    }
  };

  const employee = employees?.find((e) => e.id === employeeId);
  const run = async (event: FormEvent) => {
    event.preventDefault();
    if (!employeeId) return;
    await act("run", async () => {
      const started = await api<{ id: string }>(`${path}/runs`, {
        method: "POST",
        body: { employeeId, ...(version !== LIVE && { version: Number(version) }) },
      });
      setSelectedRun(started.id);
      reload();
    });
  };

  const shownRun = selectedRun ?? data.runs[0]?.id;
  return (
    <div className="flex flex-col gap-6">
      <Link href="/quality" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Quality
      </Link>
      <PageHeader title={data.name} description={data.description || "A regression dataset: its customer messages are replayed against an employee version and graded."}>
        {isAdmin && (
          <Button
            variant="outline"
            onClick={() =>
              setConfirmation({
                title: `Delete ${data.name}?`,
                description: "Its cases and the results of its runs are deleted. The replayed conversations stay.",
                confirmLabel: "Delete dataset",
                onConfirm: () => void act("delete", async () => (await api(path, { method: "DELETE" }), router.push("/quality"))),
              })
            }
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        )}
      </PageHeader>

      {failure && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          {failure}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Cases ({data.cases})</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {data.caseList.length === 0 ? (
              <p className="text-sm text-muted-foreground">No cases yet. Add one below, or open a conversation and add it from its Quality card.</p>
            ) : (
              <ul className="flex flex-col divide-y">
                {data.caseList.map((c) => (
                  <CaseItem
                    key={c.id}
                    c={c}
                    onDelete={isAdmin ? () => act("delete-case", async () => (await api(`${path}/cases/${c.id}`, { method: "DELETE" }), reload())) : undefined}
                  />
                ))}
              </ul>
            )}
            {isAdmin && (
              <form onSubmit={addCase} className="flex flex-col gap-3 border-t pt-4">
                <p className="text-sm font-medium">Write a case</p>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="case-name">Name</Label>
                  <Input id="case-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="case-messages">Customer messages, one per line</Label>
                  <Textarea id="case-messages" value={lines} onChange={(e) => setLines(e.target.value)} rows={3} placeholder={"How much is the enterprise plan?\nCan I pay yearly?"} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="case-expectations">What a good answer does (optional)</Label>
                  <Input id="case-expectations" value={expectations} onChange={(e) => setExpectations(e.target.value)} maxLength={2000} placeholder="Says $499 per month and offers a demo" />
                </div>
                <Button type="submit" variant="outline" className="w-fit" disabled={busy !== undefined || !name.trim() || !lines.trim()}>
                  <Plus aria-hidden />
                  Add case
                </Button>
              </form>
            )}
          </CardContent>
        </Card>

        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Runs</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            {isAdmin && (
              <form onSubmit={run} className="flex flex-wrap items-end gap-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="run-employee">Employee</Label>
                  <Select value={employeeId} onValueChange={(v) => (setEmployeeId(v), setVersion(LIVE))}>
                    <SelectTrigger id="run-employee" className="w-48">
                      <SelectValue placeholder="Choose" />
                    </SelectTrigger>
                    <SelectContent>
                      {employees?.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="run-version">Version</Label>
                  <Select value={version} onValueChange={setVersion} disabled={!employee}>
                    <SelectTrigger id="run-version" className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={LIVE}>{employee?.publishedVersion ? `Live (v${employee.publishedVersion})` : "Latest"}</SelectItem>
                      {Array.from({ length: employee?.latestVersion ?? 0 }, (_, i) => (employee?.latestVersion ?? 0) - i).map((n) => (
                        <SelectItem key={n} value={String(n)}>
                          v{n}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button type="submit" disabled={!employeeId || data.cases === 0 || busy !== undefined}>
                  <Play aria-hidden />
                  {busy === "run" ? "Starting" : "Run"}
                </Button>
                <p className="w-full text-xs text-muted-foreground">
                  Each case is replayed through the employee without tools (nothing is booked or sent) and graded by the enabled evaluators. It calls the model for
                  every message and every LLM grader.
                </p>
              </form>
            )}
            {data.runs.length === 0 ? (
              <p className="text-sm text-muted-foreground">Not run yet.</p>
            ) : (
              <ul className="flex flex-col divide-y text-sm">
                {data.runs.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedRun(r.id)}
                      aria-pressed={shownRun === r.id}
                      className="flex w-full flex-wrap items-center justify-between gap-2 px-2 py-2 text-left hover:bg-muted/50 aria-pressed:bg-muted"
                    >
                      <span>
                        {r.employee.name} v{r.employeeVersion} <span className="text-muted-foreground">· {timeAgo(r.createdAt)}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">
                          {formatScore(r.score)} · {r.passed}/{r.total}
                        </span>
                        {r.status === "COMPLETED" ? <ResultBadge passed={r.failed === 0} /> : <EvaluationStatus evaluation={{ status: r.status, passed: null, error: r.error }} />}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {shownRun && (
        <Card>
          <CardHeader>
            <CardTitle>Run results</CardTitle>
          </CardHeader>
          <CardContent>
            <RunResults key={shownRun} workspaceId={workspace.id} runId={shownRun} cases={data.caseList} />
          </CardContent>
        </Card>
      )}

      <ConfirmDialog request={confirmation} onClose={() => setConfirmation(null)} />
    </div>
  );
});
