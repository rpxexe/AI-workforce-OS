"use client";

import { EVAL_DIMENSION_LABELS, EVALUATOR_KIND_LABELS, type EvaluationRecord, type EvaluatorInput, type EvaluatorVersionInfo } from "@workforce/shared";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { timeAgo } from "@/components/inbox/meta";
import { EvaluatorForm } from "@/components/quality/evaluator-form";
import { formatScore, Provenance, ResultBadge } from "@/components/quality/meta";
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

type Detail = { id: string; key: string | null; enabled: boolean; current: EvaluatorVersionInfo; versions: EvaluatorVersionInfo[]; evaluations: EvaluationRecord[] };

const SAMPLE_DATE = "2026-01-01T00:00:00.000Z";

const SAMPLE_VERSION: EvaluatorVersionInfo = {
  id: "sample-version",
  number: 3,
  createdBy: "system",
  createdAt: SAMPLE_DATE,
  name: "Answer is grounded in knowledge",
  description: "Checks that every fact in a reply comes from the attached knowledge sources.",
  dimension: "grounding",
  passScore: 70,
  kind: "llm",
  config: { rubric: "The answer only states facts found in the attached knowledge sources and says so when it does not know." },
};

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: Detail = {
  id: "sample-evaluator",
  key: null,
  enabled: true,
  current: SAMPLE_VERSION,
  versions: [3, 2, 1].map((number) => ({ ...SAMPLE_VERSION, id: `sample-version-${number}`, number })),
  evaluations: Array.from({ length: 4 }, (_, i) => ({
    id: `sample-${i}`,
    conversationId: `sample-${i}`,
    conversationTitle: "Customer asked about a delayed refund",
    employee: { id: "sample-employee", name: "Priya Support" },
    employeeVersion: 3,
    provider: "openai",
    model: "gpt-4o-mini",
    workflow: null,
    trigger: "auto",
    status: "COMPLETED",
    score: 78,
    passed: true,
    failures: 0,
    messageCount: 12,
    error: null,
    createdAt: SAMPLE_DATE,
    completedAt: SAMPLE_DATE,
    results: [
      {
        id: `sample-result-${i}`,
        evaluatorId: "sample-evaluator",
        evaluatorName: "Answer is grounded in knowledge",
        evaluatorVersion: 3,
        dimension: "grounding",
        kind: "llm",
        status: "scored",
        score: 78,
        passed: true,
        reason: "Every fact in the reply matches the refund policy document.",
        findings: [],
      },
    ],
  })),
};

export default withWorkspace(function EvaluatorPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const isAdmin = useIsAdmin();
  const path = `/workspaces/${workspace.id}/evaluators/${id}`;
  const { data, error, reload } = useApiQuery<Detail>(path);

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  return (
    <Skullet data={data} sample={SAMPLE} id="evaluator-detail" label="Loading evaluator">
      {(data) => (
        <EvaluatorView
          data={data}
          isAdmin={isAdmin}
          onSave={async (body) => {
            await api(path, { method: "PUT", body, toast: `${body.name} saved` });
            reload();
          }}
        />
      )}
    </Skullet>
  );
});

function EvaluatorView({ data, isAdmin, onSave }: { data: Detail; isAdmin: boolean; onSave: (body: EvaluatorInput) => Promise<void> }) {
  const { current } = data;
  return (
    <div className="flex flex-col gap-6">
      <Link href="/quality" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Quality
      </Link>
      <PageHeader title={current.name} description={current.description || undefined}>
        <Badge variant="outline">{EVAL_DIMENSION_LABELS[current.dimension]}</Badge>
        <Badge variant="outline">{EVALUATOR_KIND_LABELS[current.kind]}</Badge>
        <Badge variant={data.enabled ? "secondary" : "outline"}>{data.enabled ? "On" : "Off"}</Badge>
      </PageHeader>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardHeader>
            <CardTitle>Version {current.number}</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Re-keyed per version, so the form shows what was just saved (Next keeps pages mounted). */}
            <EvaluatorForm
              key={current.id}
              initial={current}
              disabled={!isAdmin}
              submitLabel="Save as a new version"
              onSubmit={onSave}
            />
          </CardContent>
        </Card>
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Versions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2 text-sm">
              {data.versions.map((v) => (
                <li key={v.id} className="flex justify-between gap-2">
                  <span>
                    v{v.number} {v.id === current.id && <span className="text-muted-foreground">(current)</span>}
                  </span>
                  <span className="text-muted-foreground">
                    pass at {v.passScore} · {timeAgo(v.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent results</CardTitle>
        </CardHeader>
        <CardContent>
          {data.evaluations.length === 0 ? (
            <p className="text-sm text-muted-foreground">This evaluator has not graded anything yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {data.evaluations.map((e) => {
                const r = e.results[0];
                return (
                  <li key={e.id}>
                    <Link href={`/conversations/${e.conversationId}`} className="flex flex-col gap-1 py-2.5 hover:bg-muted/40">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{e.conversationTitle}</span>
                        <span className="flex items-center gap-2 text-sm">
                          <span className="tabular-nums">{formatScore(r?.score ?? null)}</span>
                          <ResultBadge passed={r?.passed ?? null} status={r?.status} />
                        </span>
                      </div>
                      <Provenance evaluation={e} />
                      {r && <p className="text-sm text-muted-foreground">{r.findings[0]?.message ?? r.reason}</p>}
                      <span className="text-xs text-muted-foreground">
                        v{r?.evaluatorVersion} · {e.trigger === "dataset" ? "regression run" : e.trigger} · {timeAgo(e.createdAt)}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
