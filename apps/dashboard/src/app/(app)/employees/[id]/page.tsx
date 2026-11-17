"use client";

import { useAuth } from "@clerk/nextjs";
import { LANGUAGES, type EmployeeDetail } from "@workforce/shared";
import {
  Archive,
  ArrowLeft,
  ChartColumn,
  Copy,
  Ellipsis,
  MessageSquare,
  Pause,
  Pencil,
  Play,
  Rocket,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { EmployeeKnowledge } from "@/components/employees/employee-knowledge";
import { EmployeePhone } from "@/components/employees/employee-phone";
import { EmployeeTools } from "@/components/employees/employee-tools";
import { DAY_LABELS, EmployeeAvatar, StatusBadge, formatDate } from "@/components/employees/meta";
import { ErrorState, LoadingState } from "@/components/states";
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
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

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

function NotConnected({ icon: Icon, text }: { icon: LucideIcon; text: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <Icon className="size-4 shrink-0" aria-hidden />
      {text}
    </div>
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
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const { userId } = useAuth();
  const api = useApi();
  const router = useRouter();
  const path = `/workspaces/${workspace.id}/employees/${id}`;

  const { data, error, reload, setData } = useApiQuery<EmployeeDetail>(path);
  const [actionError, setActionError] = useState<string>();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const latest = data?.versions[0];
  if (!data || !latest) return <LoadingState rows={6} />;

  const live = data.publishedVersion;
  const archived = data.status === "ARCHIVED";
  const hasUnpublishedChanges = live !== latest.number;

  /** Runs an action that returns the updated employee, and shows the result or why it failed. */
  const run = async (action: () => Promise<EmployeeDetail | void>) => {
    setActionError(undefined);
    try {
      const updated = await action();
      if (updated) setData(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };
  const setStatus = (status: "ACTIVE" | "PAUSED" | "ARCHIVED") =>
    run(() => api<EmployeeDetail>(`${path}/status`, { method: "PATCH", body: { status } }));
  const publish = (version: number) =>
    setConfirm({
      title: `Publish version ${version}?`,
      description:
        live === null
          ? "This employee goes live with this configuration."
          : `Customers will be served version ${version} instead of version ${live}. You can publish another version at any time.`,
      confirmLabel: "Publish",
      onConfirm: () => run(() => api<EmployeeDetail>(`${path}/publish`, { method: "POST", body: { version } })),
    });
  const duplicate = () =>
    run(async () => {
      const copy = await api<EmployeeDetail>(`${path}/duplicate`, { method: "POST" });
      router.push(`/employees/${copy.id}`);
    });

  const workingDays = latest.workingHours.days.filter((d) => d.enabled);

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
          <p className="rounded-lg border bg-muted/50 px-4 py-2.5 text-sm" role="status">
            {live === null
              ? `This employee has never been published. You are looking at version ${latest.number}, a draft.`
              : `You are looking at version ${latest.number}, which is not live. Customers are served version ${live}.`}
          </p>
        )}
        {actionError && <ErrorState message={actionError} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Identity">
          <dl className="grid gap-4 sm:grid-cols-2">
            <Fact label="Name">{latest.name}</Fact>
            <Fact label="Language">{LANGUAGES[latest.language]}</Fact>
            <div className="sm:col-span-2">
              <Fact label="Description">{latest.description || <span className="text-muted-foreground">None</span>}</Fact>
            </div>
            <Fact label="Working hours">
              {workingDays.length === 0 ? (
                <span className="text-muted-foreground">No working days set</span>
              ) : (
                <span className="flex flex-col">
                  {workingDays.map((d) => (
                    <span key={d.day} className="tabular-nums">
                      {DAY_LABELS[d.day].slice(0, 3)} {d.start}–{d.end}
                    </span>
                  ))}
                  <span className="text-muted-foreground">{latest.workingHours.timezone.replaceAll("_", " ")}</span>
                </span>
              )}
            </Fact>
            <Fact label="Escalation">
              {latest.escalation.enabled ? (
                <span className="flex flex-col">
                  <span>Hands off to {latest.escalation.contactEmail}</span>
                  <span className="text-muted-foreground">
                    {[
                      latest.escalation.onCustomerRequest && "when the customer asks",
                      latest.escalation.afterFailedAttempts > 0 &&
                        `after ${latest.escalation.afterFailedAttempts} failed attempts`,
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

        <Section title="Knowledge" description="Documents and sources this employee answers from.">
          <EmployeeKnowledge workspaceId={workspace.id} employeeId={id} canEdit={isAdmin && !archived} />
        </Section>

        <Section title="Tools" description="Actions this employee can take in other systems.">
          <EmployeeTools workspaceId={workspace.id} employeeId={id} canEdit={isAdmin && !archived} />
        </Section>

        <Section title="Phone" description="Calls this employee answers and makes. Callers reach the published version.">
          <EmployeePhone
            workspaceId={workspace.id}
            employeeId={id}
            canEdit={isAdmin && !archived}
            live={data.status === "ACTIVE" && data.publishedVersion !== null}
          />
        </Section>

        <Section title="Analytics" description="How this employee is performing.">
          <dl className="grid grid-cols-2 gap-4">
            <Fact label="Created">{formatDate(data.createdAt)}</Fact>
            <Fact label="Last changed">{formatDate(data.updatedAt)}</Fact>
          </dl>
          <div className="mt-4">
            <NotConnected icon={ChartColumn} text="No conversations yet, so there is nothing to measure." />
          </div>
        </Section>

        <Section
          title="Versions"
          description="Every save is kept. Publishing chooses which version customers are served."
          className="lg:col-span-2"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Saved</TableHead>
                <TableHead className="hidden sm:table-cell">By</TableHead>
                <TableHead className="w-24">
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
                  <TableCell className="text-right">
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
      </div>

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
});
