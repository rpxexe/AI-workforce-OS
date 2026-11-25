"use client";

import {
  knowledgeSourceSchema,
  type KnowledgeMatch,
  type KnowledgeSource,
} from "@workforce/shared";
import { BookOpen, Plus, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { formatDate } from "@/components/employees/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Item, ItemContent } from "@/components/ui/item";
import { Label } from "@/components/ui/label";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Try again.");

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: KnowledgeSource[] = Array.from({ length: 6 }, (_, i) => ({
  id: `sample-${i}`,
  name: "Pricing and plans",
  description: "",
  documentCount: 12,
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

/** Shows which passages a question would retrieve, across every source in the workspace. */
function KnowledgeSearch({ base }: { base: string }) {
  const api = useApi();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<{ query: string; matches: KnowledgeMatch[] }>();

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const asked = query.trim();
    if (!asked) return;
    setSearching(true);
    try {
      // No success toast: the matches appear below.
      setResult({ query: asked, matches: await api<KnowledgeMatch[]>(`${base}/search`, { method: "POST", body: { query: asked } }) });
    } catch {
      // The toast in useApi shows why it failed; drop the old matches so they are not read as this question's.
      setResult(undefined);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Search knowledge</CardTitle>
        <CardDescription>
          Ask a question the way a customer would to see which passages an AI employee would be given.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={search} className="flex gap-2">
          <Label htmlFor="knowledge-query" className="sr-only">
            Question
          </Label>
          <Input
            id="knowledge-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="What is the enterprise plan price?"
            maxLength={1000}
          />
          <Button type="submit" variant="outline" disabled={searching || query.trim() === ""}>
            <Search aria-hidden />
            {searching ? "Searching" : "Search"}
          </Button>
        </form>
        {result && (
          <div aria-live="polite" className="flex flex-col gap-3">
            {result.matches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing found for “{result.query}”. Check that documents have finished processing.
              </p>
            ) : (
              <ol className="flex flex-col gap-3">
                {result.matches.map((m) => (
                  <Item key={m.chunkId} variant="outline" asChild>
                    <li>
                      <ItemContent className="gap-1.5">
                          <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                            <Link href={`/knowledge/${m.sourceId}`} className="font-medium text-foreground hover:underline">
                              {m.documentName}
                            </Link>
                            <span>
                              {m.sourceName}
                              {m.page !== null && ` · page ${m.page}`}
                            </span>
                            <span className="tabular-nums">{Math.round(m.score * 100)}% match</span>
                          </p>
                          <p className="line-clamp-4 text-sm whitespace-pre-wrap">{m.content}</p>
                      </ItemContent>
                    </li>
                  </Item>
                ))}
              </ol>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default withWorkspace(function KnowledgePage({ workspace }) {
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  const base = `/workspaces/${workspace.id}/knowledge`;
  const { data, error, reload } = useApiQuery<KnowledgeSource[]>(`${base}/sources`);

  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>();

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = knowledgeSourceSchema.safeParse({ name });
    if (!parsed.success) return setCreateError(parsed.error.issues[0]?.message);
    setCreating(true);
    setCreateError(undefined);
    try {
      const source = await api<KnowledgeSource>(`${base}/sources`, { method: "POST", body: parsed.data, toast: `${parsed.data.name} created` });
      setName("");
      router.push(`/knowledge/${source.id}`);
    } catch (err) {
      setCreateError(messageOf(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Knowledge"
        description={`Company documents AI employees in the ${workspace.name} workspace can answer from.`}
      />

      {isAdmin && (
        <form onSubmit={create} className="flex flex-col gap-1.5">
          <Label htmlFor="source-name">New knowledge source</Label>
          <div className="flex max-w-xl gap-2">
            <Input
              id="source-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pricing and plans"
              maxLength={80}
              aria-invalid={createError !== undefined}
              aria-describedby={createError ? "source-name-error" : undefined}
            />
            <Button type="submit" disabled={creating || name.trim() === ""}>
              <Plus aria-hidden />
              {creating ? "Creating" : "Create"}
            </Button>
          </div>
          {createError && (
            <p id="source-name-error" role="alert" className="text-sm text-destructive">
              {createError}
            </p>
          )}
        </form>
      )}

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="knowledge-sources" label="Loading knowledge sources">
          {(data) => data.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No knowledge sources yet"
          description={
            isAdmin
              ? "Create a source, upload documents to it, then attach it to an AI employee."
              : "An organization admin can create sources and upload documents."
          }
        />
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((source) => (
              <li key={source.id}>
                <Link
                  href={`/knowledge/${source.id}`}
                  className="flex h-full flex-col gap-1 rounded-lg border bg-card p-4 shadow-sm dark:shadow-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                >
                  <span className="truncate font-medium">{source.name}</span>
                  <span className="text-sm text-muted-foreground">
                    {source.documentCount} {source.documentCount === 1 ? "document" : "documents"} · updated{" "}
                    {formatDate(source.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <KnowledgeSearch base={base} />
        </>
          )}
        </Skullet>
      )}
    </div>
  );
});
