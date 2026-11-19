"use client";

import { CHANNEL_CAPABILITIES, CHANNEL_KINDS, type ChannelKind, type ChannelMessageRecord, type ChannelMessageStatus } from "@workforce/shared";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiQuery } from "@/lib/api";

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
const BAD: ChannelMessageStatus[] = ["FAILED", "REJECTED"];

/** Every message in and out of this employee's channels, newest first: the audit log, with delivery state. */
export function ChannelLog({ workspaceId, employeeId }: { workspaceId: string; employeeId: string }) {
  const [channel, setChannel] = useState<ChannelKind | "all">("all");
  const query = `employeeId=${employeeId}${channel === "all" ? "" : `&channel=${channel}`}`;
  const log = useApiQuery<ChannelMessageRecord[]>(`/workspaces/${workspaceId}/channel-messages?${query}`);
  const failed = log.data?.filter((m) => BAD.includes(m.status)).length ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Select value={channel} onValueChange={(v) => setChannel(v as ChannelKind | "all")}>
          <SelectTrigger className="w-44" aria-label="Channel">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels</SelectItem>
            {CHANNEL_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {CHANNEL_CAPABILITIES[k].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-3">
          {log.data && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {log.data.length} {log.data.length === 1 ? "message" : "messages"}
              {failed > 0 && `, ${failed} not answered or not delivered`}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={log.reload}>
            Refresh
          </Button>
        </div>
      </div>

      {log.error ? (
        <p className="text-sm text-destructive">{log.error.message}</p>
      ) : !log.data ? (
        <Skeleton className="h-24 w-full" />
      ) : log.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">No messages yet.</p>
      ) : (
        <ul className="flex flex-col divide-y">
          {log.data.map((m) => {
            const inbound = m.direction === "INBOUND";
            const Icon = inbound ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={m.id} className="flex flex-col gap-1 py-2.5 text-sm">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Icon className="size-4 text-muted-foreground" aria-label={inbound ? "From the customer" : "To the customer"} />
                  <Badge variant="secondary">{CHANNEL_CAPABILITIES[m.channel].label}</Badge>
                  <Badge variant={BAD.includes(m.status) ? "destructive" : "outline"}>{m.status.toLowerCase()}</Badge>
                  <span className="truncate font-mono text-xs text-muted-foreground">{inbound ? m.from : m.to}</span>
                  <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                    {m.latencyMs !== null && `${(m.latencyMs / 1000).toFixed(1)} s · `}
                    {m.attempts > 1 && `${m.attempts} tries · `}
                    {when(m.createdAt)}
                  </span>
                </div>
                {m.text && <p className="line-clamp-3 whitespace-pre-wrap">{m.text}</p>}
                {m.media.map((f, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {f.kind} ({f.mimeType}){f.filename && ` ${f.filename}`}
                    {f.note && `: ${f.note}`}
                  </p>
                ))}
                {m.error && <p className="text-xs text-destructive">{m.error}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
