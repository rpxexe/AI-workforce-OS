"use client";

import {
  HANDOFF_TRIGGER_LABELS,
  type CallTransferRecord,
  type ConversationAction,
  type CopilotSuggestion,
  type InboxConversation,
} from "@workforce/shared";
import { ArrowLeft, Bot, CornerDownLeft, Hand, RotateCcw, SendHorizontal, Sparkles, UserRoundCheck, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHANNEL_LABELS, ConversationStatusBadge, formatDuration, timeAgo } from "@/components/inbox/meta";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useApi, useApiQuery } from "@/lib/api";
import { useMembers } from "@/lib/members";
import { cn } from "@/lib/utils";
import { withWorkspace } from "@/lib/workspace";

/** How often an open conversation looks for the customer's new messages. */
const REFRESH_MS = 4000;
const UNASSIGNED = "__queue";

const TRANSFER_RESULTS: Record<CallTransferRecord["status"], (t: CallTransferRecord) => string> = {
  INITIATED: () => "",
  COMPLETED: (t) => `Call transfer answered; talked ${formatDuration(t.talkSec === null ? null : t.talkSec * 1000)}`,
  NO_ANSWER: (t) => `No one answered ${t.to}: call the customer back`,
  BUSY: (t) => `${t.to} was busy: call the customer back`,
  CANCELED: () => "The caller hung up before the transfer was answered: call them back",
  FAILED: (t) => `The call could not be transferred (${t.error ?? "unknown error"}): call the customer back`,
};

type Entry =
  | { kind: "message"; at: string; id: string; role: "USER" | "ASSISTANT" | "AGENT"; content: string; authorId: string | null }
  | { kind: "event"; at: string; id: string; text: string };

/** Messages and handoff events, in time order. */
function timeline(c: InboxConversation, nameOf: (id: string | null) => string): Entry[] {
  const entries: Entry[] = c.messages.map((m) => ({ kind: "message", at: m.createdAt, id: m.id, role: m.role, content: m.content, authorId: m.authorId }));
  for (const h of c.handoffs) {
    entries.push({ kind: "event", at: h.requestedAt, id: `${h.id}:start`, text: `Handed to people: ${HANDOFF_TRIGGER_LABELS[h.trigger]}. ${h.reason}` });
    if (h.acceptedAt) entries.push({ kind: "event", at: h.acceptedAt, id: `${h.id}:accept`, text: `${nameOf(h.assignedTo)} took over` });
    if (h.endedAt)
      entries.push({ kind: "event", at: h.endedAt, id: `${h.id}:end`, text: h.outcome === "resolved" ? "Resolved" : "Handed back to the AI" });
  }
  for (const t of c.transfers) {
    entries.push({ kind: "event", at: t.createdAt, id: `${t.id}:start`, text: `Transferring the call to ${t.to}` });
    if (t.endedAt) entries.push({ kind: "event", at: t.endedAt, id: `${t.id}:end`, text: TRANSFER_RESULTS[t.status](t) });
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}

function Copilot({ suggestions, busy, error, onSuggest, onUse }: {
  suggestions: CopilotSuggestion[];
  busy: boolean;
  error?: string;
  onSuggest: () => void;
  onUse: (s: CopilotSuggestion) => void;
}) {
  const latest = suggestions[0];
  return (
    <Card className="h-fit">
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden />
          AI Copilot
        </CardTitle>
        <Button size="sm" variant="outline" onClick={onSuggest} disabled={busy}>
          {busy ? "Thinking…" : latest ? "Suggest again" : "Suggest"}
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm" aria-live="polite">
        {error && <p role="alert" className="text-destructive">{error}</p>}
        {!latest ? (
          <p className="text-muted-foreground">
            Get a summary of the customer, a suggested reply, what they told us before, the company knowledge that applies, and a next step. Suggestions are never sent on their own.
          </p>
        ) : (
          <>
            {latest.summary && (
              <section className="flex flex-col gap-1">
                <h3 className="font-medium">Customer summary</h3>
                <p className="text-muted-foreground">{latest.summary}</p>
              </section>
            )}
            <section className="flex flex-col gap-2">
              <h3 className="font-medium">Suggested response</h3>
              <p className="rounded-md bg-muted px-3 py-2 whitespace-pre-wrap">{latest.reply}</p>
              <Button size="sm" variant="secondary" className="w-fit" onClick={() => onUse(latest)} disabled={latest.usedInMessageId !== null}>
                <CornerDownLeft aria-hidden />
                {latest.usedInMessageId ? "Used" : "Use this reply"}
              </Button>
            </section>
            {latest.nextAction && (
              <section className="flex flex-col gap-1">
                <h3 className="font-medium">Recommended next action</h3>
                <p className="text-muted-foreground">{latest.nextAction}</p>
              </section>
            )}
            <section className="flex flex-col gap-1">
              <h3 className="font-medium">Relevant memory</h3>
              {latest.memory.length === 0 ? (
                <p className="text-muted-foreground">Nothing remembered about this customer yet.</p>
              ) : (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                  {latest.memory.map((f) => (
                    <div key={f.key} className="contents">
                      <dt className="text-muted-foreground">{f.key.replaceAll("_", " ")}</dt>
                      <dd className="break-words">{f.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </section>
            <section className="flex flex-col gap-1">
              <h3 className="font-medium">Knowledge citations</h3>
              {latest.citations.length === 0 ? (
                <p className="text-muted-foreground">No company knowledge applied.</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {latest.citations.map((c, i) => (
                    <li key={`${c.documentId}:${c.page}:${i}`} className="rounded-md border px-3 py-2">
                      <p className="font-medium">
                        {c.documentName}
                        {c.page !== null && <span className="font-normal text-muted-foreground">, page {c.page}</span>}
                      </p>
                      <p className="line-clamp-3 text-muted-foreground">{c.excerpt}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <p className="text-xs text-muted-foreground">Suggested {timeAgo(latest.createdAt)}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default withWorkspace(function ConversationPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const path = `/workspaces/${workspace.id}/conversations/${id}`;
  const { data, error, reload, setData } = useApiQuery<InboxConversation>(path);
  const { me, list: members, nameOf } = useMembers();
  const [draft, setDraft] = useState("");
  const [suggestionId, setSuggestionId] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [copilotError, setCopilotError] = useState<string>();
  const bottom = useRef<HTMLDivElement>(null);
  const count = data?.messages.length ?? 0;

  useEffect(() => {
    const timer = setInterval(reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [count]);

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={6} />;

  const run = async (label: string, work: () => Promise<InboxConversation>) => {
    setBusy(label);
    setFailure(undefined);
    try {
      setData(await work());
      return true;
    } catch (err) {
      setFailure(err instanceof Error ? err.message : "Something went wrong. Try again.");
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const act = (action: ConversationAction) => run(action.action, () => api<InboxConversation>(path, { method: "PATCH", body: action }));

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const ok = await run("send", () => api<InboxConversation>(`${path}/messages`, { method: "POST", body: { text, suggestionId } }));
    if (ok) {
      setDraft("");
      setSuggestionId(undefined);
    }
  };

  const suggest = async () => {
    setBusy("copilot");
    setCopilotError(undefined);
    try {
      const suggestion = await api<CopilotSuggestion>(`${path}/copilot`, { method: "POST" });
      setData({ ...data, suggestions: [suggestion, ...data.suggestions] });
    } catch (err) {
      setCopilotError(err instanceof Error ? err.message : "The copilot could not answer. Try again.");
    } finally {
      setBusy(undefined);
    }
  };

  const withPeople = data.status === "WAITING_FOR_HUMAN" || data.status === "HUMAN_ACTIVE";
  const mine = data.assignedTo !== null && data.assignedTo === me;
  const who = (e: Extract<Entry, { kind: "message" }>) =>
    e.role === "USER" ? (data.customer?.name ?? "Customer") : e.role === "AGENT" ? nameOf(e.authorId) : `${data.employee.name} (AI)`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link href="/conversations" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" aria-hidden />
          Conversations
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold tracking-tight">{data.customer?.name ?? data.customer?.externalId ?? data.title}</h1>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
              <ConversationStatusBadge status={data.status} />
              <span>{CHANNEL_LABELS[data.channel] ?? data.channel}</span>
              <span>· {data.employee.name}</span>
              {data.customer?.name && <span>· {data.customer.externalId}</span>}
              {withPeople && <span>· {nameOf(data.assignedTo)}</span>}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {data.status === "RESOLVED" ? (
              <Button variant="outline" onClick={() => act({ action: "reopen" })} disabled={busy !== undefined}>
                <RotateCcw aria-hidden />
                Reopen
              </Button>
            ) : (
              <>
                {!(data.status === "HUMAN_ACTIVE" && mine) && (
                  <Button onClick={() => act({ action: "take_over" })} disabled={busy !== undefined}>
                    <Hand aria-hidden />
                    Take over
                  </Button>
                )}
                <Select
                  value={data.assignedTo ?? UNASSIGNED}
                  onValueChange={(v) => act({ action: "assign", userId: v === UNASSIGNED ? null : v })}
                  disabled={busy !== undefined}
                >
                  <SelectTrigger aria-label="Assigned agent" className="w-44">
                    <UserRoundCheck aria-hidden />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>{withPeople ? "Unassigned (queue)" : "Assign to…"}</SelectItem>
                    {data.assignedTo && !members.some((m) => m.id === data.assignedTo) && (
                      <SelectItem value={data.assignedTo}>{nameOf(data.assignedTo)}</SelectItem>
                    )}
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.id === me ? `${m.name} (you)` : m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {withPeople && (
                  <Button variant="outline" onClick={() => act({ action: "return_to_ai" })} disabled={busy !== undefined}>
                    <Bot aria-hidden />
                    Return to AI
                  </Button>
                )}
                <Button variant="outline" onClick={() => act({ action: "resolve" })} disabled={busy !== undefined}>
                  <CircleCheck aria-hidden />
                  Resolve
                </Button>
              </>
            )}
          </div>
        </div>
      </div>

      {failure && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
          {failure}
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div role="log" aria-label="Conversation" className="flex h-[55vh] min-h-64 flex-col gap-3 overflow-y-auto pr-1">
              {timeline(data, nameOf).map((e) =>
                e.kind === "event" ? (
                  <p key={e.id} className="self-center px-4 text-center text-xs text-muted-foreground">
                    {e.text} · {timeAgo(e.at)}
                  </p>
                ) : (
                  <div key={e.id} className={cn("flex flex-col gap-1", e.role === "USER" ? "items-start" : "items-end")}>
                    <span className="px-1 text-xs text-muted-foreground">
                      {who(e)} · {timeAgo(e.at)}
                    </span>
                    <p
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap",
                        e.role === "USER" ? "bg-muted" : e.role === "AGENT" ? "bg-primary text-primary-foreground" : "border bg-background",
                      )}
                    >
                      {e.content}
                    </p>
                  </div>
                ),
              )}
              <div ref={bottom} />
            </div>

            {!data.canReply ? (
              <p className="text-sm text-muted-foreground">
                {data.channel === "voice"
                  ? "This was a phone call: it cannot be continued by text. Call the customer back."
                  : "There is no customer to write to in this conversation."}
              </p>
            ) : (
              <form onSubmit={send} className="flex flex-col gap-2">
                <label htmlFor="agent-message" className="sr-only">
                  Your reply
                </label>
                <div className="flex items-end gap-2">
                  <Textarea
                    id="agent-message"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={`Reply on ${CHANNEL_LABELS[data.channel] ?? data.channel}`}
                    maxLength={4000}
                    rows={2}
                    className="max-h-40 min-h-10"
                  />
                  <Button type="submit" disabled={busy !== undefined || draft.trim() === ""}>
                    <SendHorizontal aria-hidden />
                    {busy === "send" ? "Sending" : "Send"}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {data.status === "HUMAN_ACTIVE"
                    ? `The AI is silent until someone returns the conversation to it.`
                    : "Sending takes the conversation over: the AI stops answering until it is returned to it."}
                  {suggestionId && " Started from the Copilot's suggestion."}
                </p>
              </form>
            )}
          </CardContent>
        </Card>

        <Copilot
          suggestions={data.suggestions}
          busy={busy === "copilot"}
          error={copilotError}
          onSuggest={suggest}
          onUse={(s) => {
            setDraft(s.reply);
            setSuggestionId(s.id);
            document.getElementById("agent-message")?.focus();
          }}
        />
      </div>
    </div>
  );
});
