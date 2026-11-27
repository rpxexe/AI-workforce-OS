"use client";

import type { KnowledgeSourceCounts, KnowledgeSourceFilter, KnowledgeSourcePage, KnowledgeSourceSummary } from "@workforce/shared";
import { BookOpen, CircleAlert, CircleCheck, Library, LoaderCircle, Search, SearchX } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatDate } from "@/components/employees/meta";
import { CreateSourceDialog } from "@/components/knowledge/create-source-dialog";
import { KnowledgeSearch } from "@/components/knowledge/knowledge-search";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { TablePager, useCursorPaged, type Pager } from "@/components/table-pager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Item, ItemContent, ItemDescription, ItemFooter, ItemMedia, ItemTitle } from "@/components/ui/item";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE_PAGE: KnowledgeSourcePage = {
  nextCursor: null,
  data: Array.from({ length: 6 }, (_, i) => ({
    id: `sample-${i}`,
    name: "Pricing and plans",
    description: "Current price list, plan limits and discounts.",
    documentCount: 12,
    readyDocuments: 12,
    processingDocuments: 0,
    failedDocuments: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  })),
};

// The server filters; each filter's size comes from the summary of the same search.
const FILTERS: Record<KnowledgeSourceFilter, { label: string; count: (c: KnowledgeSourceCounts) => number }> = {
  all: { label: "All", count: (c) => c.sources },
  filled: { label: "With documents", count: (c) => c.sources - c.emptySources },
  empty: { label: "Empty", count: (c) => c.emptySources },
};
type Filter = KnowledgeSourceFilter;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export default withWorkspace(function KnowledgePage({ workspace }) {
  const isAdmin = useIsAdmin();
  const base = `/workspaces/${workspace.id}/knowledge`;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const q = search ? `q=${encodeURIComponent(search)}` : "";
  const summary = useApiQuery<KnowledgeSourceCounts>(`${base}/sources/summary${q && `?${q}`}`, { keepPrevious: true });
  // Cursor pages from the server, by name. A new search or filter starts again at page 1 with no cursor.
  const paged = useCursorPaged(`${search}:${filter}`);
  const list = useApiQuery<KnowledgeSourcePage>(`${base}/sources?filter=${filter}&${paged.query}${q && `&${q}`}`, { keepPrevious: true });
  // While a page loads, `data` is still the previous one: its cursor must not open yet another page.
  const pager = paged.pager({
    total: summary.data && FILTERS[filter].count(summary.data),
    nextCursor: list.loading ? null : (list.data?.nextCursor ?? null),
    rows: list.loading ? 1 : (list.data?.data.length ?? 1),
  });
  const error = summary.error ?? list.error;
  const clear = () => {
    setQuery("");
    setSearch("");
    setFilter("all");
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Knowledge" description={`Company documents AI employees in the ${workspace.name} workspace can answer from.`}>
        {isAdmin && <CreateSourceDialog base={base} />}
      </PageHeader>

      {error ? (
        <ErrorState
          message={error.message}
          onRetry={() => {
            summary.reload();
            list.reload();
          }}
        />
      ) : !search && summary.data?.sources === 0 ? (
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
          <Summary counts={summary.data} search={search} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <InputGroup className="sm:max-w-xs">
              <InputGroupAddon>
                <Search aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search sources"
                aria-label="Search sources by name or description"
                maxLength={100}
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
                  {FILTERS[k].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>

          <Skullet data={list.data} sample={SAMPLE_PAGE} id="knowledge-sources" label="Loading knowledge sources">
            {(page) => <SourceGrid data={page.data} pager={pager} loading={list.loading} clear={clear} />}
          </Skullet>

          <KnowledgeSearch base={base} />
        </div>
      )}
    </div>
  );
});

/** Headline numbers over every source (or every source matching the search), counted on the server. */
function Summary({ counts, search }: { counts: KnowledgeSourceCounts | undefined; search: string }) {
  const value = (pick: (c: KnowledgeSourceCounts) => number) => (counts ? pick(counts) : "—");
  const empty = counts?.emptySources ?? 0;
  const processing = counts?.processingDocuments ?? 0;
  const failed = counts?.failedDocuments ?? 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile
        label="Sources"
        value={value((c) => c.sources)}
        icon={Library}
        hint={
          search
            ? "Matching your search"
            : empty === 0
              ? `${plural(counts?.documents ?? 0, "document")} in all`
              : `${plural(empty, "empty source")}, upload documents to use them`
        }
      />
      <StatTile label="Ready" value={value((c) => c.readyDocuments)} icon={CircleCheck} hint="Documents your employees can answer from" />
      <StatTile
        label="Processing"
        value={value((c) => c.processingDocuments)}
        icon={LoaderCircle}
        hint={processing === 0 ? "Nothing waiting" : "Being read and indexed"}
      />
      <StatTile
        label="Failed"
        value={value((c) => c.failedDocuments)}
        icon={CircleAlert}
        hint={failed === 0 ? "Every document was read" : "Open the source to see why and reprocess"}
      />
    </div>
  );
}

function SourceGrid({ data, pager, loading, clear }: { data: KnowledgeSourceSummary[]; pager: Pager; loading: boolean; clear: () => void }) {
  if (data.length === 0) {
    return (
      <EmptyState icon={SearchX} title="No matching sources" description="Try a different search or filter.">
        <Button variant="outline" size="sm" onClick={clear}>
          Clear filters
        </Button>
      </EmptyState>
    );
  }

  return (
    <div className={`flex flex-col ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Knowledge sources">
        {data.map((source) => (
          <li key={source.id} className="flex">
            <Item variant="outline" asChild className="w-full content-between items-start bg-card">
              <Link href={`/knowledge/${source.id}`}>
                <ItemMedia variant="icon">
                  <BookOpen aria-hidden />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full truncate">{source.name}</ItemTitle>
                  <ItemDescription className={source.description ? undefined : "italic"}>{source.description || "No description"}</ItemDescription>
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
      <TablePager {...pager} />
    </div>
  );
}
