"use client";

// Phase 17: Settings > API Keys and Settings > Webhooks. Secrets (keys, signing secrets) arrive once, in the answer to
// create or rotate, and are shown once here; the server cannot show them again.
import { useAuth } from "@clerk/nextjs";
import {
  API_SCOPE_LABELS,
  API_SCOPES,
  ROTATION_GRACE_HOURS,
  WEBHOOK_EVENT_LABELS,
  WEBHOOK_EVENTS,
  type ApiKeyInfo,
  type ApiScope,
  type CreatedApiKey,
  type CreatedWebhookEndpoint,
  type DeveloperAuditEntry,
  type WebhookDeliveryPage,
  type WebhookDeliveryRecord,
  type WebhookEndpointInfo,
  type WebhookEventType,
} from "@workforce/shared";
import { ChevronRight, CircleAlert, KeyRound, TriangleAlert, Webhook } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { CopyBlock } from "@/components/employees/employee-channels";
import { timeAgo } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState } from "@/components/states";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { TablePager, useCursorPaged } from "@/components/table-pager";
import { API_URL, ApiRequestError, useApi, useApiQuery } from "@/lib/api";
import { useWorkspaces } from "@/lib/workspace";

const GRACE_LABELS: Record<(typeof ROTATION_GRACE_HOURS)[number], string> = { 0: "Stop it now", 1: "After 1 hour", 24: "After 24 hours", 168: "After 7 days" };

const KEY_STATUS: Record<ApiKeyInfo["status"], { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  active: { label: "Active", variant: "secondary" },
  expiring: { label: "Expiring", variant: "outline" },
  expired: { label: "Expired", variant: "outline" },
  revoked: { label: "Revoked", variant: "destructive" },
};

const DELIVERY_STATUS: Record<WebhookDeliveryRecord["status"], { label: string; variant: "secondary" | "outline" | "destructive" }> = {
  succeeded: { label: "Delivered", variant: "secondary" },
  pending: { label: "Retrying", variant: "outline" },
  failed: { label: "Failed", variant: "destructive" },
};

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_KEYS: ApiKeyInfo[] = Array.from({ length: 3 }, (_, i) => ({
  id: `sample-${i}`,
  name: "CRM sync",
  workspaceId: "sample-workspace",
  workspaceName: "Main workspace",
  prefix: "wfk_a1b2c3d4",
  scopes: ["employees:read", "conversations:read", "conversations:write"],
  status: "active",
  createdBy: "sample-user",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: "2026-01-01T00:00:00.000Z",
  lastUsedIp: "203.0.113.7",
  expiresAt: null,
  rateLimitPerMinute: 600,
  allowedIps: [],
  revokedAt: null,
  replacedById: null,
}));

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_AUDIT: DeveloperAuditEntry[] = Array.from({ length: 4 }, (_, i) => ({
  id: `sample-${i}`,
  actorId: "sample-user",
  action: "api_key.create",
  targetId: `sample-target-${i}`,
  detail: { name: "CRM sync" },
  createdAt: "2026-01-01T00:00:00.000Z",
}));

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_ENDPOINTS: WebhookEndpointInfo[] = Array.from({ length: 3 }, (_, i) => ({
  id: `sample-${i}`,
  url: "https://example.com/webhooks/workforce",
  description: "Production CRM",
  workspaceId: "sample-workspace",
  workspaceName: "Main workspace",
  events: ["conversation.started", "conversation.completed", "call.completed"],
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  pending: 0,
  failed: 0,
  previousSecretUntil: null,
}));

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_DELIVERIES: WebhookDeliveryRecord[] = Array.from({ length: 3 }, (_, i) => ({
  id: `sample-${i}`,
  endpointId: "sample-endpoint",
  eventId: `sample-event-${i}`,
  event: "conversation.started",
  status: "succeeded",
  attempts: 1,
  nextAttemptAt: null,
  deliveredAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  log: [{ at: "2026-01-01T00:00:00.000Z", statusCode: 200, error: null, durationMs: 240 }],
  payload: {},
}));

const errorOf = (err: unknown) =>
  err instanceof ApiRequestError ? (err.issues[0] ? `${err.issues[0].path}: ${err.issues[0].message}` : err.message) : "Something went wrong. Try again.";

const EXPIRY_LABELS: Record<string, string> = { never: "Never", "30": "In 30 days", "90": "In 90 days", "365": "In a year" };
const KEEP_LABELS: Record<string, string> = { "0": "Stop it now", "1": "For 1 hour", "24": "For 24 hours", "168": "For 7 days" };
/** One address or range per line (commas also work). */
const ipsOf = (text: string) => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

/** A list of switches, one per choice. */
function Choices<T extends string>({ all, labels, value, onChange, idPrefix }: { all: readonly T[]; labels: Record<T, string>; value: T[]; onChange: (next: T[]) => void; idPrefix: string }) {
  return (
    <div className="flex flex-col gap-2">
      {all.map((item) => (
        <div key={item} className="flex items-center justify-between gap-3">
          <Label htmlFor={`${idPrefix}-${item}`} className="flex flex-col items-start gap-0.5 font-normal">
            <span className="font-mono text-xs">{item}</span>
            <span className="text-xs text-muted-foreground">{labels[item]}</span>
          </Label>
          <Switch
            id={`${idPrefix}-${item}`}
            checked={value.includes(item)}
            onCheckedChange={(on) => onChange(on ? [...value, item] : value.filter((v) => v !== item))}
          />
        </div>
      ))}
    </div>
  );
}

function WorkspacePicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { workspaces = [] } = useWorkspaces();
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id="workspace" className="w-full">
        <SelectValue placeholder="Choose a workspace" />
      </SelectTrigger>
      <SelectContent>
        {workspaces.map((w) => (
          <SelectItem key={w.id} value={w.id}>
            {w.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Shows a secret that cannot be shown again. */
function SecretOnce({ label, secret, onDone }: { label: string; secret: string; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Alert className="border-warning/40 bg-warning/10 *:[svg]:text-warning">
        <TriangleAlert aria-hidden />
        <AlertDescription className="text-foreground">Copy it now and keep it somewhere safe. It is not stored, so it cannot be shown again.</AlertDescription>
      </Alert>
      <CopyBlock label={label} value={secret} />
      <Button onClick={onDone}>Done</Button>
    </div>
  );
}

// ---- API keys ----

type KeySheet = { mode: "create" } | { mode: "edit"; key: ApiKeyInfo } | { mode: "rotate"; key: ApiKeyInfo } | { mode: "secret"; created: CreatedApiKey };


/** The first two items, then "…" opening a popover with all of them on hover (click and keyboard still work). */
function ShortList({ items, label }: { items: readonly string[]; label: string }) {
  const [open, setOpen] = useState(false);
  const closing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tags = (list: readonly string[]) =>
    list.map((item) => (
      <Badge key={item} variant="secondary" className="font-medium">
        {item}
      </Badge>
    ));
  if (items.length <= 2) return <span className="flex flex-wrap gap-1">{tags(items)}</span>;
  const show = () => {
    clearTimeout(closing.current);
    setOpen(true);
  };
  // A short delay lets the pointer cross the gap from the trigger into the popover.
  const hide = () => {
    closing.current = setTimeout(() => setOpen(false), 150);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <span className="flex items-center gap-1">
        {tags(items.slice(0, 2))}
        <PopoverTrigger asChild onMouseEnter={show} onMouseLeave={hide}>
          <Button variant="outline" size="xs" className="h-5 rounded-full px-2" aria-label={`${label}: show all ${items.length}`}>
            …
          </Button>
        </PopoverTrigger>
      </span>
      <PopoverContent className="w-auto max-w-80" align="start" onMouseEnter={show} onMouseLeave={hide} onOpenAutoFocus={(e) => e.preventDefault()}>
        <p className="mb-2 text-sm font-semibold">
          {label} <span className="font-normal text-muted-foreground">{items.length}</span>
        </p>
        <div className="flex flex-wrap gap-1">{tags(items)}</div>
      </PopoverContent>
    </Popover>
  );
}
export function ApiKeys({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const { workspace } = useWorkspaces();
  const keys = useApiQuery<ApiKeyInfo[]>("/developer/api-keys");
  const [sheet, setSheet] = useState<KeySheet | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [name, setName] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [scopes, setScopes] = useState<ApiScope[]>([]);
  const [grace, setGrace] = useState<string>("24");
  const [rateLimit, setRateLimit] = useState("600");
  const [ips, setIps] = useState("");
  const [expiry, setExpiry] = useState("never");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const open = (next: KeySheet) => {
    setError(undefined);
    if (next.mode === "create") {
      setName("");
      setWorkspaceId(workspace?.id ?? "");
      setScopes([]);
      setRateLimit("600");
      setIps("");
      setExpiry("never");
    }
    if (next.mode === "edit") {
      setName(next.key.name);
      setRateLimit(String(next.key.rateLimitPerMinute));
      setIps(next.key.allowedIps.join("\n"));
    }
    if (next.mode === "rotate") setGrace("24");
    setSheet(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!sheet || sheet.mode === "secret") return;
    setSaving(true);
    setError(undefined);
    try {
      const settings = { name, rateLimitPerMinute: Number(rateLimit), allowedIps: ipsOf(ips) };
      if (sheet.mode === "edit") {
        await api(`/developer/api-keys/${sheet.key.id}`, { method: "PATCH", body: settings, toast: `API key "${name}" saved` });
        setSheet(null);
      } else {
        const created =
          sheet.mode === "create"
            ? await api<CreatedApiKey>("/developer/api-keys", {
                method: "POST",
                body: { ...settings, workspaceId, scopes, ...(expiry !== "never" && { expiresInDays: Number(expiry) }) },
                toast: `API key "${name}" created`,
              })
            : await api<CreatedApiKey>(`/developer/api-keys/${sheet.key.id}/rotate`, { method: "POST", body: { expireOldInHours: Number(grace) }, toast: `API key "${sheet.key.name}" rotated` });
        setSheet({ mode: "secret", created });
      }
      keys.reload();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setSaving(false);
    }
  };

  const revoke = (key: ApiKeyInfo) =>
    setConfirm({
      title: `Revoke "${key.name}"?`,
      description: "Requests with this key stop working at once. This cannot be undone.",
      confirmLabel: "Revoke key",
      onConfirm: () => {
        setConfirm(null);
        api(`/developer/api-keys/${key.id}`, { method: "DELETE", toast: `API key "${key.name}" revoked` }).then(keys.reload, () => {
          // The toast in useApi shows why it failed.
        });
      },
    });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>API keys</CardTitle>
            <CardDescription>Each key works in one workspace, with the permissions you give it.</CardDescription>
          </div>
          {isAdmin && <Button onClick={() => open({ mode: "create" })}>Create key</Button>}
        </CardHeader>
        <CardContent>
          {keys.error ? (
            <ErrorState message={keys.error.message} onRetry={keys.reload} />
          ) : (
            <Skullet data={keys.data} sample={SAMPLE_KEYS} id="api-keys-list" label="Loading API keys">
              {(data) =>
                data.length === 0 ? (
                  <EmptyState icon={KeyRound} title="No API keys yet" description="Create a key to call the API from your own systems." />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Key</TableHead>
                          <TableHead>Workspace</TableHead>
                          <TableHead>Permissions</TableHead>
                          <TableHead>Limits</TableHead>
                          <TableHead>Last used</TableHead>
                          <TableHead>Status</TableHead>
                          {isAdmin && <TableHead className="text-right">Actions</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.map((key) => (
                          <TableRow key={key.id}>
                            <TableCell className="font-medium">{key.name}</TableCell>
                            <TableCell className="font-mono text-xs">{key.prefix}…</TableCell>
                            <TableCell>{key.workspaceName}</TableCell>
                            <TableCell>
                              <ShortList items={key.scopes} label="Permissions" />
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {key.rateLimitPerMinute}/min
                              {key.allowedIps.length > 0 && <span className="block">{key.allowedIps.join(", ")}</span>}
                            </TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {key.lastUsedAt ? `${timeAgo(key.lastUsedAt)}${key.lastUsedIp ? ` from ${key.lastUsedIp}` : ""}` : "Never"}
                            </TableCell>
                            <TableCell>
                              <Badge variant={KEY_STATUS[key.status].variant}>{KEY_STATUS[key.status].label}</Badge>
                              {key.status === "expiring" && key.expiresAt && (
                                <span className="mt-1 block text-xs text-muted-foreground">until {new Date(key.expiresAt).toLocaleString()}</span>
                              )}
                            </TableCell>
                            {isAdmin && (
                              <TableCell className="text-right whitespace-nowrap">
                                {(key.status === "active" || key.status === "expiring") && (
                                  <Button size="sm" variant="ghost" onClick={() => open({ mode: "edit", key })}>
                                    Edit
                                  </Button>
                                )}
                                {(key.status === "active" || (key.status === "expiring" && !key.replacedById)) && (
                                  <Button size="sm" variant="ghost" onClick={() => open({ mode: "rotate", key })}>
                                    Rotate
                                  </Button>
                                )}
                                {(key.status === "active" || key.status === "expiring") && (
                                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => revoke(key)}>
                                    Revoke
                                  </Button>
                                )}
                              </TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )
              }
            </Skullet>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Using the API</CardTitle>
          <CardDescription>Versioned under /v1. The OpenAPI document lists every route, its permission and its shapes.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <CopyBlock label="OpenAPI document" value={`${API_URL}/v1/openapi.json`} />
          <CopyBlock
            label="Example"
            value={`curl ${API_URL}/v1/employees/EMPLOYEE_ID/messages \\\n  -H "Authorization: Bearer wfk_..." \\\n  -H "Content-Type: application/json" \\\n  -d '{"message": "Hi", "customer": "rahul@example.com"}'`}
          />
          <p className="text-sm text-muted-foreground">
            SDKs: TypeScript <code className="font-mono text-xs">@workforce/sdk</code> and Python <code className="font-mono text-xs">workforce_sdk</code>{" "}
            (client, paging, streaming replies, retries, webhook verification). Every answer carries <code className="font-mono text-xs">x-ratelimit-*</code> headers;
            over the key&apos;s limit the API answers 429 with <code className="font-mono text-xs">Retry-After</code>.
          </p>
        </CardContent>
      </Card>

      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              {sheet?.mode === "rotate"
                ? `Rotate "${sheet.key.name}"`
                : sheet?.mode === "edit"
                  ? `Edit "${sheet.key.name}"`
                  : sheet?.mode === "secret"
                    ? "Your new API key"
                    : "Create an API key"}
            </SheetTitle>
            <SheetDescription>
              {sheet?.mode === "edit"
                ? "Name, rate limit and addresses change at once. Permissions and workspace need a new key."
                : sheet?.mode === "rotate"
                ? "A new key with the same permissions. Choose how long the old one keeps working while you switch."
                : sheet?.mode === "secret"
                  ? `${sheet.created.key.name}, for ${sheet.created.key.workspaceName}.`
                  : "Give only the permissions the integration needs."}
            </SheetDescription>
          </SheetHeader>
          {sheet?.mode === "secret" ? (
            <SecretOnce label="API key" secret={sheet.created.secret} onDone={() => setSheet(null)} />
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-5 p-4">
              {sheet?.mode === "create" || sheet?.mode === "edit" ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="key-name">Name</Label>
                    <Input id="key-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="CRM sync" maxLength={100} required />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="key-rate">Requests per minute</Label>
                    <Input id="key-rate" type="number" min={1} max={10000} value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} required />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="key-ips">Allowed addresses (optional)</Label>
                    <Textarea id="key-ips" value={ips} onChange={(e) => setIps(e.target.value)} placeholder={"203.0.113.7\n198.51.100.0/24"} rows={3} />
                    <p className="text-xs text-muted-foreground">One address or range per line. Empty: the key works from anywhere.</p>
                  </div>
                </>
              ) : null}
              {sheet?.mode === "create" ? (
                <>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="key-expiry">Expires</Label>
                    <Select value={expiry} onValueChange={setExpiry}>
                      <SelectTrigger id="key-expiry" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {Object.entries(EXPIRY_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="workspace">Workspace</Label>
                    <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} />
                  </div>
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Permissions</span>
                      <Button type="button" size="sm" variant="ghost" onClick={() => setScopes(scopes.length === API_SCOPES.length ? [] : [...API_SCOPES])}>
                        {scopes.length === API_SCOPES.length ? "Clear all" : "Select all"}
                      </Button>
                    </div>
                    <Choices all={API_SCOPES} labels={API_SCOPE_LABELS} value={scopes} onChange={setScopes} idPrefix="scope" />
                  </div>
                </>
              ) : sheet?.mode === "edit" ? null : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="grace">The old key stops working</Label>
                  <Select value={grace} onValueChange={setGrace}>
                    <SelectTrigger id="grace" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROTATION_GRACE_HOURS.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {GRACE_LABELS[h]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {error && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={saving || (sheet?.mode === "create" && (!workspaceId || scopes.length === 0))}>
                {saving ? "Working…" : sheet?.mode === "rotate" ? "Rotate key" : sheet?.mode === "edit" ? "Save" : "Create key"}
              </Button>
            </form>
          )}
        </SheetContent>
      </Sheet>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      {isAdmin && <DeveloperActivity />}
    </div>
  );
}

const ACTION_LABELS: Record<string, string> = {
  "api_key.create": "Created API key",
  "api_key.update": "Changed API key",
  "api_key.rotate": "Rotated API key",
  "api_key.revoke": "Revoked API key",
  "webhook.create": "Added webhook endpoint",
  "webhook.update": "Changed webhook endpoint",
  "webhook.delete": "Deleted webhook endpoint",
  "webhook.rotate_secret": "Rotated signing secret",
  "webhook.test": "Sent test event",
  "webhook.redeliver": "Sent delivery again",
};

/** Who changed keys and endpoints (admins only). */
function DeveloperActivity() {
  const { userId } = useAuth();
  const audit = useApiQuery<DeveloperAuditEntry[]>("/developer/audit");
  const summary = (d: Record<string, unknown>) =>
    ["name", "url", "keepOldForHours", "expireOldInHours"]
      .filter((k) => d[k] !== undefined && d[k] !== null)
      .map((k) => (k.endsWith("Hours") ? `${String(d[k])} h grace` : String(d[k])))
      .join(" · ");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Developer activity</CardTitle>
        <CardDescription>Changes to API keys and webhook endpoints, newest first. Secrets are never recorded.</CardDescription>
      </CardHeader>
      <CardContent>
        {audit.error ? (
          <ErrorState message={audit.error.message} onRetry={audit.reload} />
        ) : (
          <Skullet data={audit.data} sample={SAMPLE_AUDIT} id="developer-activity" label="Loading developer activity">
            {(data) =>
              data.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing yet.</p>
              ) : (
                <ul className="flex flex-col divide-y text-sm">
                  {data.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                      <span>
                        <span className="font-medium">{ACTION_LABELS[e.action] ?? e.action}</span>
                        {summary(e.detail) && <span className="text-muted-foreground"> · {summary(e.detail)}</span>}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {e.actorId === userId ? "You" : "A teammate"}, {timeAgo(e.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Skullet>
        )}
      </CardContent>
    </Card>
  );
}

// ---- Webhooks ----

type HookSheet =
  | { mode: "create" }
  | { mode: "edit"; endpoint: WebhookEndpointInfo }
  | { mode: "rotate"; endpoint: WebhookEndpointInfo }
  | { mode: "secret"; created: CreatedWebhookEndpoint }
  | { mode: "log"; endpoint: WebhookEndpointInfo };

function Deliveries({ endpoint, isAdmin }: { endpoint: WebhookEndpointInfo; isAdmin: boolean }) {
  const api = useApi();
  const [event, setEvent] = useState("all");
  // The page shown and the request it answered, so a page still loading is told apart from the one shown.
  const [result, setResult] = useState<{ path: string; page: WebhookDeliveryPage } | null>(null);
  const [error, setError] = useState<string>();
  // A log: cursor pages from the server, no total. Another event filter starts again at page 1.
  const paged = useCursorPaged(event, 10);
  const path = `/developer/webhooks/${endpoint.id}/deliveries?${paged.query}${event === "all" ? "" : `&event=${event}`}`;
  const loading = result?.path !== path;
  const pager = paged.pager({ nextCursor: loading ? null : (result?.page.nextCursor ?? null), rows: loading ? 1 : (result?.page.data.length ?? 1) });
  const load = useCallback(
    () =>
      api<WebhookDeliveryPage>(path).then(
        (page) => {
          setResult({ path, page });
          setError(undefined);
        },
        (err: unknown) => setError(errorOf(err)),
      ),
    [api, path],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const redeliver = (id: string) =>
    api(`/developer/webhook-deliveries/${id}/redeliver`, { method: "POST", toast: { loading: "Sending delivery again…", success: "Delivery sent again" } }).then(
      () => load(),
      () => {
        // The toast in useApi shows why it failed.
      },
    );

  return (
    <div className="flex flex-col gap-3">
      {error && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-between gap-2">
        <Select value={event} onValueChange={setEvent}>
          <SelectTrigger className="w-56" aria-label="Event">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All events</SelectItem>
            {[...WEBHOOK_EVENTS, "webhook.test"].map((e) => (
              <SelectItem key={e} value={e}>
                {e}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <Skullet data={result?.page.data ?? null} sample={SAMPLE_DELIVERIES} id="webhook-deliveries" label="Loading deliveries">
        {(items) =>
          items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing sent yet. Events appear here within seconds of happening.</p>
          ) : (
            // Skullet wraps its content in a block, so this keeps the gaps the list used to get from its parent.
            <div className="flex flex-col gap-3">
              {items.map((d) => {
                const last = d.log.at(-1);
                return (
                  <Card key={d.id} size="sm">
                    <CardContent>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs">{d.event}</span>
                        <Badge variant={DELIVERY_STATUS[d.status].variant}>{DELIVERY_STATUS[d.status].label}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {timeAgo(d.createdAt)} · {d.attempts} {d.attempts === 1 ? "attempt" : "attempts"}
                        {last && ` · last: ${last.statusCode ?? "no answer"}${last.error ? ` (${last.error})` : ""}, ${last.durationMs} ms`}
                        {d.nextAttemptAt && ` · next try ${new Date(d.nextAttemptAt).toLocaleTimeString()}`}
                      </p>
                      <Collapsible className="mt-2">
                        <CollapsibleTrigger asChild>
                          <Button variant="link" size="xs" className="group h-auto px-0 text-xs font-normal text-muted-foreground">
                            <ChevronRight className="transition-transform group-data-[state=open]:rotate-90" aria-hidden />
                            Payload and attempts
                          </Button>
                        </CollapsibleTrigger>
                        <CollapsibleContent>
                          <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap break-all">{JSON.stringify(d.payload, null, 2)}</pre>
                          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
                            {d.log.map((a) => (
                              <li key={a.at}>
                                {new Date(a.at).toLocaleString()}: {a.statusCode ?? "no answer"}
                                {a.error && ` (${a.error})`}, {a.durationMs} ms
                              </li>
                            ))}
                          </ul>
                        </CollapsibleContent>
                      </Collapsible>
                      {isAdmin && d.status !== "pending" && (
                        <Button size="sm" variant="ghost" className="mt-1 px-0" onClick={() => redeliver(d.id)}>
                          Send again
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )
        }
      </Skullet>
      <TablePager {...pager} />
    </div>
  );
}

export function Webhooks({ isAdmin }: { isAdmin: boolean }) {
  const api = useApi();
  const { workspace } = useWorkspaces();
  const endpoints = useApiQuery<WebhookEndpointInfo[]>("/developer/webhooks");
  const [sheet, setSheet] = useState<HookSheet | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [events, setEvents] = useState<WebhookEventType[]>([]);
  const [keepOld, setKeepOld] = useState("24");
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const open = (next: HookSheet) => {
    setError(undefined);
    if (next.mode === "create") {
      setUrl("");
      setDescription("");
      setWorkspaceId(workspace?.id ?? "");
      setEvents([...WEBHOOK_EVENTS]);
    }
    if (next.mode === "rotate") setKeepOld("24");
    if (next.mode === "edit") {
      setUrl(next.endpoint.url);
      setDescription(next.endpoint.description);
      setEvents(next.endpoint.events);
    }
    setSheet(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (sheet?.mode !== "create" && sheet?.mode !== "edit" && sheet?.mode !== "rotate") return;
    setSaving(true);
    setError(undefined);
    try {
      if (sheet.mode === "rotate") {
        const created = await api<CreatedWebhookEndpoint>(`/developer/webhooks/${sheet.endpoint.id}/rotate-secret`, { method: "POST", body: { keepOldForHours: Number(keepOld) }, toast: "Signing secret rotated" });
        setSheet({ mode: "secret", created });
      } else if (sheet.mode === "create") {
        const created = await api<CreatedWebhookEndpoint>("/developer/webhooks", { method: "POST", body: { url, description, workspaceId, events }, toast: "Webhook endpoint added" });
        setSheet({ mode: "secret", created });
      } else {
        await api(`/developer/webhooks/${sheet.endpoint.id}`, { method: "PATCH", body: { url, description, events }, toast: "Webhook endpoint saved" });
        setSheet(null);
      }
      endpoints.reload();
    } catch (err) {
      setError(errorOf(err));
    } finally {
      setSaving(false);
    }
  };

  const sendTest = (endpoint: WebhookEndpointInfo) => {
    setNotice(undefined);
    api<WebhookDeliveryRecord>(`/developer/webhooks/${endpoint.id}/test`, { method: "POST", toast: { loading: "Sending test event…", success: "Test event sent" } }).then(
      (d) => {
        const last = d.log.at(-1);
        setNotice(
          d.status === "succeeded"
            ? `Test event delivered (${last?.statusCode}, ${last?.durationMs} ms).`
            : `Test event not delivered: ${last?.statusCode ?? "no answer"}${last?.error ? ` (${last.error})` : ""}. It will be retried; see Deliveries.`,
        );
        endpoints.reload();
      },
      () => {
        // The toast in useApi shows why it failed.
      },
    );
  };

  const setEnabled = (endpoint: WebhookEndpointInfo, enabled: boolean) =>
    api(`/developer/webhooks/${endpoint.id}`, { method: "PATCH", body: { enabled }, toast: enabled ? "Webhook endpoint turned on" : "Webhook endpoint turned off" }).then(
      endpoints.reload,
      () => {
        // The toast in useApi shows why it failed.
      },
    );

  const remove = (endpoint: WebhookEndpointInfo) =>
    setConfirm({
      title: "Delete this endpoint?",
      description: `${endpoint.url} stops receiving events, and its delivery log is deleted.`,
      confirmLabel: "Delete endpoint",
      onConfirm: () => {
        setConfirm(null);
        api(`/developer/webhooks/${endpoint.id}`, { method: "DELETE", toast: "Webhook endpoint deleted" }).then(endpoints.reload, () => {
          // The toast in useApi shows why it failed.
        });
      },
    });

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Endpoints</CardTitle>
            <CardDescription>Your servers, told about events in one workspace as they happen. Failed deliveries are retried for about 3 days.</CardDescription>
          </div>
          {isAdmin && <Button onClick={() => open({ mode: "create" })}>Add endpoint</Button>}
        </CardHeader>
        <CardContent>
          {notice && (
            <Alert role="status" className="mb-3">
              <AlertDescription>{notice}</AlertDescription>
            </Alert>
          )}
          {endpoints.error ? (
            <ErrorState message={endpoints.error.message} onRetry={endpoints.reload} />
          ) : (
            <Skullet data={endpoints.data} sample={SAMPLE_ENDPOINTS} id="webhook-endpoints" label="Loading webhook endpoints">
              {(data) =>
                data.length === 0 ? (
                  <EmptyState icon={Webhook} title="No endpoints yet" description="Add an https address to receive conversation, workflow and call events." />
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Address</TableHead>
                          <TableHead>Workspace</TableHead>
                          <TableHead>Events</TableHead>
                          <TableHead>Last 7 days</TableHead>
                          <TableHead>On</TableHead>
                          <TableHead className="text-right">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {data.map((e) => (
                          <TableRow key={e.id}>
                            <TableCell>
                              <span className="block max-w-72 truncate font-mono text-xs">{e.url}</span>
                              {e.description && <span className="block text-xs text-muted-foreground">{e.description}</span>}
                              {e.previousSecretUntil && (
                                <span className="block text-xs text-muted-foreground">Old secret also signs until {new Date(e.previousSecretUntil).toLocaleString()}</span>
                              )}
                            </TableCell>
                            <TableCell>{e.workspaceName}</TableCell>
                            <TableCell>
                              <ShortList items={e.events} label="Events" />
                            </TableCell>
                            <TableCell className="text-sm">
                              {e.failed > 0 && <Badge variant="destructive">{e.failed} failed</Badge>} {e.pending > 0 && <Badge variant="outline">{e.pending} retrying</Badge>}
                              {e.failed === 0 && e.pending === 0 && <span className="text-muted-foreground">No problems</span>}
                            </TableCell>
                            <TableCell>
                              <Switch checked={e.enabled} disabled={!isAdmin} onCheckedChange={(on) => setEnabled(e, on)} aria-label={`Send events to ${e.url}`} />
                            </TableCell>
                            <TableCell className="text-right whitespace-nowrap">
                              <Button size="sm" variant="ghost" onClick={() => open({ mode: "log", endpoint: e })}>
                                Deliveries
                              </Button>
                              {isAdmin && (
                                <>
                                  <Button size="sm" variant="ghost" onClick={() => sendTest(e)}>
                                    Send test
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => open({ mode: "edit", endpoint: e })}>
                                    Edit
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => open({ mode: "rotate", endpoint: e })}>
                                    Rotate secret
                                  </Button>
                                  <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(e)}>
                                    Delete
                                  </Button>
                                </>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                )
              }
            </Skullet>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Checking that a request came from us</CardTitle>
          <CardDescription>Requests follow the Standard Webhooks scheme.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Each request carries <code className="font-mono text-xs">webhook-id</code>, <code className="font-mono text-xs">webhook-timestamp</code> and{" "}
            <code className="font-mono text-xs">webhook-signature</code>: <code className="font-mono text-xs">v1,</code> followed by the base64 HMAC-SHA256 of{" "}
            <code className="font-mono text-xs">id.timestamp.body</code>, keyed with the endpoint&apos;s secret (the part after{" "}
            <code className="font-mono text-xs">whsec_</code>, base64-decoded). The SDK&apos;s <code className="font-mono text-xs">verifyWebhook</code> does all of
            this.
          </p>
          <p>Answer with any 2xx within 10 seconds. A retry keeps the same id, so use it to ignore repeats.</p>
        </CardContent>
      </Card>

      <Sheet open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
        <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>
              {sheet?.mode === "log"
                ? "Deliveries"
                : sheet?.mode === "secret"
                  ? "Signing secret"
                  : sheet?.mode === "rotate"
                    ? "Rotate the signing secret"
                    : sheet?.mode === "edit"
                      ? "Edit endpoint"
                      : "Add an endpoint"}
            </SheetTitle>
            <SheetDescription>
              {sheet?.mode === "log"
                ? sheet.endpoint.url
                : sheet?.mode === "secret"
                  ? `Use it to check the signature of every request sent to ${sheet.created.endpoint.url}.`
                  : sheet?.mode === "rotate"
                    ? "A new secret signs every request. Keep the old one signing too while your servers switch."
                  : "Events of one workspace are sent to this https address."}
            </SheetDescription>
          </SheetHeader>
          {sheet?.mode === "log" ? (
            <div className="p-4">
              <Deliveries endpoint={sheet.endpoint} isAdmin={isAdmin} />
            </div>
          ) : sheet?.mode === "secret" ? (
            <SecretOnce label="Signing secret" secret={sheet.created.secret} onDone={() => setSheet(null)} />
          ) : sheet?.mode === "rotate" ? (
            <form onSubmit={submit} className="flex flex-col gap-5 p-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="keep-old">The old secret keeps signing</Label>
                <Select value={keepOld} onValueChange={setKeepOld}>
                  <SelectTrigger id="keep-old" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Object.entries(KEEP_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Meanwhile each request carries two signatures; either secret verifies it.</p>
              </div>
              {error && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={saving}>
                {saving ? "Working…" : "Rotate secret"}
              </Button>
            </form>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-5 p-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="hook-url">Address</Label>
                <Input id="hook-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/webhooks/workforce" required />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="hook-description">Description (optional)</Label>
                <Input id="hook-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={200} />
              </div>
              {sheet?.mode === "create" && (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="workspace">Workspace</Label>
                  <WorkspacePicker value={workspaceId} onChange={setWorkspaceId} />
                </div>
              )}
              <div className="flex flex-col gap-3">
                <span className="text-sm font-medium">Events</span>
                <Choices all={WEBHOOK_EVENTS} labels={WEBHOOK_EVENT_LABELS} value={events} onChange={setEvents} idPrefix="event" />
              </div>
              {error && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={saving || events.length === 0 || (sheet?.mode === "create" && !workspaceId)}>
                {saving ? "Saving…" : sheet?.mode === "edit" ? "Save" : "Add endpoint"}
              </Button>
            </form>
          )}
        </SheetContent>
      </Sheet>
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
