"use client";

import type { EmployeeDetail, Workspace } from "@workforce/shared";
import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ConfigDiff } from "@/components/improvements/config-diff";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useApiQuery } from "@/lib/api";
import { withWorkspace } from "@/lib/workspace";

function Compare({ workspace }: { workspace: Workspace }) {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const { data, error, reload } = useApiQuery<EmployeeDetail>(`/workspaces/${workspace.id}/employees/${id}`);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const latest = data?.versions[0];
  if (!data || !latest) return <LoadingState rows={6} />;

  // Defaults: what is live against the newest version (or the one before it, when the newest is live).
  const older = data.publishedVersion ?? data.versions[1]?.number ?? latest.number;
  const pick = (key: string, fallback: number) => data.versions.find((v) => v.number === Number(params.get(key))) ?? data.versions.find((v) => v.number === fallback);
  const from = pick("from", older === latest.number ? (data.versions[1]?.number ?? older) : older);
  const to = pick("to", latest.number);
  const choose = (key: "from" | "to", value: string) => {
    const next = new URLSearchParams({ from: String(from?.number), to: String(to?.number), [key]: value });
    router.replace(`/employees/${id}/compare?${next}`);
  };
  const label = (n: number) => `v${n}${n === data.publishedVersion ? " (live)" : ""}${n === latest.number ? " (latest)" : ""}`;

  const picker = (key: "from" | "to", value: number | undefined) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`compare-${key}`}>{key === "from" ? "Compare" : "With"}</Label>
      <Select value={String(value)} onValueChange={(v) => choose(key, v)}>
        <SelectTrigger id={`compare-${key}`} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {data.versions.map((v) => (
            <SelectItem key={v.number} value={String(v.number)}>
              {label(v.number)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <Link href={`/employees/${id}`} className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        {latest.name}
      </Link>
      <PageHeader title="Compare versions" description="Instructions and settings that differ between two saved versions. Lines marked − are removed, + added." />
      <div className="flex flex-wrap items-end gap-3">
        {picker("from", from?.number)}
        <ArrowRight className="mb-2.5 size-4 text-muted-foreground" aria-hidden />
        {picker("to", to?.number)}
      </div>
      <Card>
        <CardContent>{from && to ? <ConfigDiff before={from} after={to} /> : <p className="text-sm text-muted-foreground">Choose two versions.</p>}</CardContent>
      </Card>
    </div>
  );
}

export default withWorkspace(function CompareVersionsPage({ workspace }) {
  return (
    // useSearchParams needs a Suspense boundary to prerender.
    <Suspense>
      <Compare workspace={workspace} />
    </Suspense>
  );
});
