"use client";

import type { ModelInfo } from "@workforce/shared";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** Numbers as typed; empty means unknown. */
export type ModelRow = { id: string; contextTokens: string; inputPricePerM: string; outputPricePerM: string; tools: boolean };

export const toRow = (m: ModelInfo): ModelRow => ({
  id: m.id,
  contextTokens: m.contextTokens?.toString() ?? "",
  inputPricePerM: m.inputPricePerM?.toString() ?? "",
  outputPricePerM: m.outputPricePerM?.toString() ?? "",
  tools: m.tools,
});

const num = (v: string) => (v.trim() === "" ? null : Number(v));

/** The rows with an id, as the API's model list. */
export const toModels = (rows: ModelRow[]): ModelInfo[] =>
  rows
    .filter((m) => m.id.trim())
    .map((m) => ({ id: m.id.trim(), contextTokens: num(m.contextTokens), inputPricePerM: num(m.inputPricePerM), outputPricePerM: num(m.outputPricePerM), tools: m.tools }));

/** Context size and prices per model, for providers the router cannot ask. */
export function ModelsEditor({ rows, onChange, legend = "Models" }: { rows: ModelRow[]; onChange: (rows: ModelRow[]) => void; legend?: string }) {
  const setModel = (i: number, patch: Partial<ModelRow>) => onChange(rows.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <p className="text-xs text-muted-foreground">
        Optional. Context size and prices (US$ per million tokens) let policies check cost limits and context; leave blank when unknown.
      </p>
      {rows.map((m, i) => (
        <div key={i} className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto_auto]">
          <Input aria-label="Model id" value={m.id} onChange={(e) => setModel(i, { id: e.target.value })} placeholder="Model id" className="col-span-2 sm:col-span-1" />
          <Input aria-label="Context tokens" inputMode="numeric" value={m.contextTokens} onChange={(e) => setModel(i, { contextTokens: e.target.value })} placeholder="Context" />
          <Input aria-label="Input price per million tokens" inputMode="decimal" value={m.inputPricePerM} onChange={(e) => setModel(i, { inputPricePerM: e.target.value })} placeholder="In $/M" />
          <Input aria-label="Output price per million tokens" inputMode="decimal" value={m.outputPricePerM} onChange={(e) => setModel(i, { outputPricePerM: e.target.value })} placeholder="Out $/M" />
          <Label className="h-9 font-normal">
            <Switch checked={m.tools} onCheckedChange={(tools) => setModel(i, { tools })} aria-label="Can call tools" />
            Tools
          </Label>
          <Button type="button" variant="ghost" size="icon" aria-label="Remove model" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => onChange([...rows, { id: "", contextTokens: "", inputPricePerM: "", outputPricePerM: "", tools: true }])}
      >
        <Plus aria-hidden /> Add model
      </Button>
    </fieldset>
  );
}
