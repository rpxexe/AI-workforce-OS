"use client";

import { attentionSchema, type Attention } from "@workforce/shared";
import { SlidersHorizontal } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useApi } from "@/lib/api";

const FIELDS: { key: keyof Attention; label: string; hint: string; min: number; max: number }[] = [
  { key: "handoffRateRise", label: "Handoff rate rise (points)", hint: "Flag a handoff rate this many points above the period before.", min: 1, max: 100 },
  { key: "qualityScoreBelow", label: "Quality score below", hint: "Failed checks turn urgent when the score is under this.", min: 0, max: 100 },
  { key: "limitUsedPercent", label: "Plan limit used (%)", hint: "Flag a plan limit once this share of it is used.", min: 50, max: 100 },
];

/** Admins set when the dashboard's "Needs attention" list flags something, for this workspace. */
export function AttentionThresholds({ workspaceId, value, onSaved }: { workspaceId: string; value: Attention; onSaved: () => void }) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<keyof Attention, string>>(() => toDraft(value));
  const [errors, setErrors] = useState<Partial<Record<keyof Attention, string>>>({});
  const [saving, setSaving] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = attentionSchema.safeParse(draft);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((i) => [i.path[0], i.message])));
      return;
    }
    setSaving(true);
    try {
      await api(`/workspaces/${workspaceId}/attention`, { method: "PUT", body: parsed.data, toast: "Thresholds saved" });
      setOpen(false);
      onSaved();
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (saving) return;
        if (next) {
          setDraft(toDraft(value));
          setErrors({});
        }
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          <SlidersHorizontal aria-hidden />
          Thresholds
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={save} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>Needs attention thresholds</DialogTitle>
            <DialogDescription>When the dashboard flags something for this workspace.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {FIELDS.map((f) => (
              <Field key={f.key} data-invalid={errors[f.key] !== undefined}>
                <FieldLabel htmlFor={`attention-${f.key}`}>{f.label}</FieldLabel>
                <Input
                  id={`attention-${f.key}`}
                  type="number"
                  inputMode="numeric"
                  min={f.min}
                  max={f.max}
                  value={draft[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  aria-invalid={errors[f.key] !== undefined}
                />
                {errors[f.key] ? <FieldError>{errors[f.key]}</FieldError> : <FieldDescription>{f.hint}</FieldDescription>}
              </Field>
            ))}
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const toDraft = (a: Attention) => ({ handoffRateRise: String(a.handoffRateRise), qualityScoreBelow: String(a.qualityScoreBelow), limitUsedPercent: String(a.limitUsedPercent) });
