"use client";

import {
  CONVERSATION_STATUS_LABELS,
  HANDOFF_TRIGGER_LABELS,
  type ChatStreamEvent,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationStatus,
  type ConversationSummary,
  type ConversationSummaryPage,
  type MessagePage,
  type EmployeeDetail,
  type ToolExecutionRecord,
  defaultEmployeeConfig,
} from "@workforce/shared";
import { ArrowLeft, ArrowUp, Bot, CircleAlert, MessageCircleDashed, Plus, UserRoundCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Checkpoint, MessageSources, MessageTools, useToolExecutions } from "@/components/chat/message-parts";
import { EmployeeAvatar, formatDate } from "@/components/employees/meta";
import { LoadOnView } from "@/components/load-on-view";
import { catchUp, mergeMessages } from "@/lib/messages";
import { ErrorState } from "@/components/states";
import { Skeleton as Skullet } from "skullet/react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Markdown } from "@/components/markdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageFooter, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { useApi, useApiQuery, useApiStream } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: EmployeeDetail = {
  id: "sample",
  status: "ACTIVE",
  publishedVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versions: [
    {
      ...defaultEmployeeConfig("Asia/Kolkata"),
      name: "Sample employee",
      role: "Customer support agent",
      number: 1,
      createdBy: "sample-user",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

// Stands in for the real data so Skullet can draw a skeleton the shape of this list; never shown as data.
const SAMPLE_HISTORY: ConversationSummaryPage = {
  data: Array.from({ length: 4 }, (_, i) => ({
    id: `sample-${i}`,
    title: "Question about an order delivery",
    updatedAt: "2026-01-01T00:00:00.000Z",
    status: "AI_ACTIVE",
  })),
  nextCursor: null,
};

function ChatBubble({
  role,
  children,
  message,
  executions,
}: {
  role: ConversationMessage["role"];
  children: string;
  /** The saved message, for its tools, sources and usage; absent while a turn is in flight. */
  message?: ConversationMessage;
  executions?: Map<string, ToolExecutionRecord>;
}) {
  const mine = role === "USER";
  const usage = message && usageOf(message);
  return (
    <Message align={mine ? "end" : "start"}>
      <MessageContent className="gap-2">
        {role === "AGENT" ? (
          <MessageHeader className="px-1 font-normal">A person from your team</MessageHeader>
        ) : (
          <span className="sr-only">{mine ? "You:" : "Employee:"}</span>
        )}
        {message && <MessageTools tools={message.tools} executions={executions} />}
        {role === "ASSISTANT" ? (
          <Markdown>{children}</Markdown>
        ) : (
          <Bubble align={mine ? "end" : "start"} variant={mine ? "muted" : "outline"}>
            <BubbleContent className="whitespace-pre-wrap">{children}</BubbleContent>
          </Bubble>
        )}
        {message && <MessageSources sources={message.sources} />}
        {usage && <MessageFooter className="px-0 font-normal tabular-nums">{usage}</MessageFooter>}
      </MessageContent>
    </Message>
  );
}

/** Whether message i is the first answer from the other side (AI or a person) than the answer before it. */
function answererChanged(messages: ConversationMessage[], i: number) {
  const role = messages[i].role;
  if (role === "USER") return false;
  const previous = messages.slice(0, i).findLast((m) => m.role !== "USER");
  return previous !== undefined && previous.role !== role;
}

const usageOf = (m: ConversationMessage) =>
  m.role === "ASSISTANT" && m.inputTokens !== null && m.outputTokens !== null
    ? `v${m.employeeVersion} · ${m.model} · ${m.inputTokens} in / ${m.outputTokens} out tokens`
    : undefined;

export default withWorkspace(function EmployeeChatPage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const stream = useApiStream();
  const path = `/workspaces/${workspace.id}/employees/${id}`;

  const employee = useApiQuery<EmployeeDetail>(path);
  const history = useApiQuery<ConversationSummaryPage>(`${path}/conversations`);
  // Pages after the first, loaded as the list scrolls to its end; `cursor` opens the next one (null: no more).
  const [older, setOlder] = useState<{ rows: ConversationSummary[]; cursor: string | null }>();
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderCursor = older ? older.cursor : (history.data?.nextCursor ?? null);
  const loadOlder = async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api<ConversationSummaryPage>(`${path}/conversations?cursor=${encodeURIComponent(olderCursor)}`);
      setOlder((o) => ({ rows: [...(o?.rows ?? []), ...page.data], cursor: page.nextCursor }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load older conversations. Try again.");
    } finally {
      setLoadingOlder(false);
    }
  };

  const [conversationId, setConversationId] = useState<string>();
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  /** The turn in flight: what was sent, and the reply as it arrives. */
  const [pending, setPending] = useState<{ sent: string; reply: string }>();
  const [draft, setDraft] = useState("");
  /** Who the tester is playing; the employee remembers them across conversations. */
  const [customer, setCustomer] = useState("");
  const [error, setError] = useState<string>();
  /** Who answers: while people have the conversation (inbox), the AI keeps quiet and their replies are fetched. */
  const [status, setStatus] = useState<ConversationStatus>();
  const [notice, setNotice] = useState<string>();
  const withPeople = status === "WAITING_FOR_HUMAN" || status === "HUMAN_ACTIVE";
  const executions = useToolExecutions(workspace.id, conversationId, messages);
  /** Opens the page of messages before the ones shown (null: none, or a conversation started here). */
  const [earlierCursor, setEarlierCursor] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** Where the next poll continues; unset until the open conversation's detail was read. */
  const newest = useRef<string>(undefined);
  const openConversation = useRef(conversationId);
  useEffect(() => {
    openConversation.current = conversationId;
  });

  // While people have it, poll for only what is new (following …/messages/new when more than one window came in).
  useEffect(() => {
    if (!withPeople || !conversationId) return;
    const conversationPath = `${path}/conversations/${conversationId}`;
    let active = true;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const after = newest.current;
        const detail = await api<ConversationDetail>(after ? `${conversationPath}?after=${encodeURIComponent(after)}` : conversationPath);
        const rest = detail.caughtUp ? { messages: [], cursor: detail.newestCursor } : await catchUp(api, conversationPath, detail.newestCursor);
        if (!active) return;
        newest.current = rest.cursor;
        if (!after) setEarlierCursor(detail.olderCursor);
        setMessages((current) => mergeMessages(current, [...detail.messages, ...rest.messages]));
        setStatus(detail.status);
      } catch {
        // The next poll tries again.
      } finally {
        polling = false;
      }
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [api, path, conversationId, withPeople]);

  const loadEarlier = async () => {
    if (!earlierCursor || !conversationId || loadingEarlier) return;
    const openId = conversationId;
    setLoadingEarlier(true);
    try {
      const page = await api<MessagePage>(`${path}/conversations/${openId}/messages?cursor=${encodeURIComponent(earlierCursor)}`);
      // Another conversation was opened meanwhile: this page is not its.
      if (openConversation.current !== openId) return;
      setMessages((current) => mergeMessages(page.data, current));
      setEarlierCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load earlier messages. Try again.");
    } finally {
      setLoadingEarlier(false);
    }
  };

  if (employee.error) return <ErrorState message={employee.error.message} onRetry={employee.reload} />;
  const view = (data: EmployeeDetail) => {
    const latest = data.versions[0];
    if (!latest) return null;
    const archived = data.status === "ARCHIVED";
    const busy = pending !== undefined;

    const startNew = () => {
      setConversationId(undefined);
      setMessages([]);
      setEarlierCursor(null);
      newest.current = undefined;
      setError(undefined);
      setStatus(undefined);
      setNotice(undefined);
    };

    const open = async (conversation: ConversationSummary) => {
      setError(undefined);
      try {
        const detail = await api<ConversationDetail>(`${path}/conversations/${conversation.id}`);
        setConversationId(detail.id);
        setMessages(detail.messages);
        setEarlierCursor(detail.olderCursor);
        newest.current = detail.newestCursor;
        setCustomer(detail.customer ?? "");
        setStatus(detail.status);
        setNotice(undefined);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not open the conversation. Try again.");
      }
    };

    const send = async () => {
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
          else if (e.type === "held") {
            setMessages((current) => [...current, e.message]);
            setStatus(e.conversation.status);
          } else {
            setConversationId(e.conversation.id);
            setStatus(e.conversation.status);
            setNotice(e.handoff && `Handed to people: ${HANDOFF_TRIGGER_LABELS[e.handoff.trigger]}. ${e.handoff.reason}`);
            setMessages((current) => [...current, ...e.messages]);
            history.setData({ data: [e.conversation, ...(history.data?.data ?? []).filter((c) => c.id !== e.conversation.id)], nextCursor: history.data?.nextCursor ?? null });
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
      // Desktop: fill the window under the app header (3.5rem) and its padding (3rem), so only the panels scroll.
      <div className="flex flex-col gap-4 lg:h-[calc(100dvh-6.5rem)]">
        <div className="flex shrink-0 flex-col gap-4">
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
                  {data.publishedVersion === latest.number ? " and live" : ", not yet published"}. Conversations
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

        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[16rem_minmax(0,1fr)]">
          <Card className="h-fit lg:h-auto lg:min-h-0 lg:overflow-y-auto">
            <CardHeader>
              <CardTitle>Past conversations</CardTitle>
            </CardHeader>
            <CardContent>
              {history.error ? (
                <p className="text-sm text-destructive">{history.error.message}</p>
              ) : (
                <Skullet data={history.data} sample={SAMPLE_HISTORY} id="employee-chat-history" label="Loading past conversations">
                  {(first) => {
                    // A chat that moved to the top (a new message) is shown there, not again further down.
                    const onTop = new Set(first.data.map((c) => c.id));
                    const conversations = [...first.data, ...(older?.rows.filter((c) => !onTop.has(c.id)) ?? [])];
                    return conversations.length === 0 ? (
                      <p className="text-sm text-muted-foreground">None yet. Send a message to start one.</p>
                    ) : (
                      <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto lg:max-h-none">
                        {conversations.map((c) => (
                          <li key={c.id}>
                            <Button
                              type="button"
                              variant="ghost"
                              onClick={() => open(c)}
                              disabled={busy}
                              aria-current={c.id === conversationId}
                              className="h-auto w-full flex-col items-start gap-0 px-2 py-1.5 text-left font-normal aria-[current=true]:bg-muted"
                            >
                              <span className="w-full truncate">{c.title}</span>
                              <span className="text-xs text-muted-foreground">{formatDate(c.updatedAt)}</span>
                            </Button>
                          </li>
                        ))}
                        {olderCursor && (
                          <li>
                            <LoadOnView onView={loadOlder} loading={loadingOlder} label="Loading older conversations" />
                          </li>
                        )}
                      </ul>
                    );
                  }}
                </Skullet>
              )}
            </CardContent>
          </Card>

          <Card className="h-[70vh] min-h-96 gap-0 overflow-hidden py-0 lg:h-auto lg:min-h-0">
            {messages.length === 0 && !pending ? (
              <Empty className="min-h-0 flex-1">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <MessageCircleDashed />
                  </EmptyMedia>
                  <EmptyTitle>No messages yet</EmptyTitle>
                  <EmptyDescription>Send a message to see how {latest.name} answers with its current configuration.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <MessageScrollerProvider autoScroll>
                <MessageScroller className="min-h-0 flex-1">
                  <MessageScrollerViewport>
                    <MessageScrollerContent role="log" aria-label="Conversation" aria-busy={busy || loadingEarlier} className="gap-4 p-4">
                      {/* Earlier pages are prepended; the viewport keeps what you were reading in place. */}
                      {earlierCursor && <LoadOnView onView={loadEarlier} loading={loadingEarlier} label="Loading earlier messages" />}
                      {messages.map((m, i) => {
                        const switched = answererChanged(messages, i);
                        return (
                          // Your turn is the scroll anchor, so a new question settles near the top and the reply streams under it.
                          <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === "USER"}>
                            {switched && (
                              <Checkpoint icon={m.role === "AGENT" ? UserRoundCheck : Bot}>
                                {m.role === "AGENT" ? "A person from your team took over" : "Back to the AI"}
                              </Checkpoint>
                            )}
                            <ChatBubble role={m.role} message={m} executions={executions}>
                              {m.content}
                            </ChatBubble>
                          </MessageScrollerItem>
                        );
                      })}
                      {pending && (
                        <>
                          <MessageScrollerItem messageId="pending-sent" scrollAnchor>
                            <ChatBubble role="USER">{pending.sent}</ChatBubble>
                          </MessageScrollerItem>
                          <MessageScrollerItem messageId="pending-reply">
                            <ChatBubble role="ASSISTANT">{pending.reply || "Thinking…"}</ChatBubble>
                          </MessageScrollerItem>
                        </>
                      )}
                    </MessageScrollerContent>
                  </MessageScrollerViewport>
                  <MessageScrollerButton />
                </MessageScroller>
              </MessageScrollerProvider>
            )}

            <div className="flex shrink-0 flex-col gap-3 border-t p-3">
              {(withPeople || notice) && conversationId && (
                <Alert role="status">
                  <AlertDescription>
                    {notice && <>{notice} </>}
                    {withPeople && (
                      <>
                        {CONVERSATION_STATUS_LABELS[status!]}: the AI does not answer until someone returns the conversation to it.{" "}
                        <Link href={`/conversations/${conversationId}`} className="underline underline-offset-2">
                          Open in the inbox
                        </Link>
                      </>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              {error && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {archived ? (
                <p className="text-sm text-muted-foreground">Restore this employee to test it.</p>
              ) : !isAdmin ? (
                <p className="text-sm text-muted-foreground">Only organization admins can send test messages.</p>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="chat-customer" className="gap-1">
                      Customer <span className="font-normal text-muted-foreground">(optional)</span>
                    </Label>
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
<form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <InputGroup>
                    <InputGroupTextarea
                      id="chat-message"
                      aria-label="Message"
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
                      className="max-h-40 min-h-10 px-3 py-2.5"
                    />
                    <InputGroupAddon align="inline-end" className="self-end">
                      <InputGroupButton
                        type="submit"
                        size="icon-sm"
                        variant="default"
                        className="ml-auto rounded-full"
                        disabled={busy || draft.trim() === ""}
                        aria-label="Send"
                      >
                        {busy ? <Spinner /> : <ArrowUp aria-hidden />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </form>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
    );
  };

  return (
    <Skullet data={employee.data} sample={SAMPLE} id="employee-chat" label="Loading test chat">
      {view}
    </Skullet>
  );
});
