"use client";

import { OrganizationProfile, UserProfile } from "@clerk/nextjs";
import {
  PROVIDER_TYPE_LABELS,
  PROVIDER_TYPES,
  workspaceSchema,
  type ProviderSettings,
  type ProviderType,
  type ToolInfo,
  type Workspace,
} from "@workforce/shared";
import {
  Code,
  PanelLeftClose,
  PanelLeftOpen,
  Cpu,
  HardDrive,
  KeyRound,
  Mail,
  MessageCircle,
  Phone,
  LayoutList,
  Settings2,
  ShieldCheck,
  Webhook,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, Suspense, useState, useSyncExternalStore, type FormEvent, type ReactNode } from "react";
import { ApiKeys, Webhooks } from "@/components/developer/developer-api";
import { formatDate } from "@/components/employees/meta";
import { AuditLog, ProviderMetrics } from "@/components/providers/provider-activity";
import { ProviderList, platformNames } from "@/components/providers/provider-list";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApi, useApiQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useIsAdmin, useWorkspaces } from "@/lib/workspace";

function Workspaces() {
  const state = useWorkspaces();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (!state.workspace) return null;
  const { workspaces = [], workspace: current, select, reload } = state;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = workspaceSchema.safeParse({ name });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setError(undefined);
    setSaving(true);
    try {
      const created = await api<Workspace>("/workspaces", { method: "POST", body: parsed.data });
      setName("");
      reload();
      select(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspaces</CardTitle>
        <CardDescription>
          Workspaces keep AI employees apart inside your organization, for example one per brand or team.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <ul className="flex flex-col divide-y rounded-lg border">
          {workspaces.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{w.name}</span>
                <span className="text-sm text-muted-foreground">Created {formatDate(w.createdAt)}</span>
              </span>
              {w.id === current.id ? (
                <Badge variant="secondary">Current</Badge>
              ) : (
                <Button variant="outline" size="sm" onClick={() => select(w.id)}>
                  Switch
                </Button>
              )}
            </li>
          ))}
        </ul>

        {isAdmin ? (
          <form onSubmit={create} noValidate className="flex flex-col gap-1.5">
            <Label htmlFor="workspace-name">New workspace</Label>
            <div className="flex max-w-md gap-2">
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Support"
                maxLength={60}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "workspace-name-error" : undefined}
              />
              <Button type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create"}
              </Button>
            </div>
            {error && (
              <p id="workspace-name-error" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Only organization admins can create workspaces.</p>
        )}
      </CardContent>
    </Card>
  );
}


const ACCOUNT_TABS = ["workspaces", "organization", "profile"] as const;

function AccountTabs({ initial }: { initial: string | null }) {
  return (
    <Tabs defaultValue={ACCOUNT_TABS.find((t) => t === initial) ?? "workspaces"} className="gap-6">
      <TabsList>
        <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
        <TabsTrigger value="organization">Organization</TabsTrigger>
        <TabsTrigger value="profile">Profile</TabsTrigger>
      </TabsList>
      <TabsContent value="workspaces">
        <Workspaces />
      </TabsContent>
      {/* Clerk's own screens: organization details, members, invitations and roles; and the user's account. */}
      <TabsContent value="organization" className="overflow-x-auto">
        <OrganizationProfile routing="hash" />
      </TabsContent>
      <TabsContent value="profile" className="overflow-x-auto">
        <UserProfile routing="hash" />
      </TabsContent>
    </Tabs>
  );
}

const SECTIONS = [
  { id: "general", label: "General", icon: Settings2 },
  { id: "overview", label: "Provider overview", icon: LayoutList },
  { id: "ai-providers", label: "AI Providers", icon: Cpu },
  { id: "voice", label: "Voice & Telephony", icon: Phone },
  { id: "messaging", label: "Messaging", icon: MessageCircle },
  { id: "email", label: "Email", icon: Mail },
  { id: "storage", label: "Storage", icon: HardDrive },
  { id: "tools", label: "Employee tools", icon: Wrench },
  { id: "api-keys", label: "API Keys", icon: KeyRound },
  { id: "webhooks", label: "Webhooks", icon: Webhook },
  { id: "audit", label: "Credentials & audit", icon: ShieldCheck },
  { id: "developer", label: "Developer", icon: Code },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon }[];
type SectionId = (typeof SECTIONS)[number]["id"];

/** Where each provider type is managed. */
const SECTION_OF: Record<ProviderType, SectionId> = {
  llm: "ai-providers",
  stt: "ai-providers",
  tts: "ai-providers",
  telephony: "voice",
  messaging: "messaging",
  email: "email",
  storage: "storage",
};

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

type ProvidersQuery = { data?: ProviderSettings; error?: { message: string }; reload: () => void };

/** Renders `children` once the organization's provider settings have loaded. */
function WithProviders({ query, children }: { query: ProvidersQuery; children: (settings: ProviderSettings) => ReactNode }) {
  if (query.error && !query.data) return <ErrorState message={query.error.message} onRetry={query.reload} />;
  if (!query.data) return <LoadingState rows={4} />;
  return children(query.data);
}

function ProviderOverview({ settings }: { settings: ProviderSettings }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Providers</CardTitle>
        <CardDescription>
          What answers for each kind of work: the organization&apos;s default connection, else the platform&apos;s own account. Employees and workflows can
          choose another for AI, speech and email.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Organization default</TableHead>
              <TableHead className="hidden sm:table-cell">Platform provides</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {PROVIDER_TYPES.map((t) => {
              const def = settings.connections.find((c) => c.providerType === t && c.isDefault && c.status === "active");
              const platform = platformNames(t, settings.platform[t]);
              return (
                <TableRow key={t}>
                  <TableCell>
                    <Link href={`/settings?section=${SECTION_OF[t]}`} scroll={false} className="font-medium underline-offset-4 hover:underline">
                      {PROVIDER_TYPE_LABELS[t]}
                    </Link>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {def ? def.displayName : <span className="text-muted-foreground">None{platform ? `, so ${platform}` : ""}</span>}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">{platform || "Nothing configured"}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Keys and connections here; which model each kind of work uses, and usage, on the Model routing page. */
function LlmProviders({ settings, isAdmin, reload }: { settings: ProviderSettings; isAdmin: boolean; reload: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Choose which model handles each kind of work, its fallbacks and limits, and see what every call cost, on{" "}
        <Link href="/model-routing" className="font-medium text-foreground underline underline-offset-4">
          Model routing
        </Link>
        .
      </p>
      <ProviderList type="llm" settings={settings} isAdmin={isAdmin} reload={reload} />
    </div>
  );
}

function EmployeeTools() {
  const { workspace } = useWorkspaces();
  const tools = useApiQuery<ToolInfo[]>(workspace ? `/workspaces/${workspace.id}/tools` : null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Tools</CardTitle>
        <CardDescription>
          Actions employees can take in other systems. Each tool is granted per employee, on the employee&apos;s page under Tools.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {tools.error && !tools.data ? (
          <ErrorState message={tools.error.message} onRetry={tools.reload} />
        ) : !tools.data ? (
          <Skeleton className="h-24 w-full" />
        ) : tools.data.length === 0 ? (
          <EmptyState icon={Wrench} title="No tools available" description="This workspace has no tools to grant yet." />
        ) : (
          <ul className="flex flex-col divide-y">
            {tools.data.map((tool) => (
              <li key={tool.name} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <span className="text-sm font-medium">{tool.title}</span>
                <span className="text-xs text-muted-foreground">{tool.description}</span>
                <span className="flex flex-wrap gap-1">
                  {tool.permissions.map((p) => (
                    <Badge key={p} variant="outline" className="font-mono text-[11px]">
                      {p}
                    </Badge>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link href="/employees">Go to employees</Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function CredentialsAudit({ settings, isAdmin }: { settings: ProviderSettings; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Credentials</CardTitle>
          <CardDescription>How provider secrets are kept.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge variant={settings.canStoreKeys ? "secondary" : "destructive"}>{settings.canStoreKeys ? "Can store credentials" : "Cannot store credentials"}</Badge>
            {!settings.canStoreKeys && <span className="text-muted-foreground">The server has no AI_CREDENTIALS_KEY.</span>}
          </p>
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-muted-foreground">
            <li>Secrets are sealed with AES-256-GCM before they are stored and are never returned: the dashboard only sees their last four characters.</li>
            <li>Secrets change only by rotating them; configuring a connection never touches them.</li>
            <li>Test Connection is limited to 10 tests a minute per organization.</li>
            <li>Members can see connections; only admins can change them or read the audit log.</li>
          </ul>
        </CardContent>
      </Card>
      {isAdmin ? <AuditLog settings={settings} /> : <p className="text-sm text-muted-foreground">Only organization admins can see the audit log.</p>}
    </div>
  );
}

function Developer() {
  return (
    <div className="flex flex-col gap-6">
      <ProviderMetrics />
      <Card>
        <CardHeader>
          <CardTitle>Adding a provider</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Describe it in <code className="font-mono text-xs">PROVIDER_CATALOG</code> (packages/shared/src/providers.ts), write its adapter and register it in
          the provider registry; this page renders its connection form from the catalog entry. The steps are in docs/ARCHITECTURE.md.
        </CardContent>
      </Card>
    </div>
  );
}

function SectionBody({ section, providers, accountTab }: { section: SectionId; providers: ProvidersQuery; accountTab: string | null }) {
  const isAdmin = useIsAdmin();
  const list = (type: ProviderType) => (
    <WithProviders query={providers}>{(settings) => <ProviderList type={type} settings={settings} isAdmin={isAdmin} reload={providers.reload} />}</WithProviders>
  );

  switch (section) {
    case "general":
      return (
        <>
          <SectionHeading title="General" description="Your workspaces, organization and account." />
          <AccountTabs initial={accountTab} />
        </>
      );
    case "overview":
      return (
        <>
          <SectionHeading title="Provider overview" description="For each kind of provider: your organization's default, and what the platform provides without one." />
          <WithProviders query={providers}>{(settings) => <ProviderOverview settings={settings} />}</WithProviders>
        </>
      );
    case "ai-providers":
      return (
        <>
          <SectionHeading title="AI Providers" description="Language models, speech to text and text to speech." />
          <WithProviders query={providers}>
            {(settings) => (
              <Tabs defaultValue="llm" className="gap-4">
                <TabsList>
                  <TabsTrigger value="llm">LLM</TabsTrigger>
                  <TabsTrigger value="stt">STT</TabsTrigger>
                  <TabsTrigger value="tts">TTS</TabsTrigger>
                </TabsList>
                <TabsContent value="llm">
                  <LlmProviders settings={settings} isAdmin={isAdmin} reload={providers.reload} />
                </TabsContent>
                <TabsContent value="stt">
                  <ProviderList type="stt" settings={settings} isAdmin={isAdmin} reload={providers.reload} />
                </TabsContent>
                <TabsContent value="tts">
                  <ProviderList type="tts" settings={settings} isAdmin={isAdmin} reload={providers.reload} />
                </TabsContent>
              </Tabs>
            )}
          </WithProviders>
        </>
      );
    case "voice":
      return (
        <>
          <SectionHeading
            title="Voice & Telephony"
            description="Phone accounts that carry your numbers. The voices and transcription calls use are under AI Providers."
          />
          {list("telephony")}
        </>
      );
    case "messaging":
      return (
        <>
          <SectionHeading title="Messaging" description="WhatsApp accounts. Choose one per employee on its WhatsApp channel." />
          {list("messaging")}
        </>
      );
    case "email":
      return (
        <>
          <SectionHeading title="Email" description="Accounts that send (and, with Resend, receive) your employees' email." />
          {list("email")}
        </>
      );
    case "storage":
      return (
        <>
          <SectionHeading title="Storage" description="Buckets the platform keeps files in." />
          {list("storage")}
        </>
      );
    case "tools":
      return (
        <>
          <SectionHeading title="Employee tools" description="What employees can do in other systems. Grant tools per employee, on its page." />
          <EmployeeTools />
        </>
      );
    case "api-keys":
      return (
        <>
          <SectionHeading title="API Keys" description="Keys for the platform's own API (/v1). Keys for outside providers live in the provider sections." />
          <ApiKeys isAdmin={isAdmin} />
        </>
      );
    case "webhooks":
      return (
        <>
          <SectionHeading title="Webhooks" description="Signed requests to your servers when conversations, workflows and calls change." />
          <Webhooks isAdmin={isAdmin} />
        </>
      );
    case "audit":
      return (
        <>
          <SectionHeading title="Credentials & audit" description="How provider credentials are protected, and who changed what." />
          <WithProviders query={providers}>{(settings) => <CredentialsAudit settings={settings} isAdmin={isAdmin} />}</WithProviders>
        </>
      );
    case "developer":
      return (
        <>
          <SectionHeading title="Developer" description="How providers are performing, and how to add one." />
          <Developer />
        </>
      );
  }
}

/** The section menu's groups. */
const GROUPS: { label: string; ids: SectionId[] }[] = [
  { label: "Account", ids: ["general"] },
  { label: "Providers", ids: ["overview", "ai-providers", "voice", "messaging", "email", "storage"] },
  { label: "Platform", ids: ["tools", "api-keys", "webhooks", "audit", "developer"] },
];

// The menu's collapsed state, remembered per browser. Storage can be unavailable (private windows): then it just resets.
const COLLAPSED_KEY = "settings-menu-collapsed";
const collapsedListeners = new Set<() => void>();
const readCollapsed = () => {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
};
const writeCollapsed = (value: boolean) => {
  try {
    localStorage.setItem(COLLAPSED_KEY, value ? "1" : "0");
  } catch {
    // Not remembered; the toggle still works for this page view.
  }
  collapsedListeners.forEach((l) => l());
};
const subscribeCollapsed = (listener: () => void) => {
  collapsedListeners.add(listener);
  return () => collapsedListeners.delete(listener);
};

/** The section menu: labels and groups, or (collapsed) icons only with their names in tooltips. */
function SectionMenu({ section }: { section: SectionId }) {
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, () => false);
  return (
    <nav
      aria-label="Settings sections"
      className={cn(
        "hidden shrink-0 flex-col gap-1 overflow-hidden rounded-xl border bg-card p-2 transition-[width] duration-200 lg:sticky lg:top-16 lg:flex",
        collapsed ? "w-[3.25rem]" : "w-52",
      )}
    >
      <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between pl-2")}>
        {!collapsed && <span className="text-xs font-medium text-muted-foreground">Sections</span>}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={collapsed ? "Expand the section menu" : "Collapse the section menu"}
              aria-expanded={!collapsed}
              onClick={() => writeCollapsed(!collapsed)}
            >
              {collapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{collapsed ? "Expand" : "Collapse"}</TooltipContent>
        </Tooltip>
      </div>
      {GROUPS.map((group, index) => (
        <div key={group.label} role="group" aria-label={group.label} className="flex flex-col gap-0.5">
          {collapsed ? (
            index > 0 && <span aria-hidden className="mx-auto my-1.5 h-px w-6 bg-border" />
          ) : (
            <span className="px-2 pt-3 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{group.label}</span>
          )}
          {group.ids.map((id) => {
            const { label, icon: Icon } = SECTIONS.find((s) => s.id === id)!;
            const link = (
              <Link
                href={`/settings?section=${id}`}
                scroll={false}
                aria-current={id === section ? "page" : undefined}
                aria-label={collapsed ? label : undefined}
                className={cn(
                  "flex h-8 items-center gap-2 rounded-md text-sm text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground",
                  collapsed ? "w-8 justify-center self-center" : "px-2",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden />
                {!collapsed && <span className="truncate">{label}</span>}
              </Link>
            );
            return collapsed ? (
              <Tooltip key={id}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            ) : (
              <Fragment key={id}>{link}</Fragment>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function SettingsSections() {
  const params = useSearchParams();
  const router = useRouter();
  const section = SECTIONS.find((s) => s.id === params.get("section"))?.id ?? "general";
  const providers = useApiQuery<ProviderSettings>("/providers/settings");

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
      <SectionMenu section={section} />
      {/* Phones and narrow windows: the menu is a dropdown. */}
      <div className="flex flex-col gap-1.5 lg:hidden">
        <Label htmlFor="settings-section">Section</Label>
        <Select value={section} onValueChange={(id) => router.push(`/settings?section=${id}`, { scroll: false })}>
          <SelectTrigger id="settings-section" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GROUPS.map((group) => (
              <SelectGroup key={group.label}>
                <SelectLabel>{group.label}</SelectLabel>
                {group.ids.map((id) => (
                  <SelectItem key={id} value={id}>
                    {SECTIONS.find((s) => s.id === id)!.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-6">
        <SectionBody key={section} section={section} providers={providers} accountTab={params.get("tab")} />
      </div>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Your workspaces and organization, and the providers and tools they use." />
      {/* useSearchParams needs a Suspense boundary to prerender. */}
      <Suspense>
        <SettingsSections />
      </Suspense>
    </div>
  );
}
