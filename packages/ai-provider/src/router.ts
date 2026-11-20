// The model router: every model call in the application goes through it. It picks the models a request may use
// (capability, context, cost, allowed providers), orders them (the tenant's order, latency or cost), tries them
// one after another until one answers, and records each attempt. Fallback is bounded: each model at most once,
// at most `maxAttempts` models, and never after any text has reached the caller.
import { randomUUID } from "node:crypto";
import { costOf, type ModelInfo } from "./catalog.ts";
import { AIProviderError, type AIProvider, type AIProviderErrorKind, type CompletionRequest, type ProviderEvent } from "./types.ts";

/** Who is asking and for what; chosen by the caller, never by the request body. */
export type Route = { organizationId: string; workspaceId?: string; task: string };

/** One model the request may go to: a concrete provider (never another router), so fallback cannot recurse. */
export type RouteTarget = {
  provider: AIProvider;
  /** Provider kind, matched against the policy's allowed providers. */
  kind: string;
  /** The organization's credential behind it; null = the platform's own provider. */
  credentialId: string | null;
  info?: ModelInfo;
};

/** What the tenant's policy allows for a route, primary first. */
export type RoutePlan = {
  targets: RouteTarget[];
  maxCostUsd: number | null;
  timeoutMs: number | null;
  allowedProviders: string[];
  strategy: "ordered" | "fastest" | "cheapest";
};

export type UsageRecord = {
  route: Route;
  /** Shared by every attempt of one request. */
  requestId: string;
  attempt: number;
  provider: string;
  model: string;
  credentialId: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  success: boolean;
  errorKind: string | null;
  error: string | null;
};

export type RouterDeps = {
  plan: (route: Route) => Promise<RoutePlan>;
  /** Called once per attempt; must not throw. */
  record: (usage: UsageRecord) => void;
  maxAttempts?: number;
  /** How long a model that just failed for availability reasons is tried last. */
  cooldownMs?: number;
};

/** Failures another model may not have. A refusal is the model's judgement of the request: not shopped around. */
const FALLBACK_KINDS: ReadonlySet<AIProviderErrorKind | "timeout"> = new Set(["config", "auth", "billing", "rate_limit", "unavailable", "invalid", "timeout"]);
/** Failures that say the model is struggling right now. */
const COOLDOWN_KINDS: ReadonlySet<string> = new Set(["rate_limit", "unavailable", "timeout"]);
/** Tokens a reply is assumed to need when checking context and cost before the call. */
const OUTPUT_RESERVE = 1024;

const keyOf = (t: RouteTarget) => `${t.credentialId ?? "platform"}:${t.kind}:${t.provider.model}`;

/** Roughly 4 characters per token: good enough to rule out models that clearly cannot take a request. */
export const estimateTokens = ({ system, messages, tools }: Pick<CompletionRequest, "system" | "messages" | "tools">) =>
  Math.ceil((system.length + JSON.stringify(messages).length + (tools ? JSON.stringify(tools).length : 0)) / 4);

/** Why a target cannot take this request, or null when it can. */
export const ineligible = (target: RouteTarget, plan: RoutePlan, inputTokens: number, needsTools: boolean): string | null => {
  const name = `${target.kind}/${target.provider.model}`;
  if (plan.allowedProviders.length > 0 && !plan.allowedProviders.includes(target.kind)) return `${name}: provider not allowed`;
  if (needsTools && target.info && !target.info.tools) return `${name}: cannot call tools`;
  if (target.info?.contextTokens && inputTokens + OUTPUT_RESERVE > target.info.contextTokens) return `${name}: context too small`;
  if (plan.maxCostUsd !== null) {
    const cost = costOf(target.info, inputTokens, OUTPUT_RESERVE);
    if (cost === null) return `${name}: price unknown, so the cost limit cannot be checked`;
    if (cost > plan.maxCostUsd) return `${name}: over the cost limit`;
  }
  return null;
};

export function createRouter(deps: RouterDeps) {
  const maxAttempts = deps.maxAttempts ?? 3;
  const cooldownMs = deps.cooldownMs ?? 30_000;
  /** Average latency of successful calls per model (exponential, newest weighs 30%). */
  const latency = new Map<string, number>();
  const cooling = new Map<string, number>();

  /** The targets to try, in order: eligible ones, deduplicated, sorted by the strategy, models cooling down last. */
  const order = (plan: RoutePlan, request: CompletionRequest) => {
    const inputTokens = estimateTokens(request);
    const needsTools = (request.tools?.length ?? 0) > 0;
    const seen = new Set<string>();
    const skipped: string[] = [];
    const eligible: RouteTarget[] = [];
    for (const target of plan.targets) {
      if (seen.has(keyOf(target))) continue;
      seen.add(keyOf(target));
      const reason = ineligible(target, plan, inputTokens, needsTools);
      if (reason) skipped.push(reason);
      else eligible.push(target);
    }
    const score = (t: RouteTarget) =>
      plan.strategy === "fastest"
        ? // An unmeasured model goes first once, so every model gets measured.
          (latency.get(keyOf(t)) ?? 0)
        : plan.strategy === "cheapest"
          ? (costOf(t.info, inputTokens, OUTPUT_RESERVE) ?? Number.MAX_SAFE_INTEGER)
          : 0;
    const now = Date.now();
    const cool = (t: RouteTarget) => ((cooling.get(keyOf(t)) ?? 0) > now ? 1 : 0);
    // toSorted is stable: equal scores keep the tenant's order, so the primary wins ties.
    const ordered = eligible.toSorted((a, b) => cool(a) - cool(b) || score(a) - score(b)).slice(0, maxAttempts);
    return { ordered, skipped, inputTokens };
  };

  return {
    /** A provider bound to a route. Its `stream` routes every call; the `done` event names who answered. */
    provider(route: Route): AIProvider {
      return {
        name: "router",
        model: route.task,
        async *stream(request): AsyncGenerator<ProviderEvent> {
          const requestId = randomUUID();
          const base = { route, requestId, inputTokens: 0, outputTokens: 0, costUsd: null };
          let plan: RoutePlan;
          try {
            plan = await deps.plan(route);
          } catch (err) {
            const message = err instanceof Error ? err.message : "The model policy could not be loaded";
            deps.record({ ...base, attempt: 1, provider: "none", model: "none", credentialId: null, latencyMs: 0, success: false, errorKind: "config", error: message.slice(0, 500) });
            throw err instanceof AIProviderError ? err : new AIProviderError("config", message, err);
          }
          const { ordered, skipped } = order(plan, request);
          if (ordered.length === 0) {
            const message = `No model allowed for "${route.task}" can take this request (${skipped.join("; ") || "no models configured"})`;
            deps.record({ ...base, attempt: 1, provider: "none", model: "none", credentialId: null, latencyMs: 0, success: false, errorKind: "config", error: message.slice(0, 500) });
            throw new AIProviderError("config", message);
          }

          for (const [index, target] of ordered.entries()) {
            const attempt = index + 1;
            const last = attempt === ordered.length;
            const timer = plan.timeoutMs ? AbortSignal.timeout(plan.timeoutMs) : undefined;
            const signal = timer ? AbortSignal.any([request.signal, timer]) : request.signal;
            const started = Date.now();
            const who = { provider: target.provider.name, model: target.provider.model, credentialId: target.credentialId };
            let answered = false;
            try {
              for await (const event of target.provider.stream({ ...request, signal })) {
                if (event.type === "text") {
                  answered = true;
                  yield event;
                  continue;
                }
                const latencyMs = Date.now() - started;
                const handledBy = { provider: event.provider ?? who.provider, model: event.model ?? who.model };
                const costUsd = event.costUsd ?? costOf(target.info, event.inputTokens, event.outputTokens);
                const key = keyOf(target);
                latency.set(key, Math.round((latency.get(key) ?? latencyMs) * 0.7 + latencyMs * 0.3));
                cooling.delete(key);
                deps.record({ ...base, ...who, ...handledBy, attempt, inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd, latencyMs, success: true, errorKind: null, error: null });
                yield { ...event, ...handledBy, ...(costUsd !== null && { costUsd }) };
                return;
              }
              throw new AIProviderError("unavailable", "The provider stream ended early");
            } catch (err) {
              const cancelled = request.signal.aborted;
              const timedOut = !cancelled && Boolean(timer?.aborted);
              const kind = cancelled ? "cancelled" : timedOut ? "timeout" : err instanceof AIProviderError ? err.kind : "internal";
              const message = timedOut ? `${who.model} did not answer within ${plan.timeoutMs} ms` : err instanceof Error ? err.message : String(err);
              deps.record({ ...base, ...who, attempt, latencyMs: Date.now() - started, success: false, errorKind: kind, error: message.slice(0, 500) });
              if (COOLDOWN_KINDS.has(kind)) cooling.set(keyOf(target), Date.now() + cooldownMs);
              // Text already reached the caller, or another model would not help: this request ends here.
              const fallback = !answered && !last && FALLBACK_KINDS.has(kind as AIProviderErrorKind);
              if (!fallback) throw timedOut ? new AIProviderError("unavailable", message, err) : err;
            }
          }
          // Unreachable: the last attempt either returns or throws.
          throw new AIProviderError("unavailable", "No model answered");
        },
      };
    },
  };
}
