"use client";

import type {
  ChatStreamEvent,
  ConversationDetail,
  ConversationMessage,
  ConversationSummary,
  EmployeeDetail,
} from "@workforce/shared";
import { ArrowLeft, Plus, SendHorizontal } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { EmployeeAvatar, formatDate } from "@/components/employees/meta";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useApi, useApiQuery, useApiStream } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

function Bubble({ role, children, meta }: { role: "USER" | "ASSISTANT"; children: string; meta?: (string | undefined)[] }) {
  const mine = role === "USER";
  return (
    <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      <span className="sr-only">{mine ? "You:" : "Employee:"}</span>
      <p
        className={cn(
          "max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap",
          mine ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {children}
      </p>
      {meta?.map((line) => line && (
        <span key={line} className="max-w-[85%] px-1 text-xs text-muted-foreground tabular-nums">
          {line}
        </span>
      ))}
    </div>
  );
}

const usageOf = (m: ConversationMessage) =>
  m.role === "ASSISTANT" && m.inputTokens !== null && m.outputTokens !== null
    ? `v${m.employeeVersion} · ${m.model} · ${m.inputTokens} in / ${m.outputTokens} out tokens`
    : undefined;

/** "Answered from pricing.pdf (page 2), handbook.docx": the knowledge the reply was given. */
const sourcesOf = (m: ConversationMessage) => {
  const pages = new Map<string, number[]>();
  for (const s of m.sources) pages.set(s.documentName, [...(pages.get(s.documentName) ?? []), ...(s.page === null ? [] : [s.page])]);
  if (pages.size === 0) return undefined;
  const names = [...pages].map(([name, p]) =>
    p.length === 0 ? name : `${name} (page${p.length > 1 ? "s" : ""} ${p.sort((a, b) => a - b).join(", ")})`,
  );
  return `Answered from ${names.join(", ")}`;
};

/** "Tools: calendar_book_meeting (succeeded)": what the employee did while writing the reply. */
const toolsOf = (m: ConversationMessage) =>
  m.tools.length === 0
    ? undefined
    : `Tools: ${m.tools.map((t) => `${t.tool} (${t.status.toLowerCase()})`).join(", ")}`;

export default withWorkspace(function EmployeeChatPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const stream = useApiStream();
  const path = `/workspaces/${workspace.id}/employees/${id}`;

  const employee = useApiQuery<EmployeeDetail>(path);
  const history = useApiQuery<ConversationSummary[]>(`${path}/conversations`);

  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  /** The turn in flight: what was sent, and the reply as it arrives. */
  const [pending, setPending] = useState<{ sent: string; reply: string }>();
  const [draft, setDraft] = useState("");
  /** Who the tester is playing; the employee remembers them across conversations. */
  const [customer, setCustomer] = useState("");
  const [error, setError] = useState<string>();

  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [messages, pending]);

  if (employee.error) return <ErrorState message={employee.error.message} onRetry={employee.reload} />;
  const latest = employee.data?.versions[0];
  if (!employee.data || !latest) return <LoadingState rows={6} />;

  const archived = employee.data.status === "ARCHIVED";
  const busy = pending !== undefined;

  const startNew = () => {
    setConversationId(undefined);
    setMessages([]);
    setError(undefined);
  };

  const open = async (conversation: ConversationSummary) => {
    setError(undefined);
    try {
      const detail = await api<ConversationDetail>(`${path}/conversations/${conversation.id}`);
      setConversationId(detail.id);
      setMessages(detail.messages);
      setCustomer(detail.customer ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open the conversation. Try again.");
    }
  };

  const send = async (event: FormEvent) => {
    event.preventDefault();
    const sent = draft.trim();
    if (!sent || busy) return;
    setDraft("");
    setError(undefined);
    setPending({ sent, reply: "" });

    // Nothing is saved when a turn fails, so the message goes back in the box to send again.
    const fail = (message: string) => {
      setError(message);
      setDraft(sent);
    };
    try {
      let finished = false;
      await stream<ChatStreamEvent>(`${path}/messages`, {
        conversationId,
        message: sent,
        // A conversation keeps the customer it started with.
        customer: conversationId ? undefined : customer.trim() || undefined,
      }, (e) => {
        if (e.type === "text") setPending((p) => p && { ...p, reply: p.reply + e.text });
        else if (e.type === "error") fail(e.error);
        else {
          setConversationId(e.conversation.id);
          setMessages((current) => [...current, ...e.messages]);
          history.setData([e.conversation, ...(history.data ?? []).filter((c) => c.id !== e.conversation.id)]);
        }
        finished ||= e.type !== "text";
      });
      if (!finished) fail("The connection closed before the reply finished. Try again.");
    } catch (err) {
      fail(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setPending(undefined);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href={`/employees/${id}`}
          className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {latest.name}
        </Link>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <EmployeeAvatar avatar={latest.avatar} className="size-11 rounded-xl" />
            <div className="min-w-0">
              <h1 className="truncate text-xl font-semibold tracking-tight">Test chat with {latest.name}</h1>
              <p className="text-sm text-muted-foreground">
                Talks to version {latest.number}, the latest
                {employee.data.publishedVersion === latest.number ? " and live" : ", not yet published"}. Conversations
                here are saved.
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={startNew} disabled={busy}>
            <Plus aria-hidden />
            New conversation
          </Button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[16rem_1fr]">
        <Card className="h-fit">
          <CardHeader>
            <CardTitle>Past conversations</CardTitle>
          </CardHeader>
          <CardContent>
            {history.error ? (
              <p className="text-sm text-destructive">{history.error.message}</p>
            ) : !history.data ? (
              <LoadingState rows={2} />
            ) : history.data.length === 0 ? (
              <p className="text-sm text-muted-foreground">None yet. Send a message to start one.</p>
            ) : (
              <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
                {history.data.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => open(c)}
                      disabled={busy}
                      aria-current={c.id === conversationId}
                      className="flex w-full flex-col rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50 aria-[current=true]:bg-muted"
                    >
                      <span className="truncate">{c.title}</span>
                      <span className="text-xs text-muted-foreground">{formatDate(c.updatedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="flex flex-col gap-4">
            <div
              role="log"
              aria-label="Conversation"
              aria-busy={busy}
              className="flex h-[55vh] min-h-64 flex-col gap-3 overflow-y-auto pr-1"
            >
              {messages.length === 0 && !pending && (
                <p className="m-auto max-w-sm text-center text-sm text-muted-foreground">
                  Send a message to see how {latest.name} answers with its current configuration.
                </p>
              )}
              {messages.map((m) => (
                <Bubble key={m.id} role={m.role} meta={[toolsOf(m), sourcesOf(m), usageOf(m)]}>
                  {m.content}
                </Bubble>
              ))}
              {pending && (
                <>
                  <Bubble role="USER">{pending.sent}</Bubble>
                  <Bubble role="ASSISTANT">{pending.reply || "Thinking…"}</Bubble>
                </>
              )}
              <div ref={bottom} />
            </div>

            {error && (
              <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm">
                {error}
              </p>
            )}

            {archived ? (
              <p className="text-sm text-muted-foreground">Restore this employee to test it.</p>
            ) : !isAdmin ? (
              <p className="text-sm text-muted-foreground">Only organization admins can send test messages.</p>
            ) : (
              <>
                <div className="flex flex-col gap-1.5">
                  <label htmlFor="chat-customer" className="text-sm font-medium">
                    Customer <span className="font-normal text-muted-foreground">(optional)</span>
                  </label>
                  <Input
                    id="chat-customer"
                    value={customer}
                    onChange={(e) => setCustomer(e.target.value)}
                    disabled={conversationId !== undefined || busy}
                    placeholder="Email, phone or any id, e.g. rahul@example.com"
                    maxLength={200}
                    aria-describedby="chat-customer-help"
                    className="sm:max-w-sm"
                  />
                  <p id="chat-customer-help" className="text-xs text-muted-foreground">
                    {conversationId === undefined
                      ? `Chat as this customer and ${latest.name} remembers them in later conversations. Leave empty for an anonymous chat.`
                      : "Fixed for this conversation. Start a new conversation to change it."}
                  </p>
                </div>
                <form onSubmit={send} className="flex items-end gap-2">
                  <label htmlFor="chat-message" className="sr-only">
                    Message
                  </label>
                  <Textarea
                    id="chat-message"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      // Enter sends; Shift+Enter adds a line. Not while an IME is composing.
                      if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        e.currentTarget.form?.requestSubmit();
                      }
                    }}
                    placeholder={`Message ${latest.name}`}
                    maxLength={8000}
                    rows={1}
                    className="max-h-40 min-h-10"
                  />
                  <Button type="submit" disabled={busy || draft.trim() === ""}>
                    <SendHorizontal aria-hidden />
                    {busy ? "Sending" : "Send"}
                  </Button>
                </form>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
});
