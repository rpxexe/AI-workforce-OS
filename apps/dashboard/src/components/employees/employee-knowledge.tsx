"use client";

import type { KnowledgeSource } from "@workforce/shared";
import Link from "next/link";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useApi, useApiQuery } from "@/lib/api";

/** The workspace's knowledge sources, with a switch on each to attach it to this employee. */
export function EmployeeKnowledge({
  workspaceId,
  employeeId,
  canEdit,
}: {
  workspaceId: string;
  employeeId: string;
  canEdit: boolean;
}) {
  const api = useApi();
  const attachedPath = `/workspaces/${workspaceId}/employees/${employeeId}/knowledge`;
  const all = useApiQuery<KnowledgeSource[]>(`/workspaces/${workspaceId}/knowledge/sources`);
  const attached = useApiQuery<KnowledgeSource[]>(attachedPath);
  const [saving, setSaving] = useState(false);

  const loadError = all.error ?? attached.error;
  if (loadError) return <p className="text-sm text-destructive">{loadError.message}</p>;
  if (!all.data || !attached.data) return <Skeleton className="h-10 w-full" />;
  if (all.data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No knowledge sources in this workspace yet.{" "}
        <Link href="/knowledge" className="text-foreground underline underline-offset-4">
          Create one
        </Link>{" "}
        and upload documents to it.
      </p>
    );

  const attachedIds = new Set(attached.data.map((s) => s.id));
  const toggle = async (source: KnowledgeSource, on: boolean) => {
    const sourceId = source.id;
    setSaving(true);
    const sourceIds = [...attachedIds].filter((id) => id !== sourceId).concat(on ? [sourceId] : []);
    try {
      attached.setData(
        await api<KnowledgeSource[]>(attachedPath, { method: "PUT", body: { sourceIds }, toast: `${source.name} ${on ? "attached" : "detached"}` }),
      );
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {all.data.map((source) => (
          <li key={source.id} className="flex items-center justify-between gap-3">
            <Label htmlFor={`source-${source.id}`} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
              <span className="max-w-full truncate text-sm font-medium">{source.name}</span>
              <span className="text-xs text-muted-foreground">
                {source.documentCount} {source.documentCount === 1 ? "document" : "documents"}
              </span>
            </Label>
            <Switch
              id={`source-${source.id}`}
              checked={attachedIds.has(source.id)}
              disabled={!canEdit || saving}
              onCheckedChange={(on) => toggle(source, on)}
            />
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">Changes apply to the next message; they are not part of a version.</p>
    </div>
  );
}
