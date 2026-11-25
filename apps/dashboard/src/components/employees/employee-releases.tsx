"use client";

import type { EmployeeDetail, EmployeeReleases, ReleaseAction, RolloutInfo } from "@workforce/shared";
import { Database, GitCompareArrows, Undo2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { rolloutLabel } from "@/components/improvements/meta";
import { RolloutPanel, StartRollout } from "@/components/improvements/rollout";
import { timeAgo } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useApi, useApiQuery } from "@/lib/api";

const ACTIONS: Record<ReleaseAction, string> = { publish: "Published", rollback: "Rolled back to", promote: "Promoted" };

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: EmployeeReleases = {
  active: null,
  rollouts: [],
  releases: [4, 3, 2, 1].map((version) => ({
    id: `sample-${version}`,
    action: "publish",
    version,
    previousVersion: version > 1 ? version - 1 : null,
    by: "sample-user",
    createdAt: "2026-01-01T00:00:00.000Z",
  })),
  regressionSuite: { id: "sample", cases: 12 },
  rollbackTo: 3,
};

/**
 * Releases: a running rollout (A/B) with its KPI, starting one, rolling back to the previous live version, the
 * regression suite, and the history of what was live when.
 */
export function EmployeeReleases({
  workspaceId,
  employee,
  canEdit,
  onLiveChange,
}: {
  workspaceId: string;
  employee: EmployeeDetail;
  canEdit: boolean;
  /** The live version changed (promoted, rolled back): the page reloads the employee. */
  onLiveChange: () => void;
}) {
  const api = useApi();
  const path = `/workspaces/${workspaceId}/employees/${employee.id}`;
  const { data, error, reload } = useApiQuery<EmployeeReleases>(`${path}/releases`);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;

  const live = employee.publishedVersion;
  const changed = (rollout: RolloutInfo) => {
    reload();
    if (rollout.status !== "active") onLiveChange();
  };
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      reload();
      onLiveChange();
    } catch {
      // The toast in useApi shows why it failed.
    }
  };
  const candidates = employee.versions.map((v) => v.number).filter((n) => n !== live);

  return (
    <Skullet data={data} sample={SAMPLE} id="employee-releases" label="Loading releases">
      {(data) => {
        const ended = data.rollouts.filter((r) => r.status !== "active");
        return (
          <div className="flex flex-col gap-6">
            {data.active ? (
              <RolloutPanel workspaceId={workspaceId} rollout={data.active} canEdit={canEdit} onChange={changed} />
            ) : live === null || employee.status !== "ACTIVE" ? (
              <p className="text-sm text-muted-foreground">Publish this employee and make it active to roll out new versions gradually.</p>
            ) : canEdit && candidates.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-muted-foreground">
                  Serve a saved version to a share of customers next to v{live}, and compare a KPI before promoting it. Versions from improvement suggestions need
                  approval first.
                </p>
                <StartRollout workspaceId={workspaceId} employeeId={employee.id} versions={candidates} liveVersion={live} onStarted={changed} />
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">v{live} serves every customer. No rollout is running.</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              {canEdit && !data.active && data.rollbackTo !== null && (
                <Button
                  variant="outline"
                  onClick={() =>
                    setConfirm({
                      title: `Roll back to v${data.rollbackTo}?`,
                      description: `Customers will be served version ${data.rollbackTo}, which was live before v${live}. Version ${live} stays saved.`,
                      confirmLabel: "Roll back",
                      onConfirm: () => act(() => api(`${path}/rollback`, {
                          method: "POST",
                          toast: { loading: "Rolling back…", success: `Rolled back to v${data.rollbackTo}` },
                        })),
                    })
                  }
                >
                  <Undo2 aria-hidden />
                  Roll back to v{data.rollbackTo}
                </Button>
              )}
              <Button variant="outline" asChild>
                <Link href={`/employees/${employee.id}/compare`}>
                  <GitCompareArrows aria-hidden />
                  Compare versions
                </Link>
              </Button>
              {data.regressionSuite ? (
                <Button variant="outline" asChild>
                  <Link href={`/quality/datasets/${data.regressionSuite.id}`}>
                    <Database aria-hidden />
                    Regression suite ({data.regressionSuite.cases} {data.regressionSuite.cases === 1 ? "case" : "cases"})
                  </Link>
                </Button>
              ) : (
                canEdit && (
                  <Button variant="outline" onClick={() => act(() => api(`${path}/regression-suite`, { method: "POST", toast: "Regression suite created" }))}>
                    <Database aria-hidden />
                    Create regression suite
                  </Button>
                )
              )}
            </div>

            {(data.releases.length > 0 || ended.length > 0) && (
              <div className="grid gap-6 sm:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <h3 className="text-sm font-medium">Live version history</h3>
                  {data.releases.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Nothing published since releases were recorded.</p>
                  ) : (
                    <ul className="flex flex-col divide-y text-sm">
                      {data.releases.slice(0, 10).map((r) => (
                        <li key={r.id} className="flex justify-between gap-2 py-1.5">
                          <span>
                            {ACTIONS[r.action]} v{r.version}
                            {r.previousVersion !== null && <span className="text-muted-foreground"> (was v{r.previousVersion})</span>}
                          </span>
                          <span className="text-muted-foreground">{timeAgo(r.createdAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {ended.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-medium">Past rollouts</h3>
                    <ul className="flex flex-col divide-y text-sm">
                      {ended.slice(0, 10).map((r) => (
                        <li key={r.id} className="flex justify-between gap-2 py-1.5">
                          <span>{rolloutLabel(r)}</span>
                          <span className="text-muted-foreground">
                            {r.result.difference === null ? "no data" : `${r.result.difference > 0 ? "+" : ""}${Math.round(r.result.difference)} ${r.kpi === "score" ? "points" : "percentage points"}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
          </div>
        );
      }}
    </Skullet>
  );
}
