"use client";

import type { EmployeeSummary } from "@workforce/shared";
import { Bot, Plus } from "lucide-react";
import Link from "next/link";
import { EmployeeAvatar, StatusBadge, formatDate } from "@/components/employees/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

export default withWorkspace(function DashboardPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useApiQuery<EmployeeSummary[]>(`/workspaces/${workspace.id}/employees`);

  const count = (status: EmployeeSummary["status"]) => data?.filter((e) => e.status === status).length;
  const stats = [
    { label: "Employees", value: data?.length },
    { label: "Active", value: count("ACTIVE") },
    { label: "Paused", value: count("PAUSED") },
    { label: "Drafts", value: count("DRAFT") },
  ];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description={`Your AI workforce in the ${workspace.name} workspace.`} />

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {stats.map(({ label, value }) => (
              <Card key={label} size="sm">
                <CardContent>
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
                </CardContent>
              </Card>
            ))}
          </dl>

          {data.length === 0 ? (
            <EmptyState
              icon={Bot}
              title="No employees yet"
              description={
                isAdmin
                  ? "Create your first AI employee to give it a role, a personality and goals."
                  : "An organization admin has not created any AI employees in this workspace yet."
              }
            >
              {isAdmin && (
                <Button asChild>
                  <Link href="/employees/new">
                    <Plus aria-hidden />
                    New employee
                  </Link>
                </Button>
              )}
            </EmptyState>
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>Recently changed</CardTitle>
                <CardDescription>The employees your team worked on last.</CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col divide-y">
                  {data.slice(0, 5).map((e) => (
                    <li key={e.id}>
                      <Link href={`/employees/${e.id}`} className="group flex items-center gap-3 py-2.5">
                        <EmployeeAvatar avatar={e.avatar} />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="truncate text-sm font-medium group-hover:underline">{e.name}</span>
                          <span className="truncate text-sm text-muted-foreground">{e.role}</span>
                        </span>
                        <span className="hidden text-sm text-muted-foreground sm:inline">{formatDate(e.updatedAt)}</span>
                        <StatusBadge status={e.status} />
                      </Link>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
});
