"use client";

import {
  CONDITION_OPERATORS,
  NODE_LABELS,
  type EmployeeSummary,
  type NodeType,
  type ToolInfo,
  type WorkflowNode,
} from "@workforce/shared";
import { Plus, Trash2, X } from "lucide-react";
import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/** Settings a node starts with when added from the palette. */
export const NEW_NODE_CONFIG: Record<NodeType, Record<string, unknown>> = {
  trigger: { kind: "manual" },
  ai_employee: { employeeId: "", message: "", customer: "" },
  condition: { mode: "ai", question: "" },
  tool: { employeeId: "", tool: "", input: {} },
  http_request: { method: "GET", url: "", headers: [], body: "" },
  webhook: { url: "" },
  wait: { amount: 5, unit: "minutes" },
  voice_call: { employeeId: "", to: "", greeting: "" },
  message: { channel: "email", to: "", subject: "", body: "" },
  crm_update: { customer: "", fields: [] },
  human_handoff: { note: "" },
  end: {},
};

type Pair = { key: string; value: string };

function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Choice({
  id,
  value,
  options,
  onChange,
  disabled,
  placeholder,
}: {
  id: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder={placeholder ?? "Choose…"} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Name/value rows (headers, CRM fields, tool arguments). */
function Pairs({ pairs, onChange, disabled, keyLabel }: { pairs: Pair[]; onChange: (pairs: Pair[]) => void; disabled?: boolean; keyLabel: string }) {
  const set = (i: number, patch: Partial<Pair>) => onChange(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <div className="flex flex-col gap-2">
      {pairs.map((p, i) => (
        <div key={i} className="flex gap-2">
          <Input aria-label={keyLabel} placeholder={keyLabel} value={p.key} onChange={(e) => set(i, { key: e.target.value })} disabled={disabled} className="w-2/5" />
          <Input aria-label="Value" placeholder="Value" value={p.value} onChange={(e) => set(i, { value: e.target.value })} disabled={disabled} />
          {!disabled && (
            <Button variant="ghost" size="icon" aria-label="Remove" onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
              <X aria-hidden />
            </Button>
          )}
        </div>
      ))}
      {!disabled && (
        <Button variant="outline" size="sm" className="w-fit" onClick={() => onChange([...pairs, { key: "", value: "" }])}>
          <Plus aria-hidden />
          Add
        </Button>
      )}
    </div>
  );
}

const TEMPLATE_HINT = "Use {{trigger.field}} for what started the run, or {{steps.<node id>.field}} for an earlier step's result.";

/** The form for one node's settings. Edits go straight back into the definition. */
export function NodeSettings({
  node,
  onChange,
  onDelete,
  employees,
  tools,
  hookUrl,
  readOnly,
}: {
  node: WorkflowNode;
  onChange: (node: WorkflowNode) => void;
  onDelete: () => void;
  employees: EmployeeSummary[];
  tools: ToolInfo[];
  hookUrl: string | null;
  readOnly: boolean;
}) {
  const c = node.config;
  const str = (key: string) => (typeof c[key] === "string" ? (c[key] as string) : "");
  const set = (key: string, value: unknown) => onChange({ ...node, config: { ...c, [key]: value } });
  const pairs = (key: string) => (Array.isArray(c[key]) ? (c[key] as Pair[]) : []);
  const text = (key: string, label: string, opts: { hint?: string; rows?: number; placeholder?: string } = {}) => (
    <Field label={label} hint={opts.hint}>
      {(id) =>
        opts.rows ? (
          <Textarea id={id} rows={opts.rows} value={str(key)} placeholder={opts.placeholder} onChange={(e) => set(key, e.target.value)} disabled={readOnly} />
        ) : (
          <Input id={id} value={str(key)} placeholder={opts.placeholder} onChange={(e) => set(key, e.target.value)} disabled={readOnly} />
        )
      }
    </Field>
  );
  const choice = (key: string, label: string, options: { value: string; label: string }[], hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => <Choice id={id} value={str(key)} options={options} onChange={(v) => set(key, v)} disabled={readOnly} />}
    </Field>
  );
  const employee = (hint?: string) =>
    choice(
      "employeeId",
      "AI employee",
      employees.map((e) => ({ value: e.id, label: `${e.name}${e.publishedVersion === null ? " (not published)" : ""}` })),
      hint,
    );

  // Tool arguments are a record; numbers typed as digits are sent as numbers.
  const input = (c.input ?? {}) as Record<string, unknown>;
  const inputPairs = Object.entries(input).map(([key, value]) => ({ key, value: String(value) }));
  const setInput = (rows: Pair[]) =>
    set("input", Object.fromEntries(rows.map((r) => [r.key, /^-?\d+(\.\d+)?$/.test(r.value) ? Number(r.value) : r.value])));

  const fields: Partial<Record<NodeType, ReactNode>> = {
    trigger: (
      <>
        {choice("kind", "Starts when", [
          { value: "manual", label: "Someone runs it (dashboard or API)" },
          { value: "webhook", label: "A webhook is received" },
        ])}
        {str("kind") === "webhook" && (
          <p className="text-xs break-all text-muted-foreground">
            {hookUrl ? (
              <>
                POST JSON to <code className="rounded bg-muted px-1">{hookUrl}</code>. Its fields are {"{{trigger.<field>}}"}.
              </>
            ) : (
              "An admin can see the webhook address."
            )}
          </p>
        )}
      </>
    ),
    ai_employee: (
      <>
        {employee("Answers with its published version, knowledge, memory and tools.")}
        {text("message", "Message to the employee", { rows: 4, hint: TEMPLATE_HINT })}
        {text("customer", "Customer (email or phone, optional)", { placeholder: "{{trigger.email}}" })}
      </>
    ),
    condition: (
      <>
        {choice("mode", "Decide by", [
          { value: "ai", label: "Asking the AI a yes/no question" },
          { value: "compare", label: "Comparing values" },
        ])}
        {str("mode") === "compare" ? (
          <>
            {text("left", "Value", { placeholder: "{{steps.ai_call.status}}" })}
            {choice(
              "operator",
              "Is",
              CONDITION_OPERATORS.map((o) => ({ value: o, label: o.replaceAll("_", " ") })),
            )}
            {!["is_empty", "is_not_empty"].includes(str("operator")) && text("right", "Compared with", { hint: "Text comparisons ignore case." })}
          </>
        ) : (
          text("question", "Question", { rows: 3, hint: "The AI sees everything the run has so far, e.g. the call transcript." })
        )}
      </>
    ),
    tool: (
      <>
        {employee("The tool runs with this employee's grant and settings.")}
        {choice(
          "tool",
          "Tool",
          tools.map((t) => ({ value: t.name, label: t.title })),
        )}
        <Field label="Arguments" hint={`${TEMPLATE_HINT} A value that is only {{...}} keeps its type.`}>
          {() => <Pairs pairs={inputPairs} onChange={setInput} disabled={readOnly} keyLabel="Argument" />}
        </Field>
      </>
    ),
    http_request: (
      <>
        {choice(
          "method",
          "Method",
          ["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => ({ value: m, label: m })),
        )}
        {text("url", "URL", { placeholder: "https://api.example.com/leads", hint: "Public https addresses only." })}
        <Field label="Headers">{() => <Pairs pairs={pairs("headers")} onChange={(v) => set("headers", v)} disabled={readOnly} keyLabel="Header" />}</Field>
        {!["GET", "DELETE"].includes(str("method")) && text("body", "Body", { rows: 4, hint: TEMPLATE_HINT })}
      </>
    ),
    webhook: text("url", "URL", { placeholder: "https://hooks.example.com/…", hint: "Receives the run's trigger data and step results as JSON." }),
    wait: (
      <div className="flex gap-2">
        <Field label="Wait">
          {(id) => (
            <Input
              id={id}
              type="number"
              min={1}
              value={typeof c.amount === "number" ? c.amount : ""}
              onChange={(e) => set("amount", e.target.value === "" ? "" : Number(e.target.value))}
              disabled={readOnly}
              className="w-24"
            />
          )}
        </Field>
        <div className="flex-1">
          {choice(
            "unit",
            "Unit",
            ["seconds", "minutes", "hours", "days"].map((u) => ({ value: u, label: u })),
          )}
        </div>
      </div>
    ),
    voice_call: (
      <>
        {employee("Calls from its phone number with its published version. The run waits until the call ends.")}
        {text("to", "Number to call", { placeholder: "{{trigger.phone}}", hint: "International format, e.g. +14155550100." })}
        {text("greeting", "Greeting (optional)", { rows: 2, hint: "{name} is the employee's name." })}
      </>
    ),
    message: (
      <>
        <p className="text-xs text-muted-foreground">Email, test mode: messages are recorded on the run, not delivered.</p>
        {text("to", "To", { placeholder: "{{trigger.email}}" })}
        {text("subject", "Subject")}
        {text("body", "Message", { rows: 5, hint: TEMPLATE_HINT })}
      </>
    ),
    crm_update: (
      <>
        {text("customer", "Customer (email or phone)", { placeholder: "{{trigger.email}}", hint: "Created if new." })}
        <Field label="Fields" hint="Saved to the customer's memory; name, email, phone and company also update their profile.">
          {() => <Pairs pairs={pairs("fields")} onChange={(v) => set("fields", v)} disabled={readOnly} keyLabel="Field" />}
        </Field>
      </>
    ),
    human_handoff: text("note", "What should the person do?", { rows: 3, hint: "The run waits until someone presses Continue on it." }),
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{NODE_LABELS[node.type]}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">id: {node.id}</p>
        </div>
        {!readOnly && (
          <Button variant="ghost" size="icon" aria-label="Delete step" onClick={onDelete}>
            <Trash2 aria-hidden />
          </Button>
        )}
      </div>
      <Field label="Name">
        {(id) => <Input id={id} value={node.name} onChange={(e) => onChange({ ...node, name: e.target.value })} disabled={readOnly} maxLength={80} />}
      </Field>
      {fields[node.type]}
    </div>
  );
}
