"use client";

import type { KnowledgeSourceSummary } from "@workforce/shared";
import { BookOpen, CircleAlert, CircleCheck, Library, LoaderCircle, Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { formatDate } from "@/components/employees/meta";
import { CreateSourceDialog } from "@/components/knowledge/create-source-dialog";
import { KnowledgeSearch } from "@/components/knowledge/knowledge-search";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: KnowledgeSourceSummary[] = Array.from({ length: 6 }, (_, i) => ({
  id: `sample-${i}`,
  name: "Pricing and plans",
  description: "Current price list, plan limits and discounts.",
  documentCount: 12,
  readyDocuments: 12,
  processingDocuments: 0,
  failedDocuments: 0,
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

const FILTERS = { all: "All", filled: "With documents", empty: "Empty" } as const;
type Filter = keyof typeof FILTERS;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default withWorkspace(function KnowledgePage({ workspace }) {
  const isAdmin = useIsAdmin();
  const base = `/workspaces/${workspace.id}/knowledge`;
  const { data, error, reload } = useApiQuery<KnowledgeSourceSummary[]>(`${base}/sources`);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Knowledge"
        description={`Company documents AI employees in the ${workspace.name} workspace can answer from.`}
      >
        {isAdmin && <CreateSourceDialog base={base} />}
      </PageHeader>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="knowledge-sources" label="Loading knowledge sources">
          {(data) =>
            data.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="No knowledge sources yet"
                description={
                  isAdmin
                    ? "Create a source, upload documents to it, then attach it to an AI employee."
                    : "An organization admin can create sources and upload documents."
                }
              >
                {isAdmin && <CreateSourceDialog base={base} label="Create your first source" />}
              </EmptyState>
            ) : (
              <div className="flex flex-col gap-6">
                <Summary data={data} />

                <div className="flex flex-wrap items-center justify-between gap-3">
                  <InputGroup className="sm:max-w-xs">
                    <InputGroupAddon>
                      <Search aria-hidden />
                    </InputGroupAddon>
                    <InputGroupInput
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search sources"
                      aria-label="Search sources by name or description"
                    />
                  </InputGroup>
                  <ToggleGroup
                    type="single"
                    variant="outline"
                    size="sm"
                    value={filter}
                    onValueChange={(v) => v && setFilter(v as Filter)}
                    aria-label="Filter sources"
                  >
                    {(Object.keys(FILTERS) as Filter[]).map((k) => (
                      <ToggleGroupItem key={k} value={k} className="px-3">
                        {FILTERS[k]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>

                <SourceGrid
                  data={data}
                  query={query}
                  filter={filter}
                  clear={() => {
                    setQuery("");
                    setFilter("all");
                  }}
                />

                <KnowledgeSearch base={base} />
              </div>
            )
          }
        </Skullet>
      )}
    </div>
  );
});

/** Headline numbers over every source, with documents counted by status on the server. */
function Summary({ data }: { data: KnowledgeSourceSummary[] }) {
  const sum = (pick: (s: KnowledgeSourceSummary) => number) => data.reduce((total, s) => total + pick(s), 0);
  const documents = sum((s) => s.documentCount);
  const processing = sum((s) => s.processingDocuments);
  const failed = sum((s) => s.failedDocuments);
  const empty = data.filter((s) => s.documentCount === 0).length;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Sources"
        value={data.length}
        icon={Library}
        hint={empty === 0 ? `${plural(documents, "document")} in all` : `${plural(empty, "empty source")}, upload documents to use them`}
      />
      <StatTile label="Ready" value={sum((s) => s.readyDocuments)} icon={CircleCheck} hint="Documents your employees can answer from" />
      <StatTile label="Processing" value={processing} icon={LoaderCircle} hint={processing === 0 ? "Nothing waiting" : "Being read and indexed"} />
      <StatTile
        label="Failed"
        value={failed}
        icon={CircleAlert}
        hint={failed === 0 ? "Every document was read" : "Open the source to see why and reprocess"}
      />
    </div>
  );
}

function SourceGrid({
  data,
  query,
  filter,
  clear,
}: {
  data: KnowledgeSourceSummary[];
  query: string;
  filter: Filter;
  clear: () => void;
}) {
  const q = query.trim().toLowerCase();
  const shown = data.filter(
    (s) =>
      (filter === "all" || (filter === "empty") === (s.documentCount === 0)) &&
      (q === "" || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)),
  );

  if (shown.length === 0) {
    return (
      <EmptyState icon={SearchX} title="No matching sources" description="Try a different search or filter.">
        <Button variant="outline" size="sm" onClick={clear}>
          Clear filters
        </Button>
      </EmptyState>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Knowledge sources">
      {shown.map((source) => (
        <li key={source.id} className="flex">
          <Item variant="outline" asChild className="w-full content-between items-start bg-card">
            <Link href={`/knowledge/${source.id}`}>
              <ItemMedia variant="icon">
                <BookOpen aria-hidden />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="w-full truncate">{source.name}</ItemTitle>
                <ItemDescription className={source.description ? undefined : "italic"}>
                  {source.description || "No description"}
                </ItemDescription>
              </ItemContent>
              <ItemFooter>
                <span className="flex flex-wrap gap-1.5">
                  {source.documentCount === 0 ? (
                    <Badge variant="outline" className="border-warning/40 text-warning">
                      Empty
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="tabular-nums">
                      {plural(source.documentCount, "document")}
                    </Badge>
                  )}
                  {source.processingDocuments > 0 && (
                    <Badge variant="outline" className="border-info/40 text-info tabular-nums">
                      {source.processingDocuments} processing
                    </Badge>
                  )}
                  {source.failedDocuments > 0 && (
                    <Badge variant="outline" className="border-destructive/40 text-destructive tabular-nums">
                      {source.failedDocuments} failed
                    </Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">Updated {formatDate(source.updatedAt)}</span>
              </ItemFooter>
            </Link>
          </Item>
        </li>
      ))}
    </ul>
  );
}
