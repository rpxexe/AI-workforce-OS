"use client";

import type { AiSettings } from "@workforce/shared";
import { Credentials } from "@/components/ai/credentials";
import { Policies } from "@/components/ai/policies";
import { Usage } from "@/components/ai/usage";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin } from "@/lib/workspace";

/** Organization-wide: keys, policies and usage apply to every workspace. */
export default function AiModelsPage() {
  const isAdmin = useIsAdmin();
  const { data, error, reload } = useApiQuery<AiSettings>("/ai/settings");

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="AI models" description="Your own provider keys, which models each kind of work uses, and what every model call cost." />
      {error && !data ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : !data ? (
        <LoadingState rows={4} />
      ) : (
        <Tabs defaultValue="policies" className="gap-6">
          <TabsList>
            <TabsTrigger value="policies">Policies</TabsTrigger>
            <TabsTrigger value="keys">Keys</TabsTrigger>
            <TabsTrigger value="usage">Usage</TabsTrigger>
          </TabsList>
          <TabsContent value="policies">
            <Policies settings={data} isAdmin={isAdmin} reload={reload} />
          </TabsContent>
          <TabsContent value="keys">
            <Credentials settings={data} isAdmin={isAdmin} reload={reload} />
          </TabsContent>
          <TabsContent value="usage">
            <Usage />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
