"use client";

import type { EmployeeDetail, EmployeeSummary } from "@workforce/shared";
import { Archive, Bot, Copy, Ellipsis, Eye, Pencil, Plus, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { EmployeeAvatar, StatusBadge, formatDate, versionLabel } from "@/components/employees/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LANGUAGES } from "@workforce/shared";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

export default withWorkspace(function EmployeesPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  const base = `/workspaces/${workspace.id}/employees`;

  const [archived, setArchived] = useState(false);
  const { data, error, loading, reload } = useApiQuery<EmployeeSummary[]>(`${base}?archived=${archived}`);
  const [actionError, setActionError] = useState<string>();
  const [confirm, setConfirm] = useState<Confirmation | null>(null);

  /** Runs a row action, then refreshes the list or reports why it failed. */
  const run = async (action: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await action();
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };
  const setStatus = (id: string, status: "PAUSED" | "ARCHIVED") =>
    run(() => api(`${base}/${id}/status`, { method: "PATCH", body: { status } }));
  const duplicate = (id: string) =>
    run(async () => {
      const copy = await api<EmployeeDetail>(`${base}/${id}/duplicate`, { method: "POST" });
      router.push(`/employees/${copy.id}`);
    });

  const newButton = isAdmin && (
    <Button asChild>
      <Link href="/employees/new">
        <Plus aria-hidden />
        New employee
      </Link>
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Employees" description={`AI employees in the ${workspace.name} workspace.`}>
        {newButton}
      </PageHeader>

      <Tabs value={archived ? "archived" : "current"} onValueChange={(v) => setArchived(v === "archived")}>
        <TabsList>
          <TabsTrigger value="current">Current</TabsTrigger>
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>
      </Tabs>

      {actionError && <ErrorState message={actionError} />}

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : data.length === 0 ? (
        archived ? (
          <EmptyState icon={Archive} title="No archived employees" description="Employees you archive are kept here and can be restored." />
        ) : (
          <EmptyState
            icon={Bot}
            title="No employees yet"
            description={
              isAdmin
                ? "Create your first AI employee to give it a role, a personality and goals."
                : "An organization admin has not created any AI employees in this workspace yet."
            }
          >
            {newButton}
          </EmptyState>
        )
      ) : (
        <div className={`rounded-lg border ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Language</TableHead>
                <TableHead className="hidden sm:table-cell">Version</TableHead>
                <TableHead className="hidden lg:table-cell">Updated</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link href={`/employees/${e.id}`} className="group flex min-w-0 items-center gap-3">
                      <EmployeeAvatar avatar={e.avatar} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium group-hover:underline">{e.name}</span>
                        <span className="truncate text-sm text-muted-foreground">{e.role}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={e.status} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{LANGUAGES[e.language]}</TableCell>
                  <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
                    {versionLabel(e.latestVersion, e.publishedVersion)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDate(e.updatedAt)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${e.name}`}>
                          <Ellipsis aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/employees/${e.id}`}>
                            <Eye aria-hidden />
                            View
                          </Link>
                        </DropdownMenuItem>
                        {isAdmin && (
                          <>
                            <DropdownMenuItem asChild>
                              <Link href={`/employees/${e.id}/edit`}>
                                <Pencil aria-hidden />
                                Edit
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => duplicate(e.id)}>
                              <Copy aria-hidden />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {e.status === "ARCHIVED" ? (
                              <DropdownMenuItem onSelect={() => setStatus(e.id, "PAUSED")}>
                                <Undo2 aria-hidden />
                                Restore
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() =>
                                  setConfirm({
                                    title: `Archive ${e.name}?`,
                                    description:
                                      "It stops working and moves to the Archived tab. Its versions are kept and you can restore it later.",
                                    confirmLabel: "Archive",
                                    onConfirm: () => setStatus(e.id, "ARCHIVED"),
                                  })
                                }
                              >
                                <Archive aria-hidden />
                                Archive
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
});
