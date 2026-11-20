// Continuous improvement, the analysis half: failure patterns in production evaluations -> a model proposes a
// change to the employee's instructions -> an ImprovementSuggestion with its evidence. It writes suggestions
// only: creating the version, testing, approving and rolling out are people's actions (apps/api/src/improvements.ts).
import { configOf } from "@workforce/agent-runtime";
import type { AIProvider, Route } from "@workforce/ai-provider";
import { Prisma, prisma } from "@workforce/database";
import {
  EVAL_DIMENSION_LABELS,
  employeeConfigSchema,
  IMPROVABLE_FIELDS,
  type EmployeeConfig,
  type EvalDimension,
  type EvaluationFinding,
  type KpiComparison,
  type ProposedChange,
  type SuggestionEvidence,
} from "@workforce/shared";

type Scope = { organizationId: string; workspaceId: string };

/** A pattern: at least this many failures of one evaluator on one live version, and at least this share of its results. */
export const PATTERN_MIN_FAILURES = 3;
export const PATTERN_MIN_RATE = 0.2;
const EXAMPLES = 8;
/** Suggestions written per analysis, so one run's model calls stay bounded. */
const MAX_PER_RUN = 5;

export const IMPROVE_PROMPT = `You improve the configuration of a company's AI employee after its conversations kept failing one quality check.
You get the employee's current configuration, the quality check, and examples of the failures with the reviewer's reasons and quotes.
Propose the smallest change to the employee's instructions, personality or goals that would prevent these failures without changing anything else it does well.
Answer with one JSON object and nothing else:
{"title": "a short name for the change, under 80 characters", "summary": "what you changed and why, in two or three sentences", "systemInstructions": "the complete new instructions", "personality": "the complete new personality", "goals": ["the complete new list of goals"]}
Include only the fields you change, each with its complete new value. Keep every existing instruction that is not part of the problem, word for word.
Never invent facts, prices or policies the company has not given. When the failures come from missing information, tell the employee to say it does not know and offer to connect a person.
If no change to these fields would help (for example the failures come from a broken tool or missing knowledge documents), answer {"title": null, "summary": "why not"}.`;

export type Proposal = { title: string; change: ProposedChange } | { skipped: string };

/** Reads the model's proposal; only the improvable fields are taken, and the result must be a valid, different configuration. */
export function parseProposal(text: string, base: EmployeeConfig): Proposal {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(/\{[\s\S]*\}/.exec(text)?.[0] ?? "") as Record<string, unknown>;
  } catch {
    return { skipped: "The model did not answer in the expected format." };
  }
  const summary = typeof o.summary === "string" ? o.summary.trim().slice(0, 1000) : "";
  if (typeof o.title !== "string" || !o.title.trim()) return { skipped: summary || "The model proposed no change." };
  const fields: ProposedChange["fields"] = {};
  for (const key of IMPROVABLE_FIELDS) if (key in o) Object.assign(fields, { [key]: o[key] });
  const parsed = employeeConfigSchema.safeParse({ ...base, ...fields });
  if (!parsed.success) return { skipped: `The proposed change is not a valid configuration: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  // Keep only fields that really change.
  const changed = Object.fromEntries(
    IMPROVABLE_FIELDS.filter((k) => k in fields && JSON.stringify(parsed.data[k]) !== JSON.stringify(base[k])).map((k) => [k, parsed.data[k]]),
  ) as ProposedChange["fields"];
  if (Object.keys(changed).length === 0) return { skipped: "The proposed change is the same as the current configuration." };
  return { title: o.title.trim().slice(0, 100), change: { summary, fields: changed } };
}

export type FailurePattern = { employeeId: string; versionId: string; evaluatorId: string; dimension: EvalDimension; failures: number; results: number };

/**
 * Evaluators that keep failing on an employee's live version in production conversations of the last `days`
 * days, without a suggestion for that version and evaluator yet. Most failures first.
 */
export async function findFailurePatterns(scope: Scope, days: number): Promise<FailurePattern[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await prisma.$queryRaw<FailurePattern[]>`
    SELECT e."employeeId", e."employeeVersionId" AS "versionId", r."evaluatorId", r.dimension,
      count(*) FILTER (WHERE r.passed = false)::int AS failures, count(*) FILTER (WHERE r.passed IS NOT NULL)::int AS results
    FROM "EvaluationResult" r
    JOIN "Evaluation" e ON e.id = r."evaluationId"
    JOIN "AIEmployee" a ON a.id = e."employeeId" AND a."publishedVersionId" = e."employeeVersionId" AND a.status = 'ACTIVE'
    WHERE e."organizationId" = ${scope.organizationId} AND e."workspaceId" = ${scope.workspaceId}
      AND e.trigger IN ('auto', 'manual') AND e."createdAt" >= ${since}
      AND NOT EXISTS (SELECT 1 FROM "ImprovementSuggestion" s WHERE s."baseVersionId" = e."employeeVersionId" AND s."evaluatorId" = r."evaluatorId")
    GROUP BY 1, 2, 3, 4
    HAVING count(*) FILTER (WHERE r.passed = false) >= ${PATTERN_MIN_FAILURES}
    ORDER BY failures DESC`;
  return rows.filter((r) => r.failures >= PATTERN_MIN_RATE * r.results);
}

function briefing(config: EmployeeConfig, evaluator: { name: string; dimension: string; kind: string; config: unknown }, evidence: SuggestionEvidence) {
  const check =
    evaluator.kind === "llm"
      ? `Rubric: ${(evaluator.config as { rubric?: string }).rubric ?? ""}`
      : `Settings: ${JSON.stringify(evaluator.config).slice(0, 2000)}`;
  const examples = evidence.examples
    .map(
      (x, i) =>
        `Failure ${i + 1} (score ${x.score ?? "n/a"}): ${x.reason}${x.findings.map((f) => `\n  - ${f.message}${f.quote ? ` (quote: "${f.quote}")` : ""}`).join("")}`,
    )
    .join("\n\n");
  return [
    `The employee's configuration:\nName: ${config.name}\nRole: ${config.role}\nPersonality: ${config.personality || "(none)"}\nGoals: ${JSON.stringify(config.goals)}\nInstructions:\n${config.systemInstructions || "(none)"}`,
    `The quality check: ${evaluator.name} (${EVAL_DIMENSION_LABELS[evaluator.dimension as EvalDimension] ?? evaluator.dimension})\n${check}`,
    `It failed ${evidence.failures} of ${evidence.results} conversations in the last ${evidence.days} days. Examples:\n\n${examples}`,
  ].join("\n\n");
}

/** The failing results behind a pattern: counts and the newest examples with their reasons and quotes. */
async function evidenceOf(pattern: FailurePattern, days: number): Promise<SuggestionEvidence> {
  const since = new Date(Date.now() - days * 86_400_000);
  const failing = await prisma.evaluationResult.findMany({
    where: {
      evaluatorId: pattern.evaluatorId,
      passed: false,
      evaluation: { employeeVersionId: pattern.versionId, trigger: { in: ["auto", "manual"] }, createdAt: { gte: since } },
    },
    orderBy: { createdAt: "desc" },
    take: EXAMPLES,
    include: { evaluation: { select: { id: true, conversationId: true, conversation: { select: { title: true } } } } },
  });
  return {
    failures: pattern.failures,
    results: pattern.results,
    days,
    examples: failing.map((r) => ({
      evaluationId: r.evaluation.id,
      conversationId: r.evaluation.conversationId,
      conversationTitle: r.evaluation.conversation.title,
      score: r.score,
      reason: r.reason,
      findings: ((r.details as { findings?: EvaluationFinding[] }).findings ?? []).slice(0, 5),
    })),
  };
}

export type ImproveDeps = { provider: (route: Route) => AIProvider; timeoutMs: number; onError?: (err: unknown, pattern: FailurePattern) => void };

/**
 * Finds failure patterns in the workspace and writes one suggestion per pattern the model can propose a change
 * for. Returns the new suggestion ids. Patterns the model declines are not recorded, so a later analysis (with
 * more failures) asks again.
 */
export async function analyzeWorkspace(scope: Scope, deps: ImproveDeps, { days = 14 }: { days?: number } = {}): Promise<string[]> {
  const patterns = (await findFailurePatterns(scope, days)).slice(0, MAX_PER_RUN);
  const created: string[] = [];
  for (const pattern of patterns) {
    try {
      const [version, evaluator, evidence] = await Promise.all([
        prisma.aiEmployeeVersion.findUniqueOrThrow({ where: { id: pattern.versionId } }),
        prisma.evaluator.findUniqueOrThrow({ where: { id: pattern.evaluatorId }, include: { currentVersion: true } }),
        evidenceOf(pattern, days),
      ]);
      const check = evaluator.currentVersion;
      if (!check) continue;
      const base = configOf(version);
      let text = "";
      for await (const event of deps.provider({ ...scope, task: "improvement" }).stream({
        system: IMPROVE_PROMPT,
        messages: [{ role: "user", content: briefing(base, check, evidence) }],
        signal: AbortSignal.timeout(deps.timeoutMs),
      }))
        if (event.type === "text") text += event.text;
      const proposal = parseProposal(text, base);
      if ("skipped" in proposal) continue;
      const suggestion = await prisma.improvementSuggestion.create({
        data: {
          ...scope,
          employeeId: pattern.employeeId,
          baseVersionId: pattern.versionId,
          evaluatorId: pattern.evaluatorId,
          dimension: pattern.dimension,
          title: proposal.title,
          reason: `"${check.name}" failed ${pattern.failures} of ${pattern.results} conversations on version ${version.number} in the last ${days} days.`,
          evidence: evidence as unknown as Prisma.InputJsonValue,
          change: proposal.change as unknown as Prisma.InputJsonValue,
          kpi: pattern.dimension,
          createdBy: "system",
        },
      });
      created.push(suggestion.id);
    } catch (err) {
      // Two analyses at once: the unique pattern key let the other one write it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      deps.onError?.(err, pattern);
    }
  }
  return created;
}

/** Workspaces with failing production evaluations lately: the daily analysis visits only these. */
export async function workspacesWithFailures(days = 14) {
  return prisma.$queryRaw<Scope[]>`
    SELECT DISTINCT "organizationId", "workspaceId" FROM "Evaluation"
    WHERE trigger IN ('auto', 'manual') AND failures > 0 AND "createdAt" >= ${new Date(Date.now() - days * 86_400_000)}`;
}

// ---- KPI ----

/** Below this many samples on either side there is no verdict. */
export const KPI_MIN_SAMPLES = 10;

/**
 * Compares a KPI between two versions from per-conversation values (scores 0-100, or 0/100 for pass or fail):
 * the difference of the means, and whether it is larger than chance would explain (two-sided, 95%, Welch).
 */
export function compareKpi(kpi: KpiComparison["kpi"], control: { version: number; values: number[] }, candidate: { version: number; values: number[] }): KpiComparison {
  const stats = (xs: number[]) => {
    const n = xs.length;
    const mean = n > 0 ? xs.reduce((a, b) => a + b, 0) / n : null;
    const variance = n > 1 && mean !== null ? xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1) : 0;
    return { n, mean, variance };
  };
  const c = stats(control.values);
  const t = stats(candidate.values);
  const round = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
  const difference = c.mean !== null && t.mean !== null ? t.mean - c.mean : null;
  let verdict: KpiComparison["verdict"] = "not_enough_data";
  if (difference !== null && c.n >= KPI_MIN_SAMPLES && t.n >= KPI_MIN_SAMPLES) {
    const se = Math.sqrt(c.variance / c.n + t.variance / t.n);
    const significant = se === 0 ? difference !== 0 : Math.abs(difference / se) >= 1.96;
    verdict = !significant ? "no_difference" : difference > 0 ? "improved" : "worse";
  }
  return {
    kpi,
    control: { version: control.version, samples: c.n, value: round(c.mean) },
    candidate: { version: candidate.version, samples: t.n, value: round(t.mean) },
    difference: round(difference),
    verdict,
  };
}
