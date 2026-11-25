"use client";

// shadcn AI Elements patterns for a reply's extras: Sources and Tool (both on Trace), and Suggestion (on Button).
import type { MessageSource, MessageTool, ToolExecutionRecord, ToolExecutionStatus } from "@workforce/shared";
import { BookOpen, FileText, Wrench, type LucideIcon } from "lucide-react";
import { useEffect, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block";
import { Marker, MarkerContent } from "@/components/ui/marker";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { useApiQuery } from "@/lib/api";

/** "Used 3 sources", opening into each document (and page) the reply was given. */
export function MessageSources({ sources }: { sources: MessageSource[] }) {
  // The same page can be matched more than once.
  const unique = sources.filter(
    (s, i, all) => all.findIndex((o) => o.documentId === s.documentId && o.page === s.page) === i,
  );
  if (unique.length === 0) return null;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine>
            <TraceIcon>
              <BookOpen />
            </TraceIcon>
            <TraceTitle>
              Used {unique.length} source{unique.length > 1 ? "s" : ""}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <Trace>
            {unique.map((s) => (
              <TraceLine key={`${s.documentId}:${s.page}`}>
                <TraceIcon>
                  <FileText />
                </TraceIcon>
                <TraceTitle>
                  {s.documentName}
                  {s.page !== null && `, page ${s.page}`}
                  <span className="text-muted-foreground"> · {s.sourceName}</span>
                </TraceTitle>
              </TraceLine>
            ))}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

const VERB: Record<ToolExecutionStatus, string> = {
  SUCCEEDED: "Ran",
  FAILED: "Failed to run",
  DENIED: "Not allowed to run",
  INVALID: "Gave bad input to",
};

const json = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** Each tool the employee called for a reply; opens into its input and output when the record is loaded. */
export function MessageTools({ tools, executions }: { tools: MessageTool[]; executions?: Map<string, ToolExecutionRecord> }) {
  if (tools.length === 0) return null;
  return (
    <Trace>
      {tools.map((t) => {
        const record = executions?.get(t.executionId);
        const line = (
          <TraceLine status={t.status === "SUCCEEDED" ? undefined : "error"}>
            <TraceIcon>
              <Wrench />
            </TraceIcon>
            <TraceTitle>
              {VERB[t.status]} {t.tool}
            </TraceTitle>
          </TraceLine>
        );
        if (!record) return <div key={t.executionId}>{line}</div>;
        return (
          <TraceCollapsible key={t.executionId}>
            <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
            <TraceCollapsibleContent className="flex flex-col gap-2">
              <CodeBlock size="sm">
                <CodeBlockContent wrap className="max-h-48">
                  {`Input\n${json(record.input)}`}
                </CodeBlockContent>
              </CodeBlock>
              <CodeBlock size="sm">
                <CodeBlockContent wrap className="max-h-64">
                  {record.error ? `Error\n${record.error}` : `Output\n${json(record.output)}`}
                </CodeBlockContent>
              </CodeBlock>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        );
      })}
    </Trace>
  );
}

/** The tool records of one conversation, by execution id; fetched once a message used a tool, again when more do. */
export function useToolExecutions(workspaceId: string, conversationId: string | undefined, messages: { tools: MessageTool[] }[]) {
  const calls = messages.reduce((n, m) => n + m.tools.length, 0);
  const path = calls > 0 && conversationId ? `/workspaces/${workspaceId}/tool-executions?conversationId=${conversationId}` : null;
  const { data, reload } = useApiQuery<ToolExecutionRecord[]>(path);
  useEffect(() => {
    if (calls > 0) reload();
  }, [calls, reload]);
  return useMemo(() => (data ? new Map(data.map((r) => [r.id, r])) : undefined), [data]);
}

/**
 * A point in the thread where who answers changed (AI to a person, back, a call transfer): the AI Elements
 * Checkpoint pattern. No Restore button: a live customer conversation cannot be rewound.
 */
export function Checkpoint({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <Marker variant="separator" role="note">
      <MarkerContent className="inline-flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5" aria-hidden />
        {children}
      </MarkerContent>
    </Marker>
  );
}

/** A row of one-click prompts above the reply box; the label is what gets used. */
export function Suggestions({ items, onPick, disabled }: { items: string[]; onPick: (text: string) => void; disabled?: boolean }) {
  if (items.length === 0) return null;
  return (
    <div className="flex scroll-fade-x scrollbar-none gap-2 overflow-x-auto overscroll-x-contain">
      {items.map((text) => (
        <Button
          key={text}
          type="button"
          variant="outline"
          size="sm"
          className="max-w-80 shrink-0"
          title={text}
          disabled={disabled}
          onClick={() => onPick(text)}
        >
          <span className="truncate">{text}</span>
        </Button>
      ))}
    </div>
  );
}
