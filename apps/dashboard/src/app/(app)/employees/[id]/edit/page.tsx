"use client";

import { defaultEmployeeConfig, type EmployeeDetail } from "@workforce/shared";
import { useParams, useRouter } from "next/navigation";
import { EmployeeForm } from "@/components/employees/employee-form";
import { ErrorState, PageHeader } from "@/components/states";
import { Skeleton as Skullet } from "skullet/react";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: EmployeeDetail = {
  id: "sample",
  status: "ACTIVE",
  publishedVersion: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  versions: [
    {
      ...defaultEmployeeConfig("Asia/Kolkata"),
      name: "Sample employee",
      role: "Customer support agent",
      description: "Answers customer questions about orders, deliveries and returns.",
      personality: "Warm, patient and concise. Explains next steps clearly and never promises what it cannot do.",
      systemInstructions: "You help customers of an online store with their orders. Ask for the order number before checking its status.",
      goals: ["Answer in the first reply", "Collect the order number", "Hand off when the customer asks for a person"],
      number: 1,
      createdBy: "sample-user",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

export default withWorkspace(function EditEmployeePage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  const path = `/workspaces/${workspace.id}/employees/${id}`;
  const { data, error, reload } = useApiQuery<EmployeeDetail>(path);

  if (!isAdmin) return <ErrorState message="Only organization admins can edit AI employees." />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const view = (data: EmployeeDetail) => {
    const latest = data.versions[0];
    if (!latest) return null;
    const { number } = latest;
    const live = data.publishedVersion;

    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={`Edit ${latest.name}`} description={`Based on version ${number}.`} />
        <EmployeeForm
          // Remount when a newer version arrives, so the form never shows a stale draft;
          // the sample render gets its own key so the real form never keeps state seeded from the sample.
          key={data === SAMPLE ? "sample" : number}
          // A version is its configuration plus metadata; the form's schema drops the metadata on submit.
          initial={latest}
          submitLabel={`Save as version ${number + 1}`}
          note={
            live === null
              ? "Saving creates a new version. Nothing is live until you publish."
              : `Saving creates a new version. Version ${live} stays live until you publish.`
          }
          cancelHref={`/employees/${id}`}
          onSubmit={async (next) => {
            await api<EmployeeDetail>(path, { method: "PUT", body: next, toast: `Version ${number + 1} saved` });
            router.push(`/employees/${id}`);
          }}
        />
      </div>
    );
  };

  return (
    <Skullet data={data} sample={SAMPLE} id="employee-edit" label="Loading employee">
      {view}
    </Skullet>
  );
});
