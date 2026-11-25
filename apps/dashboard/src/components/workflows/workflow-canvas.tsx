"use client";

// Draws a workflow definition with React Flow and turns edits on the canvas back into a new
// definition. Nothing here runs a workflow: the engine on the server does, from the saved data.
import "@xyflow/react/dist/style.css";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from "@xyflow/react";
import { NODE_LABELS, type Branch, type WorkflowDefinition, type WorkflowNode, type WorkflowStepExecution } from "@workforce/shared";
import { useState } from "react";
import { NODE_ICONS, runDot } from "@/components/workflows/meta";
import { cn } from "@/lib/utils";

type StepData = { node: WorkflowNode; hasIssue: boolean; status?: WorkflowStepExecution["status"] };
type StepNode = Node<StepData, "step">;

function Step({ data, selected }: NodeProps<StepNode>) {
  const { node, hasIssue, status } = data;
  const Icon = NODE_ICONS[node.type];
  return (
    <div
      className={cn(
        "w-56 rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-sm dark:shadow-none",
        selected && "ring-2 ring-ring",
        hasIssue && "border-destructive",
      )}
    >
      {node.type !== "trigger" && <Handle type="target" position={Position.Top} />}
      <div className="flex items-center gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{node.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {NODE_LABELS[node.type]} · {node.id}
          </span>
        </span>
        {status && <span className={cn("size-2 shrink-0 rounded-full", runDot(status))} title={status.toLowerCase()} />}
      </div>
      {node.type === "condition" ? (
        <>
          <Handle type="source" id="yes" position={Position.Bottom} style={{ left: "30%" }} />
          <Handle type="source" id="no" position={Position.Bottom} style={{ left: "70%" }} />
          <div className="mt-1 flex justify-around text-[10px] text-muted-foreground">
            <span>yes</span>
            <span>no</span>
          </div>
        </>
      ) : (
        node.type !== "end" && <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}

const nodeTypes = { step: Step };

/**
 * `onChange` receives the whole new definition after a drag, a connection or a deletion.
 * `statuses` colours nodes by what happened to them in a run.
 */
export function WorkflowCanvas({
  definition,
  onChange,
  selectedId,
  onSelect,
  issueNodeIds = new Set(),
  statuses,
  readOnly = false,
  className,
}: {
  definition: WorkflowDefinition;
  onChange?: (definition: WorkflowDefinition) => void;
  selectedId?: string | null;
  onSelect?: (nodeId: string | null) => void;
  issueNodeIds?: Set<string>;
  statuses?: Record<string, WorkflowStepExecution["status"]>;
  readOnly?: boolean;
  className?: string;
}) {
  // React Flow measures nodes after rendering; kept here so the definition holds only our data.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());

  const nodes: StepNode[] = definition.nodes.map((node) => ({
    id: node.id,
    type: "step",
    position: node.position,
    data: { node, hasIssue: issueNodeIds.has(node.id), status: statuses?.[node.id] },
    selected: node.id === selectedId,
    measured: measured[node.id],
    deletable: !readOnly,
  }));
  const edges: Edge[] = definition.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: e.branch ?? null,
    label: e.branch,
    selected: selectedEdges.has(e.id),
    animated: statuses !== undefined && statuses[e.target] !== undefined && statuses[e.source] === "SUCCEEDED",
  }));

  const removeNodes = (ids: Set<string>) =>
    onChange?.({
      nodes: definition.nodes.filter((n) => !ids.has(n.id)),
      edges: definition.edges.filter((e) => !ids.has(e.source) && !ids.has(e.target)),
    });

  const onNodesChange = (changes: NodeChange<StepNode>[]) => {
    const sizes: typeof measured = {};
    const moved = new Map<string, { x: number; y: number }>();
    const removed = new Set<string>();
    for (const change of changes) {
      if (change.type === "dimensions" && change.dimensions) sizes[change.id] = change.dimensions;
      else if (change.type === "position" && change.position) moved.set(change.id, change.position);
      else if (change.type === "remove") removed.add(change.id);
      else if (change.type === "select" && change.selected) onSelect?.(change.id);
      else if (change.type === "select" && selectedId === change.id) onSelect?.(null);
    }
    if (Object.keys(sizes).length > 0) setMeasured((m) => ({ ...m, ...sizes }));
    if (readOnly) return;
    if (removed.size > 0) {
      removeNodes(removed);
      if (selectedId && removed.has(selectedId)) onSelect?.(null);
    } else if (moved.size > 0)
      onChange?.({ ...definition, nodes: definition.nodes.map((n) => (moved.has(n.id) ? { ...n, position: moved.get(n.id)! } : n)) });
  };

  const onEdgesChange = (changes: EdgeChange[]) => {
    const removed = new Set(changes.flatMap((c) => (c.type === "remove" ? [c.id] : [])));
    const selects = changes.flatMap((c) => (c.type === "select" ? [c] : []));
    if (selects.length > 0)
      setSelectedEdges((s) => {
        const next = new Set(s);
        for (const c of selects) {
          if (c.selected) next.add(c.id);
          else next.delete(c.id);
        }
        return next;
      });
    if (!readOnly && removed.size > 0) onChange?.({ ...definition, edges: definition.edges.filter((e) => !removed.has(e.id)) });
  };

  // A node has one way out (a condition one per branch): a new connection replaces the old one.
  const onConnect = (c: Connection) => {
    if (readOnly || c.source === c.target) return;
    const branch = (c.sourceHandle ?? undefined) as Branch | undefined;
    const kept = definition.edges.filter((e) => !(e.source === c.source && e.branch === branch));
    onChange?.({ ...definition, edges: [...kept, { id: `${c.source}-${branch ?? "next"}-${c.target}`, source: c.source, target: c.target, branch }] });
  };

  return (
    <div className={cn("h-[560px] w-full overflow-hidden rounded-lg border bg-muted/30 shadow-sm dark:shadow-none", className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onPaneClick={() => onSelect?.(null)}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : ["Backspace", "Delete"]}
        // The app themes with a .dark class that nothing sets yet; follow it when a theme switch exists.
        colorMode="light"
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
