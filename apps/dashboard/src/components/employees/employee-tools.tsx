"use client";

import { toolConfigSchemas, type EmployeeTool, type ToolInfo, type ToolName } from "@workforce/shared";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useApi, useApiQuery } from "@/lib/api";

type Draft = Record<ToolName, { on: boolean; hosts: string; url: string }>;

const draftFrom = (catalog: ToolInfo[], granted: EmployeeTool[]) =>
  Object.fromEntries(
    catalog.map((tool) => {
      const grant = granted.find((g) => g.name === tool.name);
      const config = (grant?.config ?? {}) as { allowedHosts?: string[]; url?: string };
      return [tool.name, { on: grant !== undefined, hosts: (config.allowedHosts ?? []).join("\n"), url: config.url ?? "" }];
    }),
  ) as Draft;

const configOf = (name: ToolName, d: Draft[ToolName]) =>
  name === "http_request"
    ? { allowedHosts: d.hosts.split(/[\s,]+/).filter(Boolean) }
    : name === "send_webhook"
      ? { url: d.url.trim() }
      : {};

/** The tool catalog, with a switch on each to grant it to this employee, and each tool's settings. */
export function EmployeeTools({ workspaceId, employeeId, canEdit }: { workspaceId: string; employeeId: string; canEdit: boolean }) {
  const grantsPath = `/workspaces/${workspaceId}/employees/${employeeId}/tools`;
  const catalog = useApiQuery<ToolInfo[]>(`/workspaces/${workspaceId}/tools`);
  const granted = useApiQuery<EmployeeTool[]>(grantsPath);
  const [version, setVersion] = useState(0);

  const loadError = catalog.error ?? granted.error;
  if (loadError) return <p className="text-sm text-destructive">{loadError.message}</p>;
  if (!catalog.data || !granted.data) return <Skeleton className="h-24 w-full" />;
  return (
    <ToolsForm
      // Re-keyed after each save so the form starts again from what was stored.
      key={version}
      path={grantsPath}
      catalog={catalog.data}
      initial={draftFrom(catalog.data, granted.data)}
      canEdit={canEdit}
      onSaved={(tools) => {
        granted.setData(tools);
        setVersion((v) => v + 1);
      }}
    />
  );
}

function ToolsForm({
  path,
  catalog,
  initial,
  canEdit,
  onSaved,
}: {
  path: string;
  catalog: ToolInfo[];
  initial: Draft;
  canEdit: boolean;
  onSaved: (tools: EmployeeTool[]) => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Partial<Record<ToolName, string>>>({});
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);

  const update = (name: ToolName, patch: Partial<Draft[ToolName]>) => setDraft((d) => ({ ...d, [name]: { ...d[name], ...patch } }));

  const save = async () => {
    const tools = catalog.filter((t) => draft[t.name].on).map((t) => ({ name: t.name, config: configOf(t.name, draft[t.name]) }));
    // The same schemas the API validates with.
    const invalid = Object.fromEntries(
      tools.flatMap(({ name, config }) => {
        const parsed = toolConfigSchemas[name].safeParse(config);
        return parsed.success ? [] : [[name, parsed.error.issues[0]?.message ?? "Check these settings"]];
      }),
    );
    setErrors(invalid);
    setError(undefined);
    if (Object.keys(invalid).length > 0) return;
    setSaving(true);
    try {
      onSaved(await api<EmployeeTool[]>(path, { method: "PUT", body: { tools } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-4">
        {catalog.map((tool) => {
          const d = draft[tool.name];
          const fieldError = errors[tool.name];
          return (
            <li key={tool.name} className="flex flex-col gap-2">
              <div className="flex items-start justify-between gap-3">
                <Label htmlFor={`tool-${tool.name}`} className="flex min-w-0 flex-col items-start gap-1 font-normal">
                  <span className="text-sm font-medium">{tool.title}</span>
                  <span className="text-xs text-muted-foreground">{tool.description}</span>
                  <span className="flex flex-wrap gap-1">
                    {tool.permissions.map((p) => (
                      <Badge key={p} variant="outline" className="font-mono text-[11px]">
                        {p}
                      </Badge>
                    ))}
                  </span>
                </Label>
                <Switch
                  id={`tool-${tool.name}`}
                  checked={d.on}
                  disabled={!canEdit || saving}
                  onCheckedChange={(on) => update(tool.name, { on })}
                />
              </div>
              {d.on && tool.name === "http_request" && (
                <div className="flex flex-col gap-1.5 pl-0.5">
                  <Label htmlFor="tool-http-hosts" className="text-xs">
                    Approved hosts, one per line
                  </Label>
                  <Textarea
                    id="tool-http-hosts"
                    value={d.hosts}
                    onChange={(e) => update(tool.name, { hosts: e.target.value })}
                    disabled={!canEdit || saving}
                    placeholder="api.example.com"
                    rows={2}
                    aria-invalid={fieldError !== undefined}
                    aria-describedby={fieldError ? "tool-http-error" : undefined}
                    className="font-mono text-sm sm:max-w-sm"
                  />
                </div>
              )}
              {d.on && tool.name === "send_webhook" && (
                <div className="flex flex-col gap-1.5 pl-0.5">
                  <Label htmlFor="tool-webhook-url" className="text-xs">
                    Webhook URL
                  </Label>
                  <Input
                    id="tool-webhook-url"
                    value={d.url}
                    onChange={(e) => update(tool.name, { url: e.target.value })}
                    disabled={!canEdit || saving}
                    placeholder="https://hooks.example.com/ai-employee"
                    aria-invalid={fieldError !== undefined}
                    aria-describedby={fieldError ? "tool-webhook-error" : undefined}
                    className="font-mono text-sm sm:max-w-sm"
                  />
                </div>
              )}
              {fieldError && (
                <p id={tool.name === "http_request" ? "tool-http-error" : "tool-webhook-error"} className="text-xs text-destructive">
                  {fieldError}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">Changes apply to the next message; they are not part of a version.</p>
        {canEdit && (
          <Button size="sm" onClick={save} disabled={!changed || saving}>
            {saving ? "Saving" : "Save tools"}
          </Button>
        )}
      </div>
    </div>
  );
}
