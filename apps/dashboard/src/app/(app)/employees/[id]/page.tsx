"use client";

import { useAuth } from "@clerk/nextjs";
import { LANGUAGES, defaultEmployeeConfig, type EmployeeDetail, type Workspace } from "@workforce/shared";
import {
  Archive,
  ArrowLeft,
  Copy,
  Ellipsis,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Rocket,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { ChannelLog } from "@/components/employees/channel-log";
import { EmployeeChannels } from "@/components/employees/employee-channels";
import { EmployeeKnowledge } from "@/components/employees/employee-knowledge";
import { EmployeePhone } from "@/components/employees/employee-phone";
import { EmployeeReleases } from "@/components/employees/employee-releases";
import { EmployeeTools } from "@/components/employees/employee-tools";
import { EmployeeOverview } from "@/components/employees/employee-overview";
import { EMPLOYEE_TABS, resolveTab } from "@/components/employees/helpers.ts";
import { EmployeeAvatar, StatusBadge, formatDate } from "@/components/employees/meta";
import { ProviderOverridesForm } from "@/components/providers/provider-overrides";
import { ErrorState } from "@/components/states";
import { Skeleton as Skullet } from "skullet/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: EmployeeDetail = {
  id: "sample",
  status: "ACTIVE",
  publishedVersion: 4,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versions: [4, 3, 2, 1].map((number) => ({
    ...defaultEmployeeConfig("Asia/Kolkata"),
    name: "Sample employee",
    role: "Customer support agent",
    description: "Answers customer questions about orders, deliveries and returns.",
    personality: "Warm, patient and concise. Explains next steps clearly and never promises what it cannot do.",
    systemInstructions:
      "You help customers of an online store with their orders.\nAsk for the order number before checking its status.\nOffer a person when the customer is unhappy.",
    goals: ["Answer in the first reply", "Collect the order number", "Hand off when the customer asks for a person"],
    number,
    createdBy: "sample-user",
    createdAt: "2026-01-01T00:00:00.000Z",
  })),
};

function Section({
  title,
  description,
  className,
  children,
}: {
  title: string;
  description?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** Long free text, or a quiet note when the field was left empty. */
function Prose({ text, empty }: { text: string; empty: string }) {
  return text ? (
    <p className="text-sm leading-relaxed whitespace-pre-wrap">{text}</p>
  ) : (
    <p className="text-sm text-muted-foreground">{empty}</p>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

export default withWorkspace(function EmployeePage({ workspace }) {
  // useSearchParams needs a Suspense boundary to prerender.
  return (
    <Suspense>
      <EmployeeView workspace={workspace} />
    </Suspense>
  );
});

function EmployeeView({ workspace }: { workspace: Workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const { userId } = useAuth();
  const api = useApi();
  const router = useRouter();
  const tab = resolveTab(useSearchParams().get("tab"));
  const path = `/workspaces/${workspace.id}/employees/${id}`;

  const { data, error, reload, setData } = useApiQuery<EmployeeDetail>(path);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const view = (data: EmployeeDetail) => {
    const latest = data.versions[0];
    if (!latest) return null;
    // Sections below fetch their own data: they mount only for the real employee, never the sample.
    const real = data !== SAMPLE;

    const live = data.publishedVersion;
    const archived = data.status === "ARCHIVED";
    const hasUnpublishedChanges = live !== latest.number;

    /** Runs an action that returns the updated employee, and shows the result. */
    const run = async (action: () => Promise<EmployeeDetail | void>) => {
      try {
        const updated = await action();
        if (updated) setData(updated);
      } catch {
        // The toast in useApi shows why it failed.
      }
    };
    const statusDone = { ACTIVE: "resumed", PAUSED: archived ? "restored" : "paused", ARCHIVED: "archived" };
    const setStatus = (status: "ACTIVE" | "PAUSED" | "ARCHIVED") =>
      run(() =>
        api<EmployeeDetail>(`${path}/status`, { method: "PATCH", body: { status }, toast: `${latest.name} ${statusDone[status]}` }),
      );
    const publish = (version: number) =>
      setConfirm({
        title: `Publish version ${version}?`,
        description:
          live === null
            ? "This employee goes live with this configuration."
            : `Customers will be served version ${version} instead of version ${live}. You can publish another version at any time.`,
        confirmLabel: "Publish",
        onConfirm: () => run(() => api<EmployeeDetail>(`${path}/publish`, { method: "POST", body: { version }, toast: `Version ${version} published` })),
      });
    const duplicate = () =>
      run(async () => {
        const copy = await api<EmployeeDetail>(`${path}/duplicate`, { method: "POST", toast: `${latest.name} duplicated` });
        router.push(`/employees/${copy.id}`);
      });

    return (
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-4">
          <Link href="/employees" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-4" aria-hidden />
            Employees
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <EmployeeAvatar avatar={latest.avatar} className="size-14 rounded-xl" />
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className="truncate text-xl font-semibold tracking-tight">{latest.name}</h1>
                  <StatusBadge status={data.status} />
                </div>
                <p className="truncate text-sm text-muted-foreground">{latest.role}</p>
              </div>
            </div>

            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2">
                {!archived && (
                  <Button variant="outline" asChild>
                    <Link href={`/employees/${id}/chat`}>
                      <MessageSquare aria-hidden />
                      Test chat
                    </Link>
                  </Button>
                )}
                {hasUnpublishedChanges && !archived && (
                  <Button onClick={() => publish(latest.number)}>
                    <Rocket aria-hidden />
                    Publish v{latest.number}
                  </Button>
                )}
                <Button variant="outline" asChild>
                  <Link href={`/employees/${id}/edit`}>
                    <Pencil aria-hidden />
                    Edit
                  </Link>
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" aria-label="More actions">
                      <Ellipsis aria-hidden />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {data.status === "ACTIVE" && (
                      <DropdownMenuItem onSelect={() => setStatus("PAUSED")}>
                        <Pause aria-hidden />
                        Pause
                      </DropdownMenuItem>
                    )}
                    {data.status === "PAUSED" && (
                      <DropdownMenuItem onSelect={() => setStatus("ACTIVE")}>
                        <Play aria-hidden />
                        Resume
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={duplicate}>
                      <Copy aria-hidden />
                      Duplicate
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    {archived ? (
                      <DropdownMenuItem onSelect={() => setStatus("PAUSED")}>
                        <Undo2 aria-hidden />
                        Restore
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() =>
                          setConfirm({
                            title: `Archive ${latest.name}?`,
                            description:
                              "It stops working and moves to the Archived tab. Its versions are kept and you can restore it later.",
                            confirmLabel: "Archive",
                            onConfirm: () => setStatus("ARCHIVED"),
                          })
                        }
                      >
                        <Archive aria-hidden />
                        Archive
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>

          {hasUnpublishedChanges && (
            <Alert role="status">
              <AlertDescription>
                {live === null
                  ? `This employee has never been published. You are looking at version ${latest.number}, a draft.`
                  : `You are looking at version ${latest.number}, which is not live. Customers are served version ${live}.`}
              </AlertDescription>
            </Alert>
          )}
        </div>

        <Tabs value={tab} onValueChange={(t) => window.history.replaceState(null, "", `?tab=${t}`)}>
          <div className="overflow-x-auto">
            <TabsList>
              {EMPLOYEE_TABS.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="overview" className="mt-4">
            {real && <EmployeeOverview workspaceId={workspace.id} employee={data} />}
          </TabsContent>

          <TabsContent value="setup" className="mt-4 grid gap-4 lg:grid-cols-2">
            <Section title="Identity">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Fact label="Name">{latest.name}</Fact>
                <Fact label="Language">{LANGUAGES[latest.language]}</Fact>
                <div className="sm:col-span-2">
                  <Fact label="Description">{latest.description || <span className="text-muted-foreground">None</span>}</Fact>
                </div>
                <Fact label="Escalation">
                  {latest.escalation.enabled ? (
                    <span className="flex flex-col">
                      <span>Hands off to the inbox, notifying {latest.escalation.contactEmail}</span>
                      <span className="text-muted-foreground">
                        {[
                          latest.escalation.onCustomerRequest && "when the customer asks",
                          latest.escalation.onLowConfidence && "on low confidence",
                          latest.escalation.onPolicyRisk && "on policy risk",
                          latest.escalation.onToolFailure && "when a tool fails",
                          latest.escalation.afterFailedAttempts > 0 &&
                            `after ${latest.escalation.afterFailedAttempts} failed attempts`,
                          latest.escalation.highValueKey && `for ${latest.escalation.highValueKey} of ${latest.escalation.highValueMinimum} or more`,
                          latest.escalation.transferNumber && `calls transferred to ${latest.escalation.transferNumber}`,
                          latest.escalation.rules.length > 0 &&
                            `on ${latest.escalation.rules.length} condition${latest.escalation.rules.length > 1 ? "s" : ""}`,
                        ]
                          .filter(Boolean)
                          .join(", ") || "No triggers set"}
                      </span>
                    </span>
                  ) : (
                    <span className="text-muted-foreground">Off</span>
                  )}
                </Fact>
              </dl>
            </Section>

            <Section title="Role">
              <div className="flex flex-col gap-4">
                <p className="text-sm font-medium">{latest.role}</p>
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">System instructions</span>
                  {latest.systemInstructions ? (
                    <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
                      {latest.systemInstructions}
                    </pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">No instructions written yet.</p>
                  )}
                </div>
              </div>
            </Section>

            <Section title="Personality">
              <Prose text={latest.personality} empty="No personality described yet." />
            </Section>

            <Section title="Goals">
              {latest.goals.length === 0 ? (
                <p className="text-sm text-muted-foreground">No goals set yet.</p>
              ) : (
                <ol className="flex list-decimal flex-col gap-1.5 pl-5 text-sm">
                  {latest.goals.map((goal, i) => (
                    <li key={i}>{goal}</li>
                  ))}
                </ol>
              )}
            </Section>

            <Section title="Providers" description="The AI model, speech and email accounts this employee uses instead of the organization's defaults.">
              {real && <ProviderOverridesForm path={`${path}/providers`} canEdit={isAdmin && !archived} />}
            </Section>
          </TabsContent>

          <TabsContent value="knowledge" className="mt-4 grid gap-4 lg:grid-cols-2">
            <Section title="Knowledge" description="Documents and sources this employee answers from.">
              {real && <EmployeeKnowledge workspaceId={workspace.id} employeeId={id} canEdit={isAdmin && !archived} />}
            </Section>

            <Section title="Tools" description="Actions this employee can take in other systems.">
              {real && <EmployeeTools workspaceId={workspace.id} employeeId={id} canEdit={isAdmin && !archived} />}
            </Section>
          </TabsContent>

          <TabsContent value="channels" className="mt-4 flex flex-col gap-4">
            <Section title="Phone" description="Calls this employee answers and makes. Callers reach the published version.">
              {real && (
                <EmployeePhone
                  workspaceId={workspace.id}
                  employeeId={id}
                  canEdit={isAdmin && !archived}
                  live={data.status === "ACTIVE" && data.publishedVersion !== null}
                />
              )}
            </Section>

            <Section
              title="Channels"
              description="Web chat, WhatsApp and email. Every channel reaches the published version, and a customer is remembered across all of them."
           
            >
              {real && (
                <EmployeeChannels
                  workspaceId={workspace.id}
                  employeeId={id}
                  canEdit={isAdmin && !archived}
                  live={data.status === "ACTIVE" && data.publishedVersion !== null}
                />
              )}
            </Section>

            <Section title="Message log" description="Every message in and out, on every channel, with its delivery state.">
              {real && <ChannelLog workspaceId={workspace.id} employeeId={id} />}
            </Section>
          </TabsContent>

          <TabsContent value="releases" className="mt-4 flex flex-col gap-4">
            <Section
              title="Releases"
              description="Roll a version out to a share of customers, compare a KPI, then promote or roll back."
           
            >
              {real && <EmployeeReleases workspaceId={workspace.id} employee={data} canEdit={isAdmin && !archived} onLiveChange={reload} />}
            </Section>

            <Section
              title="Versions"
              description="Every save is kept. Publishing chooses which version customers are served."
           
            >
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Version</TableHead>
                    <TableHead>Saved</TableHead>
                    <TableHead className="hidden sm:table-cell">By</TableHead>
                    <TableHead className="w-48">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.versions.map((v) => (
                    <TableRow key={v.number}>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium tabular-nums">v{v.number}</span>
                          {v.number === live && <Badge>Live</Badge>}
                          {v.number === latest.number && <Badge variant="secondary">Latest</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatDate(v.createdAt)}</TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">
                        {v.createdBy === userId ? "You" : "A teammate"}
                      </TableCell>
                      <TableCell className="space-x-2 text-right whitespace-nowrap">
                        {live !== null && v.number !== live && (
                          <Button variant="ghost" size="sm" asChild>
                            <Link href={`/employees/${id}/compare?from=${live}&to=${v.number}`}>Compare with live</Link>
                          </Button>
                        )}
                        {isAdmin && !archived && v.number !== live && (
                          <Button variant="outline" size="sm" onClick={() => publish(v.number)}>
                            {live !== null && v.number < live ? "Roll back" : "Publish"}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Section>
          </TabsContent>
        </Tabs>

        <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      </div>
    );
  };

  return (
    <Skullet data={data} sample={SAMPLE} id="employee-detail" label="Loading employee">
      {view}
    </Skullet>
  );
}
