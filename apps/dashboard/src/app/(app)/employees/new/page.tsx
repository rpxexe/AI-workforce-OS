"use client";

import { defaultEmployeeConfig, type EmployeeDetail } from "@workforce/shared";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { EmployeeForm } from "@/components/employees/employee-form";
import { ErrorState, PageHeader } from "@/components/states";
import { useApi } from "@/lib/api";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

export default withWorkspace(function NewEmployeePage({ workspace }) {
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  // Start in the viewer's own time zone; they can change it.
  const [initial] = useState(() => defaultEmployeeConfig(Intl.DateTimeFormat().resolvedOptions().timeZone));
  // Next.js keeps this page mounted while hidden; a new key gives the next visit an empty form.
  const [formKey, setFormKey] = useState(0);

  if (!isAdmin) return <ErrorState message="Only organization admins can create AI employees." />;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="New employee" description="It starts as a draft. Nothing goes live until you publish it." />
      <EmployeeForm
        key={formKey}
        initial={initial}
        submitLabel="Create employee"
        cancelHref="/employees"
        onSubmit={async (config) => {
          const created = await api<EmployeeDetail>(`/workspaces/${workspace.id}/employees`, {
            method: "POST",
            body: config,
          });
          setFormKey((k) => k + 1);
          router.push(`/employees/${created.id}`);
        }}
      />
    </div>
  );
});
