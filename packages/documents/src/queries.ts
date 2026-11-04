import type { QueryClient } from "@tanstack/react-query"
import type { DocumentItem, DocumentsPage, DocumentsProvider } from "./index"
import type { DocumentsEditor } from "./model"

/**
 * How Documents caches what it reads, in one place so the browser, its editor tabs and a host warming them up all use
 * the same keys. Every key starts with the host's scope (organization and person): a cache is never shared across
 * identities.
 */

/** A listing the person left stays on screen when they come back, while it refreshes behind it (it is never fresh). */
export const DOCUMENTS_LIST_GC_MS = 5 * 60_000
/** A file read started on hover is kept this long for the click that usually follows; then it is dropped. */
export const DOCUMENT_PREFETCH_GC_MS = 20_000
/** How long a pointer rests on a file before its content is read ahead of the click. */
export const DOCUMENT_INTENT_MS = 120

export function documentsListKey(scope: readonly string[], providerId: string, folderId: string, search: string) {
  return ["documents", ...scope, providerId, folderId, search] as const
}

/** Every page of every sheet window of one file's editor read: what closing or discarding its tab releases. */
export function documentEditorPrefix(scope: readonly string[], fileId: string) {
  return ["documents", ...scope, "editor", fileId] as const
}

export function documentEditorKey(scope: readonly string[], fileId: string, sheetId: string | undefined, startRow: number, editingEnabled: boolean) {
  return [...documentEditorPrefix(scope, fileId), sheetId, startRow, editingEnabled] as const
}

/**
 * Reads the Recent listing ahead of the person opening Documents (on hovering its tab), into the exact entry the
 * browser reads first, so it opens with files instead of a skeleton. A listing already cached is left alone.
 */
export function prefetchRecentDocuments(client: QueryClient, input: { provider: DocumentsProvider; scope: readonly string[] }) {
  return client.prefetchInfiniteQuery({
    queryKey: documentsListKey(input.scope, input.provider.id, "recent", ""),
    queryFn: ({ pageParam, signal }: { pageParam: string; signal: AbortSignal }): Promise<DocumentsPage> =>
      input.provider.list({ view: "recent", folderId: "root", query: "", cursor: pageParam || undefined, signal }),
    initialPageParam: "",
    gcTime: DOCUMENTS_LIST_GC_MS,
    // A listing someone looked at within the last few seconds is current enough to show; the browser refreshes it anyway.
    staleTime: 5_000,
  }).catch(() => {
    // A failed warm-up is not an error the person sees: opening Documents reads again and reports it there.
  })
}

/**
 * Reads a file's first editor window ahead of the click that opens it. Only files are read, never folders, and only
 * the first window (first sheet, first rows) that a new tab asks for. Failures are dropped: the tab reads again.
 */
export function prefetchDocumentEditor(client: QueryClient, input: { editor: DocumentsEditor; scope: readonly string[]; item: DocumentItem; editingEnabled: boolean }) {
  if (input.item.kind !== "file") return Promise.resolve()
  return client.prefetchQuery({
    queryKey: documentEditorKey(input.scope, input.item.id, undefined, 1, input.editingEnabled),
    queryFn: ({ signal }) => input.editor.open(input.item.id, { startRow: 1 }, signal),
    gcTime: DOCUMENT_PREFETCH_GC_MS,
    staleTime: DOCUMENT_PREFETCH_GC_MS,
  }).catch(() => {})
}
