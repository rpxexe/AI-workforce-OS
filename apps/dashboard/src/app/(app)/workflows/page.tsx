"use client";

import {
  blankWorkflow,
  leadFollowUpWorkflow,
  type EmployeeSummary,
  type WorkflowDetail,
  type WorkflowPage,
  type WorkflowSummary,
} from "@workforce/shared";
import { History, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { formatDate } from "@/components/employees/meta";
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState, PageHeader } from "@/components/states";
import { TablePager, useCursorPaged } from "@/components/table-pager";
import { SAMPLE_PAGE, WorkflowList } from "@/components/workflows/workflow-list";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const SAMPLE_DELETED: WorkflowPage = { data: SAMPLE_PAGE.data.slice(0, 3), nextCursor: null };

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
        toast: `${name} created`,
      });
      router.push(`/workflows/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="sm:max-w-lg">
      <CardHeader>
        <CardTitle>New workflow</CardTitle>
        <CardDescription>Start from the example journey or a blank canvas. You can edit every step next.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
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
      </CardContent>
    </Card>
  );
}

/** Deleted workflows, newest first, a cursor page at a time, each with Restore. Admins only. */
function DeletedWorkflows({ workspaceId, onRestored }: { workspaceId: string; onRestored: () => void }) {
  const api = useApi();
  const paged = useCursorPaged("deleted");
  const { data, error, loading, reload } = useApiQuery<WorkflowPage>(`/workspaces/${workspaceId}/workflows?deleted=true&${paged.query}`, {
    keepPrevious: true,
  });
  // While a page loads, `data` is still the previous one: its cursor must not open yet another page.
  const pager = paged.pager({ nextCursor: loading ? null : (data?.nextCursor ?? null), rows: loading ? 1 : (data?.data.length ?? 1) });
  const [busy, setBusy] = useState<string>();
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const restore = async (workflow: WorkflowSummary) => {
    setBusy(workflow.id);
    try {
      await api(`/workspaces/${workspaceId}/workflows/${workflow.id}/restore`, { method: "POST", toast: `${workflow.name} restored` });
      reload();
      onRestored();
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <Skullet data={data} sample={SAMPLE_DELETED} id="workflows-deleted" label="Loading deleted workflows">
      {(page) => page.data.length === 0 ? <p className="text-sm text-muted-foreground">No deleted workflows.</p> : (
    <div className="flex flex-col gap-2">
      <Card className="gap-0 py-0">
        <ul className="divide-y">
          {page.data.map((w) => (
            <li key={w.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <span className="min-w-0">
                <span className="block truncate font-medium">{w.name}</span>
                <span className="text-sm text-muted-foreground">Deleted {w.deletedAt && formatDate(w.deletedAt)}</span>
              </span>
              <Button variant="outline" size="sm" onClick={() => restore(w)} disabled={busy !== undefined}>
                <History aria-hidden />
                Restore
              </Button>
            </li>
          ))}
        </ul>
        <TablePager {...pager} className="border-t px-4 py-3" />
      </Card>
      <p className="text-xs text-muted-foreground">A restored workflow comes back paused. Resume it to run it again.</p>
    </div>
      )}
    </Skullet>
  );
}

export default withWorkspace(function WorkflowsPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const [creating, setCreating] = useState(false);
  // Bumped after a restore so the list and its tiles load again.
  const [refresh, setRefresh] = useState(0);
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
      <WorkflowList workspaceId={workspace.id} isAdmin={isAdmin} newButton={newButton} refresh={refresh} />
      {isAdmin && (
        <div className="flex flex-col gap-3">
          <Button variant="ghost" size="sm" className="w-fit" onClick={() => setShowDeleted((v) => !v)} aria-expanded={showDeleted}>
            {showDeleted ? "Hide deleted workflows" : "Show deleted workflows"}
          </Button>
          {showDeleted && <DeletedWorkflows workspaceId={workspace.id} onRestored={() => setRefresh((n) => n + 1)} />}
        </div>
      )}
    </div>
  );
});
