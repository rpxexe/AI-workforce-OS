"use client";

import type { EmployeeDetail, EmployeePage, EmployeeStatus, EmployeeSummary } from "@workforce/shared";
import { Archive, Bot, Copy, Ellipsis, Eye, Pencil, Plus, Search, SearchX, Undo2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { EmployeeAvatar, StatusBadge, formatDate, versionLabel } from "@/components/employees/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LANGUAGES } from "@workforce/shared";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";
import { TablePager, useCursorPaged, usePaged, type Pager } from "@/components/table-pager";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: EmployeeSummary[] = Array.from({ length: 5 }, (_, i) => ({
  id: `sample-${i}`,
  name: "Sample employee",
  role: "Customer support agent",
  description: "",
  avatar: "bot",
  language: "en",
  status: "ACTIVE",
  latestVersion: 2,
  publishedVersion: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
}));

export default withWorkspace(function EmployeesPage({ workspace }) {
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  const base = `/workspaces/${workspace.id}/employees`;

  const [archived, setArchived] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  // The Archived tab asks the server; wait for a pause in typing first.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const searchRef = useRef<HTMLInputElement>(null);

  // Current: the whole tab (plans cap employees at 50), searched and paged here with no more requests.
  const current = useApiQuery<EmployeeSummary[]>(archived ? null : `${base}?archived=false`, { keepPrevious: true });
  const needle = query.trim().toLowerCase();
  const matches = current.data && (needle ? current.data.filter((e) => e.name.toLowerCase().includes(needle) || e.role.toLowerCase().includes(needle)) : current.data);
  const local = usePaged(matches ?? [], 20, needle);
  // Archived: not plan-limited, so cursor pages and the search come from the server (a new search starts at page 1).
  const paged = useCursorPaged(search);
  const old = useApiQuery<EmployeePage>(
    archived ? `${base}?archived=true&${paged.query}${search ? `&q=${encodeURIComponent(search)}` : ""}` : null,
    { keepPrevious: true },
  );
  // While a page loads, `old.data` is still the previous one: its cursor must not open yet another page.
  const serverPager = paged.pager({ nextCursor: old.loading ? null : (old.data?.nextCursor ?? null), rows: old.loading ? 1 : (old.data?.data.length ?? 1) });

  const { error, loading, reload } = archived ? old : current;
  const view = archived
    ? old.data && { rows: old.data.data, pager: serverPager, searching: search !== "" }
    : matches && { rows: local.rows, pager: local.pager, searching: needle !== "" };
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const nameOf = (id: string) => view?.rows.find((e) => e.id === id)?.name ?? "Employee";

  /** Runs a row action, then refreshes the list. */
  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      reload();
    } catch {
      // The toast in useApi shows why it failed.
    }
  };
  const setStatus = (id: string, status: "PAUSED" | "ARCHIVED") =>
    run(() =>
      api(`${base}/${id}/status`, {
        method: "PATCH",
        body: { status },
        toast: `${nameOf(id)} ${status === "ARCHIVED" ? "archived" : "restored"}`,
      }),
    );
  const duplicate = (id: string) =>
    run(async () => {
      const copy = await api<EmployeeDetail>(`${base}/${id}/duplicate`, { method: "POST", toast: `${nameOf(id)} duplicated` });
      router.push(`/employees/${copy.id}`);
    });

  const newButton = isAdmin && (
    <Button asChild>
      <Link href="/employees/new">
        <Plus aria-hidden />
        New employee
      </Link>
    </Button>
  );

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Employees" description={`AI employees in the ${workspace.name} workspace.`}>
        {newButton}
      </PageHeader>

      <Tabs value={archived ? "archived" : "current"} onValueChange={(v) => {
          setArchived(v === "archived");
          setQuery("");
        }}
      >
        <TabsList>
          <TabsTrigger value="current">Current</TabsTrigger>
          <TabsTrigger value="archived">Archived</TabsTrigger>
        </TabsList>
      </Tabs>

      {!error && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <InputGroup className="sm:max-w-xs">
            <InputGroupAddon>
              <Search aria-hidden />
            </InputGroupAddon>
            <InputGroupInput
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by name or role"
              aria-label="Search by name or role"
              maxLength={100}
            />
          </InputGroup>
          {current.data && !archived && <Counts data={current.data} />}
        </div>
      )}

      {error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : (
        <Skullet data={view} sample={{ rows: SAMPLE, pager: local.pager, searching: false }} id="employees-list" label="Loading employees">
          {(view) => (
            <EmployeeList
              {...view}
              archived={archived}
              query={query}
              clearQuery={() => {
                setQuery("");
                // The Clear button unmounts with the empty state; keep keyboard focus in the search box.
                searchRef.current?.focus();
              }}
              isAdmin={isAdmin}
              loading={loading}
              newButton={newButton}
              duplicate={duplicate}
              setStatus={setStatus}
              setConfirm={setConfirm}
            />
          )}
        </Skullet>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
});

/** Counts over the whole tab, not the search or the page. */
function Counts({ data }: { data: EmployeeSummary[] }) {
  const counts = { DRAFT: 0, ACTIVE: 0, PAUSED: 0, ARCHIVED: 0 } satisfies Record<EmployeeStatus, number>;
  for (const e of data) counts[e.status]++;
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant="outline">{counts.ACTIVE} active</Badge>
      <Badge variant="outline">{counts.PAUSED} paused</Badge>
      <Badge variant="outline">{counts.DRAFT} draft</Badge>
    </div>
  );
}

function EmployeeList({
  rows,
  pager,
  searching,
  archived,
  query,
  clearQuery,
  isAdmin,
  loading,
  newButton,
  duplicate,
  setStatus,
  setConfirm,
}: {
  rows: EmployeeSummary[];
  pager: Pager;
  searching: boolean;
  archived: boolean;
  query: string;
  clearQuery: () => void;
  isAdmin: boolean;
  loading: boolean;
  newButton: ReactNode;
  duplicate: (id: string) => void;
  setStatus: (id: string, status: "PAUSED" | "ARCHIVED") => void;
  setConfirm: (confirm: Confirmation) => void;
}) {
  // Page 1 has no rows: the tab is empty, or nothing matches the search.
  return rows.length === 0 && pager.page === 0 && !searching ? (
        archived ? (
          <EmptyState icon={Archive} title="No archived employees" description="Employees you archive are kept here and can be restored." />
        ) : (
          <EmptyState
            icon={Bot}
            title="No employees yet"
            description={
              isAdmin
                ? "Create your first AI employee to give it a role, a personality and goals."
                : "An organization admin has not created any AI employees in this workspace yet."
            }
          >
            {newButton}
          </EmptyState>
        )
      ) : rows.length === 0 ? (
        <EmptyState icon={SearchX} title={`No employees match "${query.trim()}"`} description="Try another name or role.">
          <Button variant="outline" onClick={clearQuery}>
            Clear search
          </Button>
        </EmptyState>
      ) : (
        <Card className={`gap-0 py-0 ${loading ? "opacity-60" : ""}`} aria-busy={loading}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="hidden md:table-cell">Language</TableHead>
                <TableHead className="hidden sm:table-cell">Version</TableHead>
                <TableHead className="hidden lg:table-cell">Updated</TableHead>
                <TableHead className="w-10">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id}>
                  <TableCell>
                    <Link href={`/employees/${e.id}`} className="group flex min-w-0 items-center gap-3">
                      <EmployeeAvatar avatar={e.avatar} />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate font-medium group-hover:underline">{e.name}</span>
                        <span className="truncate text-sm text-muted-foreground">{e.role}</span>
                      </span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={e.status} />
                  </TableCell>
                  <TableCell className="hidden md:table-cell">{LANGUAGES[e.language]}</TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <span className="flex flex-wrap gap-1.5" title={versionLabel(e.latestVersion, e.publishedVersion)}>
                      {e.publishedVersion !== null && <Badge className="tabular-nums">Live v{e.publishedVersion}</Badge>}
                      {e.latestVersion !== e.publishedVersion && (
                        <Badge variant="secondary" className="tabular-nums">
                          Draft v{e.latestVersion}
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">{formatDate(e.updatedAt)}</TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" aria-label={`Actions for ${e.name}`}>
                          <Ellipsis aria-hidden />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/employees/${e.id}`}>
                            <Eye aria-hidden />
                            View
                          </Link>
                        </DropdownMenuItem>
                        {isAdmin && (
                          <>
                            <DropdownMenuItem asChild>
                              <Link href={`/employees/${e.id}/edit`}>
                                <Pencil aria-hidden />
                                Edit
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => duplicate(e.id)}>
                              <Copy aria-hidden />
                              Duplicate
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {e.status === "ARCHIVED" ? (
                              <DropdownMenuItem onSelect={() => setStatus(e.id, "PAUSED")}>
                                <Undo2 aria-hidden />
                                Restore
                              </DropdownMenuItem>
                            ) : (
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() =>
                                  setConfirm({
                                    title: `Archive ${e.name}?`,
                                    description:
                                      "It stops working and moves to the Archived tab. Its versions are kept and you can restore it later.",
                                    confirmLabel: "Archive",
                                    onConfirm: () => setStatus(e.id, "ARCHIVED"),
                                  })
                                }
                              >
                                <Archive aria-hidden />
                                Archive
                              </DropdownMenuItem>
                            )}
                          </>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <TablePager {...pager} className="px-4 pb-3" />
        </Card>
      );
}
