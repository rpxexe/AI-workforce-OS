"use client";

import { KPI_LABELS, KPIS, type Kpi, type RolloutInfo } from "@workforce/shared";
import { Percent, Rocket, Undo2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { KpiResult } from "@/components/improvements/meta";
import { timeAgo } from "@/components/inbox/meta";
import { ErrorState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApi } from "@/lib/api";

const SHARES = [5, 10, 25, 50, 100] as const;

/** A running rollout: its share and KPI, with change share, promote and roll back for admins. */
export function RolloutPanel({
  workspaceId,
  rollout,
  canEdit,
  onChange,
}: {
  workspaceId: string;
  rollout: RolloutInfo;
  canEdit: boolean;
  onChange: (rollout: RolloutInfo) => void;
}) {
  const api = useApi();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const path = `/workspaces/${workspaceId}/employees/${rollout.employeeId}/rollouts/${rollout.id}`;
  const act = async (body: object) => {
    setError(undefined);
    setBusy(true);
    try {
      onChange(await api<RolloutInfo>(path, { method: "PATCH", body }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const active = rollout.status === "active";

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        {active ? (
          <>
            <span className="font-medium">
              v{rollout.candidateVersion} answers {rollout.percent}% of customers
            </span>
            , v{rollout.controlVersion} the rest. Each customer keeps the same version on every channel. Started {timeAgo(rollout.startedAt)}.
          </>
        ) : rollout.status === "promoted" ? (
          `v${rollout.candidateVersion} was promoted and is live for everyone (${timeAgo(rollout.endedAt ?? rollout.startedAt)}).`
        ) : (
          `v${rollout.candidateVersion} was rolled back; customers are served v${rollout.controlVersion} (${timeAgo(rollout.endedAt ?? rollout.startedAt)}).`
        )}
      </p>
      <KpiResult result={rollout.result} />
      {canEdit && active && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`share-${rollout.id}`}>Share of customers</Label>
            <Select value={String(rollout.percent)} onValueChange={(v) => act({ action: "set_percent", percent: Number(v) })} disabled={busy}>
              <SelectTrigger id={`share-${rollout.id}`} className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[...new Set([...SHARES, rollout.percent])].sort((a, b) => a - b).map((p) => (
                  <SelectItem key={p} value={String(p)}>
                    {p}%
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={busy}
            onClick={() =>
              setConfirm({
                title: `Promote v${rollout.candidateVersion} to everyone?`,
                description: `Version ${rollout.candidateVersion} is published and every customer is served it. You can roll back to v${rollout.controlVersion} afterwards.`,
                confirmLabel: "Promote",
                onConfirm: () => act({ action: "promote" }),
              })
            }
          >
            <Rocket aria-hidden />
            Promote
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              setConfirm({
                title: "Roll back this rollout?",
                description: `Every customer goes back to v${rollout.controlVersion}. Version ${rollout.candidateVersion} stays saved.`,
                confirmLabel: "Roll back",
                onConfirm: () => act({ action: "rollback" }),
              })
            }
          >
            <Undo2 aria-hidden />
            Roll back
          </Button>
        </div>
      )}
      {error && <ErrorState message={error} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** Starts a rollout of one version to a share of customers, measuring a KPI. */
export function StartRollout({
  workspaceId,
  employeeId,
  versions,
  defaultVersion,
  defaultKpi = "score",
  liveVersion,
  onStarted,
}: {
  workspaceId: string;
  employeeId: string;
  /** Versions that may be rolled out (not the live one). */
  versions: number[];
  defaultVersion?: number;
  defaultKpi?: Kpi;
  liveVersion: number;
  onStarted: (rollout: RolloutInfo) => void;
}) {
  const api = useApi();
  const [version, setVersion] = useState(String(defaultVersion ?? versions[0] ?? ""));
  const [percent, setPercent] = useState("10");
  const [kpi, setKpi] = useState<Kpi>(defaultKpi);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setConfirm({
      title: `Serve v${version} to ${percent}% of customers?`,
      description: `${percent}% of customers will be answered by version ${version} on every channel; the rest stay on v${liveVersion}. You can change the share, promote or roll back at any time.`,
      confirmLabel: "Start rollout",
      onConfirm: async () => {
        setError(undefined);
        setBusy(true);
        try {
          onStarted(
            await api<RolloutInfo>(`/workspaces/${workspaceId}/employees/${employeeId}/rollouts`, {
              method: "POST",
              body: { version: Number(version), percent: Number(percent), kpi },
            }),
          );
        } catch (err) {
          setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
        } finally {
          setBusy(false);
        }
      },
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rollout-version-${employeeId}`}>Version</Label>
          <Select value={version} onValueChange={setVersion}>
            <SelectTrigger id={`rollout-version-${employeeId}`} className="w-28">
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              {versions.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  v{n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rollout-share-${employeeId}`}>Share</Label>
          <Select value={percent} onValueChange={setPercent}>
            <SelectTrigger id={`rollout-share-${employeeId}`} className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SHARES.map((p) => (
                <SelectItem key={p} value={String(p)}>
                  {p}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`rollout-kpi-${employeeId}`}>KPI to watch</Label>
          <Select value={kpi} onValueChange={(v) => setKpi(v as Kpi)}>
            <SelectTrigger id={`rollout-kpi-${employeeId}`} className="w-60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KPIS.map((k) => (
                <SelectItem key={k} value={k}>
                  {KPI_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={!version || busy}>
          <Percent aria-hidden />
          {busy ? "Starting" : "Start rollout"}
        </Button>
      </div>
      {error && <ErrorState message={error} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </form>
  );
}
