"use client";

import { knowledgeSourceSchema, type KnowledgeSource } from "@workforce/shared";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/api";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Try again.");

/** "New source" button and its dialog; on success it opens the new source so documents can be uploaded. */
export function CreateSourceDialog({ base, label = "New source" }: { base: string; label?: string }) {
  const api = useApi();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = knowledgeSourceSchema.safeParse({ name, description });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setCreating(true);
    setError(undefined);
    try {
      const source = await api<KnowledgeSource>(`${base}/sources`, { method: "POST", body: parsed.data, toast: `${parsed.data.name} created` });
      router.push(`/knowledge/${source.id}`);
    } catch (err) {
      setError(messageOf(err));
      setCreating(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (creating) return;
        setOpen(next);
        if (!next) {
          setName("");
          setDescription("");
          setError(undefined);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={create} className="flex flex-col gap-6">
          <DialogHeader>
            <DialogTitle>New knowledge source</DialogTitle>
            <DialogDescription>
              Group related documents, then attach the source to the AI employees that should answer from them.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={error !== undefined || undefined}>
              <FieldLabel htmlFor="source-name">Name</FieldLabel>
              <Input
                id="source-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Pricing and plans"
                maxLength={80}
                autoFocus
                aria-invalid={error !== undefined}
                aria-describedby={error ? "source-name-error" : undefined}
              />
              {error && <FieldError id="source-name-error">{error}</FieldError>}
            </Field>
            <Field>
              <FieldLabel htmlFor="source-description">Description</FieldLabel>
              <Textarea
                id="source-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Current price list, plan limits and discounts."
                maxLength={500}
                rows={3}
              />
              <FieldDescription>Optional. Helps your team tell sources apart.</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button type="submit" disabled={creating || name.trim() === ""}>
              {creating ? <Spinner /> : <Plus aria-hidden />}
              {creating ? "Creating" : "Create source"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
