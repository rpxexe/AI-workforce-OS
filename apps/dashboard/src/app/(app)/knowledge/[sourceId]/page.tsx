"use client";

import {
  MAX_UPLOAD_BYTES,
  knowledgeKindOf,
  type DocumentStatus,
  type KnowledgeDocument,
  type KnowledgeDocumentFilter,
  type KnowledgeDocumentPage,
  type KnowledgeSourceDetail,
} from "@workforce/shared";
import { ArrowLeft, CircleAlert, CircleCheck, FileText, Loader, RefreshCw, Trash2, Upload, X } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ConfirmDialog, type Confirmation } from "@/components/confirm-dialog";
import { formatDate } from "@/components/employees/meta";
import { Skeleton as Skullet } from "skullet/react";
import { EmptyState, ErrorState, PageHeader, StatTile } from "@/components/states";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "@/components/ui/attachment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApi, useApiQuery } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useIsAdmin, withWorkspace } from "@/lib/workspace";
import { TablePager, useCursorPaged, type Pager } from "@/components/table-pager";

const STATUS: Record<DocumentStatus, { label: string; dot: string }> = {
  PENDING: { label: "Waiting", dot: "bg-muted-foreground/50" },
  PROCESSING: { label: "Processing", dot: "bg-warning animate-pulse" },
  READY: { label: "Ready", dot: "bg-success" },
  FAILED: { label: "Failed", dot: "bg-destructive" },
};

const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const working = (d: KnowledgeDocument) => d.status === "PENDING" || d.status === "PROCESSING";

const FILTERS: Record<KnowledgeDocumentFilter, string> = { all: "All", ready: "Ready", processing: "Processing", failed: "Failed" };

/** A file picked or dropped in this visit, shown as an attachment until it is dismissed. */
type PickedFile = { id: string; name: string; size: number; state: "uploading" | "done" | "error"; message: string };

/** Why a file cannot be uploaded, or null when it can. */
const problemOf = (f: File) =>
  !knowledgeKindOf(f.name)
    ? "Not a PDF, DOCX, TXT or CSV file"
    : f.size === 0
      ? "The file is empty"
      : f.size > MAX_UPLOAD_BYTES
        ? `Larger than ${formatSize(MAX_UPLOAD_BYTES)}`
        : null;

const SAMPLE_DOCUMENT_NAMES = ["Refund policy 2026.pdf", "Shipping and delivery FAQ.docx", "Product catalogue.csv", "Warranty terms.txt", "Onboarding guide for new customers.pdf"];

// Stands in for the real data so Skullet can draw a skeleton the shape of this page; never shown as data.
const SAMPLE: Loaded = {
  source: {
    id: "sample-source",
    name: "Customer support handbook",
    description: "",
    documentCount: SAMPLE_DOCUMENT_NAMES.length,
    readyDocuments: SAMPLE_DOCUMENT_NAMES.length,
    processingDocuments: 0,
    failedDocuments: 0,
    passages: 42 * SAMPLE_DOCUMENT_NAMES.length,
    totalBytes: 245_760 * SAMPLE_DOCUMENT_NAMES.length,
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  documents: SAMPLE_DOCUMENT_NAMES.map((name, i) => ({
    id: `sample-${i}`,
    name,
    kind: "pdf",
    sizeBytes: 245_760,
    status: "READY",
    error: null,
    chunkCount: 42,
    createdAt: "2026-01-01T00:00:00.000Z",
  })),
};

export default withWorkspace(function KnowledgeSourcePage({ workspace }) {
  const { sourceId } = useParams<{ sourceId: string }>();
  const isAdmin = useIsAdmin();
  const base = `/workspaces/${workspace.id}/knowledge`;

  // The source with its counts, and its documents one cursor page at a time (back to page 1 on a new status).
  const detail = useApiQuery<KnowledgeSourceDetail>(`${base}/sources/${sourceId}`);
  const [filter, setFilter] = useState<KnowledgeDocumentFilter>("all");
  const paged = useCursorPaged(filter);
  const list = useApiQuery<KnowledgeDocumentPage>(`${base}/sources/${sourceId}/documents?${paged.query}${filter === "all" ? "" : `&status=${filter}`}`, {
    keepPrevious: true,
  });
  const source = detail.data;
  const totals: Record<KnowledgeDocumentFilter, number | undefined> = {
    all: source?.documentCount,
    ready: source?.readyDocuments,
    processing: source?.processingDocuments,
    failed: source?.failedDocuments,
  };
  // While a page loads, `data` is still the previous one: its cursor must not open yet another page.
  const pager = paged.pager({
    total: totals[filter],
    nextCursor: list.loading ? null : (list.data?.nextCursor ?? null),
    rows: list.loading ? 1 : (list.data?.data.length ?? 1),
  });
  const { reload: reloadSource } = detail;
  const { reload: reloadList } = list;
  // After an upload, delete or reprocess, and while documents process: the counts and the page shown.
  const reload = useCallback(() => {
    reloadSource();
    reloadList();
  }, [reloadSource, reloadList]);

  // Processing happens on the server after the upload returns; keep checking until it settles.
  const inProgress = (source?.processingDocuments ?? 0) > 0;
  useEffect(() => {
    if (!inProgress) return;
    const timer = setInterval(reload, 2000);
    return () => clearInterval(timer);
  }, [inProgress, reload]);

  const error = detail.error ?? list.error;
  if (error) return <ErrorState message={error.message} onRetry={reload} />;
  const loaded = source && list.data ? { source, documents: list.data.data } : undefined;
  return (
    <Skullet data={loaded} sample={SAMPLE} id="knowledge-source" label="Loading knowledge source">
      {(loaded) => (
        <SourceView {...loaded} base={base} sourceId={sourceId} isAdmin={isAdmin} reload={reload} filter={filter} setFilter={setFilter} pager={pager} />
      )}
    </Skullet>
  );
});

type Loaded = { source: KnowledgeSourceDetail; documents: KnowledgeDocument[] };

function SourceView({
  source: data,
  documents,
  base,
  sourceId,
  isAdmin,
  reload,
  filter,
  setFilter,
  pager,
}: Loaded & {
  base: string;
  sourceId: string;
  isAdmin: boolean;
  reload: () => void;
  filter: KnowledgeDocumentFilter;
  setFilter: (filter: KnowledgeDocumentFilter) => void;
  pager: Pager;
}) {
  const api = useApi();
  const router = useRouter();
  const [uploading, setUploading] = useState(false);
  const [confirm, setConfirm] = useState<Confirmation | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
      reload();
    } catch {
      // The toast in useApi shows why it failed.
    }
  };

  const [uploads, setUploads] = useState<PickedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const patch = (id: string, change: Partial<PickedFile>) => setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...change } : u)));

  /** Uploads one file at a time; each shows its own state, so a bad file does not stop the others. */
  const uploadFiles = async (files: File[]) => {
    if (files.length === 0) return;
    const batch = files.map((file) => {
      const problem = problemOf(file);
      return {
        file,
        entry: { id: crypto.randomUUID(), name: file.name, size: file.size, state: problem ? "error" : "uploading", message: problem ?? "Uploading" } satisfies PickedFile,
      };
    });
    // Finished uploads from earlier make way for the new batch; failed ones stay until dismissed.
    setUploads((list) => [...list.filter((u) => u.state !== "done"), ...batch.map((b) => b.entry)]);
    setUploading(true);
    let uploaded = false;
    for (const { file, entry } of batch) {
      if (entry.state === "error") continue;
      try {
        await api(`${base}/sources/${sourceId}/documents?name=${encodeURIComponent(file.name)}`, { method: "POST", file, toast: false });
        patch(entry.id, { state: "done", message: "Uploaded, now processing" });
        uploaded = true;
      } catch (err) {
        patch(entry.id, { state: "error", message: err instanceof Error ? err.message : "Upload failed" });
      }
    }
    setUploading(false);
    if (uploaded) reload();
  };
  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const files = [...(event.target.files ?? [])];
    event.target.value = ""; // so picking the same file again still fires
    void uploadFiles(files);
  };
  const drop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void uploadFiles([...event.dataTransfer.files]);
  };

  const { passages, processingDocuments: processing, failedDocuments: failed } = data;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/knowledge" className="flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden />
        Knowledge
      </Link>

      <PageHeader
        title={data.name}
        description={`${data.description || "Documents in this source. Attach the source to an AI employee from the employee's page."} Updated ${formatDate(data.updatedAt)}.`}
      >
        {isAdmin && (
          <>
            <Input
              ref={picker}
              type="file"
              multiple
              accept=".pdf,.docx,.txt,.csv"
              onChange={upload}
              className="hidden"
              tabIndex={-1}
              aria-hidden
            />
            <Button onClick={() => picker.current?.click()} disabled={uploading}>
              {uploading ? <Spinner /> : <Upload aria-hidden />}
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
                      await api(`${base}/sources/${sourceId}`, { method: "DELETE", toast: `${data.name} deleted` });
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

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Documents" value={data.documentCount} icon={FileText} hint={`${formatSize(data.totalBytes)} in total`} />
        <StatTile label="Ready" value={data.readyDocuments} icon={CircleCheck} hint={`${passages} searchable ${passages === 1 ? "passage" : "passages"}`} />
        <StatTile label="Processing" value={processing} icon={Loader} hint={processing ? "Updates automatically" : "Nothing in the queue"} />
        <StatTile label="Failed" value={failed} icon={CircleAlert} hint={failed ? "Retry or replace them" : "No problems"} />
      </div>

      {isAdmin && (
        <section aria-label="Upload documents" className="flex flex-col gap-3">
          <Attachment
            state="idle"
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
            className={cn("w-full max-w-none justify-center py-6", dragging && "border-primary bg-muted/50")}
          >
            <AttachmentTrigger onClick={() => picker.current?.click()} disabled={uploading} aria-label="Choose documents to upload" />
            <AttachmentMedia>
              <Upload aria-hidden />
            </AttachmentMedia>
            <AttachmentContent className="flex-none">
              <AttachmentTitle>{dragging ? "Drop to upload" : "Drop files here, or click to choose"}</AttachmentTitle>
              <AttachmentDescription>PDF, DOCX, TXT or CSV, up to {formatSize(MAX_UPLOAD_BYTES)} each</AttachmentDescription>
            </AttachmentContent>
          </Attachment>

          {uploads.length > 0 && (
            <AttachmentGroup aria-live="polite">
              {uploads.map((u) => (
                <Attachment key={u.id} state={u.state} className="max-w-72">
                  <AttachmentMedia>
                    {u.state === "uploading" ? (
                      <Spinner />
                    ) : u.state === "error" ? (
                      <CircleAlert aria-hidden />
                    ) : (
                      <CircleCheck className="text-success" aria-hidden />
                    )}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle title={u.name}>{u.name}</AttachmentTitle>
                    <AttachmentDescription title={u.message}>
                      {formatSize(u.size)} · {u.message}
                    </AttachmentDescription>
                  </AttachmentContent>
                  {u.state !== "uploading" && (
                    <AttachmentActions>
                      <AttachmentAction aria-label={`Dismiss ${u.name}`} onClick={() => setUploads((list) => list.filter((x) => x.id !== u.id))}>
                        <X aria-hidden />
                      </AttachmentAction>
                    </AttachmentActions>
                  )}
                </Attachment>
              ))}
            </AttachmentGroup>
          )}
        </section>
      )}

      {failed > 0 && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>
            {failed} {failed === 1 ? "document" : "documents"} could not be processed
          </AlertTitle>
          <AlertDescription>
            AI employees cannot answer from {failed === 1 ? "it" : "them"} yet. The reason is shown under each name;
            fix the file and upload it again, or retry it.
          </AlertDescription>
        </Alert>
      )}

      {data.documentCount === 0 ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description={
            isAdmin
              ? `Upload PDF, DOCX, TXT or CSV files, up to ${formatSize(MAX_UPLOAD_BYTES)} each.`
              : "An organization admin can upload documents here."
          }
        />
      ) : (
        <Card className="gap-0 py-0">
          <CardHeader className="flex flex-wrap items-center justify-between gap-3 border-b py-4">
            <CardTitle>Documents</CardTitle>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={filter}
              onValueChange={(v) => v && setFilter(v as KnowledgeDocumentFilter)}
              aria-label="Filter documents by status"
            >
              {(Object.keys(FILTERS) as KnowledgeDocumentFilter[]).map((k) => (
                <ToggleGroupItem key={k} value={k} className="px-3">
                  {FILTERS[k]}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </CardHeader>
          <CardContent className="px-0">
            {documents.length === 0 ? (
              <p className="px-4 py-10 text-center text-sm text-muted-foreground">No documents with this status.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-4">Document</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden text-right md:table-cell">Passages</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">Size</TableHead>
                    <TableHead className="hidden sm:table-cell">Uploaded</TableHead>
                    <TableHead className="w-24 pr-4">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documents.map((d) => (
                    <TableRow key={d.id}>
                      <TableCell className="max-w-72 pl-4">
                        <span className="flex items-center gap-2">
                          <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="truncate font-medium" title={d.name}>
                            {d.name}
                          </span>
                          <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground uppercase">
                            {d.kind}
                          </Badge>
                        </span>
                        {d.status === "FAILED" && d.error && (
                          <span className="mt-1 block text-xs whitespace-normal text-destructive">{d.error}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge doc={d} />
                      </TableCell>
                      <TableCell className="hidden text-right text-muted-foreground tabular-nums md:table-cell">
                        {d.status === "READY" ? d.chunkCount : "—"}
                      </TableCell>
                      <TableCell className="hidden text-right text-muted-foreground tabular-nums sm:table-cell">
                        {formatSize(d.sizeBytes)}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground sm:table-cell">{formatDate(d.createdAt)}</TableCell>
                      <TableCell className="pr-4">
                        {isAdmin && (
                          <span className="flex justify-end gap-1">
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`${d.status === "FAILED" ? "Retry" : "Reprocess"} ${d.name}`}
                                  disabled={working(d)}
                                  onClick={() =>
                                    run(() =>
                                      api(`${base}/documents/${d.id}/reprocess`, {
                                        method: "POST",
                                        toast: { loading: `Reprocessing ${d.name}…`, success: `${d.name} sent for reprocessing` },
                                      }),
                                    )
                                  }
                                >
                                  <RefreshCw aria-hidden />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>{d.status === "FAILED" ? "Retry" : "Reprocess"}</TooltipContent>
                            </Tooltip>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  aria-label={`Delete ${d.name}`}
                                  onClick={() =>
                                    setConfirm({
                                      title: `Delete ${d.name}?`,
                                      description: "AI employees stop answering from this document. This cannot be undone.",
                                      confirmLabel: "Delete",
                                      onConfirm: () => run(() => api(`${base}/documents/${d.id}`, { method: "DELETE", toast: `${d.name} deleted` })),
                                    })
                                  }
                                >
                                  <Trash2 aria-hidden />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Delete</TooltipContent>
                            </Tooltip>
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
          {documents.length > 0 && (
            <CardFooter className="border-t py-3">
              <TablePager {...pager} />
            </CardFooter>
          )}
        </Card>
      )}

      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

/** Status pill; a failed document's reason is also in a tooltip so it can be read without widening the row. */
function StatusBadge({ doc }: { doc: KnowledgeDocument }) {
  const badge = (
    <Badge variant="outline" className="gap-1.5 font-normal">
      <span className={cn("size-1.5 rounded-full", STATUS[doc.status].dot)} aria-hidden />
      {STATUS[doc.status].label}
    </Badge>
  );
  if (doc.status !== "FAILED" || !doc.error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-md focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{doc.error}</TooltipContent>
    </Tooltip>
  );
}
