"use client";

import {
  OVERRIDABLE_TYPES,
  PROVIDER_CATALOG,
  PROVIDER_TYPE_LABELS,
  type ProviderConnectionInfo,
  type ProviderMeta,
  type ProviderSettings,
  type ProviderType,
  type TestConnectionResult,
} from "@workforce/shared";
import { Ellipsis, ExternalLink, Plus } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { CopyBlock } from "@/components/employees/employee-channels";
import { timeAgo } from "@/components/inbox/meta";
import { ConnectionSheet, type SheetRequest } from "@/components/providers/connection-sheet";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useApi } from "@/lib/api";


const WEBHOOK_LABELS: Record<string, string> = { voice: "Incoming call URL", status: "Status callback URL", webhook: "Webhook URL" };
const WEBHOOK_HELP: Partial<Record<ProviderType, string>> = {
  telephony: "Enter these in the provider's console: the incoming call URL as the number's voice webhook, the status URL as its status callback.",
  messaging: "Enter this in the provider's console as the WhatsApp number's incoming message webhook.",
  email: "Enter this in the provider's console as the webhook for received email.",
};

/** The server's own providers for `type`, by name. */
export const platformNames = (type: ProviderType, ids: string[]) =>
  ids.map((id) => PROVIDER_CATALOG.find((p) => p.type === type && p.id === id)?.name ?? id).join(", ");

type Action = "test" | "default" | "status" | "delete" | "configure" | "rotate";

/** What happened the last time an admin pressed a button on a connection. */
type Outcome = { test?: TestConnectionResult };

function TestResult({ result }: { result: TestConnectionResult }) {
  const models = result.models ?? [];
  return (
    <Alert role="status" className="flex flex-col gap-2 bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={result.ok ? "secondary" : "destructive"}>{result.ok ? "Connection works" : "Test failed"}</Badge>
        <span className="text-muted-foreground">
          Credentials {result.auth === "ok" ? "accepted" : result.auth === "failed" ? "rejected" : "not checked"} · settings{" "}
          {result.config === "ok" ? "valid" : "invalid"} · {result.latencyMs} ms
        </span>
      </div>
      {result.capabilities.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {result.capabilities.map((c) => (
            <Badge key={c} variant="outline" className="font-mono text-[11px]">
              {c}
            </Badge>
          ))}
        </div>
      )}
      {result.error && <p className="text-destructive">{result.error}</p>}
      {models.length > 0 && (
        <p className="text-xs break-words text-muted-foreground">
          Offers {models.slice(0, 8).join(", ")}
          {models.length > 8 && ` and ${models.length - 8} more`}
        </p>
      )}
    </Alert>
  );
}

function ConnectionRow({
  connection,
  meta,
  isAdmin,
  busy,
  outcome,
  onAction,
}: {
  connection: ProviderConnectionInfo;
  meta: ProviderMeta;
  isAdmin: boolean;
  busy: boolean;
  outcome: Outcome | undefined;
  onAction: (action: Action) => void;
}) {
  const c = connection;
  const label = (key: string) => meta.credentialFields.find((f) => f.key === key)?.label ?? key;
  const hints = Object.entries(c.credentialHints).map(([key, hint]) => `${label(key)} …${hint}`);
  const disabled = c.status === "disabled";

  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate font-medium">{c.displayName}</span>
            {c.isDefault && <Badge>Default</Badge>}
            {disabled && <Badge variant="outline">Disabled</Badge>}
          </span>
          {hints.length > 0 && <span className="text-xs break-words text-muted-foreground">{hints.join(" · ")}</span>}
          <span className="text-xs text-muted-foreground">
            {c.lastTestedAt === null ? (
              "Not tested yet"
            ) : (
              <>
                <span className={c.lastTestStatus === "failed" ? "text-destructive" : undefined}>
                  {c.lastTestStatus === "ok" ? "Test passed" : "Test failed"}
                </span>{" "}
                {timeAgo(c.lastTestedAt)}
                {c.lastTestStatus === "failed" && c.lastTestError && `: ${c.lastTestError}`}
              </>
            )}
          </span>
        </div>
        {isAdmin && (
          <div className="flex items-center gap-1">
            <Button size="sm" variant="outline" onClick={() => onAction("test")} disabled={busy}>
              {busy ? "Working…" : "Test connection"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${c.displayName}`} disabled={busy}>
                  <Ellipsis aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onAction("configure")}>Configure</DropdownMenuItem>
                {!c.isDefault && !disabled && <DropdownMenuItem onSelect={() => onAction("default")}>Set as default</DropdownMenuItem>}
                {meta.credentialFields.length > 0 && <DropdownMenuItem onSelect={() => onAction("rotate")}>Rotate credentials</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => onAction("status")}>{disabled ? "Enable" : "Disable"}</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onAction("delete")}>
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
      {outcome?.test && <TestResult result={outcome.test} />}
      {c.webhookUrls && Object.keys(c.webhookUrls).length > 0 && (
        <div className="flex flex-col gap-2">
          {WEBHOOK_HELP[c.providerType] && <p className="text-xs text-muted-foreground">{WEBHOOK_HELP[c.providerType]}</p>}
          {Object.entries(c.webhookUrls).map(([key, url]) => (
            <CopyBlock key={key} label={WEBHOOK_LABELS[key] ?? key} value={url} />
          ))}
        </div>
      )}
    </li>
  );
}

/** Every catalog entry of `type`, each with the organization's connections to it and their actions (admins). */
export function ProviderList({
  type,
  settings,
  isAdmin,
  reload,
}: {
  type: ProviderType;
  settings: ProviderSettings;
  isAdmin: boolean;
  reload: () => void;
}) {
  const api = useApi();
  const [sheet, setSheet] = useState<SheetRequest | null>(null);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState<string>();
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const entries = PROVIDER_CATALOG.filter((p) => p.type === type);

  const run = async (c: ProviderConnectionInfo, action: () => Promise<TestConnectionResult | void>) => {
    setBusy(c.id);
    setOutcomes((o) => ({ ...o, [c.id]: {} }));
    try {
      const test = (await action()) ?? undefined;
      setOutcomes((o) => ({ ...o, [c.id]: { test } }));
      reload();
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setBusy(undefined);
    }
  };

  const act = (c: ProviderConnectionInfo, meta: ProviderMeta) => (action: Action) => {
    const path = `/providers/connections/${c.id}`;
    if (action === "configure" || action === "rotate") return setSheet({ mode: action, meta, connection: c });
    if (action === "test") return void run(c, () => api<TestConnectionResult>(`${path}/test`, { method: "POST", toast: { loading: `Testing ${c.displayName}…`, success: `${c.displayName} tested` } }));
    if (action === "default") return void run(c, () => api(`${path}/default`, { method: "POST", toast: `${c.displayName} set as default` }).then(() => undefined));
    if (action === "status")
      return void run(c, () => api(`${path}/status`, {
              method: "POST",
              body: { status: c.status === "active" ? "disabled" : "active" },
              toast: c.status === "active" ? `${c.displayName} disabled` : `${c.displayName} enabled`,
            }).then(() => undefined));
    setConfirm({
      title: `Delete "${c.displayName}"?`,
      description: "Its credentials are erased from the server. Employees, workflows, numbers and channels that use it must be changed first.",
      confirmLabel: "Delete connection",
      onConfirm: () => void run(c, () => api(path, { method: "DELETE", toast: `${c.displayName} deleted` }).then(() => undefined)),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      {isAdmin && !settings.canStoreKeys && (
        <Alert role="status">
          <AlertDescription>New connections cannot be added yet: the server has no AI_CREDENTIALS_KEY to seal credentials with.</AlertDescription>
        </Alert>

      )}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        {entries.map((meta) => {
          const connections = settings.connections.filter((c) => c.providerType === type && c.providerId === meta.id);
          const soon = meta.status === "coming_soon";
          return (
            <Card key={meta.id} size="sm">
              <CardHeader>
                <CardTitle className="flex flex-wrap items-center gap-2">
                  {meta.name}
                  {soon && <Badge variant="outline">Coming soon</Badge>}
                </CardTitle>
                <CardDescription className="flex flex-col gap-2">
                  {meta.capabilities.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {meta.capabilities.map((c) => (
                        <Badge key={c} variant="secondary" className="font-mono text-[11px]">
                          {c}
                        </Badge>
                      ))}
                    </span>
                  )}
                  {meta.notes && <span className="text-xs">{meta.notes}</span>}
                  <a
                    href={meta.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex w-fit items-center gap-1 text-xs underline-offset-4 hover:text-foreground hover:underline"
                  >
                    Documentation <ExternalLink className="size-3" aria-hidden />
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </CardDescription>
                {isAdmin && !soon && (
                  <CardAction>
                    <Button size="sm" variant="outline" onClick={() => setSheet({ mode: "connect", meta })} aria-label={`Connect ${meta.name}`}>
                      <Plus aria-hidden /> Connect
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              {connections.length > 0 && (
                <CardContent>
                  <ul className="flex flex-col divide-y border-t pt-3">
                    {connections.map((c) => (
                      <ConnectionRow
                        key={c.id}
                        connection={c}
                        meta={meta}
                        isAdmin={isAdmin}
                        busy={busy === c.id}
                        outcome={outcomes[c.id]}
                        onAction={act(c, meta)}
                      />
                    ))}
                  </ul>
                </CardContent>
              )}
            </Card>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {PROVIDER_TYPE_LABELS[type]}: the default connection serves the whole organization
        {(OVERRIDABLE_TYPES as readonly string[]).includes(type) ? "; employees and workflows can choose another" : ""}. Without one, the platform&apos;s own
        account is used{settings.platform[type].length > 0 ? ` (${platformNames(type, settings.platform[type])})` : ", and none is configured"}.
      </p>
      <ConnectionSheet request={sheet} canStoreKeys={settings.canStoreKeys} onClose={() => setSheet(null)} onSaved={reload} />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
