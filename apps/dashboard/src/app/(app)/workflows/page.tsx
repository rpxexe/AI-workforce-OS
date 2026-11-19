"use client";

import {
  blankWorkflow,
  leadFollowUpWorkflow,
  type EmployeeSummary,
  type WorkflowDetail,
  type WorkflowSummary,
} from "@workforce/shared";
import { History, Plus, Workflow } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { StatusBadge, formatDate, versionLabel } from "@/components/employees/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

function NewWorkflow({ workspaceId, onCancel }: { workspaceId: string; onCancel: () => void }) {
  const api = useApi();
  const router = useRouter();
  const employees = useApiQuery<EmployeeSummary[]>(`/workspaces/${workspaceId}/employees`);
  const [name, setName] = useState("");
  const [start, setStart] = useState<"blank" | "example">("example");
  const [employeeId, setEmployeeId] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (start === "example" && !employeeId) return setError("Choose the employee who makes the call.");
    setSaving(true);
    setError(undefined);
    try {
      const created = await api<WorkflowDetail>(`/workspaces/${workspaceId}/workflows`, {
        method: "POST",
        body: { name, definition: start === "example" ? leadFollowUpWorkflow(employeeId) : blankWorkflow() },
      });
      router.push(`/workflows/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 rounded-lg border p-4 sm:max-w-lg">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wf-name">Name</Label>
        <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="New lead follow-up" maxLength={80} required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="wf-start">Start from</Label>
        <Select value={start} onValueChange={(v) => setStart(v as typeof start)}>
          <SelectTrigger id="wf-start" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="example">Example: new lead, AI call, book a meeting</SelectItem>
            <SelectItem value="blank">Blank</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {start === "example" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="wf-employee">Employee who calls the lead</Label>
          <Select value={employeeId || undefined} onValueChange={setEmployeeId}>
            <SelectTrigger id="wf-employee" className="w-full">
              <SelectValue placeholder="Choose an employee" />
            </SelectTrigger>
            <SelectContent>
              {(employees.data ?? []).map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            It needs a phone number and the calendar tool, and must be published, before the workflow can run.
          </p>
        </div>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          Create workflow
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Deleted workflows, newest first, each with Restore. Admins only. */
function DeletedWorkflows({ workspaceId, onRestored }: { workspaceId: string; onRestored: () => void }) {
  const api = useApi();
  const { data, error, reload } = useApiQuery<WorkflowSummary[]>(`/workspaces/${workspaceId}/workflows?deleted=true`);
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={2} />;
  if (data.length === 0) return <p className="text-sm text-muted-foreground">No deleted workflows.</p>;
  const restore = async (id: string) => {
    setBusy(id);
    setFailure(undefined);
    try {
      await api(`/workspaces/${workspaceId}/workflows/${id}/restore`, { method: "POST" });
      reload();
      onRestored();
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      {failure && <p className="text-sm text-destructive">{failure}</p>}
      <ul className="divide-y rounded-lg border">
        {data.map((w) => (
          <li key={w.id} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="min-w-0">
              <span className="block truncate font-medium">{w.name}</span>
              <span className="text-sm text-muted-foreground">Deleted {w.deletedAt && formatDate(w.deletedAt)}</span>
            </span>
            <Button variant="outline" size="sm" onClick={() => restore(w.id)} disabled={busy !== undefined}>
              <History aria-hidden />
              Restore
            </Button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">A restored workflow comes back paused. Resume it to run it again.</p>
    </div>
  );
}

export default withWorkspace(function WorkflowsPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useApiQuery<WorkflowSummary[]>(`/workspaces/${workspace.id}/workflows`);
  const [creating, setCreating] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  const newButton = isAdmin && !creating && (
    <Button onClick={() => setCreating(true)}>
      <Plus aria-hidden />
      New workflow
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Workflows" description={`Journeys your AI employees run in the ${workspace.name} workspace.`}>
        {newButton}
      </PageHeader>
      {creating && <NewWorkflow workspaceId={workspace.id} onCancel={() => setCreating(false)} />}
      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : data.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No workflows yet"
          description={
            isAdmin
              ? "Draw a journey: what starts it, what your AI employees do, and what happens next."
              : "An organization admin has not created any workflows in this workspace yet."
          }
        >
          {newButton}
        </EmptyState>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Workflow</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden sm:table-cell">Version</TableHead>
                <TableHead className="hidden lg:table-cell">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((w) => (
                <TableRow key={w.id}>
                  <TableCell>
                    <Link href={`/workflows/${w.id}`} className="font-medium hover:underline">
                      {w.name}
                    </Link>
                    {w.description && <span className="block truncate text-sm text-muted-foreground">{w.description}</span>}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={w.status} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">{versionLabel(w.latestVersion, w.publishedVersion)}</TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDate(w.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {isAdmin && (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="w-fit" onClick={() => setShowDeleted((v) => !v)} aria-expanded={showDeleted}>
            {showDeleted ? "Hide deleted workflows" : "Show deleted workflows"}
          </Button>
          {showDeleted && <DeletedWorkflows workspaceId={workspace.id} onRestored={reload} />}
        </div>
      )}
    </div>
  );
});
