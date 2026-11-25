"use client";

import {
  DETERMINISTIC_CHECK_LABELS,
  DETERMINISTIC_CHECKS,
  EVAL_DIMENSION_LABELS,
  EVAL_DIMENSIONS,
  EVALUATOR_KIND_LABELS,
  EVALUATOR_KINDS,
  type DeterministicCheck,
  type EvalDimension,
  type EvaluatorDefinition,
  type EvaluatorInput,
  type EvaluatorKind,
} from "@workforce/shared";
import { CircleAlert, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError } from "@/lib/api";

type Rule = { label: string; match: "forbid" | "require"; phrases: string };

const BLANK: EvaluatorDefinition = {
  name: "",
  description: "",
  dimension: "correctness",
  kind: "llm",
  passScore: 70,
  config: { rubric: "" },
};

/** Create or edit an evaluator. Saving an existing one adds a version. */
export function EvaluatorForm({
  initial = BLANK,
  disabled,
  submitLabel,
  onSubmit,
}: {
  initial?: EvaluatorDefinition;
  disabled?: boolean;
  submitLabel: string;
  onSubmit: (body: EvaluatorInput) => Promise<void>;
}) {
  const c = initial.config as Partial<{ rubric: string; target: "assistant" | "customer"; rules: { label: string; match: "forbid" | "require"; phrases: string[] }[]; check: DeterministicCheck; maxReplyMs: number; maxWaitMinutes: number }>;
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [dimension, setDimension] = useState<EvalDimension>(initial.dimension);
  const [kind, setKind] = useState<EvaluatorKind>(initial.kind);
  const [passScore, setPassScore] = useState(String(initial.passScore));
  const [rubric, setRubric] = useState(c.rubric ?? "");
  const [target, setTarget] = useState<"assistant" | "customer">(c.target ?? "assistant");
  const [rules, setRules] = useState<Rule[]>(c.rules?.map((r) => ({ ...r, phrases: r.phrases.join(", ") })) ?? [{ label: "", match: "forbid", phrases: "" }]);
  const [check, setCheck] = useState<DeterministicCheck>(c.check ?? "tool_success");
  const [maxReplySec, setMaxReplySec] = useState(String((c.maxReplyMs ?? 10_000) / 1000));
  const [maxWaitMinutes, setMaxWaitMinutes] = useState(String(c.maxWaitMinutes ?? 30));
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const config = () => {
    if (kind === "llm") return { rubric };
    if (kind === "rule")
      return {
        target,
        rules: rules.map((r) => ({ label: r.label, match: r.match, phrases: r.phrases.split(/[,\n]/).map((p) => p.trim()).filter(Boolean) })),
      };
    return { check, maxReplyMs: Math.round(Number(maxReplySec) * 1000), maxWaitMinutes: Number(maxWaitMinutes) };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setErrors([]);
    try {
      await onSubmit({ name, description, dimension, kind, passScore: Number(passScore), config: config() } as EvaluatorInput);
    } catch (err) {
      if (err instanceof ApiRequestError && err.issues.length > 0) setErrors(err.issues.map((i) => `${i.path}: ${i.message}`));
      else setErrors([err instanceof Error ? err.message : "Could not save. Try again."]);
    } finally {
      setSaving(false);
    }
  };

  const setRule = (i: number, patch: Partial<Rule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <fieldset disabled={disabled || saving} className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-name">Name</Label>
            <Input id="ev-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-dimension">Dimension</Label>
            <Select value={dimension} onValueChange={(v) => setDimension(v as EvalDimension)}>
              <SelectTrigger id="ev-dimension" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVAL_DIMENSIONS.map((d) => (
                  <SelectItem key={d} value={d}>
                    {EVAL_DIMENSION_LABELS[d]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ev-description">Description</Label>
          <Input id="ev-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-kind">Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as EvaluatorKind)}>
              <SelectTrigger id="ev-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EVALUATOR_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {EVALUATOR_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-pass">Pass at score (0-100)</Label>
            <Input id="ev-pass" type="number" min={0} max={100} value={passScore} onChange={(e) => setPassScore(e.target.value)} required />
          </div>
        </div>

        {kind === "llm" && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ev-rubric">Rubric</Label>
            <Textarea id="ev-rubric" value={rubric} onChange={(e) => setRubric(e.target.value)} rows={6} maxLength={4000} />
            <p className="text-xs text-muted-foreground">
              What a good conversation looks like on this dimension, and what loses points. A model reads it with the transcript, the employee&apos;s
              configuration and the knowledge it was given, and answers with a score from 0 to 100. Each graded conversation is one model call.
            </p>
          </div>
        )}

        {kind === "rule" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ev-target">Rules read</Label>
              <Select value={target} onValueChange={(v) => setTarget(v as "assistant" | "customer")}>
                <SelectTrigger id="ev-target" className="w-full sm:w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="assistant">The employee&apos;s replies</SelectItem>
                  <SelectItem value="customer">The customer&apos;s messages</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">Phrases match whole words, ignoring case. Separate them with commas. The score is the share of rules that held.</p>
            {rules.map((r, i) => (
              <Card key={i} size="sm">
                <CardContent className="grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
                    <Input aria-label={`Rule ${i + 1} name`} placeholder="Rule name" value={r.label} onChange={(e) => setRule(i, { label: e.target.value })} />
                    <Select value={r.match} onValueChange={(v) => setRule(i, { match: v as Rule["match"] })}>
                      <SelectTrigger aria-label={`Rule ${i + 1} kind`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="forbid">Must not say</SelectItem>
                        <SelectItem value="require">Must say</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button type="button" variant="ghost" size="icon" onClick={() => setRules(rules.filter((_, j) => j !== i))} disabled={rules.length === 1} aria-label={`Remove rule ${i + 1}`}>
                      <Trash2 aria-hidden />
                    </Button>
                    <Textarea
                      aria-label={`Rule ${i + 1} phrases`}
                      placeholder="guaranteed, I promise"
                      value={r.phrases}
                      onChange={(e) => setRule(i, { phrases: e.target.value })}
                      rows={2}
                      className="sm:col-span-3"
                    />
                </CardContent>
              </Card>
            ))}
            <Button type="button" variant="outline" className="w-fit" onClick={() => setRules([...rules, { label: "", match: "forbid", phrases: "" }])} disabled={rules.length >= 20}>
              <Plus aria-hidden />
              Add rule
            </Button>
          </div>
        )}

        {kind === "deterministic" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="ev-check">Check</Label>
              <Select value={check} onValueChange={(v) => setCheck(v as DeterministicCheck)}>
                <SelectTrigger id="ev-check" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DETERMINISTIC_CHECKS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {DETERMINISTIC_CHECK_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {check === "reply_latency" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ev-latency">Longest acceptable reply time (seconds)</Label>
                <Input id="ev-latency" type="number" min={0.1} step={0.1} value={maxReplySec} onChange={(e) => setMaxReplySec(e.target.value)} />
              </div>
            )}
            {check === "escalation_handling" && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="ev-wait">Longest wait for a person (minutes)</Label>
                <Input id="ev-wait" type="number" min={1} value={maxWaitMinutes} onChange={(e) => setMaxWaitMinutes(e.target.value)} />
              </div>
            )}
          </div>
        )}
      </fieldset>

      {errors.length > 0 && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertDescription>
            <ul>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {!disabled && (
        <Button type="submit" className="w-fit" disabled={saving}>
          {saving ? "Saving" : submitLabel}
        </Button>
      )}
    </form>
  );
}
