"use client";

import type { CustomerSummary } from "@workforce/shared";
import { Activity, AtSign, Building2, ChevronRight, Mail, Phone, Search, SearchX, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CustomerAvatar, RelativeTime, seenThisWeek } from "@/components/customers/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApiQuery } from "@/lib/api";
import { withWorkspace } from "@/lib/workspace";
import { TablePager, usePaged } from "@/components/table-pager";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: CustomerSummary[] = Array.from({ length: 6 }, (_, i) => ({
  id: `sample-${i}`,
  externalId: "+919876543210",
  name: "Priya Sharma",
  email: "priya.sharma@example.com",
  phone: "+919876543210",
  company: "Sharma Textiles",
  lastSeenAt: "2026-01-01T00:00:00.000Z",
}));

const FILTERS = {
  all: { label: "All", match: () => true },
  week: { label: "Seen this week", match: (c: CustomerSummary) => seenThisWeek(c.lastSeenAt) },
  email: { label: "Has email", match: (c: CustomerSummary) => c.email !== null },
  phone: { label: "Has phone", match: (c: CustomerSummary) => c.phone !== null },
} satisfies Record<string, { label: string; match: (c: CustomerSummary) => boolean }>;
type Filter = keyof typeof FILTERS;

export default withWorkspace(function CustomersPage({ workspace }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const base = `/workspaces/${workspace.id}/customers`;
  const { data, error, loading, reload } = useApiQuery<CustomerSummary[]>(search ? `${base}?q=${encodeURIComponent(search)}` : base, {
    keepPrevious: true,
  });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Customers"
        description={`People your AI employees in the ${workspace.name} workspace have talked to, and what they remember about them.`}
      />

      {!error && <Stats data={data} search={search} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <InputGroup className="sm:max-w-sm">
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, email, phone or company"
            aria-label="Search customers"
            maxLength={100}
          />
        </InputGroup>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
          aria-label="Filter customers"
          className="flex-wrap"
        >
          {(Object.keys(FILTERS) as Filter[]).map((k) => (
            <ToggleGroupItem key={k} value={k} className="px-3">
              {FILTERS[k].label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="customers-list" label="Loading customers">
          {(data) => (
            <CustomerList
              data={data}
              search={search}
              filter={filter}
              loading={loading}
              clearFilter={() => setFilter("all")}
            />
          )}
        </Skullet>
      )}
      {data?.length === 200 && <p className="text-xs text-muted-foreground">Showing the 200 most recent. Search to find others.</p>}
    </div>
  );
});

/** Counts over the rows already loaded (the 200 most recent, or the search results). */
function Stats({ data, search }: { data: CustomerSummary[] | undefined; search: string }) {
  const count = (match: (c: CustomerSummary) => boolean) => (data ? data.filter(match).length.toLocaleString() : "—");
  const scope = search ? "Matching your search" : data?.length === 200 ? "Of the 200 most recent" : "In this workspace";
  return (
    <section aria-label="Customer summary" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatTile label="Customers" icon={Users} value={count(() => true)} hint={scope} />
      <StatTile label="Seen this week" icon={Activity} value={count(FILTERS.week.match)} hint="Talked in the last 7 days" />
      <StatTile label="Reachable" icon={AtSign} value={count((c) => c.email !== null || c.phone !== null)} hint="Have an email or phone number" />
      <StatTile label="With a company" icon={Building2} value={count((c) => c.company !== null)} hint="Business customers" />
    </section>
  );
}

function CustomerList({
  data,
  search,
  filter,
  loading,
  clearFilter,
}: {
  data: CustomerSummary[];
  search: string;
  filter: Filter;
  loading: boolean;
  clearFilter: () => void;
}) {
  const matches = data.filter(FILTERS[filter].match);
  const customers = usePaged(matches, 20, `${search}:${filter}`);

  if (data.length === 0) {
    return search ? (
      <EmptyState icon={SearchX} title="No customers match" description={`Nobody found for “${search}”. Try part of a name, email or phone number.`} />
    ) : (
      <EmptyState
        icon={Users}
        title="No customers yet"
        description="Customers appear here after they talk to an AI employee by phone, WhatsApp, web chat, email or test chat."
      />
    );
  }
  if (matches.length === 0) {
    return (
      <EmptyState icon={SearchX} title={`No customers match “${FILTERS[filter].label}”`} description="Try another filter.">
        <Button variant="outline" onClick={clearFilter}>
          Show all
        </Button>
      </EmptyState>
    );
  }

  return (
    <Card className={`gap-0 py-0 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Customer</TableHead>
            <TableHead className="hidden md:table-cell">Contact</TableHead>
            <TableHead className="hidden lg:table-cell">Company</TableHead>
            <TableHead className="text-right">Last seen</TableHead>
            <TableHead className="w-10">
              <span className="sr-only">Opens</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.rows.map((c) => (
            <TableRow key={c.id} className="group">
              <TableCell className="max-w-64">
                <Link href={`/customers/${c.id}`} className="flex min-w-0 items-center gap-3">
                  <CustomerAvatar customer={c} />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium group-hover:underline">{c.name ?? c.externalId}</span>
                    {c.name && <span className="truncate text-xs text-muted-foreground">{c.externalId}</span>}
                  </span>
                </Link>
              </TableCell>
              <TableCell className="hidden max-w-64 text-muted-foreground md:table-cell">
                {c.email || c.phone ? (
                  <span className="flex min-w-0 flex-col gap-0.5 text-sm">
                    {c.email && (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Mail className="size-3.5 shrink-0" aria-hidden />
                        <span className="sr-only">Email:</span>
                        <span className="truncate">{c.email}</span>
                      </span>
                    )}
                    {c.phone && (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Phone className="size-3.5 shrink-0" aria-hidden />
                        <span className="sr-only">Phone:</span>
                        <span className="truncate tabular-nums">{c.phone}</span>
                      </span>
                    )}
                  </span>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell className="hidden max-w-48 text-muted-foreground lg:table-cell">
                <span className="block truncate">{c.company ?? "—"}</span>
              </TableCell>
              <TableCell className="text-right text-muted-foreground">
                <RelativeTime iso={c.lastSeenAt} />
              </TableCell>
              <TableCell>
                {/* The name is the link; the chevron only hints the row opens. */}
                <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <TablePager {...customers.pager} className="px-4 pb-3" />
    </Card>
  );
}
