"use client";

import type { KnowledgeMatch } from "@workforce/shared";
import { FileText, Search } from "lucide-react";
import Link from "next/link";
import { useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemContent, ItemDescription, ItemHeader, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Spinner } from "@/components/ui/spinner";
import { useApi } from "@/lib/api";

/** Shows which passages a question would retrieve, across every source in the workspace. */
export function KnowledgeSearch({ base }: { base: string }) {
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
        <CardTitle>Test retrieval</CardTitle>
        <CardDescription>
          Ask a question the way a customer would to see which passages an AI employee would be given.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={search} className="flex gap-2">
          <InputGroup>
            <InputGroupAddon>
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What is the enterprise plan price?"
              aria-label="Question"
              maxLength={1000}
            />
          </InputGroup>
          <Button type="submit" variant="outline" disabled={searching || query.trim() === ""}>
            {searching && <Spinner />}
            {searching ? "Searching" : "Search"}
          </Button>
        </form>
        <div aria-live="polite" className="flex flex-col gap-3">
          {result &&
            (result.matches.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing found for “{result.query}”. Check that documents have finished processing.
              </p>
            ) : (
              <ol className="flex flex-col gap-2">
                {result.matches.map((m) => (
                  <Item key={m.chunkId} variant="outline" size="sm" asChild>
                    <li>
                      <ItemMedia variant="icon">
                        <FileText aria-hidden />
                      </ItemMedia>
                      <ItemContent className="min-w-0 gap-1.5">
                        <ItemHeader className="gap-2">
                          <ItemTitle className="min-w-0">
                            <Link href={`/knowledge/${m.sourceId}`} className="truncate hover:underline">
                              {m.documentName}
                            </Link>
                          </ItemTitle>
                          <Badge variant="secondary" className="tabular-nums">
                            {Math.round(m.score * 100)}% match
                          </Badge>
                        </ItemHeader>
                        <p className="text-xs text-muted-foreground">
                          {m.sourceName}
                          {m.page !== null && ` · page ${m.page}`}
                        </p>
                        <ItemDescription className="line-clamp-4 whitespace-pre-wrap text-foreground">{m.content}</ItemDescription>
                      </ItemContent>
                    </li>
                  </Item>
                ))}
              </ol>
            ))}
        </div>
      </CardContent>
    </Card>
  );
}
