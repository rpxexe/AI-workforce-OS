"use client";

import {
  NODE_LABELS,
  NODE_TYPES,
  validateWorkflow,
  type EmployeeSummary,
  type NodeType,
  type ToolInfo,
  type WorkflowDefinition,
  type WorkflowDependencies,
  type WorkflowDetail,
  type WorkflowNode,
} from "@workforce/shared";
import { ArrowLeft, CircleAlert, Copy, History, Pause, Play, Plug, Rocket, Save, Trash2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { StatusBadge } from "@/components/employees/meta";
import { ProviderOverridesForm } from "@/components/providers/provider-overrides";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NODE_ICONS } from "@/components/workflows/meta";
import { NEW_NODE_CONFIG, NodeSettings } from "@/components/workflows/node-settings";
import { WorkflowCanvas } from "@/components/workflows/workflow-canvas";
import { WorkflowRuns } from "@/components/workflows/workflow-runs";
import { ApiRequestError, useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

/** A node of `type` placed under the selected node, or under the lowest one. */
function newNode(definition: WorkflowDefinition, type: NodeType, below?: WorkflowNode): WorkflowNode {
  let n = 1;
  while (definition.nodes.some((node) => node.id === `${type}_${n}`)) n++;
  const anchor = below ?? definition.nodes.reduce<WorkflowNode | undefined>((low, node) => (!low || node.position.y > low.position.y ? node : low), undefined);
  return {
    id: `${type}_${n}`,
    type,
    name: NODE_LABELS[type],
    position: anchor ? { x: anchor.position.x + (below ? 40 : 0), y: anchor.position.y + 140 } : { x: 0, y: 0 },
    config: structuredClone(NEW_NODE_CONFIG[type]),
  };
}

export default withWorkspace(function WorkflowPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  const base = `/workspaces/${workspace.id}`;
  const [version, setVersion] = useState<number>();
  const path = `${base}/workflows/${id}${version ? `?version=${version}` : ""}`;
  const { data, error, reload, setData } = useApiQuery<WorkflowDetail>(path);
  const employees = useApiQuery<EmployeeSummary[]>(`${base}/employees`);
  const tools = useApiQuery<ToolInfo[]>(`${base}/tools`);

  // Unsaved edits; null while showing what the server has.
  const [draft, setDraft] = useState<WorkflowDefinition | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; issues: string[] }>();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={6} />;

  const definition = draft ?? data.definition;
  const dirty = draft !== null || (name !== null && name !== data.name);
  const issues = draft ? validateWorkflow(draft) : data.issues;
  const issueNodeIds = new Set(issues.flatMap((i) => (i.nodeId ? [i.nodeId] : [])));
  const selected = definition.nodes.find((n) => n.id === selectedId);
  const readOnly = !isAdmin;
  const isLatest = data.version === data.latestVersion;

  /** Runs `action` with the buttons disabled and shows what went wrong. */
  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setActionError(undefined);
    try {
      await action();
    } catch (err) {
      setActionError({
        message: err instanceof Error ? err.message : "Something went wrong. Try again.",
        issues: err instanceof ApiRequestError ? err.issues.map((i) => i.message) : [],
      });
    } finally {
      setBusy(false);
    }
  };
  const run = (action: () => Promise<WorkflowDetail>) =>
    act(async () => {
      const updated = await action();
      setVersion(undefined);
      setData(updated);
      setDraft(null);
      setName(null);
    });
  const duplicate = () =>
    act(async () => {
      const copy = await api<WorkflowDetail>(`${base}/workflows/${id}/duplicate`, { method: "POST", body: { version: data.version } });
      router.push(`/workflows/${copy.id}`);
    });
  // Shows what deleting affects (runs it stops, a webhook that stops working) before asking.
  const remove = () =>
    act(async () => {
      const deps = await api<WorkflowDependencies>(`${base}/workflows/${id}/dependencies`);
      const runs = deps.activeRuns === 1 ? "1 run" : `${deps.activeRuns} runs`;
      setConfirm({
        title: `Delete ${data.name}?`,
        description: [
          deps.activeRuns > 0 && `${runs} in progress will be stopped. They can be retried if you restore the workflow.`,
          deps.webhookTrigger && "Its webhook URL stops working: anything posting to it gets an error.",
          "You can restore it from the deleted workflows on the Workflows page.",
        ]
          .filter(Boolean)
          .join(" "),
        confirmLabel: deps.activeRuns > 0 ? `Delete and stop ${runs}` : "Delete",
        onConfirm: () =>
          act(async () => {
            await api(`${base}/workflows/${id}${deps.activeRuns > 0 ? "?stopRuns=true" : ""}`, { method: "DELETE" });
            router.push("/workflows");
          }),
      });
    });
  const save = () =>
    run(() =>
      api<WorkflowDetail>(`${base}/workflows/${id}`, {
        method: "PUT",
        body: { name: name ?? data.name, description: data.description, definition },
      }),
    );
  const publish = () =>
    setConfirm({
      title: `Publish version ${data.version}?`,
      description:
        data.publishedVersion === null
          ? "The workflow goes live and can be run."
          : `New runs will use version ${data.version} instead of version ${data.publishedVersion}. Runs already started keep their version.`,
      confirmLabel: "Publish",
      onConfirm: () => run(() => api<WorkflowDetail>(`${base}/workflows/${id}/publish`, { method: "POST", body: { version: data.version } })),
    });
  const setStatus = (status: "ACTIVE" | "PAUSED") =>
    run(() => api<WorkflowDetail>(`${base}/workflows/${id}/status`, { method: "PATCH", body: { status } }));
  const edit = (next: WorkflowDefinition) => setDraft(next);
  const updateNode = (node: WorkflowNode) => edit({ ...definition, nodes: definition.nodes.map((n) => (n.id === node.id ? node : n)) });
  const deleteNode = (nodeId: string) => {
    edit({ nodes: definition.nodes.filter((n) => n.id !== nodeId), edges: definition.edges.filter((e) => e.source !== nodeId && e.target !== nodeId) });
    setSelectedId(null);
  };
  const addNode = (type: NodeType) => {
    const node = newNode(definition, type, selected);
    edit({ ...definition, nodes: [...definition.nodes, node] });
    setSelectedId(node.id);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link href="/workflows" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Workflows
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {isAdmin ? (
              <Input aria-label="Workflow name" value={name ?? data.name} onChange={(e) => setName(e.target.value)} maxLength={80} className="max-w-sm text-base font-semibold" />
            ) : (
              <h1 className="truncate text-xl font-semibold tracking-tight">{data.name}</h1>
            )}
            <StatusBadge status={data.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={String(data.version)}
              onValueChange={(v) => {
                setDraft(null);
                setSelectedId(null);
                setVersion(Number(v) === data.latestVersion ? undefined : Number(v));
              }}
            >
              <SelectTrigger aria-label="Version" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data.versions.map((v) => (
                  <SelectItem key={v.number} value={String(v.number)}>
                    v{v.number}
                    {v.number === data.publishedVersion ? " · live" : ""}
                    {v.number === data.latestVersion ? " · latest" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">
                  <Plug aria-hidden />
                  Providers
                </Button>
              </SheetTrigger>
              <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
                <SheetHeader>
                  <SheetTitle>Providers</SheetTitle>
                  <SheetDescription>
                    The AI model, speech and email accounts this workflow&apos;s steps use. They win over the employee&apos;s and the organization&apos;s.
                  </SheetDescription>
                </SheetHeader>
                <div className="px-4 pb-6">
                  <ProviderOverridesForm path={`${base}/workflows/${id}/providers`} canEdit={isAdmin} />
                </div>
              </SheetContent>
            </Sheet>
            {isAdmin && (
              <>
                <Button variant="outline" onClick={save} disabled={(!dirty && isLatest) || busy}>
                  {isLatest || dirty ? <Save aria-hidden /> : <History aria-hidden />}
                  {isLatest || dirty ? "Save draft" : `Restore as v${data.latestVersion + 1}`}
                </Button>
                {!dirty && data.version !== data.publishedVersion && (
                  <Button onClick={publish} disabled={busy}>
                    <Rocket aria-hidden />
                    Publish v{data.version}
                  </Button>
                )}
                {data.status === "ACTIVE" && (
                  <Button variant="outline" onClick={() => setStatus("PAUSED")} disabled={busy}>
                    <Pause aria-hidden />
                    Pause
                  </Button>
                )}
                {data.status === "PAUSED" && (
                  <Button variant="outline" onClick={() => setStatus("ACTIVE")} disabled={busy}>
                    <Play aria-hidden />
                    Resume
                  </Button>
                )}
                <Button variant="outline" onClick={duplicate} disabled={busy} title={`Copy version ${data.version} into a new workflow`}>
                  <Copy aria-hidden />
                  Duplicate
                </Button>
                <Button variant="outline" onClick={remove} disabled={busy} className="text-destructive">
                  <Trash2 aria-hidden />
                  Delete
                </Button>
              </>
            )}
          </div>
        </div>
        {(dirty || !isLatest || data.publishedVersion !== data.version) && (
          <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm" role="status">
            {dirty
              ? "You have unsaved changes. Saving adds a new version; runs keep using the published one."
              : !isLatest
                ? `You are looking at version ${data.version}. Restoring it saves it as a new latest version; publish that to make it live.`
                : data.publishedVersion === null
                  ? "This workflow has never been published, so it cannot run yet."
                  : `Version ${data.version} is not live. Runs use version ${data.publishedVersion}.`}
          </p>
        )}
        {data.status === "PAUSED" && <p className="text-sm text-muted-foreground">Paused: runs in progress hold where they are and new runs are refused.</p>}
        {actionError && (
          <div className="flex flex-col gap-1">
            <ErrorState message={actionError.message} />
            {actionError.issues.length > 0 && (
              <ul className="list-disc pl-6 text-sm text-destructive">
                {actionError.issues.map((issue, i) => (
                  <li key={i}>{issue}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <Tabs defaultValue="editor">
        <TabsList>
          <TabsTrigger value="editor">Editor</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>
        <TabsContent value="editor" className="mt-4">
          <div className="flex flex-col gap-4 lg:flex-row">
            <div className="min-w-0 flex-1">
              <WorkflowCanvas
                definition={definition}
                onChange={edit}
                selectedId={selectedId}
                onSelect={setSelectedId}
                issueNodeIds={issueNodeIds}
                readOnly={readOnly}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                Drag from a step&apos;s bottom handle to the next step to connect them. Select a step or connection and press Delete to remove it.
              </p>
            </div>
            <aside className="flex w-full flex-col gap-4 lg:w-80">
              {selected ? (
                <div className="rounded-lg border p-4">
                  <NodeSettings
                    key={selected.id}
                    node={selected}
                    onChange={updateNode}
                    onDelete={() => deleteNode(selected.id)}
                    employees={employees.data ?? []}
                    tools={tools.data ?? []}
                    hookUrl={data.hookUrl}
                    readOnly={readOnly}
                  />
                </div>
              ) : (
                isAdmin && (
                  <div className="rounded-lg border p-4">
                    <p className="mb-3 text-sm font-medium">Add a step</p>
                    <div className="grid grid-cols-2 gap-2">
                      {NODE_TYPES.map((type) => {
                        const Icon = NODE_ICONS[type];
                        return (
                          <Button key={type} variant="outline" size="sm" className="justify-start" onClick={() => addNode(type)}>
                            <Icon aria-hidden />
                            {NODE_LABELS[type]}
                          </Button>
                        );
                      })}
                    </div>
                  </div>
                )
              )}
              <div className="rounded-lg border p-4">
                <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                  Checks
                  {issues.length === 0 ? <Badge variant="secondary">Ready to publish</Badge> : <Badge variant="destructive">{issues.length}</Badge>}
                </p>
                {issues.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Every step is connected and set up.</p>
                ) : (
                  <ul className="flex flex-col gap-1.5 text-sm">
                    {issues.map((issue, i) => (
                      <li key={i}>
                        <button
                          type="button"
                          className="flex items-start gap-2 text-left hover:underline"
                          onClick={() => issue.nodeId && setSelectedId(issue.nodeId)}
                        >
                          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
                          {issue.message}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </aside>
          </div>
        </TabsContent>
        <TabsContent value="runs" className="mt-4">
          <WorkflowRuns workspaceId={workspace.id} workflow={data} isAdmin={isAdmin} />
        </TabsContent>
      </Tabs>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
});
