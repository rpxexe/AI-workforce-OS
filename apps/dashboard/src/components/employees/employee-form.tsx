"use client";

import { AVATARS, HANDOFF_RULE_OPERATORS, LANGUAGES, employeeConfigSchema, type EmployeeConfig, type HandoffRule } from "@workforce/shared";
import { Plus, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { AVATAR_ICONS, AVATAR_LABELS, DAY_LABELS } from "@/components/employees/meta";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiRequestError } from "@/lib/api";
import { cn } from "@/lib/utils";

const MAX_GOALS = 20;

type Issues = Record<string, string>;

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-sm text-destructive">
          {error}
        </p>
      ) : (
        hint && <p className="text-sm text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/** Props that tie an input to its Field's error message. */
const invalid = (id: string, error?: string) =>
  error ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
    </Card>
  );
}

export function EmployeeForm({
  initial,
  submitLabel,
  note,
  cancelHref,
  onSubmit,
}: {
  initial: EmployeeConfig;
  submitLabel: string;
  /** Shown beside the submit button, e.g. what saving will and will not change. */
  note?: string;
  cancelHref: string;
  onSubmit: (config: EmployeeConfig) => Promise<void>;
}) {
  const [form, setForm] = useState(initial);
  const [issues, setIssues] = useState<Issues>({});
  const [formError, setFormError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const timeZones = useMemo(() => {
    const zones = Intl.supportedValuesOf("timeZone");
    // The saved zone may be an alias (e.g. "UTC") that the browser's list leaves out.
    return zones.includes(initial.workingHours.timezone) ? zones : [initial.workingHours.timezone, ...zones];
  }, [initial.workingHours.timezone]);

  const set = <K extends keyof EmployeeConfig>(key: K, value: EmployeeConfig[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setEscalation = (patch: Partial<EmployeeConfig["escalation"]>) =>
    set("escalation", { ...form.escalation, ...patch });
  const setDay = (index: number, patch: Partial<EmployeeConfig["workingHours"]["days"][number]>) =>
    set("workingHours", {
      ...form.workingHours,
      days: form.workingHours.days.map((d, i) => (i === index ? { ...d, ...patch } : d)),
    });
  const setGoal = (index: number, value: string) =>
    set(
      "goals",
      form.goals.map((g, i) => (i === index ? value : g)),
    );

  const showIssues = (list: { path: string; message: string }[]) => {
    // Keep the first message per field.
    setIssues(Object.fromEntries(list.toReversed().map((i) => [i.path, i.message])));
    setFormError("Some fields need attention.");
    requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = employeeConfigSchema.safeParse(form);
    if (!parsed.success) {
      showIssues(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
      return;
    }
    setIssues({});
    setFormError(undefined);
    setSaving(true);
    try {
      await onSubmit(parsed.data);
    } catch (error) {
      if (error instanceof ApiRequestError && error.issues.length > 0) showIssues(error.issues);
      else setFormError(error instanceof Error ? error.message : "Something went wrong. Try again.");
    } finally {
      // Also on success: Next.js keeps this page mounted while hidden, so it must not come back stuck on "Saving…".
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <Section title="Identity" description="How this employee appears to your team and your customers.">
        <div className="flex flex-col gap-1.5">
          <span id="avatar-label" className="text-sm font-medium">
            Icon
          </span>
          <div role="radiogroup" aria-labelledby="avatar-label" className="flex flex-wrap gap-2">
            {AVATARS.map((avatar) => {
              const Icon = AVATAR_ICONS[avatar];
              const selected = form.avatar === avatar;
              return (
                <button
                  key={avatar}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={AVATAR_LABELS[avatar]}
                  onClick={() => set("avatar", avatar)}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-lg border transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                    selected ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="name" label="Name" error={issues.name}>
            <Input
              id="name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Ava"
              maxLength={80}
              autoComplete="off"
              {...invalid("name", issues.name)}
            />
          </Field>
          <Field id="language" label="Language" error={issues.language}>
            <Select value={form.language} onValueChange={(v) => set("language", v as EmployeeConfig["language"])}>
              <SelectTrigger id="language" className="w-full" {...invalid("language", issues.language)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(LANGUAGES).map(([code, label]) => (
                  <SelectItem key={code} value={code}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </div>

        <Field
          id="description"
          label="Description"
          hint="A sentence your team will see in the employee list."
          error={issues.description}
        >
          <Textarea
            id="description"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            rows={2}
            maxLength={500}
            {...invalid("description", issues.description)}
          />
        </Field>
      </Section>

      <Section title="Role and personality" description="What this employee does and how it comes across.">
        <Field id="role" label="Role" error={issues.role}>
          <Input
            id="role"
            value={form.role}
            onChange={(e) => set("role", e.target.value)}
            placeholder="Customer support agent"
            maxLength={80}
            {...invalid("role", issues.role)}
          />
        </Field>
        <Field
          id="personality"
          label="Personality"
          hint="Tone and manner, for example: warm, concise, never pushy."
          error={issues.personality}
        >
          <Textarea
            id="personality"
            value={form.personality}
            onChange={(e) => set("personality", e.target.value)}
            rows={3}
            maxLength={2000}
            {...invalid("personality", issues.personality)}
          />
        </Field>
        <Field
          id="systemInstructions"
          label="System instructions"
          hint="The rules this employee always follows."
          error={issues.systemInstructions}
        >
          <Textarea
            id="systemInstructions"
            value={form.systemInstructions}
            onChange={(e) => set("systemInstructions", e.target.value)}
            rows={8}
            maxLength={20000}
            className="font-mono text-sm"
            {...invalid("systemInstructions", issues.systemInstructions)}
          />
        </Field>
      </Section>

      <Section title="Goals" description="Outcomes this employee works toward. Up to 20.">
        {form.goals.length > 0 && (
          <ul className="flex flex-col gap-2">
            {form.goals.map((goal, i) => {
              const id = `goal-${i}`;
              const error = issues[`goals.${i}`];
              return (
                <li key={i} className="flex flex-col gap-1">
                  <div className="flex gap-2">
                    <Input
                      id={id}
                      aria-label={`Goal ${i + 1}`}
                      value={goal}
                      onChange={(e) => setGoal(i, e.target.value)}
                      maxLength={200}
                      {...invalid(id, error)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove goal ${i + 1}`}
                      onClick={() =>
                        set(
                          "goals",
                          form.goals.filter((_, index) => index !== i),
                        )
                      }
                    >
                      <X aria-hidden />
                    </Button>
                  </div>
                  {error && (
                    <p id={`${id}-error`} className="text-sm text-destructive">
                      {error}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={form.goals.length >= MAX_GOALS}
            onClick={() => set("goals", [...form.goals, ""])}
          >
            <Plus aria-hidden />
            Add goal
          </Button>
        </div>
      </Section>

      <Section title="Working hours" description="When this employee is available. Outside these hours it is off duty.">
        <Field id="timezone" label="Time zone" error={issues["workingHours.timezone"]} className="sm:max-w-xs">
          <Select
            value={form.workingHours.timezone}
            onValueChange={(timezone) => set("workingHours", { ...form.workingHours, timezone })}
          >
            <SelectTrigger id="timezone" className="w-full" {...invalid("timezone", issues["workingHours.timezone"])}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {timeZones.map((zone) => (
                <SelectItem key={zone} value={zone}>
                  {zone.replaceAll("_", " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <ul className="flex flex-col divide-y">
          {form.workingHours.days.map((d, i) => {
            const error = issues[`workingHours.days.${i}.end`] ?? issues[`workingHours.days.${i}.start`];
            const label = DAY_LABELS[d.day];
            return (
              <li key={d.day} className="flex flex-col gap-1 py-2.5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="flex w-36 items-center gap-3">
                    <Switch
                      id={`day-${d.day}`}
                      checked={d.enabled}
                      onCheckedChange={(enabled) => setDay(i, { enabled })}
                    />
                    <Label htmlFor={`day-${d.day}`}>{label}</Label>
                  </div>
                  {d.enabled ? (
                    <div className="flex items-center gap-2">
                      <Input
                        type="time"
                        aria-label={`${label} start`}
                        value={d.start}
                        onChange={(e) => setDay(i, { start: e.target.value })}
                        className="w-28"
                      />
                      <span className="text-sm text-muted-foreground">to</span>
                      <Input
                        type="time"
                        aria-label={`${label} end`}
                        value={d.end}
                        onChange={(e) => setDay(i, { end: e.target.value })}
                        className="w-28"
                        aria-invalid={error ? true : undefined}
                      />
                    </div>
                  ) : (
                    <span className="text-sm text-muted-foreground">Off</span>
                  )}
                </div>
                {error && <p className="text-sm text-destructive">{error}</p>}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Escalation" description="When and how this employee hands a conversation to a person.">
        <div className="flex items-center gap-3">
          <Switch
            id="escalation-enabled"
            checked={form.escalation.enabled}
            onCheckedChange={(enabled) => setEscalation({ enabled })}
          />
          <Label htmlFor="escalation-enabled">Hand off to a person when needed</Label>
        </div>

        {form.escalation.enabled && (
          <>
            <Field
              id="contactEmail"
              label="Contact email"
              hint="Who is notified when a conversation is handed off."
              error={issues["escalation.contactEmail"]}
              className="sm:max-w-sm"
            >
              <Input
                id="contactEmail"
                type="email"
                value={form.escalation.contactEmail}
                onChange={(e) => setEscalation({ contactEmail: e.target.value })}
                placeholder="support@example.com"
                autoComplete="off"
                {...invalid("contactEmail", issues["escalation.contactEmail"])}
              />
            </Field>

            <fieldset className="flex flex-col gap-3">
              <legend className="mb-1 text-sm font-medium">Hand off when</legend>
              {(
                [
                  ["onCustomerRequest", "The customer asks for a person"],
                  ["onLowConfidence", "The employee is not confident it can answer correctly"],
                  ["onPolicyRisk", "An answer could break policy (legal or medical advice, refunds, threats, abuse)"],
                  ["onToolFailure", "A tool the employee uses fails"],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="flex items-center gap-3">
                  <Switch id={key} checked={form.escalation[key]} onCheckedChange={(on) => setEscalation({ [key]: on })} />
                  <Label htmlFor={key}>{label}</Label>
                </div>
              ))}
            </fieldset>

            <div className="flex flex-wrap gap-4">
              <Field
                id="highValueKey"
                label="High-value customers"
                hint="A remembered number, e.g. budget. Customers at or above the minimum go to a person. Empty turns this off."
                error={issues["escalation.highValueKey"]}
                className="sm:max-w-xs"
              >
                <Input
                  id="highValueKey"
                  value={form.escalation.highValueKey}
                  onChange={(e) => setEscalation({ highValueKey: e.target.value.trim().toLowerCase() })}
                  placeholder="budget"
                  maxLength={50}
                  {...invalid("highValueKey", issues["escalation.highValueKey"])}
                />
              </Field>
              <Field id="highValueMinimum" label="Minimum" error={issues["escalation.highValueMinimum"]} className="w-36">
                <Input
                  id="highValueMinimum"
                  type="number"
                  min={0}
                  value={form.escalation.highValueMinimum}
                  onChange={(e) => setEscalation({ highValueMinimum: Number(e.target.value) || 0 })}
                  disabled={form.escalation.highValueKey === ""}
                  {...invalid("highValueMinimum", issues["escalation.highValueMinimum"])}
                />
              </Field>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Conditions</legend>
              <p className="text-xs text-muted-foreground">
                Hand off when the customer&apos;s message, or something remembered about them, matches. Each condition hands a conversation off once.
              </p>
              {form.escalation.rules.map((rule, i) => {
                const setRule = (patch: Partial<HandoffRule>) =>
                  setEscalation({ rules: form.escalation.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
                const error = issues[`escalation.rules.${i}.key`] ?? issues[`escalation.rules.${i}.value`];
                return (
                  <div key={i} className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Select value={rule.field} onValueChange={(field) => setRule({ field: field as HandoffRule["field"] })}>
                        <SelectTrigger aria-label={`Condition ${i + 1} checks`} className="w-36">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="message">Message</SelectItem>
                          <SelectItem value="memory">Memory</SelectItem>
                        </SelectContent>
                      </Select>
                      {rule.field === "memory" && (
                        <Input
                          aria-label={`Condition ${i + 1} memory key`}
                          value={rule.key}
                          onChange={(e) => setRule({ key: e.target.value.trim().toLowerCase() })}
                          placeholder="plan"
                          maxLength={50}
                          className="w-32"
                        />
                      )}
                      <Select value={rule.operator} onValueChange={(operator) => setRule({ operator: operator as HandoffRule["operator"] })}>
                        <SelectTrigger aria-label={`Condition ${i + 1} operator`} className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {HANDOFF_RULE_OPERATORS.map((op) => (
                            <SelectItem key={op} value={op}>
                              {op.replace("_", " ")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        aria-label={`Condition ${i + 1} value`}
                        value={rule.value}
                        onChange={(e) => setRule({ value: e.target.value })}
                        placeholder={rule.field === "message" ? "refund" : "enterprise"}
                        maxLength={200}
                        className="min-w-32 flex-1"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove condition ${i + 1}`}
                        onClick={() => setEscalation({ rules: form.escalation.rules.filter((_, j) => j !== i) })}
                      >
                        <X aria-hidden />
                      </Button>
                    </div>
                    {error && <p className="text-sm text-destructive">{error}</p>}
                  </div>
                );
              })}
              {form.escalation.rules.length < 10 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-fit"
                  onClick={() => setEscalation({ rules: [...form.escalation.rules, { field: "message", key: "", operator: "contains", value: "" }] })}
                >
                  <Plus aria-hidden />
                  Add condition
                </Button>
              )}
            </fieldset>

            <Field
              id="afterFailedAttempts"
              label="Hand off after failed attempts"
              hint="How many times the employee may fail to help before handing off. 0 turns this off."
              error={issues["escalation.afterFailedAttempts"]}
              className="sm:max-w-sm"
            >
              <Input
                id="afterFailedAttempts"
                type="number"
                min={0}
                max={10}
                value={form.escalation.afterFailedAttempts}
                onChange={(e) => setEscalation({ afterFailedAttempts: Number(e.target.value) || 0 })}
                className="w-24"
                {...invalid("afterFailedAttempts", issues["escalation.afterFailedAttempts"])}
              />
            </Field>

            <Field
              id="transferNumber"
              label="Transfer phone calls to"
              hint="A person's or team's number, in international format. Handed-off calls are put through to it; leave empty to end the call and call back."
              error={issues["escalation.transferNumber"]}
              className="sm:max-w-sm"
            >
              <Input
                id="transferNumber"
                type="tel"
                value={form.escalation.transferNumber}
                onChange={(e) => setEscalation({ transferNumber: e.target.value.trim() })}
                placeholder="+14155550100"
                autoComplete="off"
                {...invalid("transferNumber", issues["escalation.transferNumber"])}
              />
            </Field>

            <Field
              id="handoffMessage"
              label="Handoff message"
              hint="What the customer is told while they wait for a person."
              error={issues["escalation.handoffMessage"]}
            >
              <Textarea
                id="handoffMessage"
                value={form.escalation.handoffMessage}
                onChange={(e) => setEscalation({ handoffMessage: e.target.value })}
                rows={2}
                maxLength={500}
                {...invalid("handoffMessage", issues["escalation.handoffMessage"])}
              />
            </Field>
          </>
        )}
      </Section>

      <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
        <p className={cn("mr-auto text-sm", formError ? "text-destructive" : "text-muted-foreground")} role="status">
          {formError ?? note}
        </p>
        <Button variant="ghost" asChild>
          <Link href={cancelHref}>Cancel</Link>
        </Button>
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
