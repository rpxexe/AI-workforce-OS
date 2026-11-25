"use client";

import {
  CHANNEL_CAPABILITIES,
  channelConfigSchemas,
  DEFAULT_CHAT_GREETING,
  type EmployeeChannelInfo,
  type EmployeeChannels as ChannelsResponse,
  type EmployeeTool,
  type MessagingChannel,
  type ProviderConnectionInfo,
  type ProviderSettings,
  type ToolInfo,
  type ToolName,
  type WhatsAppProviderName,
  WHATSAPP_PROVIDER_LABELS,
  WHATSAPP_PROVIDERS,
} from "@workforce/shared";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError, useApi, useApiQuery } from "@/lib/api";

/** What each WhatsApp provider needs in the server's .env. */
const ENV_NEEDED: Record<WhatsAppProviderName, string> = {
  meta: "META_WHATSAPP_ACCESS_TOKEN, META_APP_SECRET and META_WHATSAPP_VERIFY_TOKEN",
  twilio: "TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN",
  telnyx: "TELNYX_API_KEY and TELNYX_PUBLIC_KEY",
};

/** The WhatsApp account select's value for "no connectionId": the platform's account. */
const PLATFORM_ACCOUNT = "platform";

const KINDS = ["web_chat", "whatsapp", "email"] as const satisfies readonly MessagingChannel[];

/** The form's fields, all as strings and booleans; turned into the channel's config on save. */
type Draft = {
  enabled: boolean;
  restrictTools: boolean;
  tools: ToolName[];
  greeting: string;
  origins: string;
  requireIdentity: boolean;
  provider: WhatsAppProviderName;
  phoneNumberId: string;
  number: string;
  displayNumber: string;
  connectionId: string;
  address: string;
};

const draftFrom = (c: EmployeeChannelInfo | undefined): Draft => {
  const config = (c?.config ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof config[key] === "string" ? (config[key] as string) : "");
  return {
    enabled: c?.enabled ?? true,
    restrictTools: c?.allowedTools != null,
    tools: c?.allowedTools ?? [],
    greeting: text("greeting") || DEFAULT_CHAT_GREETING,
    origins: Array.isArray(config.allowedOrigins) ? (config.allowedOrigins as string[]).join("\n") : "",
    requireIdentity: config.requireIdentity === true,
    provider: (text("provider") || "meta") as WhatsAppProviderName,
    phoneNumberId: text("phoneNumberId"),
    number: text("number"),
    displayNumber: text("displayNumber"),
    connectionId: text("connectionId") || PLATFORM_ACCOUNT,
    address: text("address"),
  };
};

const configOf = (kind: MessagingChannel, d: Draft) =>
  kind === "web_chat"
    ? { greeting: d.greeting.trim(), allowedOrigins: d.origins.split(/[\s,]+/).filter(Boolean), requireIdentity: d.requireIdentity }
    : kind === "whatsapp"
      ? {
          ...(d.provider === "meta"
            ? { provider: d.provider, phoneNumberId: d.phoneNumberId.trim(), ...(d.displayNumber.trim() && { displayNumber: d.displayNumber.trim() }) }
            : { provider: d.provider, number: d.number.trim() }),
          ...(d.connectionId !== PLATFORM_ACCOUNT && { connectionId: d.connectionId }),
        }
      : { address: d.address.trim() };

/** Where customers reach this employee in writing: the website widget, WhatsApp and email. */
export function EmployeeChannels({
  workspaceId,
  employeeId,
  canEdit,
  live,
}: {
  workspaceId: string;
  employeeId: string;
  canEdit: boolean;
  /** Published and active: only then does it answer. */
  live: boolean;
}) {
  const path = `/workspaces/${workspaceId}/employees/${employeeId}/channels`;
  const channels = useApiQuery<ChannelsResponse>(path);
  const granted = useApiQuery<EmployeeTool[]>(`/workspaces/${workspaceId}/employees/${employeeId}/tools`);
  const catalog = useApiQuery<ToolInfo[]>(`/workspaces/${workspaceId}/tools`);
  // Optional: without it the account select offers only the platform's account.
  const providers = useApiQuery<ProviderSettings>("/providers/settings");
  const [version, setVersion] = useState(0);

  const loadError = channels.error ?? granted.error ?? catalog.error;
  if (loadError) return <p className="text-sm text-destructive">{loadError.message}</p>;
  if (!channels.data || !granted.data || !catalog.data) return <Skeleton className="h-40 w-full" />;
  const data = channels.data;
  const titles = Object.fromEntries(catalog.data.map((t) => [t.name, t.title])) as Record<ToolName, string>;
  const grantedTools = granted.data.map((g) => g.name);
  const saved = () => {
    channels.reload();
    setVersion((v) => v + 1);
  };

  return (
    <div className="flex flex-col gap-4">
      {!live && <p className="text-sm text-muted-foreground">Publish this employee to let it answer on these channels.</p>}
      <Tabs defaultValue="web_chat">
        <TabsList>
          {KINDS.map((kind) => {
            const c = data.channels.find((x) => x.kind === kind);
            return (
              <TabsTrigger key={kind} value={kind} className="gap-1.5">
                {CHANNEL_CAPABILITIES[kind].label}
                {c && <span className={`size-1.5 rounded-full ${c.enabled ? "bg-success" : "bg-muted-foreground/50"}`} aria-label={c.enabled ? "on" : "off"} />}
              </TabsTrigger>
            );
          })}
        </TabsList>
        {KINDS.map((kind) => {
          const channel = data.channels.find((c) => c.kind === kind);
          return (
            <TabsContent key={kind} value={kind} className="pt-3">
              <ChannelForm
                // Re-keyed after each save so the form starts again from what was stored.
                key={`${kind}-${version}`}
                kind={kind}
                path={`${path}/${kind}`}
                channel={channel}
                canEdit={canEdit}
                granted={grantedTools}
                titles={titles}
                whatsappProviders={data.whatsappProviders}
                messagingConnections={(providers.data?.connections ?? []).filter((c) => c.providerType === "messaging")}
                email={{ provider: data.emailProvider, webhookUrl: data.emailWebhookUrl }}
                onSaved={saved}
              />
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}

function Field({ id, label, hint, error, children }: { id: string; label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function CopyBlock({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Button type="button" size="sm" variant="ghost" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">{value}</pre>
    </div>
  );
}

function ChannelForm({
  kind,
  path,
  channel,
  canEdit,
  granted,
  titles,
  whatsappProviders,
  messagingConnections,
  email,
  onSaved,
}: {
  kind: MessagingChannel;
  path: string;
  channel: EmployeeChannelInfo | undefined;
  canEdit: boolean;
  granted: ToolName[];
  titles: Record<ToolName, string>;
  whatsappProviders: WhatsAppProviderName[];
  messagingConnections: ProviderConnectionInfo[];
  email: EmailSetup;
  onSaved: () => void;
}) {
  const api = useApi();
  const initial = draftFrom(channel);
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const disabled = !canEdit || busy;
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      onSaved();
    } catch (err) {
      // The toast in useApi shows why it failed; field issues also go next to their fields.
      if (err instanceof ApiRequestError && err.issues.length > 0) setErrors(Object.fromEntries(err.issues.map((i) => [i.path, i.message])));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const config = configOf(kind, draft);
    // The same schema the API validates with.
    const parsed = channelConfigSchemas[kind].safeParse(config);
    setErrors(parsed.success ? {} : Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0] ?? ""), i.message])));
    if (!parsed.success) return;
    void run(() =>
      api(path, {
        method: "PUT",
        body: { enabled: draft.enabled, allowedTools: draft.restrictTools ? draft.tools : null, config },
        toast: `${CHANNEL_CAPABILITIES[kind].label} ${channel ? "saved" : "added"}`,
      }),
    );
  };
  const remove = () =>
    setConfirm({
      title: `Stop answering on ${CHANNEL_CAPABILITIES[kind].label}?`,
      description:
        kind === "web_chat"
          ? "The widget stops working on every website that shows it. Its message log is kept. Adding web chat again gives a new key."
          : "Messages sent here are no longer answered. The message log is kept.",
      confirmLabel: "Remove channel",
      onConfirm: () => void run(() => api(path, { method: "DELETE", toast: `${CHANNEL_CAPABILITIES[kind].label} removed` })),
    });

  const id = (name: string) => `${kind}-${name}`;
  // Connections whose provider carries this WhatsApp provider's numbers (meta -> meta_whatsapp, ...).
  const accounts = messagingConnections.filter(
    (c) => c.providerId === `${draft.provider}_whatsapp` && (c.status === "active" || c.id === draft.connectionId),
  );
  const invalid = (name: string) => ({
    "aria-invalid": errors[name] !== undefined,
    "aria-describedby": errors[name] ? `${id(name)}-error` : undefined,
  });

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        {kind === "web_chat" &&
          "A chat bubble on your website. Visitors are anonymous unless your website vouches for them; then the employee knows them from calls and WhatsApp too."}
        {kind === "whatsapp" &&
          "Customers message your WhatsApp Business number. A customer who called first is recognised by their number. Voice notes are transcribed and documents read."}
        {kind === "email" && "Emails sent to this address are answered by email. Replies to the employee's emails continue the same conversation."}
      </p>

      {kind === "whatsapp" && draft.connectionId === PLATFORM_ACCOUNT && !whatsappProviders.includes(draft.provider) && (
        <Alert role="status">
          <AlertDescription>
            {WHATSAPP_PROVIDER_LABELS[draft.provider]} is not set up on the server yet. Add {ENV_NEEDED[draft.provider]} to its .env. You can save the
            number now.
          </AlertDescription>
        </Alert>
      )}
      {kind === "email" && email.provider === null && (
        <Alert role="status">
          <AlertDescription>
            Test mode: replies are written and logged below, but not delivered. Add RESEND_API_KEY and RESEND_WEBHOOK_SECRET to the server&apos;s .env to
            send and receive through Resend.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {kind === "web_chat" && (
          <>
            <Field id={id("greeting")} label="Greeting" error={errors.greeting}>
              <Input id={id("greeting")} value={draft.greeting} onChange={(e) => update({ greeting: e.target.value })} disabled={disabled} {...invalid("greeting")} />
            </Field>
            <Field
              id={id("origins")}
              label="Websites allowed to show it, one per line"
              hint="For example https://www.example.com. The preview page always works."
              error={errors.allowedOrigins}
            >
              <Textarea
                id={id("origins")}
                value={draft.origins}
                onChange={(e) => update({ origins: e.target.value })}
                disabled={disabled}
                rows={2}
                placeholder="https://www.example.com"
                className="font-mono text-sm"
                {...invalid("allowedOrigins")}
              />
            </Field>
          </>
        )}
        {kind === "whatsapp" && (
          <>
            <Field id={id("provider")} label="Provider" hint="Who carries this WhatsApp number.">
              <Select
                value={draft.provider}
                onValueChange={(v) => update({ provider: v as WhatsAppProviderName, connectionId: PLATFORM_ACCOUNT })}
                disabled={disabled}
              >
                <SelectTrigger id={id("provider")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHATSAPP_PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {WHATSAPP_PROVIDER_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field id={id("account")} label="Account" hint="Your own connection from Settings, or the platform's account." error={errors.connectionId}>
              <Select value={draft.connectionId} onValueChange={(connectionId) => update({ connectionId })} disabled={disabled}>
                <SelectTrigger id={id("account")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PLATFORM_ACCOUNT}>Platform account</SelectItem>
                  {accounts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.displayName}
                      {c.status === "disabled" ? " (disabled)" : ""}
                    </SelectItem>
                  ))}
                  {draft.connectionId !== PLATFORM_ACCOUNT && !accounts.some((c) => c.id === draft.connectionId) && (
                    <SelectItem value={draft.connectionId}>Saved account</SelectItem>
                  )}
                </SelectContent>
              </Select>
            </Field>
            {draft.provider === "meta" ? (
              <Field id={id("pnid")} label="Phone number ID" hint="In Meta's WhatsApp Manager, under API Setup. Not the phone number itself." error={errors.phoneNumberId}>
                <Input
                  id={id("pnid")}
                  value={draft.phoneNumberId}
                  onChange={(e) => update({ phoneNumberId: e.target.value })}
                  disabled={disabled}
                  inputMode="numeric"
                  className="font-mono"
                  {...invalid("phoneNumberId")}
                />
              </Field>
            ) : (
              <Field
                id={id("number")}
                label="WhatsApp number"
                hint={`The WhatsApp sender in your ${WHATSAPP_PROVIDER_LABELS[draft.provider]} account.`}
                error={errors.number}
              >
                <Input
                  id={id("number")}
                  value={draft.number}
                  onChange={(e) => update({ number: e.target.value })}
                  disabled={disabled}
                  placeholder="+14155550100"
                  inputMode="tel"
                  className="font-mono"
                  {...invalid("number")}
                />
              </Field>
            )}
            {draft.provider === "meta" && (
              <Field id={id("display")} label="Phone number (optional, for your reference)" error={errors.displayNumber}>
                <Input
                  id={id("display")}
                  value={draft.displayNumber}
                  onChange={(e) => update({ displayNumber: e.target.value })}
                  disabled={disabled}
                  placeholder="+14155550100"
                  inputMode="tel"
                  className="font-mono"
                  {...invalid("displayNumber")}
                />
              </Field>
            )}
          </>
        )}
        {kind === "email" && (
          <Field id={id("address")} label="Address customers write to" error={errors.address}>
            <Input
              id={id("address")}
              type="email"
              value={draft.address}
              onChange={(e) => update({ address: e.target.value })}
              disabled={disabled}
              placeholder="support@example.com"
              {...invalid("address")}
            />
          </Field>
        )}
      </div>

      <div className="flex flex-col gap-3">
        <SwitchRow id={id("enabled")} label="Answer on this channel" checked={draft.enabled} disabled={disabled} onChange={(enabled) => update({ enabled })} />
        {kind === "web_chat" && (
          <SwitchRow
            id={id("identity")}
            label="Only visitors your website vouches for"
            hint="Anonymous visitors are refused. Use it when the employee's tools act on customers' accounts."
            checked={draft.requireIdentity}
            disabled={disabled}
            onChange={(requireIdentity) => update({ requireIdentity })}
          />
        )}
        <SwitchRow
          id={id("restrict")}
          label="Limit the tools used here"
          hint="Off: every tool granted to the employee. On: only the tools ticked below."
          checked={draft.restrictTools}
          disabled={disabled}
          onChange={(restrictTools) => update({ restrictTools })}
        />
        {draft.restrictTools && (
          <fieldset className="flex flex-col gap-2 pl-1">
            <legend className="sr-only">Tools allowed on {CHANNEL_CAPABILITIES[kind].label}</legend>
            {granted.length === 0 && <p className="text-sm text-muted-foreground">This employee has no tools yet.</p>}
            {granted.map((tool) => (
              <Label key={tool} className="font-normal">
                <Checkbox
                  checked={draft.tools.includes(tool)}
                  disabled={disabled}
                  onCheckedChange={(on) => update({ tools: on === true ? [...draft.tools, tool] : draft.tools.filter((t) => t !== tool) })}
                />
                {titles[tool] ?? tool}
              </Label>
            ))}
          </fieldset>
        )}
      </div>

      {canEdit && (
        <div className="flex flex-wrap gap-2">
          <Button onClick={save} disabled={busy || (channel !== undefined && !changed)}>
            {busy ? "Saving" : channel ? "Save changes" : `Add ${CHANNEL_CAPABILITIES[kind].label.toLowerCase()}`}
          </Button>
          {channel && (
            <Button variant="outline" onClick={remove} disabled={busy}>
              Remove
            </Button>
          )}
        </div>
      )}

      {channel && <Connect channel={channel} email={email} />}
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <Label htmlFor={id} className="flex flex-col items-start gap-0.5 font-normal">
        <span className="text-sm">{label}</span>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </Label>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

/** How to connect the saved channel: the embed code, the webhook to give Meta, the inbound email hook. */
/** How the server sends and receives email: Resend, or test mode. */
type EmailSetup = { provider: "resend" | null; webhookUrl: string | null };

function Connect({ channel, email }: { channel: EmployeeChannelInfo; email: EmailSetup }) {
  if (channel.kind === "web_chat")
    return (
      <div className="flex flex-col gap-4 border-t pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-medium">Add it to your website</h3>
          {channel.previewUrl && (
            <Button size="sm" variant="outline" asChild>
              <a href={channel.previewUrl} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                Open preview
              </a>
            </Button>
          )}
        </div>
        <CopyBlock label="Embed code, before </body>" value={`<script src="${channel.url}" data-key="${channel.address}" async></script>`} />
        {channel.secret && (
          <>
            <CopyBlock label="Identity secret (keep it on your server)" value={channel.secret} />
            <p className="text-xs text-muted-foreground">
              To continue as a known customer, add <code className="font-mono">data-customer</code> (their phone or email) and{" "}
              <code className="font-mono">data-customer-hash</code>, computed on your server:
            </p>
            <CopyBlock label="Node.js" value={`require("node:crypto").createHmac("sha256", IDENTITY_SECRET).update(customer).digest("hex")`} />
          </>
        )}
      </div>
    );
  if (channel.kind === "whatsapp") {
    const provider = ((channel.config as { provider?: WhatsAppProviderName }).provider ?? "meta") as WhatsAppProviderName;
    return (
      <div className="flex flex-col gap-3 border-t pt-4">
        <h3 className="text-sm font-medium">Connect it in {WHATSAPP_PROVIDER_LABELS[provider]}</h3>
        <p className="text-xs text-muted-foreground">
          {provider === "meta" && (
            <>
              In your Meta app, under WhatsApp, Configuration, set the callback URL below and the verify token from the server&apos;s
              META_WHATSAPP_VERIFY_TOKEN, then subscribe to the <code className="font-mono">messages</code> field.
            </>
          )}
          {provider === "twilio" &&
            "In the Twilio Console, open the WhatsApp sender and set the URL below as the webhook for incoming messages (HTTP POST). Delivery receipts come back to it on their own."}
          {provider === "telnyx" &&
            "In the Telnyx portal, set the URL below as the webhook of the messaging profile (or WhatsApp Business Account) this number uses. Delivery events come back to it on their own."}
        </p>
        {channel.url && <CopyBlock label={provider === "meta" ? "Callback URL" : "Webhook URL"} value={channel.url} />}
        <Badge variant="outline" className="w-fit font-mono">
          {channel.address}
        </Badge>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 border-t pt-4">
      {email.provider === "resend" && email.webhookUrl && (
        <>
          <h3 className="text-sm font-medium">Connect it in Resend</h3>
          <p className="text-xs text-muted-foreground">
            Verify the address&apos;s domain in Resend and turn on receiving for it (its MX record). Then add a webhook with the URL below and the events{" "}
            <code className="font-mono">email.received</code>, <code className="font-mono">email.sent</code>,{" "}
            <code className="font-mono">email.delivered</code>, <code className="font-mono">email.bounced</code>,{" "}
            <code className="font-mono">email.failed</code> and <code className="font-mono">email.opened</code>, and put its signing secret in the
            server&apos;s RESEND_WEBHOOK_SECRET.
          </p>
          <CopyBlock label="Resend webhook URL" value={email.webhookUrl} />
        </>
      )}
      <h3 className="text-sm font-medium">{email.provider === "resend" ? "Or forward incoming email" : "Forward incoming email"}</h3>
      <p className="text-xs text-muted-foreground">
        Point another inbound email service (or a forwarding script) at this URL. It POSTs JSON:{" "}
        <code className="font-mono">{"{ from, subject, text, messageId, inReplyTo? }"}</code>. Keep the URL secret.
      </p>
      {channel.url && <CopyBlock label="Inbound webhook" value={channel.url} />}
    </div>
  );
}
