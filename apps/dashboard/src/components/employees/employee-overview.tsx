"use client";

import { LANGUAGES, type EmployeeDetail, type InboxCounts, type QualityOverview } from "@workforce/shared";
import { ChartColumn, CircleCheck, Gauge, MessagesSquare, UserRound } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatRate, formatScore } from "@/components/quality/meta";
import { EmptyState, ErrorState, StatTile } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useApiQuery } from "@/lib/api";
import { openConversations } from "./helpers.ts";
import { DAY_LABELS, formatDate } from "./meta";

const DAYS = 30;

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/** Whether this employee is working: conversation and quality numbers, then its key settings. */
export function EmployeeOverview({ workspaceId, employee }: { workspaceId: string; employee: EmployeeDetail }) {
  const inbox = useApiQuery<InboxCounts>(`/workspaces/${workspaceId}/inbox/counts?employeeId=${employee.id}`);
  const quality = useApiQuery<QualityOverview>(`/workspaces/${workspaceId}/quality?days=${DAYS}&employeeId=${employee.id}`);

  const latest = employee.versions[0];
  const workingDays = latest.workingHours.days.filter((d) => d.enabled);
  const counts = inbox.data;
  const nothingYet = counts?.all === 0 && quality.data?.evaluations === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {inbox.error ? (
          <div className="sm:col-span-2">
            <ErrorState message={inbox.error.message} onRetry={inbox.reload} />
          </div>
        ) : (
          <>
            <StatTile label="Open conversations" icon={MessagesSquare} value={counts ? openConversations(counts) : "—"} />
            <StatTile label="With a human" icon={UserRound} value={counts ? (counts.human_active ?? 0) : "—"} />
          </>
        )}
        {quality.error ? (
          <div className="sm:col-span-2">
            <ErrorState message={quality.error.message} onRetry={quality.reload} />
          </div>
        ) : (
          <>
            <StatTile
              label="Quality score"
              icon={Gauge}
              value={quality.data ? formatScore(quality.data.averageScore) : "—"}
              hint={quality.data && `${quality.data.evaluations} evaluations, last ${DAYS} days`}
            />
            <StatTile label="Pass rate" icon={CircleCheck} value={quality.data ? formatRate(quality.data.passRate) : "—"} />
          </>
        )}
      </div>

      {nothingYet && (
        <EmptyState
          icon={ChartColumn}
          title="No conversations yet"
          description="Numbers appear here once customers start talking to this employee."
        />
      )}

      <Card>
        <CardHeader>
          <CardTitle>At a glance</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Fact label="Live version">{employee.publishedVersion === null ? "Not published" : `v${employee.publishedVersion}`}</Fact>
            <Fact label="Latest version">v{latest.number}</Fact>
            <Fact label="Language">{LANGUAGES[latest.language]}</Fact>
            <Fact label="Last changed">{formatDate(employee.updatedAt)}</Fact>
            <Fact label="Created">{formatDate(employee.createdAt)}</Fact>
            <Fact label="Escalation">{latest.escalation.enabled ? "On" : "Off"}</Fact>
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
          </dl>
        </CardContent>
        <CardFooter className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/conversations">View conversations</Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/quality">View quality</Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
