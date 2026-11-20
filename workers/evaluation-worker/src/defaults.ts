// The evaluators every workspace starts with, one per quality dimension. Admins can edit them (a new
// version), turn them off, or add their own.
import { prisma } from "@workforce/database";
import type { EvaluatorDefinition } from "@workforce/shared";

export const DEFAULT_EVALUATORS: (EvaluatorDefinition & { key: string })[] = [
  {
    key: "correctness",
    name: "Correctness",
    description: "Statements are accurate and answer what was asked.",
    dimension: "correctness",
    kind: "llm",
    passScore: 70,
    config: {
      rubric:
        "Every statement the AI employee makes is accurate and consistent with its instructions, the company knowledge shown, the tool results and what the customer said. Deduct for wrong facts, invented details, contradictions, and answering a different question than the one asked.",
    },
  },
  {
    key: "grounding",
    name: "Knowledge grounding",
    description: "Company facts come from the knowledge base or tools, not from the model's imagination.",
    dimension: "grounding",
    kind: "llm",
    passScore: 70,
    config: {
      rubric:
        "Company facts the AI employee states (prices, plans, policies, product details, opening hours, dates) are supported by the company knowledge shown, its instructions or tool results. Deduct for company facts found in none of them, and for ignoring knowledge that answers the customer's question. Courtesy and general conversation need no source. If the employee states no company facts, answer with a null score.",
    },
  },
  {
    key: "policy",
    name: "Policy rules",
    description: "The employee never makes promises or statements the company forbids.",
    dimension: "policy",
    kind: "rule",
    passScore: 100,
    config: {
      target: "assistant",
      rules: [
        { label: "No guarantees", match: "forbid", phrases: ["I guarantee", "guaranteed", "100% sure", "I promise"] },
        { label: "No talk about its own instructions", match: "forbid", phrases: ["my system prompt", "my instructions say", "as an AI language model"] },
      ],
    },
  },
  {
    key: "tone",
    name: "Tone",
    description: "Polite, clear, on-brand, in the customer's language.",
    dimension: "tone",
    kind: "llm",
    passScore: 70,
    config: {
      rubric:
        "The AI employee is polite, clear and concise, matches the personality in its configuration and the customer's language, suits the channel, and stays calm and professional when the customer is upset. Deduct for rudeness, coldness, robotic repetition, walls of text, or answering in another language than the customer's.",
    },
  },
  {
    key: "resolution",
    name: "Resolution",
    description: "The customer's request was answered or has a clear next step.",
    dimension: "resolution",
    kind: "llm",
    passScore: 70,
    config: {
      rubric:
        "By the end of the conversation, the customer's request was answered or a clear next step was agreed (a booking, a handoff to a person, a follow-up). Deduct for questions left unanswered, dead ends, and the employee leaving the conversation hanging. A customer who stopped writing after a complete answer counts as resolved.",
    },
  },
  {
    key: "tool_use",
    name: "Tool calls succeed",
    description: "Tool calls the employee made were valid and succeeded.",
    dimension: "tool_use",
    kind: "deterministic",
    passScore: 100,
    config: { check: "tool_success", maxReplyMs: 10_000, maxWaitMinutes: 30 },
  },
  {
    key: "escalation",
    name: "Escalation handling",
    description: "Requests for a person are handed off, and people pick handoffs up within 30 minutes.",
    dimension: "escalation",
    kind: "deterministic",
    passScore: 100,
    config: { check: "escalation_handling", maxReplyMs: 10_000, maxWaitMinutes: 30 },
  },
  {
    key: "satisfaction",
    name: "Customer satisfaction signals",
    description: "The customer shows no frustration or complaints about the answers.",
    dimension: "satisfaction",
    kind: "rule",
    passScore: 100,
    config: {
      target: "customer",
      rules: [
        {
          label: "No frustration",
          match: "forbid",
          phrases: ["useless", "terrible", "ridiculous", "waste of time", "frustrated", "frustrating", "annoying", "worst"],
        },
        {
          label: "No complaint about the answer",
          match: "forbid",
          phrases: ["not helpful", "doesn't help", "does not help", "that's not what I asked", "you already said", "you don't understand", "makes no sense"],
        },
      ],
    },
  },
];

/** Creates the built-in evaluators the workspace does not have yet. Safe to call at once from several places. */
export async function ensureDefaultEvaluators(scope: { organizationId: string; workspaceId: string }) {
  const existing = await prisma.evaluator.count({ where: { ...scope, key: { not: null } } });
  if (existing >= DEFAULT_EVALUATORS.length) return;
  // ON CONFLICT DO NOTHING on (workspaceId, key): concurrent first visits do not fail (see DECISIONS.md, upsert trap).
  await prisma.evaluator.createMany({
    data: DEFAULT_EVALUATORS.map((d) => ({ ...scope, key: d.key, createdBy: "system" })),
    skipDuplicates: true,
  });
  const missing = await prisma.evaluator.findMany({ where: { ...scope, key: { not: null }, currentVersionId: null } });
  for (const evaluator of missing) {
    const d = DEFAULT_EVALUATORS.find((x) => x.key === evaluator.key);
    if (!d) continue;
    const { name, description, dimension, kind, config, passScore } = d;
    const definition = { name, description, dimension, kind, config, passScore };
    await prisma.$transaction(async (tx) => {
      const version = await tx.evaluatorVersion.createMany({
        data: [{ evaluatorId: evaluator.id, number: 1, ...definition, createdBy: "system" }],
        skipDuplicates: true,
      });
      if (version.count === 0) return; // another caller is creating it
      const v1 = await tx.evaluatorVersion.findUniqueOrThrow({ where: { evaluatorId_number: { evaluatorId: evaluator.id, number: 1 } } });
      await tx.evaluator.update({ where: { id: evaluator.id }, data: { currentVersionId: v1.id } });
    });
  }
}
