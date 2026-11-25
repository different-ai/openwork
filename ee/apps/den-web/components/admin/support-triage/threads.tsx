import { DenBadge } from "../../../app/(den)/_components/ui/badge";
import { DenTable, type DenTableColumn } from "../../../app/(den)/_components/ui/table";
import { z } from "zod";

const categories = z.enum(["bug", "enterprise", "job_ask", "pitch", "needs_review", "other"]);
export const categoryLabels: Record<z.infer<typeof categories>, string> = {
  bug: "Product bug", enterprise: "Enterprise lead", job_ask: "Job ask", pitch: "Pitch", needs_review: "Needs review", other: "Other",
};
const statuses = z.enum(["pending", "processing", "completed", "failed"]);
const statusLabels: Record<z.infer<typeof statuses>, string> = {
  pending: "Pending", processing: "In progress", completed: "Complete", failed: "Failed",
};
const threadSchema = z.object({
  id: z.string(), workspaceId: z.string(), plainThreadId: z.string(), title: z.string(), preview: z.string().nullable(),
  category: categories.nullable(), status: statuses, createdAt: z.string(), attempts: z.number(),
});
const response = z.object({ threads: z.array(threadSchema), total: z.number() });
type Thread = z.infer<typeof threadSchema>;
export const parseThreads = (payload: unknown) => response.safeParse(payload).data ?? null;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function TriageThreads({ threads, example = false }: { threads: Thread[]; example?: boolean }) {
  const columns: DenTableColumn<Thread>[] = [
    { key: "thread", header: "Thread", render: (row) => {
      const title = row.title || "Untitled thread";
      return <div className="min-w-32 max-w-xl space-y-1">
        {example ? <span className="font-medium">{title}</span> : <a className="break-words font-medium underline-offset-2 hover:underline" target="_blank" rel="noreferrer"
          href={`https://app.plain.com/workspace/${encodeURIComponent(row.workspaceId)}/thread/${encodeURIComponent(row.plainThreadId)}/`}>{title}</a>}
        {row.preview ? <p className="line-clamp-2 break-words text-muted-foreground">{row.preview}</p> : null}
      </div>;
    } },
    { key: "category", header: "Category", render: ({ category }) => category ?
      <DenBadge size="sm" tone={category === "needs_review" ? "warning" : "neutral"}>{categoryLabels[category]}</DenBadge> : "—" },
    { key: "status", header: "Status", render: ({ status, attempts }) => status === "failed"
      ? <DenBadge size="sm" tone="danger">Failed{attempts > 1 ? ` after ${attempts} attempts` : ""}</DenBadge> : statusLabels[status] },
    ...(!example ? [{ key: "received", header: "Received", render: ({ createdAt }: Thread) => <time className="whitespace-nowrap" dateTime={createdAt}>{dateFormat.format(new Date(createdAt))}</time> }] : []),
  ];
  return <DenTable columns={columns} rows={threads} getRowKey={(row) => row.id} density="compact" emptyLabel="No threads match this category. Try a different filter." />;
}

export function TriageThreadExample() {
  return <TriageThreads example threads={[
    { id: "example-lead", workspaceId: "example", plainThreadId: "example-lead", title: "SSO for our team", preview: null, category: "enterprise", status: "completed", createdAt: "", attempts: 1 },
    { id: "example-review", workspaceId: "example", plainThreadId: "example-review", title: "Question about setup", preview: null, category: "needs_review", status: "completed", createdAt: "", attempts: 1 },
  ]} />;
}
