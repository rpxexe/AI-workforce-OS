// The three kinds of grader. Each reads a conversation as it was stored and returns a score from 0 to
// 100, or "skipped" when there is nothing to judge. None of them changes anything.
import { asksForHuman } from "@workforce/agent-runtime";
import type { AIProvider } from "@workforce/ai-provider";
import {
  EVAL_DIMENSION_LABELS,
  type EmployeeConfig,
  type EvalDimension,
  type EvaluationFinding,
  type EvaluatorConfig,
  type MessageSource,
  type MessageTool,
  type PolicyRule,
} from "@workforce/shared";

export type GradedMessage = {
  role: "USER" | "ASSISTANT" | "AGENT";
  content: string;
  createdAt: Date;
  latencyMs: number | null;
  sources: MessageSource[];
  tools: MessageTool[];
};

export type GradeInput = {
  messages: GradedMessage[];
  handoffs: { trigger: string; requestedAt: Date; acceptedAt: Date | null; endedAt: Date | null }[];
  toolExecutions: { tool: string; status: string; error: string | null }[];
  employee: EmployeeConfig | null;
  /** Knowledge passages from the documents and pages the replies were given. */
  excerpts: { documentName: string; page: number | null; content: string }[];
  /** Regression cases: what a good answer does. */
  expectations: string;
  now: Date;
  /** Built on first use, so a missing AI key fails only the LLM graders. */
  provider: () => AIProvider;
  timeoutMs: number;
};

export type Outcome = {
  status: "scored" | "skipped" | "error";
  score: number | null;
  reason: string;
  findings: EvaluationFinding[];
  usage?: { provider: string; model: string; inputTokens: number; outputTokens: number };
};

const skipped = (reason: string): Outcome => ({ status: "skipped", score: null, reason, findings: [] });
const share = (ok: number, total: number) => Math.round((100 * ok) / total);
const clip = (text: string, max = 200) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

// ---- Deterministic checks ----

export function deterministic(config: EvaluatorConfig<"deterministic">, input: GradeInput): Outcome {
  switch (config.check) {
    case "tool_success": {
      const calls = input.toolExecutions;
      if (calls.length === 0) return skipped("No tools were called.");
      const bad = calls.filter((c) => c.status !== "SUCCEEDED");
      return {
        status: "scored",
        score: share(calls.length - bad.length, calls.length),
        reason: `${calls.length - bad.length} of ${calls.length} tool calls succeeded.`,
        findings: bad.map((c) => ({ message: `${c.tool}: ${c.status.toLowerCase()}${c.error ? ` (${clip(c.error, 160)})` : ""}` })),
      };
    }

    case "reply_latency": {
      const timed = input.messages.filter((m) => m.role === "ASSISTANT" && m.latencyMs !== null);
      if (timed.length === 0) return skipped("No timed replies.");
      const slow = timed.filter((m) => (m.latencyMs ?? 0) > config.maxReplyMs);
      return {
        status: "scored",
        score: share(timed.length - slow.length, timed.length),
        reason: `${timed.length - slow.length} of ${timed.length} replies took ${config.maxReplyMs / 1000} s or less.`,
        findings: slow.map((m) => ({ message: `A reply took ${((m.latencyMs ?? 0) / 1000).toFixed(1)} s`, quote: clip(m.content) })),
      };
    }

    case "escalation_handling": {
      const maxWait = config.maxWaitMinutes * 60_000;
      const findings: EvaluationFinding[] = [];
      let checked = 0;
      const users = input.messages.filter((m) => m.role === "USER");
      // Every request for a person is followed by a handoff before the customer writes again, or people already had it.
      users.forEach((m, i) => {
        if (!asksForHuman(m.content)) return;
        checked++;
        const until = users[i + 1]?.createdAt ?? input.now;
        const handled = input.handoffs.some(
          (h) =>
            (h.requestedAt.getTime() >= m.createdAt.getTime() - 1000 && h.requestedAt <= until) ||
            (h.requestedAt < m.createdAt && (h.endedAt === null || h.endedAt > m.createdAt)),
        );
        if (!handled) findings.push({ message: "The customer asked for a person and was not handed off", quote: clip(m.content) });
      });
      // Every handoff is picked up by a person within the limit (still-open ones inside the limit are not judged yet).
      for (const h of input.handoffs) {
        const waited = (h.acceptedAt ?? h.endedAt ?? input.now).getTime() - h.requestedAt.getTime();
        if (!h.acceptedAt && !h.endedAt && waited <= maxWait) continue;
        checked++;
        if (waited > maxWait)
          findings.push({
            message: h.acceptedAt
              ? `A person took over after ${Math.round(waited / 60_000)} min (limit ${config.maxWaitMinutes} min)`
              : `No person took over the handoff (${h.trigger.replaceAll("_", " ")}) for ${Math.round(waited / 60_000)} min`,
          });
      }
      if (checked === 0) return skipped("Nobody asked for a person and nothing was handed off.");
      return {
        status: "scored",
        score: share(checked - findings.length, checked),
        reason: findings.length === 0 ? "Requests for a person were handed off and picked up in time." : `${findings.length} of ${checked} escalation checks failed.`,
        findings,
      };
    }
  }
}

// ---- Policy rules ----

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole-word, case-insensitive phrase matching. Phrases are escaped, so admins cannot write a slow regex. */
const phraseMatcher = (phrases: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${phrases.map(escape).join("|")})(?![\\p{L}\\p{N}])`, "iu");

const around = (text: string, index: number, length: number) =>
  `${index > 60 ? "…" : ""}${text.slice(Math.max(0, index - 60), index + length + 60)}${index + length + 60 < text.length ? "…" : ""}`;

export function rules(config: EvaluatorConfig<"rule">, input: GradeInput): Outcome {
  const role = config.target === "assistant" ? "ASSISTANT" : "USER";
  const texts = input.messages.filter((m) => m.role === role).map((m) => m.content);
  if (texts.length === 0) return skipped(config.target === "assistant" ? "The employee has not replied." : "The customer wrote nothing.");
  const findings: EvaluationFinding[] = [];
  let broken = 0;
  for (const rule of config.rules as PolicyRule[]) {
    const matcher = phraseMatcher(rule.phrases);
    const hits = texts.map((t) => ({ t, m: matcher.exec(t) })).filter((h) => h.m !== null);
    if (rule.match === "forbid" && hits.length > 0) {
      broken++;
      for (const { t, m } of hits.slice(0, 3)) findings.push({ message: `${rule.label}: "${m?.[0]}"`, quote: around(t, m?.index ?? 0, m?.[0].length ?? 0) });
    } else if (rule.match === "require" && hits.length === 0) {
      broken++;
      findings.push({ message: `${rule.label}: none of the messages said ${rule.phrases.map((p) => `"${p}"`).join(" or ")}` });
    }
  }
  const total = config.rules.length;
  return {
    status: "scored",
    score: share(total - broken, total),
    reason: broken === 0 ? `All ${total} rules held.` : `${broken} of ${total} rules were broken.`,
    findings,
  };
}

// ---- LLM grader ----

export const GRADER_PROMPT = `You are a strict quality reviewer. You read one conversation between a customer and a company's AI employee (sometimes with a human colleague) and grade it on one dimension only.
Answer with one JSON object and nothing else:
{"score": a whole number from 0 to 100, "reason": "one or two sentences explaining the score", "findings": [{"message": "one specific problem", "quote": "the exact words from the conversation it is about"}]}
100 means nothing is wrong on this dimension. List every problem that lowered the score; an empty list only with a score of 100.
If the conversation gives no basis to judge this dimension, answer {"score": null, "reason": "why not"}.`;

const speaker = { USER: "Customer", ASSISTANT: "AI employee", AGENT: "Human colleague" } as const;

/** The transcript as the grader reads it, with the knowledge and tools behind each reply. */
export function transcript(messages: GradedMessage[]) {
  return messages
    .map((m, i) => {
      const notes = [
        m.sources.length > 0 && `knowledge given: ${m.sources.map((s) => `${s.documentName}${s.page ? ` p.${s.page}` : ""}`).join(", ")}`,
        m.tools.length > 0 && `tools: ${m.tools.map((t) => `${t.tool} ${t.status.toLowerCase()}`).join(", ")}`,
      ].filter(Boolean);
      return `[${i + 1}] ${speaker[m.role]}: ${m.content}${notes.length > 0 ? `\n    (${notes.join("; ")})` : ""}`;
    })
    .join("\n\n");
}

function briefing(input: GradeInput, dimension: EvalDimension, rubric: string) {
  const e = input.employee;
  return [
    GRADER_PROMPT,
    `Dimension: ${EVAL_DIMENSION_LABELS[dimension]}\nRubric: ${rubric}`,
    input.expectations && `What a good answer does in this test case: ${input.expectations}`,
    e &&
      `The AI employee's configuration, for the company's facts, tone and rules:\nName: ${e.name}\nRole: ${e.role}\nPersonality: ${e.personality}\nGoals: ${e.goals.join("; ") || "none"}\nInstructions: ${e.systemInstructions.slice(0, 4000)}`,
    input.excerpts.length > 0 &&
      `Company knowledge from the documents the replies were given:\n${input.excerpts.map((x) => `- ${x.documentName}${x.page ? ` p.${x.page}` : ""}: ${x.content}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Reads the grader's JSON; a score outside 0-100 or anything unreadable is an error, not a guess. */
export function parseGrade(text: string): Pick<Outcome, "status" | "score" | "reason" | "findings"> {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json ?? "") as Record<string, unknown>;
  } catch {
    return { status: "error", score: null, reason: "The grader did not answer in the expected format.", findings: [] };
  }
  const reason = typeof o.reason === "string" ? clip(o.reason.trim(), 1000) : "";
  if (o.score === null) return { status: "skipped", score: null, reason: reason || "Nothing to judge.", findings: [] };
  const score = typeof o.score === "number" ? Math.round(o.score) : NaN;
  if (!(score >= 0 && score <= 100)) return { status: "error", score: null, reason: "The grader gave no valid score.", findings: [] };
  const findings = (Array.isArray(o.findings) ? o.findings : [])
    .map((f: unknown) => (f ?? {}) as { message?: unknown; quote?: unknown })
    .filter((f) => typeof f.message === "string" && f.message.trim() !== "")
    .slice(0, 10)
    .map((f) => ({ message: clip(String(f.message).trim(), 300), ...(typeof f.quote === "string" && f.quote.trim() && { quote: clip(f.quote.trim(), 300) }) }));
  return { status: "scored", score, reason, findings };
}

export async function llm(config: EvaluatorConfig<"llm">, dimension: EvalDimension, input: GradeInput): Promise<Outcome> {
  if (!input.messages.some((m) => m.role === "ASSISTANT")) return skipped("The employee has not replied.");
  const provider = input.provider();
  let text = "";
  const usage = { provider: provider.name, model: provider.model, inputTokens: 0, outputTokens: 0 };
  for await (const event of provider.stream({
    system: briefing(input, dimension, config.rubric),
    messages: [{ role: "user", content: `The conversation:\n\n${transcript(input.messages)}` }],
    signal: AbortSignal.timeout(input.timeoutMs),
  })) {
    if (event.type === "text") text += event.text;
    else Object.assign(usage, { inputTokens: event.inputTokens, outputTokens: event.outputTokens });
  }
  return { ...parseGrade(text), usage };
}
