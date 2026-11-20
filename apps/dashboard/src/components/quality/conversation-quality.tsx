"use client";

import type { DatasetSummary, EvaluationRecord } from "@workforce/shared";
import { DatabaseZap, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { timeAgo } from "@/components/inbox/meta";
import { EvaluationStatus, formatScore, Provenance, ResultList } from "@/components/quality/meta";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin } from "@/lib/workspace";

const POLL_MS = 3000;

/** The conversation's grades (drill-down), grading it now, and copying it into a regression dataset. */
export function ConversationQuality({ workspaceId, conversationId, title }: { workspaceId: string; conversationId: string; title: string }) {
  const api = useApi();
  const isAdmin = useIsAdmin();
  const path = `/workspaces/${workspaceId}/conversations/${conversationId}/evaluations`;
  const { data, reload } = useApiQuery<EvaluationRecord[]>(path);
  const { data: datasets } = useApiQuery<DatasetSummary[]>(isAdmin ? `/workspaces/${workspaceId}/datasets` : null);
  const [selected, setSelected] = useState<string>();
  const [datasetId, setDatasetId] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [note, setNote] = useState<string>();

  const pending = data?.some((e) => e.status === "PENDING" || e.status === "RUNNING") ?? false;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, reload]);

  const act = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setNote(undefined);
    try {
      setNote(await work());
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(undefined);
    }
  };
  const evaluate = () =>
    act("evaluate", async () => {
      const queued = await api<EvaluationRecord>(path, { method: "POST" });
      setSelected(queued.id);
      reload();
      return "Grading in the background.";
    });
  const addToDataset = () =>
    act("dataset", async () => {
      await api(`/workspaces/${workspaceId}/datasets/${datasetId}/cases`, { method: "POST", body: { name: title.slice(0, 100) || "Conversation", conversationId } });
      return `Added to ${datasets?.find((d) => d.id === datasetId)?.name}.`;
    });

  const shown = data?.find((e) => e.id === selected) ?? data?.[0];
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4" aria-hidden />
          Quality
        </CardTitle>
        {isAdmin && (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={evaluate} disabled={busy !== undefined || pending}>
              {pending ? "Grading" : "Evaluate now"}
            </Button>
            <Select value={datasetId} onValueChange={setDatasetId}>
              <SelectTrigger aria-label="Regression dataset" size="sm" className="w-44">
                <SelectValue placeholder={datasets?.length === 0 ? "No datasets yet" : "Dataset"} />
              </SelectTrigger>
              <SelectContent>
                {datasets?.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={addToDataset} disabled={!datasetId || busy !== undefined}>
              <DatabaseZap aria-hidden />
              Add to dataset
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4" aria-live="polite">
        {note && <p className="text-sm text-muted-foreground">{note}</p>}
        {!data ? null : !shown ? (
          <p className="text-sm text-muted-foreground">
            Not graded yet. Conversations are graded automatically about 10 minutes after they go quiet. See the{" "}
            <Link href="/quality" className="underline underline-offset-2">
              Quality
            </Link>{" "}
            page for every evaluator.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-col">
                <span className="text-sm">
                  Score <span className="text-lg font-semibold tabular-nums">{formatScore(shown.score)}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · {shown.failures} failed · {shown.messageCount} messages · {shown.trigger} · {timeAgo(shown.createdAt)}
                  </span>
                </span>
                <Provenance evaluation={shown} />
              </div>
              <div className="flex items-center gap-2">
                <EvaluationStatus evaluation={shown} />
                {data.length > 1 && (
                  <Select value={shown.id} onValueChange={setSelected}>
                    <SelectTrigger aria-label="Earlier evaluations" size="sm" className="w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {data.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {new Date(e.createdAt).toLocaleString()} · {formatScore(e.score)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>
            </div>
            {shown.error && <p className="text-sm text-muted-foreground">{shown.error}</p>}
            {shown.results.length > 0 && <ResultList results={shown.results} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
