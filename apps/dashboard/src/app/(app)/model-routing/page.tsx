"use client";

import type { AiSettings } from "@workforce/shared";
import Link from "next/link";
import { Policies } from "@/components/ai/policies";
import { Usage } from "@/components/ai/usage";
import { Skeleton as Skullet } from "skullet/react";
import { ErrorState, PageHeader } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApiQuery } from "@/lib/api";
import { useIsAdmin } from "@/lib/workspace";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: AiSettings = {
  platform: { provider: "openai", model: "gpt-4o-mini" },
  credentials: [
    {
      id: "sample-credential",
      name: "Production OpenAI key",
      kind: "openai",
      baseUrl: null,
      keyHint: "a1b2",
      models: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  policies: [
    {
      task: "default",
      primary: { credentialId: "sample-credential", model: "gpt-4o-mini" },
      fallbacks: [{ credentialId: null, model: "gpt-4o-mini" }],
      maxCostUsd: null,
      timeoutMs: 30_000,
      allowedProviders: [],
      strategy: "ordered",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      task: "chat",
      primary: { credentialId: "sample-credential", model: "gpt-4o" },
      fallbacks: [],
      maxCostUsd: 0.05,
      timeoutMs: null,
      allowedProviders: [],
      strategy: "ordered",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  canStoreKeys: true,
};

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
      ) : (
        <Skullet data={data} sample={SAMPLE} id="model-routing" label="Loading model routing">
          {(data) => (
            <Tabs defaultValue="policies" className="gap-6">
              <TabsList>
                <TabsTrigger value="policies">Policies</TabsTrigger>
                <TabsTrigger value="usage">Usage</TabsTrigger>
              </TabsList>
              <TabsContent value="policies">
                <Policies settings={data} isAdmin={isAdmin} reload={reload} />
              </TabsContent>
              <TabsContent value="usage">
                {/* Usage fetches its own data, so it never runs in the sample render. */}
                {data === SAMPLE ? null : <Usage />}
              </TabsContent>
            </Tabs>
          )}
        </Skullet>
      )}
    </div>
  );
}
