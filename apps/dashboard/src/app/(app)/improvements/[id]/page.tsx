"use client";

import { useAuth } from "@clerk/nextjs";
import { defaultEmployeeConfig, EVAL_DIMENSION_LABELS, KPI_LABELS, type EmployeeDetail, type ImprovementDetail, type SuggestionStage } from "@workforce/shared";
import { ArrowLeft, Check, CircleCheck, CircleDot, FlaskConical, X } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { ConfigDiff } from "@/components/improvements/config-diff";
import { StageBadge } from "@/components/improvements/meta";
import { RolloutPanel, StartRollout } from "@/components/improvements/rollout";
import { timeAgo } from "@/components/inbox/meta";
import { formatScore, ResultBadge } from "@/components/quality/meta";
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const POLL_MS = 3000;
const ORDER: SuggestionStage[] = ["proposed", "testing", "tested", "approved", "rolling_out", "released"];

const SAMPLE_DATE = "2026-01-01T00:00:00.000Z";
const SAMPLE_BASE = {
  ...defaultEmployeeConfig(),
  name: "Priya Support",
  role: "Customer support agent",
  systemInstructions: "Answer questions about orders, refunds and delivery.\nUse the knowledge base for policies.\nHand the customer to a person when asked.",
};

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: ImprovementDetail = {
  id: "sample-improvement",
  employee: { id: "sample-employee", name: "Priya Support" },
  baseVersion: 3,
  proposedVersion: 4,
  dimension: "grounding",
  title: "Quote the refund window from the policy, not from memory",
  kpi: "pass_rate",
  stage: "tested",
  approval: "pending",
  failures: 6,
  createdAt: SAMPLE_DATE,
  evaluatorId: "sample-evaluator",
  evaluatorName: "Answer is grounded in knowledge",
  reason: "Six conversations in the last 14 days quoted a refund window that is not in the refund policy.",
  evidence: {
    failures: 6,
    results: 48,
    days: 14,
    examples: Array.from({ length: 3 }, (_, i) => ({
      evaluationId: `sample-evaluation-${i}`,
      conversationId: `sample-conversation-${i}`,
      conversationTitle: "Customer asked about a delayed refund",
      score: 40,
      reason: "The reply promised a refund within 3 days; the policy says 7 working days.",
      findings: [{ message: "States a refund window not found in the knowledge base.", quote: "You will get your money back within 3 days." }],
    })),
  },
  change: { summary: "Tell the employee to look up the refund window before quoting it.", fields: {} },
  base: SAMPLE_BASE,
  proposed: { ...SAMPLE_BASE, systemInstructions: `${SAMPLE_BASE.systemInstructions}\nAlways look up the refund window in the refund policy before quoting it.` },
  tests: {
    datasetId: "sample-dataset",
    baseline: null,
    candidate: null,
    cases: ["Delayed refund", "Refund for a damaged item", "Refund after 30 days", "Partial refund request"].map((name, i) => ({
      caseId: `sample-case-${i}`,
      name,
      baseline: false,
      candidate: true,
      change: "fixed",
    })),
    fixes: 4,
    regressions: 0,
    complete: true,
  },
  decidedBy: null,
  decidedAt: null,
  decisionNote: "",
  rollout: null,
  createdBy: "system",
};

// Stands in for the real employee so Skullet can draw a skeleton of the rollout form; never shown as data.
const SAMPLE_EMPLOYEE: EmployeeDetail = {
  id: "sample-employee",
  status: "ACTIVE",
  publishedVersion: 3,
  createdAt: SAMPLE_DATE,
  updatedAt: SAMPLE_DATE,
  versions: [],
};

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Failure pattern -> change -> version -> tests -> approval -> rollout, each marked done, current or to come. */
function Pipeline({ s }: { s: ImprovementDetail }) {
  const at = ORDER.indexOf(s.stage === "rolled_back" ? "rolling_out" : s.stage);
  const steps: [string, string, boolean][] = [
    ["Failure pattern", `${s.evidence.failures} of ${s.evidence.results} failed`, true],
    ["Suggested change", s.change.summary ? "written" : "", true],
    ["Proposed version", s.proposedVersion === null ? "not created" : `v${s.proposedVersion}`, s.proposedVersion !== null],
    ["Regression tests", s.tests?.complete ? `${s.tests.fixes} fixed, ${s.tests.regressions} broken` : s.tests ? "running" : "not run", Boolean(s.tests?.complete)],
    ["Approval", s.approval === "pending" ? "waiting" : s.approval, s.approval === "approved"],
    ["Rollout", s.rollout ? (s.rollout.status === "active" ? `${s.rollout.percent}% of customers` : s.rollout.status.replace("_", " ")) : s.stage === "released" ? "published" : "not started", s.stage === "released"],
  ];
  return (
    <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {steps.map(([label, state, done], i) => {
        const current = !done && (i === 0 || steps[i - 1]?.[2]) && s.approval !== "rejected" && at >= 0;
        const Icon = done ? CircleCheck : current ? CircleDot : FlaskConical;
        return (
          <Item key={label} variant="outline" asChild className="flex-nowrap items-start gap-2 p-3" aria-current={current ? "step" : undefined}>
            <li>
              <ItemMedia>
                <Icon className={done ? "size-4 shrink-0 text-success" : "size-4 shrink-0 text-muted-foreground"} aria-hidden />
              </ItemMedia>
              <ItemContent className="gap-0">
                <ItemTitle>{label}</ItemTitle>
                <ItemDescription className="text-xs">
                  {done ? "Done · " : current ? "Next · " : ""}
                  {state}
                </ItemDescription>
              </ItemContent>
            </li>
          </Item>
        );
      })}
    </ol>
  );
}

export default withWorkspace(function ImprovementPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const path = `/workspaces/${workspace.id}/improvements/${id}`;
  const { data, error, reload, setData } = useApiQuery<ImprovementDetail>(path);
  const employee = useApiQuery<EmployeeDetail>(data ? `/workspaces/${workspace.id}/employees/${data.employee.id}` : null);

  const testing = data?.stage === "testing";
  useEffect(() => {
    if (!testing) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [testing, reload]);

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <Skullet data={data} sample={SAMPLE} id="improvement-detail" label="Loading improvement">
      {(data) => (
        <ImprovementView
          s={data}
          workspaceId={workspace.id}
          path={path}
          isAdmin={isAdmin}
          reload={reload}
          setData={setData}
          employee={employee.data}
          reloadEmployee={employee.reload}
        />
      )}
    </Skullet>
  );
});

function ImprovementView({
  s,
  workspaceId,
  path,
  isAdmin,
  reload,
  setData,
  employee,
  reloadEmployee,
}: {
  s: ImprovementDetail;
  workspaceId: string;
  path: string;
  isAdmin: boolean;
  reload: () => void;
  setData: (data: ImprovementDetail) => void;
  employee: EmployeeDetail | undefined;
  reloadEmployee: () => void;
}) {
  const { userId } = useAuth();
  const api = useApi();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  const run = async (action: () => Promise<ImprovementDetail | void>) => {
    setBusy(true);
    try {
      const updated = await action();
      if (updated) setData(updated);
      else reload();
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setBusy(false);
    }
  };
  const test = () =>
    setConfirm({
      title: s.proposedVersion === null ? "Create the version and test it?" : "Run the regression tests again?",
      description: `${s.proposedVersion === null ? "A new version of the employee is saved with this change. It is not published. " : ""}The employee's regression suite (the conversations behind this suggestion and a few recent passing ones are added to it) is replayed on v${s.baseVersion} and on the new version, without tools, and graded. This calls the model for every message and every LLM grader.`,
      confirmLabel: s.proposedVersion === null ? "Create and test" : "Run tests",
      onConfirm: () => run(() => api<ImprovementDetail>(`${path}/test`, {
            method: "POST",
            toast: { loading: "Starting regression tests…", success: "Regression tests started" },
          })),
    });
  const decide = (decision: "approve" | "reject") =>
    setConfirm({
      title: decision === "approve" ? `Approve v${s.proposedVersion}?` : "Reject this suggestion?",
      description:
        decision === "approve"
          ? `${s.tests && s.tests.regressions > 0 ? `${s.tests.regressions} test case${s.tests.regressions === 1 ? "" : "s"} that passed before now fail${s.tests.regressions === 1 ? "s" : ""}. ` : ""}Approving allows the version to be rolled out or published. It does not change anything customers get by itself.`
          : "The suggestion is closed. Its version, if created, stays saved and unpublished.",
      confirmLabel: decision === "approve" ? "Approve" : "Reject",
      onConfirm: () => run(() => api<ImprovementDetail>(`${path}/decision`, {
            method: "POST",
            body: { decision, note },
            toast: decision === "approve" ? `v${s.proposedVersion} approved` : "Suggestion rejected",
          })),
    });

  const by = (who: string | null) => (who === "system" ? "the analysis" : who === userId ? "you" : "a teammate");

  return (
    <div className="flex flex-col gap-6">
      <Link href="/improvements" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Improvements
      </Link>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{s.title}</h1>
          <StageBadge stage={s.stage} />
        </div>
        <p className="text-sm text-muted-foreground">
          For{" "}
          <Link href={`/employees/${s.employee.id}`} className="underline-offset-2 hover:underline">
            {s.employee.name}
          </Link>{" "}
          v{s.baseVersion} · {EVAL_DIMENSION_LABELS[s.dimension]} · KPI: {KPI_LABELS[s.kpi]} · found by {by(s.createdBy)} {timeAgo(s.createdAt)}
        </p>
      </div>
      <Pipeline s={s} />

      <Section title="Why" description={s.reason}>
        <ul className="flex flex-col gap-3">
          {s.evidence.examples.map((x) => (
            <Item key={x.evaluationId} variant="outline" asChild className="flex-col items-stretch gap-1.5 p-3">
              <li>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/conversations/${x.conversationId}`} className="text-sm font-medium underline-offset-2 hover:underline">
                    {x.conversationTitle}
                  </Link>
                  <span className="text-sm tabular-nums text-muted-foreground">
                    <Link href={`/quality/evaluators/${s.evaluatorId}`} className="underline-offset-2 hover:underline">
                      {s.evaluatorName}
                    </Link>{" "}
                    · score {formatScore(x.score)}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground">{x.reason}</p>
                {x.findings.length > 0 && (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {x.findings.map((f, i) => (
                      <li key={i} className="rounded-md bg-muted/60 px-2.5 py-1.5">
                        {f.message}
                        {f.quote && <q className="mt-0.5 block text-xs text-muted-foreground italic">{f.quote}</q>}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            </Item>
          ))}
        </ul>
      </Section>

      <Section title="Proposed change" description={s.change.summary || undefined}>
        <ConfigDiff before={s.base} after={s.proposed} />
      </Section>

      <Section
        title="Regression tests"
        description={`The employee's regression suite replayed on v${s.baseVersion} and on ${s.proposedVersion === null ? "the proposed version" : `v${s.proposedVersion}`}, graded by the enabled evaluators.`}
      >
        <div className="flex flex-col gap-4">
          {s.tests ? (
            <>
              <dl className="grid gap-2 sm:grid-cols-4">
                {(
                  [
                    [`v${s.baseVersion} (current)`, s.tests.baseline ? `${s.tests.baseline.passed}/${s.tests.baseline.total} · ${formatScore(s.tests.baseline.score)}` : "—"],
                    [`v${s.proposedVersion} (proposed)`, s.tests.candidate ? `${s.tests.candidate.passed}/${s.tests.candidate.total} · ${formatScore(s.tests.candidate.score)}` : "—"],
                    ["Fixed", String(s.tests.fixes)],
                    ["Broken", String(s.tests.regressions)],
                  ] as const
                ).map(([term, value]) => (
                  <Item key={term} variant="outline" className="flex-col items-stretch gap-0.5 p-2.5">
                    <dt className="text-xs text-muted-foreground">{term}</dt>
                    <dd className="text-lg font-semibold tabular-nums">{value}</dd>
                  </Item>
                ))}
              </dl>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {s.tests.complete
                  ? "Both runs finished. Passed cases / total · average score."
                  : s.stage === "testing"
                    ? "Replaying the cases. This page refreshes by itself."
                    : "A run did not finish; run the tests again."}
              </p>
              {s.tests.cases.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Case</TableHead>
                      <TableHead>v{s.baseVersion}</TableHead>
                      <TableHead>v{s.proposedVersion}</TableHead>
                      <TableHead>Change</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {s.tests.cases.map((c) => (
                      <TableRow key={c.caseId}>
                        <TableCell className="max-w-64 truncate">{c.name}</TableCell>
                        <TableCell>{c.baseline === null ? "—" : <ResultBadge passed={c.baseline} />}</TableCell>
                        <TableCell>{c.candidate === null ? "—" : <ResultBadge passed={c.candidate} />}</TableCell>
                        <TableCell>
                          {c.change === "fixed" ? (
                            <Badge variant="outline">Fixed</Badge>
                          ) : c.change === "regressed" ? (
                            <Badge variant="destructive">Broken</Badge>
                          ) : (
                            <span className="text-muted-foreground">Same</span>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {s.tests.datasetId && (
                <Link href={`/quality/datasets/${s.tests.datasetId}`} className="w-fit text-sm underline-offset-2 hover:underline">
                  Open the regression suite for each replay and its grades
                </Link>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">Not tested yet. The proposed version is created when the tests are started, not before.</p>
          )}
          {isAdmin && s.approval === "pending" && s.stage !== "testing" && (
            <Button className="w-fit" variant={s.tests ? "outline" : "default"} onClick={test} disabled={busy}>
              <FlaskConical aria-hidden />
              {s.proposedVersion === null ? "Create version and test" : "Run tests again"}
            </Button>
          )}
        </div>
      </Section>

      <Section title="Approval" description="A person decides; approval allows a rollout and changes nothing by itself.">
        {s.approval !== "pending" ? (
          <p className="text-sm">
            {s.approval === "approved" ? "Approved" : "Rejected"} by {by(s.decidedBy)} {s.decidedAt && timeAgo(s.decidedAt)}
            {s.decisionNote && <span className="mt-1 block text-muted-foreground">“{s.decisionNote}”</span>}
          </p>
        ) : !isAdmin ? (
          <p className="text-sm text-muted-foreground">Waiting for an admin.</p>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="decision-note">Note (optional)</Label>
              <Textarea id="decision-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} rows={2} />
            </div>
            {!s.tests?.complete && <p className="text-sm text-muted-foreground">Approval opens when both test runs have finished.</p>}
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => decide("approve")} disabled={busy || !s.tests?.complete}>
                <Check aria-hidden />
                Approve
              </Button>
              <Button variant="outline" onClick={() => decide("reject")} disabled={busy}>
                <X aria-hidden />
                Reject
              </Button>
            </div>
          </div>
        )}
      </Section>

      {s.approval === "approved" && s.proposedVersion !== null && (
        <Section title="Rollout" description="Serve the new version to a share of customers, watch the KPI, then promote or roll back.">
          {s.rollout ? (
            <RolloutPanel workspaceId={workspaceId} rollout={s.rollout} canEdit={isAdmin} onChange={() => (reload(), reloadEmployee())} />
          ) : s.stage === "released" ? (
            <p className="text-sm">v{s.proposedVersion} was published directly.</p>
          ) : (
            <Skullet data={employee} sample={SAMPLE_EMPLOYEE} id="improvement-rollout" label="Loading rollout">
              {(employee) =>
                employee.publishedVersion === null || employee.status !== "ACTIVE" ? (
                  <p className="text-sm text-muted-foreground">Publish the employee and make it active to roll this out.</p>
                ) : isAdmin && s.proposedVersion !== null ? (
                  <StartRollout
                    workspaceId={workspaceId}
                    employeeId={s.employee.id}
                    versions={[s.proposedVersion]}
                    defaultVersion={s.proposedVersion}
                    defaultKpi={s.kpi}
                    liveVersion={employee.publishedVersion}
                    onStarted={() => (reload(), reloadEmployee())}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">Not rolled out yet.</p>
                )
              }
            </Skullet>
          )}
        </Section>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
