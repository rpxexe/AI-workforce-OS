"use client";

import type { AiSettings } from "@workforce/shared";
import Link from "next/link";
import { Policies } from "@/components/ai/policies";
import { Usage } from "@/components/ai/usage";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin } from "@/lib/workspace";

/** Organization-wide: which model each kind of work uses, and what every model call cost. Keys live in Settings. */
export default function ModelRoutingPage() {
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useApiQuery<AiSettings>("/ai/settings");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Model routing" description="Which model handles each kind of work, what it falls back to, and what every model call cost.">
        <Button variant="outline" size="sm" asChild>
          <Link href="/settings?section=ai-providers">Manage provider keys</Link>
        </Button>
      </PageHeader>
      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : (
        <Tabs defaultValue="policies" className="gap-6">
          <TabsList>
            <TabsTrigger value="policies">Policies</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
          </TabsList>
          <TabsContent value="policies">
            <Policies settings={data} isAdmin={isAdmin} reload={reload} />
          </TabsContent>
          <TabsContent value="usage">
            <Usage />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
