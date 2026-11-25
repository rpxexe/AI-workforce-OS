"use client";

import type { CustomerSummary } from "@workforce/shared";
import { Search, Users } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { timeAgo } from "@/components/inbox/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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

export default withWorkspace(function CustomersPage({ workspace }) {
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const base = `/workspaces/${workspace.id}/customers`;
  const { data, error, reload } = useApiQuery<CustomerSummary[]>(search ? `${base}?q=${encodeURIComponent(search)}` : base);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Customers"
        description={`People your AI employees in the ${workspace.name} workspace have talked to, and what they remember about them.`}
      />

      <div className="relative max-w-md">
        <Label htmlFor="customer-search" className="sr-only">
          Search customers
        </Label>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id="customer-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, email, phone or company"
          maxLength={100}
          className="pl-8"
        />
      </div>

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={data} sample={SAMPLE} id="customers-list" label="Loading customers">
          {(data) => <CustomerList data={data} search={search} />}
        </Skullet>
      )}
      {data?.length === 200 && <p className="text-xs text-muted-foreground">Showing the 200 most recent. Search to find others.</p>}
    </div>
  );
});

function CustomerList({ data, search }: { data: CustomerSummary[]; search: string }) {
  const customers = usePaged(data, 20, search);
  return data.length === 0 ? (
        search ? (
          <EmptyState icon={Search} title="No customers match" description={`Nobody found for “${search}”. Try part of a name, email or phone number.`} />
        ) : (
          <EmptyState
            icon={Users}
            title="No customers yet"
            description="Customers appear here after they talk to an AI employee by phone, WhatsApp, web chat, email or test chat."
          />
        )
      ) : (
      <>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Customer</TableHead>
              <TableHead className="hidden md:table-cell">Contact</TableHead>
              <TableHead className="hidden lg:table-cell">Company</TableHead>
              <TableHead className="text-right">Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {customers.rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="max-w-56">
                  <Link href={`/customers/${c.id}`} className="block truncate font-medium hover:underline">
                    {c.name ?? c.externalId}
                  </Link>
                  {c.name && <span className="block truncate text-xs text-muted-foreground">{c.externalId}</span>}
                </TableCell>
                <TableCell className="hidden max-w-56 text-muted-foreground md:table-cell">
                  <span className="block truncate">{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</span>
                </TableCell>
                <TableCell className="hidden max-w-40 truncate text-muted-foreground lg:table-cell">{c.company ?? "—"}</TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground">{timeAgo(c.lastSeenAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <TablePager {...customers.pager} />
      </>
      );
}
