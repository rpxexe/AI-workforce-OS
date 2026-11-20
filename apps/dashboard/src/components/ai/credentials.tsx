"use client";

import {
  AI_PROVIDER_KINDS,
  AI_PROVIDER_LABELS,
  credentialSchema,
  credentialUpdateSchema,
  type AiCredential,
  type AiProviderKind,
  type AiSettings,
  type ModelInfo,
} from "@workforce/shared";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { formatDate } from "@/components/employees/meta";
import { EmptyState, ErrorState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/lib/api";

type Draft = { name: string; kind: AiProviderKind; apiKey: string; baseUrl: string; models: ModelRow[] };
/** Numbers as typed; empty means unknown. */
type ModelRow = { id: string; contextTokens: string; inputPricePerM: string; outputPricePerM: string; tools: boolean };

const toRow = (m: ModelInfo): ModelRow => ({
  id: m.id,
  contextTokens: m.contextTokens?.toString() ?? "",
  inputPricePerM: m.inputPricePerM?.toString() ?? "",
  outputPricePerM: m.outputPricePerM?.toString() ?? "",
  tools: m.tools,
});
const num = (v: string) => (v.trim() === "" ? null : Number(v));
const toBody = (d: Draft) => ({
  name: d.name,
  kind: d.kind,
  apiKey: d.apiKey,
  baseUrl: d.kind === "openai_compatible" ? d.baseUrl.trim() || null : null,
  models: d.models
    .filter((m) => m.id.trim())
    .map((m) => ({ id: m.id.trim(), contextTokens: num(m.contextTokens), inputPricePerM: num(m.inputPricePerM), outputPricePerM: num(m.outputPricePerM), tools: m.tools })),
});

function CredentialForm({ existing, onDone }: { existing?: AiCredential; onDone: () => void }) {
  const api = useApi();
  const [draft, setDraft] = useState<Draft>(
    existing
      ? { name: existing.name, kind: existing.kind, apiKey: "", baseUrl: existing.baseUrl ?? "", models: existing.models.map(toRow) }
      : { name: "", kind: "openai", apiKey: "", baseUrl: "", models: [] },
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setModel = (i: number, patch: Partial<ModelRow>) => set({ models: draft.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const body = toBody(draft);
    const parsed = (existing ? credentialUpdateSchema : credentialSchema).safeParse(body);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setError(undefined);
    setSaving(true);
    try {
      await api(existing ? `/ai/credentials/${existing.id}` : "/ai/credentials", { method: existing ? "PUT" : "POST", body: parsed.data });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const id = existing?.id ?? "new";
  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input id={`${id}-name`} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Production OpenAI" maxLength={80} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-kind`}>Provider</Label>
          <Select value={draft.kind} onValueChange={(v) => set({ kind: v as AiProviderKind })} disabled={Boolean(existing)}>
            <SelectTrigger id={`${id}-kind`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AI_PROVIDER_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {AI_PROVIDER_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-key`}>API key</Label>
          <Input
            id={`${id}-key`}
            type="password"
            value={draft.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            placeholder={existing ? `Unchanged (${existing.keyHint})` : "Paste the key"}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">Stored encrypted on the server. It is never shown again, here or anywhere else.</p>
        </div>
        {draft.kind === "openai_compatible" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-url`}>Base URL</Label>
            <Input id={`${id}-url`} value={draft.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} placeholder="https://llm.example.com/v1" autoComplete="off" />
            <p className="text-xs text-muted-foreground">Public https address; /chat/completions is added to it.</p>
          </div>
        )}
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">Models</legend>
        <p className="text-xs text-muted-foreground">
          Optional. Context size and prices (US$ per million tokens) let policies check cost limits and context; leave blank when unknown.
        </p>
        {draft.models.map((m, i) => (
          <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto_auto]">
            <Input aria-label="Model id" value={m.id} onChange={(e) => setModel(i, { id: e.target.value })} placeholder="Model id" className="col-span-2 sm:col-span-1" />
            <Input aria-label="Context tokens" inputMode="numeric" value={m.contextTokens} onChange={(e) => setModel(i, { contextTokens: e.target.value })} placeholder="Context" />
            <Input aria-label="Input price per million tokens" inputMode="decimal" value={m.inputPricePerM} onChange={(e) => setModel(i, { inputPricePerM: e.target.value })} placeholder="In $/M" />
            <Input aria-label="Output price per million tokens" inputMode="decimal" value={m.outputPricePerM} onChange={(e) => setModel(i, { outputPricePerM: e.target.value })} placeholder="Out $/M" />
            <label className="flex h-9 items-center gap-2 text-sm">
              <Switch checked={m.tools} onCheckedChange={(tools) => setModel(i, { tools })} aria-label="Can call tools" />
              Tools
            </label>
            <Button type="button" variant="ghost" size="icon" aria-label="Remove model" onClick={() => set({ models: draft.models.filter((_, j) => j !== i) })}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => set({ models: [...draft.models, { id: "", contextTokens: "", inputPricePerM: "", outputPricePerM: "", tools: true }] })}
        >
          <Plus aria-hidden /> Add model
        </Button>
      </fieldset>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save key" : "Add key"}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function Credentials({ settings, isAdmin, reload }: { settings: AiSettings; isAdmin: boolean; reload: () => void }) {
  const api = useApi();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [error, setError] = useState<string>();
  const done = () => {
    setEditing(null);
    reload();
  };
  const remove = (c: AiCredential) =>
    setConfirm({
      title: `Delete "${c.name}"?`,
      description: "The key is erased from the server. Policies that use it must be changed first.",
      confirmLabel: "Delete key",
      onConfirm: async () => {
        setError(undefined);
        try {
          await api(`/ai/credentials/${c.id}`, { method: "DELETE" });
          reload();
        } catch (err) {
          setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
        }
      },
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your provider keys</CardTitle>
        <CardDescription>
          Bring your own AI: add keys for OpenAI, Anthropic, Gemini, OpenRouter or any OpenAI-compatible service, then use them in a policy. Without
          a policy, the platform&apos;s model answers ({settings.platform.provider}, {settings.platform.model}).
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!settings.canStoreKeys && (
          <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm">The server has no AI_CREDENTIALS_KEY, so keys cannot be stored yet.</p>
        )}
        {error && <ErrorState message={error} />}
        {settings.credentials.length === 0 && editing !== "new" ? (
          <EmptyState icon={KeyRound} title="No keys yet" description="Every model call uses the platform's provider until you add a key and a policy." />
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {settings.credentials.map((c) =>
              editing === c.id ? (
                <li key={c.id} className="p-2">
                  <CredentialForm existing={c} onDone={done} />
                </li>
              ) : (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{c.name}</span>
                    <span className="text-sm text-muted-foreground">
                      {AI_PROVIDER_LABELS[c.kind]} · key {c.keyHint} · {c.models.length} model{c.models.length === 1 ? "" : "s"} described · added {formatDate(c.createdAt)}
                    </span>
                  </span>
                  {c.baseUrl && <Badge variant="outline">{new URL(c.baseUrl).host}</Badge>}
                  {isAdmin && (
                    <span className="flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => setEditing(c.id)}>
                        Edit
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => remove(c)}>
                        Delete
                      </Button>
                    </span>
                  )}
                </li>
              ),
            )}
          </ul>
        )}
        {isAdmin &&
          (editing === "new" ? (
            <CredentialForm onDone={done} />
          ) : (
            <Button className="self-start" onClick={() => setEditing("new")} disabled={!settings.canStoreKeys}>
              <Plus aria-hidden /> Add key
            </Button>
          ))}
      </CardContent>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </Card>
  );
}
