import { useEffect, useMemo, useState } from "react";
import { coworkerBridge, type LinkPreview } from "@/lib/bridge";
import { relativeTime } from "@/lib/activity-summary";
import { mentionedDocuments, sharedLinks, type DocumentReference } from "@/lib/message-references";
import { DocumentsIcon } from "@/ui/documents";

/**
 * Under a reply, what it points at, shown the way a messaging app shows a
 * shared link: a card for each of the coworker's documents it names (tap to
 * open) and a preview for each web link it shares, read from the page's own
 * metadata by the main process.
 */
export function ReplyReferences({ text, documents, excludeDocumentIds = [], onOpenDocument }: {
  text: string;
  documents: readonly DocumentReference[];
  /** Documents this turn already shows as attachment cards. */
  excludeDocumentIds?: readonly string[];
  onOpenDocument?: (documentId: string) => void;
}) {
  const named = useMemo(() => mentionedDocuments(text, documents).filter((document) => !excludeDocumentIds.includes(document.id)), [text, documents, excludeDocumentIds]);
  const links = useMemo(() => sharedLinks(text), [text]);
  if (!named.length && !links.length) return null;
  return (
    <div className="mt-1.5 flex max-w-full flex-wrap gap-2" data-testid="reply-references">
      {onOpenDocument ? named.map((document) => <DocumentLinkCard key={document.id} document={document} onOpen={() => onOpenDocument(document.id)} />) : null}
      {links.map((url) => <LinkPreviewCard key={url} url={url} />)}
    </div>
  );
}

function DocumentLinkCard({ document, onOpen }: { document: DocumentReference; onOpen: () => void }) {
  const updated = document.updatedAt ? relativeTime(document.updatedAt) : "";
  const meta = ["Document", document.words ? `${document.words.toLocaleString()} ${document.words === 1 ? "word" : "words"}` : "", updated ? (updated === "now" ? "updated just now" : `updated ${updated} ago`) : ""].filter(Boolean).join(" · ");
  const preview = document.summary.trim() || document.highlights[0] || "";
  return (
    <button type="button" onClick={onOpen} data-testid="reply-document-card" data-document-id={document.id}
      className="flex w-72 max-w-full min-w-0 items-start gap-2.5 rounded-2xl border border-white/8 bg-panel-2 px-3 py-2.5 text-left transition-colors hover:bg-[#232c3b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-spark/12 text-spark"><DocumentsIcon className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="line-clamp-1 block text-sm font-semibold text-snow">{document.title}</span>
        {preview ? <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-mist">{preview}</span> : null}
        <span className="mt-1 block text-[11px] text-mist/80">{meta}</span>
      </span>
    </button>
  );
}

const previews = new Map<string, Promise<LinkPreview | null>>();
function readPreview(url: string): Promise<LinkPreview | null> {
  let pending = previews.get(url);
  if (!pending) {
    pending = coworkerBridge.linkPreview(url).catch(() => null);
    previews.set(url, pending);
  }
  return pending;
}

function LinkPreviewCard({ url }: { url: string }) {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined);
  useEffect(() => {
    let current = true;
    void readPreview(url).then((value) => { if (current) setPreview(value); });
    return () => { current = false; };
  }, [url]);
  // Nothing until the page describes itself; the link in the reply stays usable either way.
  if (!preview) return null;
  return (
    <button type="button" onClick={() => void coworkerBridge.openUntrustedExternal(preview.url)} data-testid="reply-link-preview" data-url={preview.url}
      title={preview.url}
      className="w-72 max-w-full min-w-0 overflow-hidden rounded-2xl border border-white/8 bg-panel-2 text-left transition-colors hover:bg-[#232c3b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-spark/50">
      {preview.image ? <img src={preview.image} alt="" className="aspect-[1.91] w-full object-cover" /> : null}
      <span className="block px-3 py-2.5">
        <span className="line-clamp-2 block text-sm font-semibold leading-snug text-snow">{preview.title || preview.siteName}</span>
        {preview.description ? <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-mist">{preview.description}</span> : null}
        <span className="mt-1 block truncate text-[11px] text-mist/80">{preview.siteName}</span>
      </span>
    </button>
  );
}
