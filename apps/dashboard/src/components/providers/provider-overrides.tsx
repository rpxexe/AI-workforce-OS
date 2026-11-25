"use client";

import {
  OVERRIDABLE_TYPES,
  PROVIDER_TYPE_LABELS,
  providerOverridesSchema,
  type OverridableType,
  type ProviderConnectionInfo,
  type ProviderOverrides,
  type ProviderSettings,
} from "@workforce/shared";
import { CircleAlert } from "lucide-react";
import { useState } from "react";
import { platformNames } from "@/components/providers/provider-list";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiRequestError, useApi, useApiQuery } from "@/lib/api";

// Radix Select has no empty value, so "inherit" and "platform" stand in for a missing key and a null connection.
const INHERIT = "inherit";
const PLATFORM = "platform";

type Row = { target: string; model: string; voice: string };
type Draft = Record<OverridableType, Row>;

const draftFrom = (o: ProviderOverrides): Draft =>
  Object.fromEntries(
    OVERRIDABLE_TYPES.map((t) => {
      const v = o[t] as { connectionId: string | null; model?: string; voice?: string } | undefined;
      return [t, { target: v === undefined ? INHERIT : (v.connectionId ?? PLATFORM), model: v?.model ?? "", voice: v?.voice ?? "" }];
    }),
  ) as Draft;

const bodyOf = (d: Draft) => {
  const body: Record<string, unknown> = {};
  for (const t of OVERRIDABLE_TYPES) {
    const r = d[t];
    if (r.target === INHERIT) continue;
    body[t] = {
      connectionId: r.target === PLATFORM ? null : r.target,
      ...(t === "llm" && { model: r.model.trim() }),
      ...(t === "tts" && r.voice.trim() && { voice: r.voice.trim() }),
    };
  }
  return body;
};

/**
 * Which LLM, speech and email connections an employee or a workflow uses instead of the organization's defaults.
 * `path` is the overrides endpoint; PUT replaces the whole object.
 */
export function ProviderOverridesForm({ path, canEdit }: { path: string; canEdit: boolean }) {
  const settings = useApiQuery<ProviderSettings>("/providers/settings");
  const overrides = useApiQuery<ProviderOverrides>(path);
  const [version, setVersion] = useState(0);

  const loadError = settings.error ?? overrides.error;
  if (loadError) return <p className="text-sm text-destructive">{loadError.message}</p>;
  if (!settings.data || !overrides.data) return <Skeleton className="h-40 w-full" />;
  return (
    <OverridesForm
      // Re-keyed after each save so the form starts again from what was stored.
      key={version}
      path={path}
      settings={settings.data}
      initial={draftFrom(overrides.data ?? {})}
      canEdit={canEdit}
      onSaved={(saved) => {
        overrides.setData(saved);
        setVersion((v) => v + 1);
      }}
    />
  );
}

function OverridesForm({
  path,
  settings,
  initial,
  canEdit,
  onSaved,
}: {
  path: string;
  settings: ProviderSettings;
  initial: Draft;
  canEdit: boolean;
  onSaved: (saved: ProviderOverrides) => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const disabled = !canEdit || saving;
  const update = (t: OverridableType, patch: Partial<Row>) => setDraft((d) => ({ ...d, [t]: { ...d[t], ...patch } }));

  const save = async () => {
    // The same schema the API validates with.
    const parsed = providerOverridesSchema.safeParse(bodyOf(draft));
    setErrors(parsed.success ? {} : Object.fromEntries(parsed.error.issues.map((i) => [i.path.join("."), i.message])));
    setError(undefined);
    if (!parsed.success) return;
    setSaving(true);
    try {
      onSaved(await api<ProviderOverrides>(path, { method: "PUT", body: parsed.data, toast: "Providers saved" }));
    } catch (err) {
      if (err instanceof ApiRequestError) setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const optionsFor = (t: OverridableType) => {
    const all = settings.connections.filter((c) => c.providerType === t);
    const current = draft[t].target;
    // A connection disabled or deleted since it was chosen still shows, so the select never goes blank.
    const shown: { value: string; label: string }[] = all
      .filter((c) => c.status === "active" || c.id === current)
      .map((c) => ({ value: c.id, label: c.status === "active" ? c.displayName : `${c.displayName} (disabled)` }));
    if (current !== INHERIT && current !== PLATFORM && !all.some((c) => c.id === current)) shown.push({ value: current, label: "Deleted connection" });
    return shown;
  };
  const orgDefault = (t: OverridableType): ProviderConnectionInfo | undefined =>
    settings.connections.find((c) => c.providerType === t && c.isDefault && c.status === "active");

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-4">
        {OVERRIDABLE_TYPES.map((t) => {
          const row = draft[t];
          const id = `override-${t}`;
          const platform = platformNames(t, settings.platform[t]);
          const fallback = orgDefault(t)?.displayName ?? (platform ? `platform: ${platform}` : "platform");
          const err = errors[t] ?? errors[`${t}.connectionId`];
          return (
            <li key={t} className="flex flex-col gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={id}>{PROVIDER_TYPE_LABELS[t]}</Label>
                <Select value={row.target} onValueChange={(target) => update(t, { target })} disabled={disabled}>
                  <SelectTrigger id={id} className="w-full" aria-invalid={err !== undefined}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>Organization default ({fallback})</SelectItem>
                    <SelectItem value={PLATFORM}>Platform{platform ? ` (${platform})` : ""}</SelectItem>
                    {optionsFor(t).map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {err && <p className="text-xs text-destructive">{err}</p>}
              </div>
              {t === "llm" && row.target !== INHERIT && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-model`} className="text-xs">
                    Model
                  </Label>
                  <Input
                    id={`${id}-model`}
                    value={row.model}
                    onChange={(e) => update(t, { model: e.target.value })}
                    disabled={disabled}
                    placeholder="e.g. gpt-4o-mini"
                    className="font-mono text-sm"
                    aria-invalid={errors["llm.model"] !== undefined}
                    aria-describedby={errors["llm.model"] ? `${id}-model-error` : undefined}
                  />
                  {errors["llm.model"] && (
                    <p id={`${id}-model-error`} className="text-xs text-destructive">
                      {errors["llm.model"]}
                    </p>
                  )}
                </div>
              )}
              {t === "tts" && row.target !== INHERIT && (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={`${id}-voice`} className="text-xs">
                    Voice <span className="font-normal text-muted-foreground">(optional; empty uses the connection&apos;s)</span>
                  </Label>
                  <Input
                    id={`${id}-voice`}
                    value={row.voice}
                    onChange={(e) => update(t, { voice: e.target.value })}
                    disabled={disabled}
                    className="font-mono text-sm"
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Changes apply from the next conversation or run; they are not part of a version.</p>
        {canEdit && (
          <Button size="sm" onClick={save} disabled={!changed || saving}>
            {saving ? "Saving" : "Save providers"}
          </Button>
        )}
      </div>
    </div>
  );
}
