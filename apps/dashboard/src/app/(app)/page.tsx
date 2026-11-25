"use client";

import type { EmployeeSummary } from "@workforce/shared";
import { Bot, CirclePause, CirclePlay, FilePen, Plus } from "lucide-react";
import Link from "next/link";
import { EmployeeAvatar, StatusBadge, formatDate } from "@/components/employees/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

// Stands in for the real list so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: EmployeeSummary[] = Array.from({ length: 5 }, (_, i) => ({
  id: `sample-${i}`,
  name: "Sample employee",
  role: "Customer support agent",
  description: "",
  avatar: "bot",
  language: "en",
  status: "ACTIVE",
  latestVersion: 1,
  publishedVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

export default withWorkspace(function DashboardPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useApiQuery<EmployeeSummary[]>(`/workspaces/${workspace.id}/employees`);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Dashboard" description={`Your AI workforce in the ${workspace.name} workspace.`} />

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="dashboard" label="Loading dashboard">
          {(data) => <Overview employees={data} isAdmin={isAdmin} />}
        </Skullet>
      )}
    </div>
  );
});

function Overview({ employees: data, isAdmin }: { employees: EmployeeSummary[]; isAdmin: boolean }) {
  const count = (status: EmployeeSummary["status"]) => data.filter((e) => e.status === status).length;
  const stats = [
    { label: "Employees", value: data.length, icon: Bot },
    { label: "Active", value: count("ACTIVE"), icon: CirclePlay },
    { label: "Paused", value: count("PAUSED"), icon: CirclePause },
    { label: "Drafts", value: count("DRAFT"), icon: FilePen },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {stats.map(({ label, value, icon }) => (
          <StatTile key={label} label={label} value={value} icon={icon} />
        ))}
      </div>

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
  );
}
