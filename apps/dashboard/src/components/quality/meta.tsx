import { EVAL_DIMENSION_LABELS, type EvaluationRecord, type EvaluationResultRecord } from "@workforce/shared";
import { CircleAlert, CircleCheck, CircleMinus, CircleX, Loader } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export const formatScore = (score: number | null) => (score === null ? "—" : String(Math.round(score)));
export const formatRate = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);

/** Pass, fail, skipped or error, always with an icon and a word: never colour alone. */
export function ResultBadge({ passed, status }: { passed: boolean | null; status?: EvaluationResultRecord["status"] }) {
  if (status === "error")
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <CircleAlert className="size-3" aria-hidden /> Error
      </Badge>
    );
  if (passed === null)
    return (
      <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
        <CircleMinus className="size-3" aria-hidden /> Skipped
      </Badge>
    );
  return passed ? (
    <Badge variant="outline" className="gap-1 font-normal">
      <CircleCheck className="size-3 text-emerald-600 dark:text-emerald-400" aria-hidden /> Pass
    </Badge>
  ) : (
    <Badge variant="destructive" className="gap-1 font-normal">
      <CircleX className="size-3" aria-hidden /> Fail
    </Badge>
  );
}

export function EvaluationStatus({ evaluation }: { evaluation: Pick<EvaluationRecord, "status" | "passed" | "error"> }) {
  if (evaluation.status === "PENDING" || evaluation.status === "RUNNING")
    return (
      <Badge variant="outline" className="gap-1 font-normal">
        <Loader className="size-3 animate-spin motion-reduce:animate-none" aria-hidden /> {evaluation.status === "PENDING" ? "Queued" : "Grading"}
      </Badge>
    );
  if (evaluation.status === "FAILED")
    return (
      <Badge variant="outline" className="gap-1 font-normal" title={evaluation.error ?? undefined}>
        <CircleAlert className="size-3" aria-hidden /> Could not grade
      </Badge>
    );
  return <ResultBadge passed={evaluation.passed} />;
}

/** Where an evaluation's conversation came from: employee version, model, workflow. */
export function Provenance({ evaluation }: { evaluation: EvaluationRecord }) {
  return (
    <span className="text-xs text-muted-foreground">
      {evaluation.employee.name}
      {evaluation.employeeVersion !== null && ` v${evaluation.employeeVersion}`}
      {evaluation.model && ` · ${evaluation.model}`}
      {evaluation.workflow && (
        <>
          {" · "}
          <Link href={`/workflows/${evaluation.workflow.id}`} className="underline-offset-2 hover:underline">
            {evaluation.workflow.name} v{evaluation.workflow.version}
          </Link>
        </>
      )}
    </span>
  );
}

/** Every evaluator's verdict, failures first, with the reason and the quoted evidence. */
export function ResultList({ results, showEvaluator = true }: { results: EvaluationResultRecord[]; showEvaluator?: boolean }) {
  const order = (r: EvaluationResultRecord) => (r.passed === false ? 0 : r.status === "error" ? 1 : r.passed ? 2 : 3);
  return (
    <ul className="flex flex-col divide-y">
      {[...results].sort((a, b) => order(a) - order(b)).map((r) => (
        <li key={r.id} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {showEvaluator ? (
                <Link href={`/quality/evaluators/${r.evaluatorId}`} className="underline-offset-2 hover:underline">
                  {r.evaluatorName}
                </Link>
              ) : (
                EVAL_DIMENSION_LABELS[r.dimension]
              )}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">v{r.evaluatorVersion}</span>
            </span>
            <span className="flex items-center gap-2">
              <span className="text-sm tabular-nums">{formatScore(r.score)}</span>
              <ResultBadge passed={r.passed} status={r.status} />
            </span>
          </div>
          {r.reason && <p className="text-sm text-muted-foreground">{r.reason}</p>}
          {r.findings.length > 0 && (
            <ul className="flex flex-col gap-1.5 text-sm">
              {r.findings.map((f, i) => (
                <li key={i} className="rounded-md bg-muted/60 px-2.5 py-1.5">
                  {f.message}
                  {f.quote && <q className="mt-0.5 block text-xs text-muted-foreground italic">{f.quote}</q>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}
