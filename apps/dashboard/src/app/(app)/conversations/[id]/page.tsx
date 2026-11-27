"use client";

import {
  HANDOFF_TRIGGER_LABELS,
  type CallTransferRecord,
  type ConversationAction,
  type ConversationMessage,
  type CopilotSuggestion,
  type InboxConversation,
  type MessagePage,
} from "@workforce/shared";
import { ArrowLeft, ArrowUp, Bot, Phone, PhoneForwarded, type LucideIcon, CornerDownLeft, Hand, RotateCcw, Sparkles, UserRoundCheck, CircleCheck } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { Checkpoint, MessageSources, MessageTools, Suggestions, useToolExecutions } from "@/components/chat/message-parts";
import { ConversationInsightCard } from "@/components/inbox/conversation-insight";
import { LoadOnView } from "@/components/load-on-view";
import { CHANNEL_LABELS, ConversationStatusBadge, formatDuration, timeAgo } from "@/components/inbox/meta";
import { ErrorState } from "@/components/states";
import { Skeleton as Skullet } from "skullet/react";
import { Button } from "@/components/ui/button";
import { ConversationQuality } from "@/components/quality/conversation-quality";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupTextarea } from "@/components/ui/input-group";
import { Item, ItemContent, ItemDescription } from "@/components/ui/item";
import { Markdown } from "@/components/markdown";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi, useApiQuery } from "@/lib/api";
import { useMembers } from "@/lib/members";
import { catchUp, mergeMessages } from "@/lib/messages";
import { withWorkspace } from "@/lib/workspace";
import { toast } from "sonner";

/** How often an open conversation looks for the customer's new messages. */
const REFRESH_MS = 4000;
const UNASSIGNED = "__queue";
/** At most one typing ping every few seconds; the API counts a ping as typing for 6 s. */
const TYPING_PING_MS = 3000;
const NO_MESSAGES: ConversationMessage[] = [];

/** The success toast for each conversation action. */
const ACTION_DONE: Record<ConversationAction["action"], string> = {
  take_over: "You took over",
  assign: "Conversation assigned",
  return_to_ai: "Handed back to the AI",
  resolve: "Conversation resolved",
  reopen: "Conversation reopened",
};

const TRANSFER_RESULTS: Record<CallTransferRecord["status"], (t: CallTransferRecord) => string> = {
  INITIATED: () => "",
  COMPLETED: (t) => `Call transfer answered; talked ${formatDuration(t.talkSec === null ? null : t.talkSec * 1000)}`,
  NO_ANSWER: (t) => `No one answered ${t.to}: call the customer back`,
  BUSY: (t) => `${t.to} was busy: call the customer back`,
  CANCELED: () => "The caller hung up before the transfer was answered: call them back",
  FAILED: (t) => `The call could not be transferred (${t.error ?? "unknown error"}): call the customer back`,
};

const SAMPLE_TEXTS = [
  "Hi, I ordered a pair of shoes last week and the tracking page has not changed in three days.",
  "Sorry about the wait. Your order shipped on Monday and is with the courier; it should arrive by Friday.",
  "Okay. Can I change the delivery address to my office?",
  "Yes. Send me the new address and I will update it before the courier's next attempt.",
  "Thanks, that helps a lot.",
];

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: InboxConversation = {
  id: "sample",
  title: "Order delivery question",
  channel: "web",
  status: "AI_ACTIVE",
  assignedTo: null,
  employee: { id: "sample-employee", name: "Support assistant" },
  customer: { id: "sample-customer", externalId: "customer@example.com", name: "Sample customer" },
  updatedAt: "2026-01-01T00:00:00.000Z",
  messages: SAMPLE_TEXTS.map((content, i): ConversationMessage => ({
    id: `sample-${i}`,
    role: i % 2 === 0 ? "USER" : "ASSISTANT",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    authorId: null,
    employeeVersion: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    sources: [],
    tools: [],
  })),
  olderCursor: null,
  newestCursor: "",
  caughtUp: true,
  handoffs: [],
  suggestions: [],
  transfers: [],
  canReply: true,
  insight: {
    primaryLanguage: "en",
    languages: [{ language: "en", messages: 3 }],
    switches: 0,
    codeSwitchedMessages: 0,
    messages: [],
    sentiment: "neutral",
    sentimentIndicators: [],
    intent: "order_status",
    intents: ["order_status", "delivery"],
    entities: [],
    resolution: "open",
    resolutionSignals: [],
    escalation: { escalated: false, handoffs: 0, triggers: [], signals: [] },
  },
};

type Entry =
  | ({ kind: "message"; at: string } & Pick<ConversationMessage, "id" | "role" | "content" | "authorId" | "sources" | "tools">)
  | { kind: "event"; at: string; id: string; text: string; icon: LucideIcon };

/** Messages and handoff events, in time order. While earlier messages are still to load, events before the first loaded one wait with them. */
function timeline(c: InboxConversation, nameOf: (id: string | null) => string, complete: boolean): Entry[] {
  const entries: Entry[] = c.messages.map((m) => ({
    kind: "message",
    at: m.createdAt,
    id: m.id,
    role: m.role,
    content: m.content,
    authorId: m.authorId,
    sources: m.sources,
    tools: m.tools,
  }));
  for (const h of c.handoffs) {
    entries.push({ kind: "event", at: h.requestedAt, id: `${h.id}:start`, icon: Hand, text: `Handed to people: ${HANDOFF_TRIGGER_LABELS[h.trigger]}. ${h.reason}` });
    if (h.acceptedAt) entries.push({ kind: "event", at: h.acceptedAt, id: `${h.id}:accept`, icon: UserRoundCheck, text: `${nameOf(h.assignedTo)} took over` });
    if (h.endedAt)
      entries.push({
        kind: "event",
        at: h.endedAt,
        id: `${h.id}:end`,
        icon: h.outcome === "resolved" ? CircleCheck : Bot,
        text: h.outcome === "resolved" ? "Resolved" : "Handed back to the AI",
      });
  }
  for (const t of c.transfers) {
    entries.push({ kind: "event", at: t.createdAt, id: `${t.id}:start`, icon: PhoneForwarded, text: `Transferring the call to ${t.to}` });
    if (t.endedAt) entries.push({ kind: "event", at: t.endedAt, id: `${t.id}:end`, icon: Phone, text: TRANSFER_RESULTS[t.status](t) });
  }
  const from = complete ? "" : (c.messages[0]?.createdAt ?? "");
  return entries.filter((e) => e.at >= from).sort((a, b) => a.at.localeCompare(b.at));
}

function Copilot({ suggestions, busy, onSuggest, onUse }: {
  suggestions: CopilotSuggestion[];
  busy: boolean;
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
                    <Item key={`${c.documentId}:${c.page}:${i}`} variant="outline" asChild>
                      <li>
                        <ItemContent className="gap-0">
                          <p className="font-medium">
                            {c.documentName}
                            {c.page !== null && <span className="font-normal text-muted-foreground">, page {c.page}</span>}
                          </p>
                          <ItemDescription className="line-clamp-3">{c.excerpt}</ItemDescription>
                        </ItemContent>
                      </li>
                    </Item>
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
  // The customer sees your first name and "typing" in the web chat widget.
  const myName = useUser().user?.firstName ?? "";
  const lastTypingPing = useRef(0);
  const typing = () => {
    const now = Date.now();
    if (now - lastTypingPing.current < TYPING_PING_MS) return;
    lastTypingPing.current = now;
    api(`${path}/typing`, { method: "POST", body: { name: myName }, toast: false }).catch(() => {});
  };
  const [suggestionId, setSuggestionId] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [panel, setPanel] = useState("copilot");
  // The transcript as loaded: the first window, earlier pages (scrolling to the top), and what polls and replies
  // added. `older` opens the page before it (null: complete); `newest` is where the next poll continues.
  const [thread, setThread] = useState<{ id: string; messages: ConversationMessage[]; older: string | null; newest: string }>();
  const [shown, setShown] = useState(data);
  if (data !== shown) {
    setShown(data);
    if (data)
      setThread((t) =>
        t?.id === data.id
          ? { ...t, messages: mergeMessages(t.messages, data.messages) }
          : { id: data.id, messages: data.messages, older: data.olderCursor, newest: data.newestCursor },
      );
  }
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadOlder = async () => {
    if (!thread?.older || loadingOlder) return;
    const { id: conversationId, older } = thread;
    setLoadingOlder(true);
    try {
      const page = await api<MessagePage>(`${path}/messages?cursor=${encodeURIComponent(older)}`);
      setThread((t) => (t?.id === conversationId ? { ...t, messages: mergeMessages(page.data, t.messages), older: page.nextCursor } : t));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load earlier messages.");
    } finally {
      setLoadingOlder(false);
    }
  };
  const messages = data && thread?.id === data.id ? thread.messages : (data?.messages ?? NO_MESSAGES);
  const executions = useToolExecutions(workspace.id, data?.id, messages);

  // Each poll asks only for what is new since the newest message it has (following …/messages/new when more than one
  // window came in), plus the conversation's state. The cached detail keeps its first window, so a later visit can
  // still page back from it.
  const latest = useRef({ thread, data });
  useEffect(() => {
    latest.current = { thread, data };
  });
  useEffect(() => {
    let polling = false;
    const timer = setInterval(async () => {
      const { thread: t } = latest.current;
      if (polling || !t || t.id !== latest.current.data?.id) return;
      polling = true;
      try {
        const d = await api<InboxConversation>(`${path}?after=${encodeURIComponent(t.newest)}`);
        const rest = d.caughtUp ? { messages: [], cursor: d.newestCursor } : await catchUp(api, path, d.newestCursor);
        setThread((x) => (x?.id === d.id ? { ...x, messages: mergeMessages(x.messages, [...d.messages, ...rest.messages]), newest: rest.cursor } : x));
        const shownNow = latest.current.data;
        if (shownNow?.id === d.id)
          setData({ ...d, messages: shownNow.messages, olderCursor: shownNow.olderCursor, newestCursor: shownNow.newestCursor, caughtUp: true });
      } catch {
        // The next poll tries again.
      } finally {
        polling = false;
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [api, path, setData]);

  if (error && !data) return <ErrorState message={error.message} onRetry={reload} />;
  const view = (data: InboxConversation) => {
    const run = async (label: string, work: () => Promise<InboxConversation>) => {
      setBusy(label);
      try {
        setData(await work());
        return true;
      } catch {
        // The toast in useApi shows why it failed.
        return false;
      } finally {
        setBusy(undefined);
      }
    };
    const act = (action: ConversationAction) => {
      const toast = action.action === "assign" && action.userId === null ? "Returned to the queue" : ACTION_DONE[action.action];
      return run(action.action, () => api<InboxConversation>(path, { method: "PATCH", body: action, toast }));
    };

    const send = async () => {
      const text = draft.trim();
      if (!text || busy) return;
      // No success toast: the reply appears in the thread. A failure still toasts and keeps the draft.
      const ok = await run("send", () => api<InboxConversation>(`${path}/messages`, { method: "POST", body: { text, suggestionId, name: myName } }));
      if (ok) {
        setDraft("");
        setSuggestionId(undefined);
      }
    };

    const suggest = async () => {
      setBusy("copilot");
      try {
        const suggestion = await api<CopilotSuggestion>(`${path}/copilot`, {
          method: "POST",
          toast: { loading: "Asking the Copilot…", success: "Suggestion ready" },
        });
        setData({ ...data, suggestions: [suggestion, ...data.suggestions] });
      } catch {
        // The toast in useApi shows why it failed.
      } finally {
        setBusy(undefined);
      }
    };

    const withPeople = data.status === "WAITING_FOR_HUMAN" || data.status === "HUMAN_ACTIVE";
    // Every earlier message is loaded (or there were none).
    const complete = thread?.id !== data.id || thread.older === null;
    const latestSuggestion = data.suggestions[0];
    const mine = data.assignedTo !== null && data.assignedTo === me;
    const who = (e: Extract<Entry, { kind: "message" }>) =>
      e.role === "USER" ? (data.customer?.name ?? "Customer") : e.role === "AGENT" ? nameOf(e.authorId) : `${data.employee.name} (AI)`;

    return (
      // Desktop: fill the window under the app header (3.5rem) and its padding (3rem), so only the panels scroll.
      <div className="flex flex-col gap-4 lg:h-[calc(100dvh-6.5rem)]">
        <div className="flex shrink-0 flex-col gap-4">
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

        <div className="grid gap-4 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <Card className="h-[70vh] min-h-96 gap-0 overflow-hidden py-0 lg:h-auto lg:min-h-0">
            <MessageScrollerProvider autoScroll>
              <MessageScroller className="min-h-0 flex-1">
                {/* Earlier pages are prepended; the viewport keeps what you were reading in place. */}
                <MessageScrollerViewport preserveScrollOnPrepend>
                  <MessageScrollerContent role="log" aria-label="Conversation" aria-busy={loadingOlder} className="gap-4 p-4">
                    {complete ? null : <LoadOnView onView={loadOlder} loading={loadingOlder} label="Loading earlier messages" />}
                    {timeline({ ...data, messages: thread?.id === data.id ? thread.messages : data.messages }, nameOf, complete).map((e) => (
                      // The customer's turn is the scroll anchor, so a new question settles near the top.
                      <MessageScrollerItem key={e.id} messageId={e.id} scrollAnchor={e.kind === "message" && e.role === "USER"}>
                        {e.kind === "event" ? (
                          <Checkpoint icon={e.icon}>
                            {e.text} · {timeAgo(e.at)}
                          </Checkpoint>
                        ) : (
                          // Inbox view: the customer on the left, our side (the AI and the team) on the right.
                          <Message align={e.role === "USER" ? "start" : "end"}>
                            <MessageContent className="gap-2">
                              <MessageHeader className="px-1 font-normal">
                                {who(e)} · {timeAgo(e.at)}
                              </MessageHeader>
                              <MessageTools tools={e.tools} executions={executions} />
                              <Bubble
                                align={e.role === "USER" ? "start" : "end"}
                                variant={e.role === "USER" ? "muted" : e.role === "AGENT" ? "default" : "outline"}
                              >
                                {e.role === "ASSISTANT" ? (
                                  <BubbleContent>
                                    <Markdown>{e.content}</Markdown>
                                  </BubbleContent>
                                ) : (
                                  <BubbleContent className="whitespace-pre-wrap">{e.content}</BubbleContent>
                                )}
                              </Bubble>
                              <MessageSources sources={e.sources} />
                            </MessageContent>
                          </Message>
                        )}
                      </MessageScrollerItem>
                    ))}
                  </MessageScrollerContent>
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
            </MessageScrollerProvider>

            <div className="shrink-0 border-t p-3">
              {!data.canReply ? (
                <p className="text-sm text-muted-foreground">
                  {data.channel === "voice"
                    ? "This was a phone call: it cannot be continued by text. Call the customer back."
                    : "There is no customer to write to in this conversation."}
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <Suggestions
                    items={latestSuggestion && latestSuggestion.usedInMessageId === null && draft !== latestSuggestion.reply ? [latestSuggestion.reply] : []}
                    disabled={busy !== undefined}
                    onPick={(reply) => {
                      // Fills the box rather than sending: a person reads and edits a Copilot reply first.
                      setDraft(reply);
                      setSuggestionId(latestSuggestion?.id);
                      document.getElementById("agent-message")?.focus();
                    }}
                  />
                  <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <InputGroup>
                    <InputGroupTextarea
                      id="agent-message"
                      aria-label="Your reply"
                      value={draft}
                      onChange={(e) => {
                        setDraft(e.target.value);
                        if (e.target.value.trim()) typing();
                      }}
                      onKeyDown={(e) => {
                        // Enter sends; Shift+Enter adds a line. Not while an IME is composing.
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                      placeholder={`Reply on ${CHANNEL_LABELS[data.channel] ?? data.channel}`}
                      maxLength={4000}
                      rows={1}
                      className="max-h-40 min-h-10 px-3 py-2.5"
                    />
                    <InputGroupAddon align="inline-end" className="self-end">
                      <InputGroupButton
                        type="submit"
                        size="icon-sm"
                        variant="default"
                        className="ml-auto rounded-full"
                        disabled={busy !== undefined || draft.trim() === ""}
                        aria-label="Send"
                      >
                        {busy === "send" ? <Spinner /> : <ArrowUp aria-hidden />}
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </form>
                  <p className="text-xs text-muted-foreground">
                    {data.status === "HUMAN_ACTIVE"
                      ? `The AI is silent until someone returns the conversation to it.`
                      : "Sending takes the conversation over: the AI stops answering until it is returned to it."}
                    {suggestionId && " Started from the Copilot's suggestion."}
                  </p>
                </div>
              )}
            </div>
          </Card>

          <Tabs value={panel} onValueChange={setPanel} className="lg:min-h-0">
            <TabsList className="w-full">
              <TabsTrigger value="copilot">Copilot</TabsTrigger>
              <TabsTrigger value="insights">Insights</TabsTrigger>
              <TabsTrigger value="quality">Quality</TabsTrigger>
            </TabsList>
            <TabsContent value="copilot" className="lg:min-h-0 lg:overflow-y-auto">
              <Copilot
                suggestions={data.suggestions}
                busy={busy === "copilot"}
                onSuggest={suggest}
                onUse={(s) => {
                  setDraft(s.reply);
                  setSuggestionId(s.id);
                  document.getElementById("agent-message")?.focus();
                }}
              />
            </TabsContent>
            <TabsContent value="insights" className="lg:min-h-0 lg:overflow-y-auto">
              <ConversationInsightCard insight={data.insight} />
            </TabsContent>
            <TabsContent value="quality" className="lg:min-h-0 lg:overflow-y-auto">
              {/* Fetches by conversation id: only for the real conversation, never the sample. */}
              {data !== SAMPLE && <ConversationQuality workspaceId={workspace.id} conversationId={data.id} title={data.title} />}
            </TabsContent>
          </Tabs>
        </div>
      </div>
    );
  };

  return (
    <Skullet data={data} sample={SAMPLE} id="conversation-detail" label="Loading conversation">
      {view}
    </Skullet>
  );
});
