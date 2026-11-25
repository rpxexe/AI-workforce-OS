"use client";

import { checkFields, type ModelInfo, type ProviderConnectionInfo, type ProviderField, type ProviderMeta } from "@workforce/shared";
import { CircleAlert } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { ModelsEditor, toModels, toRow, type ModelRow } from "@/components/ai/models-editor";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ApiRequestError, useApi } from "@/lib/api";

/** connect: a new connection. configure: name and settings. rotate: every secret again. */
export type SheetRequest = { mode: "connect" | "configure" | "rotate"; meta: ProviderMeta; connection?: ProviderConnectionInfo };

type Draft = { displayName: string; secrets: Record<string, string>; config: Record<string, string>; models: ModelRow[] };

const draftFrom = ({ meta, connection }: SheetRequest): Draft => {
  const saved = connection?.configuration ?? {};
  const config = Object.fromEntries(
    meta.configFields
      .filter((f) => f.kind !== "models")
      .map((f) => {
        const v = saved[f.key];
        // A select always shows a choice; other defaults are shown as placeholders and applied by the server.
        return [f.key, v !== undefined && v !== null ? String(v) : f.kind === "select" && f.default !== undefined ? String(f.default) : ""];
      }),
  );
  const models = Array.isArray(saved.models) ? (saved.models as ModelInfo[]).map(toRow) : [];
  return { displayName: connection?.displayName ?? (connection ? "" : meta.name), secrets: {}, config, models };
};

/** The configuration to send: the stored one with the form's fields laid over it (empty fields removed). */
const configurationOf = (meta: ProviderMeta, draft: Draft, saved: Record<string, unknown> = {}) => {
  const out: Record<string, unknown> = { ...saved };
  for (const f of meta.configFields) {
    delete out[f.key];
    if (f.kind === "models") {
      const models = toModels(draft.models);
      if (models.length > 0) out[f.key] = models;
      continue;
    }
    const v = draft.config[f.key]?.trim() ?? "";
    if (v !== "") out[f.key] = f.kind === "number" ? Number(v) : v;
  }
  return out;
};

const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Try again.");

function Field({ id, label, help, error, required, children }: { id: string; label: string; help?: string; error?: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {!required && <span className="font-normal text-muted-foreground">(optional)</span>}
      </Label>
      {children}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function ConnectionForm({ request, canStoreKeys, onSaved, onCancel }: { request: SheetRequest; canStoreKeys: boolean; onSaved: () => void; onCancel: () => void }) {
  const api = useApi();
  const { mode, meta, connection } = request;
  const [draft, setDraft] = useState(() => draftFrom(request));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const showSecrets = mode !== "configure";
  const showConfig = mode !== "rotate";

  if (showSecrets && !canStoreKeys)
    return (
      <Alert role="status">
        <AlertDescription>
          Credentials cannot be stored yet: the server has no AI_CREDENTIALS_KEY, the key it seals secrets with. Add it to the server&apos;s .env and
          restart the API, then connect {meta.name} here.
        </AlertDescription>
      </Alert>

    );

  const credentials = Object.fromEntries(
    meta.credentialFields.map((f) => [f.key, draft.secrets[f.key]?.trim() ?? ""]).filter(([, v]) => v !== ""),
  ) as Record<string, string>;
  const configuration = configurationOf(meta, draft, connection?.configuration);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // The same checks the API runs, so most mistakes show before anything is sent.
    const issues = [
      ...(showConfig && !draft.displayName.trim() ? [{ path: "displayName", message: "Name is required" }] : []),
      ...checkFields(meta, showSecrets ? credentials : null, showConfig ? configuration : {}).filter(
        (i) => (showSecrets || !i.path.startsWith("credentials.")) && (showConfig || !i.path.startsWith("configuration.")),
      ),
    ];
    setErrors(Object.fromEntries(issues.map((i) => [i.path, i.message])));
    setError(issues.length > 0 ? "Check the highlighted fields." : undefined);
    if (issues.length > 0) return;
    setSaving(true);
    try {
      if (mode === "connect")
        await api("/providers/connections", {
          method: "POST",
          body: { providerType: meta.type, providerId: meta.id, displayName: draft.displayName.trim(), credentials, configuration },
          toast: { loading: `Connecting ${meta.name}…`, success: `${meta.name} connected` },
        });
      else if (mode === "configure")
        await api(`/providers/connections/${connection?.id}`, {
          method: "PATCH",
          body: { displayName: draft.displayName.trim(), configuration },
          toast: `${draft.displayName.trim()} saved`,
        });
      else await api(`/providers/connections/${connection?.id}/rotate`, { method: "POST", body: { credentials }, toast: `${connection?.displayName ?? meta.name} credentials rotated` });
      onSaved();
    } catch (err) {
      const fieldIssues = err instanceof ApiRequestError ? err.issues : [];
      setErrors(Object.fromEntries(fieldIssues.map((i) => [i.path, i.message])));
      const known = new Set(["displayName", ...meta.credentialFields.map((f) => `credentials.${f.key}`), ...meta.configFields.map((f) => `configuration.${f.key}`)]);
      const other = fieldIssues.find((i) => !known.has(i.path));
      setError(other ? `${message(err)}: ${other.message}` : message(err));
    } finally {
      setSaving(false);
      // Secrets never stay in memory longer than one submit.
      if (showSecrets) setDraft((d) => ({ ...d, secrets: {} }));
    }
  };

  const fid = (path: string) => `provider-${path.replace(".", "-")}`;
  const invalid = (path: string) => ({ "aria-invalid": errors[path] !== undefined, "aria-describedby": errors[path] ? `${fid(path)}-error` : undefined });
  const setConfig = (key: string, value: string) => setDraft((d) => ({ ...d, config: { ...d.config, [key]: value } }));

  const configField = (f: ProviderField) => {
    const path = `configuration.${f.key}`;
    if (f.kind === "models")
      return (
        <div key={f.key} className="flex flex-col gap-1.5">
          <ModelsEditor rows={draft.models} onChange={(models) => setDraft((d) => ({ ...d, models }))} legend={f.label} />
          {errors[path] && <p className="text-xs text-destructive">{errors[path]}</p>}
        </div>
      );
    return (
      <Field key={f.key} id={fid(path)} label={f.label} help={f.help} error={errors[path]} required={f.required}>
        {f.kind === "select" ? (
          <Select value={draft.config[f.key]} onValueChange={(v) => setConfig(f.key, v)}>
            <SelectTrigger id={fid(path)} className="w-full" {...invalid(path)}>
              <SelectValue placeholder="Choose" />
            </SelectTrigger>
            <SelectContent>
              {(f.options ?? []).map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id={fid(path)}
            type={f.kind === "url" ? "url" : "text"}
            inputMode={f.kind === "number" ? "numeric" : undefined}
            value={draft.config[f.key] ?? ""}
            onChange={(e) => setConfig(f.key, e.target.value)}
            placeholder={f.placeholder ?? (f.default !== undefined ? String(f.default) : undefined)}
            autoComplete="off"
            className={f.kind === "url" ? "font-mono text-sm" : undefined}
            {...invalid(path)}
          />
        )}
      </Field>
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
      {showConfig && (
        <Field id={fid("displayName")} label="Name" help="How this connection is listed, e.g. Production or EU account." error={errors.displayName} required>
          <Input
            id={fid("displayName")}
            value={draft.displayName}
            onChange={(e) => setDraft((d) => ({ ...d, displayName: e.target.value }))}
            maxLength={80}
            autoComplete="off"
            {...invalid("displayName")}
          />
        </Field>
      )}

      {showSecrets && meta.credentialFields.length > 0 && (
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-1 text-sm font-medium">Credentials</legend>
          <p className="-mt-2 text-xs text-muted-foreground">
            Sealed on the server and never shown again{mode === "rotate" ? ". Enter every one: the old ones are replaced together." : "."}
          </p>
          {meta.credentialFields.map((f) => {
            const path = `credentials.${f.key}`;
            const hint = connection?.credentialHints[f.key];
            return (
              <Field key={f.key} id={fid(path)} label={f.label} help={f.help} error={errors[path]} required={f.required}>
                <Input
                  id={fid(path)}
                  type="password"
                  value={draft.secrets[f.key] ?? ""}
                  onChange={(e) => setDraft((d) => ({ ...d, secrets: { ...d.secrets, [f.key]: e.target.value } }))}
                  placeholder={hint ? `Current ends in ${hint}` : undefined}
                  autoComplete="new-password"
                  spellCheck={false}
                  {...invalid(path)}
                />
              </Field>
            );
          })}
        </fieldset>
      )}

      {showConfig && meta.configFields.length > 0 && (
        <fieldset className="flex flex-col gap-4">
          <legend className="mb-1 text-sm font-medium">Settings</legend>
          {meta.configFields.map(configField)}
        </fieldset>
      )}

      {error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : mode === "connect" ? "Connect" : mode === "rotate" ? "Replace credentials" : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const TITLES = { connect: "Connect", configure: "Configure", rotate: "Rotate credentials for" } as const;

/** Connect, Configure and Rotate share one sheet; its form is rendered from the catalog entry's fields. */
export function ConnectionSheet({
  request,
  canStoreKeys,
  onClose,
  onSaved,
}: {
  request: SheetRequest | null;
  canStoreKeys: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <Sheet open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        {request && (
          <>
            <SheetHeader>
              <SheetTitle>
                {TITLES[request.mode]} {request.connection?.displayName ?? request.meta.name}
              </SheetTitle>
              <SheetDescription>
                {request.mode === "rotate"
                  ? "The new credentials replace the old ones as soon as you save. The last test result is cleared."
                  : request.mode === "configure"
                    ? `${request.meta.name}. Credentials change only by rotating them.`
                    : (request.meta.notes ?? `Paste the credentials from your ${request.meta.name} account.`)}
              </SheetDescription>
            </SheetHeader>
            <div className="px-4 pb-6">
              <ConnectionForm
                key={`${request.mode}-${request.meta.type}-${request.meta.id}-${request.connection?.id ?? "new"}`}
                request={request}
                canStoreKeys={canStoreKeys}
                onCancel={onClose}
                onSaved={() => {
                  onSaved();
                  onClose();
                }}
              />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
