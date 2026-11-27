"use client";

import type { KnowledgeSource, KnowledgeSourcePage } from "@workforce/shared";
import { Search } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { TablePager, useCursorPaged } from "@/components/table-pager";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useApi, useApiQuery } from "@/lib/api";

/**
 * The sources attached to this employee (at most 20, so loaded whole), then the workspace's sources a page at a
 * time with a server search, each with a switch to attach it to this employee.
 */
export function EmployeeKnowledge({ workspaceId, employeeId, canEdit }: { workspaceId: string; employeeId: string; canEdit: boolean }) {
  const api = useApi();
  const attachedPath = `/workspaces/${workspaceId}/employees/${employeeId}/knowledge`;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  // Wait for a pause in typing before asking the server.
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);
  const paged = useCursorPaged(search, 10);
  const all = useApiQuery<KnowledgeSourcePage>(
    `/workspaces/${workspaceId}/knowledge/sources?${paged.query}${search ? `&q=${encodeURIComponent(search)}` : ""}`,
    { keepPrevious: true },
  );
  const attached = useApiQuery<KnowledgeSource[]>(attachedPath);
  const [saving, setSaving] = useState(false);
  // While a page loads, `data` is still the previous one: its cursor must not open yet another page.
  const pager = paged.pager({
    nextCursor: all.loading ? null : (all.data?.nextCursor ?? null),
    rows: all.loading ? 1 : (all.data?.data.length ?? 1),
  });

  const loadError = all.error ?? attached.error;
  if (loadError) return <p className="text-sm text-destructive">{loadError.message}</p>;
  if (!all.data || !attached.data) return <Skeleton className="h-10 w-full" />;
  if (all.data.data.length === 0 && !search && pager.page === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No knowledge sources in this workspace yet.{" "}
        <Link href="/knowledge" className="text-foreground underline underline-offset-4">
          Create one
        </Link>{" "}
        and upload documents to it.
      </p>
    );

  const attachedIds = new Set(attached.data.map((s) => s.id));
  const toggle = async (source: KnowledgeSource, on: boolean) => {
    const sourceId = source.id;
    setSaving(true);
    const sourceIds = [...attachedIds].filter((id) => id !== sourceId).concat(on ? [sourceId] : []);
    try {
      attached.setData(
        await api<KnowledgeSource[]>(attachedPath, { method: "PUT", body: { sourceIds }, toast: `${source.name} ${on ? "attached" : "detached"}` }),
      );
    } catch {
      // The toast in useApi shows why it failed.
    } finally {
      setSaving(false);
    }
  };
  const row = (source: KnowledgeSource, idPrefix: string) => (
    <li key={source.id} className="flex items-center justify-between gap-3">
      <Label htmlFor={`${idPrefix}-${source.id}`} className="flex min-w-0 flex-col items-start gap-0.5 font-normal">
        <span className="max-w-full truncate text-sm font-medium">{source.name}</span>
        <span className="text-xs text-muted-foreground">
          {source.documentCount} {source.documentCount === 1 ? "document" : "documents"}
        </span>
      </Label>
      <Switch
        id={`${idPrefix}-${source.id}`}
        checked={attachedIds.has(source.id)}
        disabled={!canEdit || saving}
        onCheckedChange={(on) => toggle(source, on)}
      />
    </li>
  );

  return (
    <div className="flex flex-col gap-3">
      {attached.data.length > 0 && (
        <section aria-label="Attached sources" className="flex flex-col gap-3">
          <p className="text-xs font-medium text-muted-foreground">Attached</p>
          <ul className="flex flex-col gap-3">{attached.data.map((s) => row(s, "attached"))}</ul>
        </section>
      )}
      <section aria-label="All sources" className="flex flex-col gap-3">
        {attached.data.length > 0 && <p className="text-xs font-medium text-muted-foreground">All sources</p>}
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sources"
            aria-label="Search knowledge sources"
            maxLength={100}
          />
        </InputGroup>
        {all.data.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sources match “{search}”.</p>
        ) : (
          <ul className={`flex flex-col gap-3 ${all.loading ? "opacity-60" : ""}`} aria-busy={all.loading}>
            {all.data.data.map((s) => row(s, "source"))}
          </ul>
        )}
        <TablePager {...pager} />
      </section>
      <p className="text-xs text-muted-foreground">Changes apply to the next message; they are not part of a version.</p>
    </div>
  );
}
