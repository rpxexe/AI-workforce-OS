"use client";

import { OrganizationProfile, UserProfile } from "@clerk/nextjs";
import { workspaceSchema, type Workspace } from "@workforce/shared";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { formatDate } from "@/components/employees/meta";
import { PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/lib/api";
import { useIsAdmin, useWorkspaces } from "@/lib/workspace";

function Workspaces() {
  const state = useWorkspaces();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const [name, setName] = useState("");
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  if (!state.workspace) return null;
  const { workspaces = [], workspace: current, select, reload } = state;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = workspaceSchema.safeParse({ name });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    setError(undefined);
    setSaving(true);
    try {
      const created = await api<Workspace>("/workspaces", { method: "POST", body: parsed.data });
      setName("");
      reload();
      select(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspaces</CardTitle>
        <CardDescription>
          Workspaces keep AI employees apart inside your organization, for example one per brand or team.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <ul className="flex flex-col divide-y rounded-lg border">
          {workspaces.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{w.name}</span>
                <span className="text-sm text-muted-foreground">Created {formatDate(w.createdAt)}</span>
              </span>
              {w.id === current.id ? (
                <Badge variant="secondary">Current</Badge>
              ) : (
                <Button variant="outline" size="sm" onClick={() => select(w.id)}>
                  Switch
                </Button>
              )}
            </li>
          ))}
        </ul>

        {isAdmin ? (
          <form onSubmit={create} noValidate className="flex flex-col gap-1.5">
            <Label htmlFor="workspace-name">New workspace</Label>
            <div className="flex max-w-md gap-2">
              <Input
                id="workspace-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Support"
                maxLength={60}
                autoComplete="off"
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? "workspace-name-error" : undefined}
              />
              <Button type="submit" disabled={saving}>
                {saving ? "Creating…" : "Create"}
              </Button>
            </div>
            {error && (
              <p id="workspace-name-error" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">Only organization admins can create workspaces.</p>
        )}
      </CardContent>
    </Card>
  );
}

const TABS = ["workspaces", "organization", "profile"] as const;

function SettingsTabs() {
  const requested = useSearchParams().get("tab");
  const initial = TABS.find((t) => t === requested) ?? "workspaces";

  return (
    <Tabs defaultValue={initial} className="gap-6">
      <TabsList>
        <TabsTrigger value="workspaces">Workspaces</TabsTrigger>
        <TabsTrigger value="organization">Organization</TabsTrigger>
        <TabsTrigger value="profile">Profile</TabsTrigger>
      </TabsList>
      <TabsContent value="workspaces">
        <Workspaces />
      </TabsContent>
      {/* Clerk's own screens: organization details, members, invitations and roles; and the user's account. */}
      <TabsContent value="organization" className="overflow-x-auto">
        <OrganizationProfile routing="hash" />
      </TabsContent>
      <TabsContent value="profile" className="overflow-x-auto">
        <UserProfile routing="hash" />
      </TabsContent>
    </Tabs>
  );
}

export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Settings" description="Workspaces, your organization and its members, and your own account." />
      {/* useSearchParams needs a Suspense boundary to prerender. */}
      <Suspense>
        <SettingsTabs />
      </Suspense>
    </div>
  );
}
