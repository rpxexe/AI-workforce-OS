"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EvaluatorForm } from "@/components/quality/evaluator-form";
import { PageHeader } from "@/components/states";
import { Card, CardContent } from "@/components/ui/card";
import { useApi } from "@/lib/api";
import { withWorkspace } from "@/lib/workspace";

export default withWorkspace(function NewEvaluatorPage({ workspace }) {
  const api = useApi();
  const router = useRouter();
  return (
    <div className="flex flex-col gap-6">
      <Link href="/quality" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Quality
      </Link>
      <PageHeader title="New evaluator" description="Once saved and on, it grades every conversation from then on." />
      <Card>
        <CardContent>
          <EvaluatorForm
            submitLabel="Create evaluator"
            onSubmit={async (body) => {
              const { id } = await api<{ id: string }>(`/workspaces/${workspace.id}/evaluators`, { method: "POST", body });
              router.push(`/quality/evaluators/${id}`);
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
});
