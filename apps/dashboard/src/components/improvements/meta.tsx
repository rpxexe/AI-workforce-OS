import { KPI_LABELS, type KpiComparison, type RolloutInfo, type SuggestionStage } from "@workforce/shared";
import { CircleCheck, CircleMinus, CircleX, FlaskConical, Hourglass, Loader, Percent, Rocket, Undo2, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const STAGES: Record<SuggestionStage, { label: string; icon: LucideIcon; variant?: "destructive" | "secondary" }> = {
  proposed: { label: "Proposed", icon: FlaskConical, variant: "secondary" },
  testing: { label: "Testing", icon: Loader },
  tested: { label: "Waiting for approval", icon: Hourglass },
  approved: { label: "Approved", icon: CircleCheck },
  rejected: { label: "Rejected", icon: CircleX, variant: "secondary" },
  rolling_out: { label: "Rolling out", icon: Percent },
  released: { label: "Released", icon: Rocket },
  rolled_back: { label: "Rolled back", icon: Undo2, variant: "secondary" },
};

export function StageBadge({ stage }: { stage: SuggestionStage }) {
  const { label, icon: Icon, variant } = STAGES[stage];
  return (
    <Badge variant={variant ?? "outline"} className="gap-1 font-normal">
      <Icon className={stage === "testing" ? "size-3 animate-spin motion-reduce:animate-none" : "size-3"} aria-hidden />
      {label}
    </Badge>
  );
}

const VERDICTS: Record<KpiComparison["verdict"], { label: string; icon: LucideIcon; variant?: "destructive" }> = {
  improved: { label: "Improved", icon: CircleCheck },
  worse: { label: "Worse", icon: CircleX, variant: "destructive" },
  no_difference: { label: "No clear difference", icon: CircleMinus },
  not_enough_data: { label: "Not enough data yet", icon: Hourglass },
};

const value = (v: number | null) => (v === null ? "—" : String(Math.round(v)));

/** The KPI on both versions, the difference, and whether it is more than chance. */
export function KpiResult({ result }: { result: KpiComparison }) {
  const { label, icon: Icon, variant } = VERDICTS[result.verdict];
  const unit = result.kpi === "score" ? "" : "%";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{KPI_LABELS[result.kpi]}</span>
        <Badge variant={variant ?? "outline"} className="gap-1 font-normal">
          <Icon className="size-3" aria-hidden /> {label}
        </Badge>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-sm">
        {(
          [
            [`v${result.control.version} (current)`, `${value(result.control.value)}${unit}`, `${result.control.samples} conversations`],
            [`v${result.candidate.version} (new)`, `${value(result.candidate.value)}${unit}`, `${result.candidate.samples} conversations`],
            ["Difference", result.difference === null ? "—" : `${result.difference > 0 ? "+" : ""}${Math.round(result.difference)}${unit}`, "new minus current"],
          ] as const
        ).map(([term, v, hint]) => (
          <div key={term} className="flex flex-col gap-0.5 rounded-md border p-2.5">
            <dt className="text-xs text-muted-foreground">{term}</dt>
            <dd className="text-lg font-semibold tabular-nums">{v}</dd>
            <dd className="text-xs text-muted-foreground">{hint}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        Graded production conversations: the new version since the rollout started, the current one over the same time and the 14 days before. A verdict needs
        10 conversations on each side and a difference larger than chance would explain.
      </p>
    </div>
  );
}

export const rolloutLabel = (r: RolloutInfo) =>
  r.status === "active" ? `v${r.candidateVersion} to ${r.percent}% of customers` : r.status === "promoted" ? `v${r.candidateVersion} promoted to everyone` : `v${r.candidateVersion} rolled back`;
