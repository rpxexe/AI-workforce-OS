"use client";

import {
  MAX_UPLOAD_BYTES,
  knowledgeKindOf,
  type DocumentStatus,
  type KnowledgeDocument,
  type KnowledgeSourceDetail,
} from "@workforce/shared";
import { ArrowLeft, FileText, RefreshCw, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { formatDate } from "@/components/employees/meta";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi, useApiQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";

const STATUS: Record<DocumentStatus, { label: string; dot: string }> = {
  PENDING: { label: "Waiting", dot: "bg-muted-foreground/50" },
  PROCESSING: { label: "Processing", dot: "bg-amber-500 animate-pulse" },
  READY: { label: "Ready", dot: "bg-emerald-500" },
  FAILED: { label: "Failed", dot: "bg-destructive" },
};

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const working = (d: KnowledgeDocument) => d.status === "PENDING" || d.status === "PROCESSING";

export default withWorkspace(function KnowledgeSourcePage({ workspace }) {
  const { sourceId } = useParams<{ sourceId: string }>();
  const isAdmin = useIsAdmin();
  const api = useApi();
  const router = useRouter();
  const base = `/workspaces/${workspace.id}/knowledge`;

  const { data, error, reload } = useApiQuery<KnowledgeSourceDetail>(`${base}/sources/${sourceId}`);
  const [actionError, setActionError] = useState<string>();
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  // Processing happens on the server after the upload returns; keep checking until it settles.
  const inProgress = data?.documents.some(working) ?? false;
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [inProgress, reload]);

  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  if (!data) return <LoadingState rows={5} />;

  const run = async (action: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await action();
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = ""; // so picking the same file again still fires
    const problems = files.flatMap((f) =>
      !knowledgeKindOf(f.name)
        ? [`${f.name} is not a PDF, DOCX, TXT or CSV file.`]
        : f.size === 0
          ? [`${f.name} is empty.`]
          : f.size > MAX_UPLOAD_BYTES
            ? [`${f.name} is larger than ${formatSize(MAX_UPLOAD_BYTES)}.`]
            : [],
    );
    if (problems.length > 0) return setActionError(problems.join(" "));
    setUploading(true);
    await run(async () => {
      for (const file of files)
        await api(`${base}/sources/${sourceId}/documents?name=${encodeURIComponent(file.name)}`, { method: "POST", file });
    });
    setUploading(false);
  };

  return (
    <div className="flex flex-col gap-6">
      <Link href="/knowledge" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Knowledge
      </Link>

      <PageHeader title={data.name} description="Documents in this source. Attach the source to an AI employee from the employee's page.">
        {isAdmin && (
          <>
            <input
              ref={picker}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.csv"
              onChange={upload}
              className="sr-only"
              tabIndex={-1}
              aria-hidden
            />
            <Button onClick={() => picker.current?.click()} disabled={uploading}>
              <Upload aria-hidden />
              {uploading ? "Uploading" : "Upload documents"}
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                setConfirm({
                  title: `Delete ${data.name}?`,
                  description:
                    "Its documents are deleted and it is detached from every AI employee. This cannot be undone.",
                  confirmLabel: "Delete source",
                  onConfirm: () =>
                    run(async () => {
                      await api(`${base}/sources/${sourceId}`, { method: "DELETE" });
                      router.push("/knowledge");
                    }),
                })
              }
            >
              <Trash2 aria-hidden />
              Delete source
            </Button>
          </>
        )}
      </PageHeader>

      {actionError && <ErrorState message={actionError} />}

      {data.documents.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description={
            isAdmin
              ? "Upload PDF, DOCX, TXT or CSV files, up to 10 MB each."
              : "An organization admin can upload documents here."
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden sm:table-cell">Size</TableHead>
              <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
              <TableHead className="w-24">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.documents.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="max-w-64">
                  <span className="block truncate font-medium">{d.name}</span>
                  {d.status === "FAILED" && d.error && <span className="block text-xs whitespace-normal text-destructive">{d.error}</span>}
                  {d.status === "READY" && (
                    <span className="block text-xs text-muted-foreground">
                      {d.chunkCount} searchable {d.chunkCount === 1 ? "passage" : "passages"}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="gap-1.5 font-normal">
                    <span className={cn("size-1.5 rounded-full", STATUS[d.status].dot)} aria-hidden />
                    {STATUS[d.status].label}
                  </Badge>
                </TableCell>
                <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">{formatSize(d.sizeBytes)}</TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{formatDate(d.createdAt)}</TableCell>
                <TableCell>
                  {isAdmin && (
                    <span className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Reprocess ${d.name}`}
                        title="Reprocess"
                        disabled={working(d)}
                        onClick={() => run(() => api(`${base}/documents/${d.id}/reprocess`, { method: "POST" }))}
                      >
                        <RefreshCw aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete ${d.name}`}
                        title="Delete"
                        onClick={() =>
                          setConfirm({
                            title: `Delete ${d.name}?`,
                            description: "AI employees stop answering from this document. This cannot be undone.",
                            confirmLabel: "Delete",
                            onConfirm: () => run(() => api(`${base}/documents/${d.id}`, { method: "DELETE" })),
                          })
                        }
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
});
