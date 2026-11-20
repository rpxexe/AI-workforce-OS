"use client";

import {
  AI_PROVIDER_KINDS,
  AI_PROVIDER_LABELS,
  AI_TASK_LABELS,
  AI_TASKS,
  modelPolicySchema,
  ROUTING_STRATEGIES,
  type AiPolicy,
  type AiProviderKind,
  type AiSettings,
  type AiTask,
  type ModelTarget,
  type RoutingStrategy,
} from "@workforce/shared";
import { Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/lib/api";

/** Radix selects cannot hold an empty value, so the platform's provider has its own. */
const PLATFORM = "platform";

const STRATEGY_LABELS: Record<RoutingStrategy, string> = {
  ordered: "In the order listed",
  fastest: "Fastest first (measured)",
  cheapest: "Cheapest first (estimated)",
};

function TargetFields({ id, value, settings, onChange }: { id: string; value: ModelTarget; settings: AiSettings; onChange: (t: ModelTarget) => void }) {
  return (
    <div className="grid flex-1 gap-2 sm:grid-cols-2">
      <Select value={value.credentialId ?? PLATFORM} onValueChange={(v) => onChange({ ...value, credentialId: v === PLATFORM ? null : v })}>
        <SelectTrigger id={id} className="w-full" aria-label="Key">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={PLATFORM}>Platform ({settings.platform.provider})</SelectItem>
          {settings.credentials.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              {c.name} ({AI_PROVIDER_LABELS[c.kind]})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input aria-label="Model id" value={value.model} onChange={(e) => onChange({ ...value, model: e.target.value })} placeholder="Model id, e.g. claude-opus-5-5" autoComplete="off" />
    </div>
  );
}

const describe = (t: ModelTarget, settings: AiSettings) =>
  `${t.credentialId === null ? "Platform" : (settings.credentials.find((c) => c.id === t.credentialId)?.name ?? "Deleted key")} · ${t.model}`;

function PolicyForm({ task, existing, settings, onDone }: { task: AiTask; existing?: AiPolicy; settings: AiSettings; onDone: () => void }) {
  const api = useApi();
  const [primary, setPrimary] = useState<ModelTarget>(existing?.primary ?? { credentialId: settings.credentials[0]?.id ?? null, model: "" });
  const [fallbacks, setFallbacks] = useState<ModelTarget[]>(existing?.fallbacks ?? []);
  const [maxCost, setMaxCost] = useState(existing?.maxCostUsd?.toString() ?? "");
  const [timeout, setTimeoutSec] = useState(existing?.timeoutMs ? String(existing.timeoutMs / 1000) : "");
  const [allowed, setAllowed] = useState<AiProviderKind[]>(existing?.allowedProviders ?? []);
  const [strategy, setStrategy] = useState<RoutingStrategy>(existing?.strategy ?? (task === "voice" ? "fastest" : "ordered"));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = modelPolicySchema.safeParse({
      primary,
      fallbacks,
      maxCostUsd: maxCost.trim() === "" ? null : Number(maxCost),
      timeoutMs: timeout.trim() === "" ? null : Math.round(Number(timeout) * 1000),
      allowedProviders: allowed,
      strategy,
    });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setError(undefined);
    setSaving(true);
    try {
      await api(`/ai/policies/${task}`, { method: "PUT", body: parsed.data });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${task}-primary`}>Primary model</Label>
        <TargetFields id={`${task}-primary`} value={primary} settings={settings} onChange={setPrimary} />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Fallbacks</span>
        <p className="text-xs text-muted-foreground">Tried in turn when a model fails before it starts answering. Each model is tried at most once per request.</p>
        {fallbacks.map((f, i) => (
          <div key={i} className="flex items-start gap-2">
            <TargetFields id={`${task}-fallback-${i}`} value={f} settings={settings} onChange={(t) => setFallbacks(fallbacks.map((x, j) => (j === i ? t : x)))} />
            <Button type="button" variant="ghost" size="icon" aria-label="Remove fallback" onClick={() => setFallbacks(fallbacks.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        {fallbacks.length < 3 && (
          <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setFallbacks([...fallbacks, { credentialId: null, model: settings.platform.model }])}>
            <Plus aria-hidden /> Add fallback
          </Button>
        )}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${task}-cost`}>Max cost per call (US$)</Label>
          <Input id={`${task}-cost`} inputMode="decimal" value={maxCost} onChange={(e) => setMaxCost(e.target.value)} placeholder="No limit" />
          <p className="text-xs text-muted-foreground">Models without a known price are skipped when set.</p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${task}-timeout`}>Timeout per model (seconds)</Label>
          <Input id={`${task}-timeout`} inputMode="decimal" value={timeout} onChange={(e) => setTimeoutSec(e.target.value)} placeholder="Server default" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${task}-strategy`}>Order</Label>
          <Select value={strategy} onValueChange={(v) => setStrategy(v as RoutingStrategy)}>
            <SelectTrigger id={`${task}-strategy`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROUTING_STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STRATEGY_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Allowed providers</legend>
        <p className="text-xs text-muted-foreground">None selected: any provider. Data never goes to a provider left out.</p>
        <div className="flex flex-wrap gap-4">
          {AI_PROVIDER_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-2 text-sm">
              <Switch checked={allowed.includes(k)} onCheckedChange={(on) => setAllowed(on ? [...allowed, k] : allowed.filter((a) => a !== k))} />
              {AI_PROVIDER_LABELS[k]}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save policy"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function Policies({ settings, isAdmin, reload }: { settings: AiSettings; isAdmin: boolean; reload: () => void }) {
  const api = useApi();
  const [editing, setEditing] = useState<AiTask | null>(null);
  const [error, setError] = useState<string>();
  const policyOf = (task: AiTask) => settings.policies.find((p) => p.task === task);
  const fallbackText = settings.policies.some((p) => p.task === "default") ? "Uses the default policy" : `Platform model (${settings.platform.model})`;
  const reset = async (task: AiTask) => {
    setError(undefined);
    try {
      await api(`/ai/policies/${task}`, { method: "DELETE" });
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model policies</CardTitle>
        <CardDescription>
          Which models each kind of work may use, in what order, and the limits on them. Every call records the model that actually answered.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <ul className="flex flex-col divide-y rounded-lg border">
          {AI_TASKS.map((task) => {
            const policy = policyOf(task);
            return (
              <li key={task} className="flex flex-col gap-3 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{AI_TASK_LABELS[task]}</span>
                    <span className="text-sm text-muted-foreground">
                      {policy
                        ? [describe(policy.primary, settings), ...policy.fallbacks.map((f) => `then ${describe(f, settings)}`)].join(", ")
                        : task === "default"
                          ? `Platform model (${settings.platform.model})`
                          : fallbackText}
                    </span>
                  </span>
                  {policy?.maxCostUsd != null && <Badge variant="outline">≤ ${policy.maxCostUsd}</Badge>}
                  {policy?.timeoutMs != null && <Badge variant="outline">{policy.timeoutMs / 1000}s</Badge>}
                  {policy && policy.strategy !== "ordered" && <Badge variant="secondary">{policy.strategy}</Badge>}
                  {isAdmin && editing !== task && (
                    <span className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => setEditing(task)}>
                        {policy ? "Edit" : "Set policy"}
                      </Button>
                      {policy && (
                        <Button variant="ghost" size="sm" onClick={() => reset(task)}>
                          Reset
                        </Button>
                      )}
                    </span>
                  )}
                </div>
                {editing === task && (
                  <PolicyForm
                    task={task}
                    existing={policy}
                    settings={settings}
                    onDone={() => {
                      setEditing(null);
                      reload();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
