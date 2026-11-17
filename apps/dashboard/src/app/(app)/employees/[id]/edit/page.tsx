"use client";

import type { EmployeeDetail } from "@workforce/shared";
import { useParams, useRouter } from "next/navigation";
import { EmployeeForm } from "@/components/employees/employee-form";
import { ErrorState, LoadingState, PageHeader } from "@/components/states";
import { useApi, useApiQuery } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

export default withWorkspace(function EditEmployeePage({ workspace }) {
  const { id } = useParams<{ id: string }>();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  const path = `/workspaces/${workspace.id}/employees/${id}`;
  const { data, error, reload } = useApiQuery<EmployeeDetail>(path);

  if (!isAdmin) return <ErrorState message="Only organization admins can edit AI employees." />;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const latest = data?.versions[0];
  if (!data || !latest) return <LoadingState rows={6} />;

  const { number } = latest;
  const live = data.publishedVersion;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={`Edit ${latest.name}`} description={`Based on version ${number}.`} />
      <EmployeeForm
        // Remount when a newer version arrives, so the form never shows a stale draft.
        key={number}
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
          await api<EmployeeDetail>(path, { method: "PUT", body: next });
          router.push(`/employees/${id}`);
        }}
      />
    </div>
  );
});
