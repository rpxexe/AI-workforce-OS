// Workflows (the visual journey builder). The definition is plain data: the dashboard draws it
// with React Flow and the engine in @workforce/workflows runs it. Neither owns the format.
import { z } from "zod";
import { TOOL_NAMES } from "./tool.ts";

export const NODE_TYPES = [
  "trigger",
  "ai_employee",
  "condition",
  "tool",
  "http_request",
  "webhook",
  "wait",
  "voice_call",
  "message",
  "crm_update",
  "human_handoff",
  "end",
] as const;
export type NodeType = (typeof NODE_TYPES)[number];

export const NODE_LABELS: Record<NodeType, string> = {
  trigger: "Trigger",
  ai_employee: "AI Employee",
  condition: "Condition",
  tool: "Tool",
  http_request: "HTTP Request",
  webhook: "Webhook",
  wait: "Wait",
  voice_call: "Voice Call",
  message: "Message",
  crm_update: "CRM Update",
  human_handoff: "Human Handoff",
  end: "End",
};

/** The two ways out of a condition node. Every other node has one way out (End has none). */
export const BRANCHES = ["yes", "no"] as const;
export type Branch = (typeof BRANCHES)[number];

// Text fields may contain {{trigger.field}} and {{steps.<node id>.<field>}}, filled in when the step runs.
const text = (max: number) => z.string().trim().max(max);
const required = (max: number, what: string) => z.string().trim().min(1, `Enter ${what}`).max(max);
const employeeId = z.string().min(1, "Choose an employee");
const pairs = z.array(z.object({ key: required(100, "a name"), value: text(2000) })).max(30);

export const CONDITION_OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "greater_than",
  "less_than",
  "is_empty",
  "is_not_empty",
] as const;

/** What each node needs to run. Saving accepts anything; validation and publishing check these. */
export const nodeConfigSchemas = {
  trigger: z.object({
    /** manual: started from the dashboard or API. webhook: started by a POST to the workflow's hook URL. */
    kind: z.enum(["manual", "webhook"]).default("manual"),
  }),
  ai_employee: z.object({
    employeeId,
    message: required(5000, "the message to send"),
    /** Who the conversation is with (email or phone), so memory applies. Optional. */
    customer: text(200).default(""),
  }),
  condition: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("compare"),
      left: required(500, "a value to check"),
      operator: z.enum(CONDITION_OPERATORS),
      right: text(500).default(""),
    }),
    /** The model answers a yes/no question about everything the run has so far. */
    z.object({ mode: z.literal("ai"), question: required(1000, "a yes/no question") }),
  ]),
  tool: z.object({
    /** Whose grant (and admin settings) the tool runs with. */
    employeeId,
    tool: z.enum(TOOL_NAMES, "Choose a tool"),
    /** The tool's arguments. A value that is exactly one {{...}} keeps its type (numbers stay numbers). */
    input: z.record(z.string(), z.unknown()).default({}),
  }),
  http_request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: required(2000, "a URL"),
    headers: pairs.default([]),
    body: text(20000).default(""),
  }),
  webhook: z.object({ url: required(2000, "a URL") }),
  wait: z.object({
    amount: z.number().int().min(1).max(10_000),
    unit: z.enum(["seconds", "minutes", "hours", "days"]).default("minutes"),
  }),
  voice_call: z.object({
    employeeId,
    to: required(200, "the number to call"),
    greeting: text(300).default(""),
  }),
  message: z.object({
    channel: z.literal("email").default("email"),
    to: required(320, "who to send it to"),
    subject: required(200, "a subject"),
    body: required(5000, "the message"),
  }),
  crm_update: z.object({
    /** The customer's email or phone; created if new. */
    customer: required(200, "the customer's email or phone"),
    fields: pairs.min(1, "Add at least one field"),
  }),
  human_handoff: z.object({
    note: required(2000, "what the person should do"),
    /** A conversation (e.g. {{steps.ai.conversationId}}) to hand to the agents' inbox; empty for none. */
    conversationId: text(200).default(""),
  }),
  end: z.object({}),
} satisfies Record<NodeType, z.ZodType>;
export type NodeConfig<T extends NodeType> = z.infer<(typeof nodeConfigSchemas)[T]>;

const nodeId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, "Node ids are lower-case letters, digits and _, starting with a letter");

/** The stored graph. Structure only: node settings are checked by `validateWorkflow`, so drafts can be saved half-done. */
export const workflowDefinitionSchema = z.object({
  nodes: z
    .array(
      z.object({
        id: nodeId,
        type: z.enum(NODE_TYPES),
        name: z.string().trim().min(1).max(80),
        /** Where the editor draws it. The engine ignores it. */
        position: z.object({ x: z.number(), y: z.number() }),
        config: z.record(z.string(), z.unknown()),
      }),
    )
    .max(100),
  edges: z
    .array(z.object({ id: z.string().min(1).max(200), source: nodeId, target: nodeId, branch: z.enum(BRANCHES).optional() }))
    .max(200),
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
export type WorkflowNode = WorkflowDefinition["nodes"][number];
export type WorkflowEdge = WorkflowDefinition["edges"][number];

export type WorkflowIssue = { nodeId?: string; message: string };

/**
 * Checks a definition can run: one trigger, every node reachable from it, no loops, conditions
 * with a yes and a no path, every other node (but End) with exactly one way out, and every
 * node's settings complete. Pure, so the editor shows the same issues the API enforces.
 */
export function validateWorkflow(definition: WorkflowDefinition): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const nodes = new Map<string, WorkflowNode>();
  for (const node of definition.nodes) {
    if (nodes.has(node.id)) issues.push({ nodeId: node.id, message: `Two nodes have the id "${node.id}"` });
    nodes.set(node.id, node);
  }

  const triggers = definition.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) issues.push({ message: "A workflow needs exactly one trigger" });

  const outgoing = new Map<string, WorkflowEdge[]>();
  const incoming = new Map<string, number>();
  const seen = new Set<string>();
  for (const edge of definition.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      issues.push({ message: "A connection points at a node that does not exist" });
      continue;
    }
    const key = `${edge.source}>${edge.target}>${edge.branch ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge]);
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
  }

  for (const node of definition.nodes) {
    const out = outgoing.get(node.id) ?? [];
    const at = (message: string) => issues.push({ nodeId: node.id, message: `${node.name}: ${message}` });
    if (node.type === "trigger" && incoming.get(node.id)) at("nothing can lead into a trigger");
    if (node.type === "end") {
      if (out.length > 0) at("an End node cannot lead anywhere");
    } else if (node.type === "condition") {
      for (const branch of BRANCHES) {
        const n = out.filter((e) => e.branch === branch).length;
        if (n !== 1) at(n === 0 ? `connect the "${branch}" path` : `only one "${branch}" path is allowed`);
      }
      if (out.some((e) => !e.branch)) at('every path out of a condition must be "yes" or "no"');
    } else if (out.length !== 1) at(out.length === 0 ? "connect it to the next step" : "it can only lead to one next step");
    if (node.type !== "condition" && out.some((e) => e.branch)) at('only a condition has "yes" and "no" paths');

    const config = nodeConfigSchemas[node.type].safeParse(node.config);
    if (!config.success) for (const issue of config.error.issues.slice(0, 3)) at(issue.message);
  }

  // Reachability and loops, walking from the trigger.
  const trigger = triggers[0];
  if (trigger) {
    const state = new Map<string, "visiting" | "done">();
    let loop = false;
    const visit = (id: string) => {
      if (state.get(id) === "done") return;
      if (state.get(id) === "visiting") {
        loop = true;
        return;
      }
      state.set(id, "visiting");
      for (const e of outgoing.get(id) ?? []) visit(e.target);
      state.set(id, "done");
    };
    visit(trigger.id);
    if (loop) issues.push({ message: "The workflow loops back on itself; loops are not supported" });
    for (const node of definition.nodes)
      if (!state.has(node.id)) issues.push({ nodeId: node.id, message: `${node.name}: not reachable from the trigger` });
    if (!loop) referenceIssues(definition, nodes, trigger.id, outgoing, issues);
  }
  return issues;
}

/**
 * {{steps.<id>...}} must name a step that runs before this one on every path (a dominator);
 * otherwise the value is missing when the step runs. {{trigger...}} is always there.
 */
function referenceIssues(
  definition: WorkflowDefinition,
  nodes: Map<string, WorkflowNode>,
  triggerId: string,
  outgoing: Map<string, WorkflowEdge[]>,
  issues: WorkflowIssue[],
) {
  // Topological order from the trigger (the graph has no loops here), then dominator sets.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const e of outgoing.get(id) ?? []) visit(e.target);
    order.unshift(id);
  };
  visit(triggerId);
  const preds = new Map<string, string[]>();
  for (const id of order) for (const e of outgoing.get(id) ?? []) preds.set(e.target, [...(preds.get(e.target) ?? []), id]);
  const dominators = new Map<string, Set<string>>();
  for (const id of order) {
    const sets = (preds.get(id) ?? []).map((p) => dominators.get(p) ?? new Set<string>());
    const common = sets.length === 0 ? new Set<string>() : new Set([...sets[0]!].filter((d) => sets.every((s) => s.has(d))));
    dominators.set(id, common.add(id));
  }

  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : value !== null && typeof value === "object" ? Object.values(value).flatMap(strings) : [];
  for (const node of definition.nodes) {
    const before = dominators.get(node.id);
    for (const text of strings(node.config))
      for (const [tag, inner = ""] of text.matchAll(/\{\{(.*?)\}\}/g)) {
        const path = inner.trim();
        const [root, stepId] = path.split(".");
        const at = (message: string) => issues.push({ nodeId: node.id, message: `${node.name}: ${tag} ${message}` });
        if (!/^[\w.-]+$/.test(path) || (root !== "trigger" && root !== "steps"))
          at("is not a valid reference; use {{trigger.field}} or {{steps.<step id>.field}}");
        else if (root === "steps" && stepId !== undefined) {
          if (!nodes.has(stepId)) at(`refers to a step "${stepId}" that does not exist`);
          else if (stepId === node.id) at("refers to this step itself");
          else if (before && !before.has(stepId)) at(`uses "${nodes.get(stepId)?.name}", which does not always run before this step`);
        }
      }
  }
}

/** The node after `nodeId`, following `branch` out of conditions. */
export const nextNode = (definition: WorkflowDefinition, nodeId: string, branch?: Branch) =>
  definition.edges.find((e) => e.source === nodeId && (branch === undefined || e.branch === branch))?.target ?? null;

/** A new workflow: a manual trigger straight to End. */
export const blankWorkflow = (): WorkflowDefinition => ({
  nodes: [
    { id: "trigger", type: "trigger", name: "Start", position: { x: 0, y: 0 }, config: { kind: "manual" } },
    { id: "end", type: "end", name: "End", position: { x: 0, y: 200 }, config: {} },
  ],
  edges: [{ id: "trigger-end", source: "trigger", target: "end" }],
});

/**
 * The worked example: a new lead comes in by webhook, the employee calls them, and if they are
 * interested a meeting is booked at the time they asked for and a confirmation is sent.
 * Trigger input: { name, phone, email, preferredDate: "YYYY-MM-DD", preferredTime: "HH:MM" }.
 */
export const leadFollowUpWorkflow = (employeeId: string): WorkflowDefinition => {
  const node = (id: string, type: NodeType, name: string, y: number, config: Record<string, unknown>, x = 0) => ({
    id,
    type,
    name,
    position: { x, y },
    config,
  });
  return {
    nodes: [
      node("new_lead", "trigger", "New Lead", 0, { kind: "webhook" }),
      node("ai_call", "voice_call", "AI Call", 150, {
        employeeId,
        to: "{{trigger.phone}}",
        greeting: "Hi {{trigger.name}}, this is {name}. You asked us about a demo. Is now a good time?",
      }),
      node("interested", "condition", "Interested?", 300, {
        mode: "ai",
        question: "In the AI call, did the customer say they are interested in a meeting or demo?",
      }),
      node("calendar", "tool", "Calendar Tool", 450, {
        employeeId,
        tool: "calendar_book_meeting",
        input: {
          title: "Demo with {{trigger.name}}",
          date: "{{trigger.preferredDate}}",
          time: "{{trigger.preferredTime}}",
          attendeeName: "{{trigger.name}}",
          attendeeEmail: "{{trigger.email}}",
        },
      }),
      node("confirmation", "message", "Send Confirmation", 600, {
        channel: "email",
        to: "{{trigger.email}}",
        subject: "Your demo is booked",
        body: "Hi {{trigger.name}},\n\nThanks for the call. Your demo is booked for {{steps.calendar.start}} ({{steps.calendar.timezone}}).\n\nSee you then!",
      }),
      node("end", "end", "END", 750, {}),
      node("not_interested", "end", "Not interested", 450, {}, 320),
    ],
    edges: [
      { id: "e1", source: "new_lead", target: "ai_call" },
      { id: "e2", source: "ai_call", target: "interested" },
      { id: "e3", source: "interested", target: "calendar", branch: "yes" },
      { id: "e4", source: "interested", target: "not_interested", branch: "no" },
      { id: "e5", source: "calendar", target: "confirmation" },
      { id: "e6", source: "confirmation", target: "end" },
    ],
  };
};

// ---- Requests ----

export const createWorkflowSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  description: z.string().trim().max(500).default(""),
  definition: workflowDefinitionSchema.optional(),
});
export type CreateWorkflow = z.input<typeof createWorkflowSchema>;

/** Saving appends a version; name and description are not versioned. */
export const saveWorkflowSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(80),
  description: z.string().trim().max(500).default(""),
  definition: workflowDefinitionSchema,
});
export type SaveWorkflow = z.input<typeof saveWorkflowSchema>;

export const setWorkflowStatusSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]) });
export const runWorkflowSchema = z.object({ input: z.record(z.string(), z.unknown()).default({}) });
/** Copies a version (the latest by default) into a new draft workflow. */
export const duplicateWorkflowSchema = z.object({ version: z.number().int().positive().optional() });

export const WORKFLOW_STATUSES = ["DRAFT", "ACTIVE", "PAUSED"] as const;

/**
 * The workflow list: ?q= (name or description contains, any case), ?status=, ?deleted=true for deleted ones instead.
 * The API adds ?limit= and ?cursor= (from the previous page's nextCursor, only valid for the same list). Tiles take ?q= only.
 */
export const listWorkflowsQuery = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => v || undefined),
  status: z.enum(WORKFLOW_STATUSES).optional(),
  deleted: z.literal("true").optional(),
});

// ---- API responses (dates are ISO strings) ----

export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export type WorkflowSummary = {
  id: string;
  name: string;
  description: string;
  status: WorkflowStatus;
  latestVersion: number;
  publishedVersion: number | null;
  updatedAt: string;
  /** Set on deleted workflows (listed with ?deleted=true until restored). */
  deletedAt: string | null;
};

/** A workflow in the list: what starts it (published version, else the latest; null without a trigger) and its runs. */
export type WorkflowListItem = WorkflowSummary & {
  trigger: "manual" | "webhook" | null;
  runCount: number;
  lastRunAt: string | null;
  lastRunStatus: WorkflowExecutionStatus | null;
};

/** One page of the workflow list, newest change first. `nextCursor` asks for the page after it (null: the list ends here). */
export type WorkflowPage = { data: WorkflowListItem[]; nextCursor: string | null };

/** One page of a workflow's runs, newest first; `nextCursor` opens the next page, null on the last. */
export type WorkflowExecutionPage = { data: WorkflowExecutionSummary[]; nextCursor: string | null };

/** The list's tiles over every workflow matching ?q= in the workspace (not deleted ones), whatever the page or status. */
export type WorkflowListSummary = {
  total: number;
  statuses: Record<WorkflowStatus, number>;
  /** The latest version is not the live one (or nothing is live). */
  unpublished: number;
  /** Runs of these workflows, ever. */
  runs: number;
  /** Workflows whose latest run failed. */
  failing: number;
};

/** What deleting a workflow affects. */
export type WorkflowDependencies = {
  /** Runs queued, running or waiting (incl. for a person); deleting stops them. */
  activeRuns: number;
  /** Published with a webhook trigger: callers of the hook URL start getting 404. */
  webhookTrigger: boolean;
};

export type WorkflowDetail = WorkflowSummary & {
  versions: { number: number; createdBy: string; createdAt: string }[];
  /** The version asked for (?version=), the latest by default. */
  version: number;
  definition: WorkflowDefinition;
  issues: WorkflowIssue[];
  /** POST here to start a run of a webhook-triggered workflow. Admins only; null for members. */
  hookUrl: string | null;
};

export type WorkflowExecutionStatus = "QUEUED" | "RUNNING" | "WAITING" | "COMPLETED" | "FAILED";

export type WorkflowExecutionSummary = {
  id: string;
  workflowId: string;
  version: number;
  status: WorkflowExecutionStatus;
  currentNodeId: string | null;
  error: string | null;
  startedBy: string;
  createdAt: string;
  finishedAt: string | null;
  /** When a waiting run is next checked; null while it waits for a person. */
  runAt: string | null;
};

export type WorkflowStepExecution = {
  id: string;
  nodeId: string;
  nodeType: NodeType;
  attempt: number;
  status: "RUNNING" | "WAITING" | "SUCCEEDED" | "FAILED";
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
};

export type WorkflowExecutionDetail = WorkflowExecutionSummary & {
  input: unknown;
  steps: WorkflowStepExecution[];
  definition: WorkflowDefinition;
};
