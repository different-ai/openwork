"use client";

import { AppWindow, File, FileSpreadsheet, FileText, Film, Image as ImageIcon, Music, Presentation, type LucideIcon } from "lucide-react";
import { useContext, useMemo } from "react";
import { artifactColor, artifactKind, artifactLabel, artifactTitle, staticAppHtml, type ArtifactKind } from "./artifact";
import { useWorkbotFileBytes, useWorkbotImageUrl, useWorkbotPreview, useWorkbotPreviewPage, type WorkbotAttachment } from "./data";
import { OpenFileContext, OpenFileIdContext } from "./open-file";

/**
 * A file Workbot made, as a card in the conversation (Finch-style): a large preview of the file itself, then a small
 * icon, its title and its type. Tapping it opens the file beside the chat (a full-screen sheet on a phone).
 */

const ICONS: Record<ArtifactKind, LucideIcon> = {
  html: AppWindow, image: ImageIcon, pdf: FileText, video: Film, audio: Music, markdown: FileText, text: FileText,
  csv: FileSpreadsheet, sheet: FileSpreadsheet, slides: Presentation, document: FileText, other: File,
};

/** The file type's small icon, on a white tile: next to a card's title and in the panel header. */
export function ArtifactIcon({ kind, size = 28 }: { kind: ArtifactKind; size?: number }) {
  const Icon = ICONS[kind];
  return (
    <span aria-hidden className="grid shrink-0 place-items-center rounded-[8px] bg-[var(--wb-surface)] shadow-[0_0_0_1px_var(--wb-ring)]" style={{ width: size, height: size }} data-workbot-artifact-icon={kind}>
      <Icon size={Math.round(size * 0.55)} strokeWidth={1.75} style={{ color: artifactColor(kind) }} />
    </span>
  );
}

/** An app's source, read once for both its live thumbnail and the panel; null until it arrives (or for other files). */
export function useArtifactHtml(file: WorkbotAttachment | null): string | null {
  const html = file !== null && artifactKind(file) === "html";
  const bytes = useWorkbotFileBytes(html ? file.id : null, file?.updatedAt);
  return useMemo(() => (bytes.data ? new TextDecoder().decode(bytes.data.subarray(0, 2_000_000)) : null), [bytes.data]);
}

/** The panel and the card agree on a file's name: an app goes by its own <title>. */
export function useArtifactTitle(file: WorkbotAttachment): string {
  return artifactTitle(file, useArtifactHtml(file));
}

export function ArtifactCard({ file }: { file: WorkbotAttachment }) {
  const open = useContext(OpenFileContext);
  const openId = useContext(OpenFileIdContext);
  const kind = artifactKind(file);
  const html = useArtifactHtml(file);
  const title = artifactTitle(file, html);
  const label = artifactLabel(file);
  const isOpen = openId === file.id;
  return (
    <div className="group relative flex w-full min-w-0 flex-col gap-2.5" data-workbot-artifact-card={file.id} data-open={isOpen || undefined}>
      <div
        aria-hidden
        className={`aspect-[16/10] w-full overflow-hidden rounded-[16px] bg-[var(--wb-tray)] transition-shadow duration-150 ease-out ${isOpen ? "shadow-[0_0_0_2px_#01162759]" : "shadow-[var(--wb-card-shadow)] group-hover:shadow-[var(--wb-card-shadow-hover)]"}`}
        data-workbot-artifact-thumbnail
      >
        <ArtifactThumbnail file={file} kind={kind} html={html} />
      </div>
      <div aria-hidden className="flex min-w-0 items-center gap-2.5 px-0.5">
        <ArtifactIcon kind={kind} />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[14px] font-semibold leading-5 tracking-[-0.01em] text-[var(--wb-text)]">{title}</span>
          <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{label}</span>
        </span>
      </div>
      {/* One target over the whole card: the thumbnail may be a live frame, which can't sit inside a button. */}
      <button
        type="button"
        onClick={() => open(file)}
        aria-label={`${title}, ${label}`}
        title={file.name}
        className="absolute -inset-1.5 rounded-[20px] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
      />
    </div>
  );
}

/** The file itself, small: an image, a rendered first page, the app's page without its scripts, or its type. */
export function ArtifactThumbnail({ file, kind, html }: { file: WorkbotAttachment; kind: ArtifactKind; html: string | null }) {
  if (kind === "image") return <ImageThumbnail file={file} kind={kind} />;
  if (kind === "html") return html === null ? <Placeholder kind={kind} /> : <AppThumbnail html={html} />;
  if (kind === "pdf" || kind === "slides" || kind === "document") return <PageThumbnail file={file} kind={kind} />;
  return <Placeholder kind={kind} />;
}

function ImageThumbnail({ file, kind }: { file: WorkbotAttachment; kind: ArtifactKind }) {
  const url = useWorkbotImageUrl(file.id, file.updatedAt);
  // Blob URL from our own API; next/image cannot optimize it.
  // eslint-disable-next-line @next/next/no-img-element
  return url ? <img src={url} alt="" className="workbot-fade-in block h-full w-full object-cover" /> : <Placeholder kind={kind} />;
}

/**
 * The app at a desktop width, scaled down to the card, as its page looks before its scripts run (staticAppHtml): a
 * card appearing never runs the app, sends anything or navigates. Only opening it in the panel runs it.
 */
function AppThumbnail({ html }: { html: string }) {
  const page = useMemo(() => staticAppHtml(html), [html]);
  if (page === null) return <Placeholder kind="html" />;
  return (
    <span className="relative block h-full w-full overflow-hidden bg-white">
      <iframe
        srcDoc={page}
        sandbox=""
        tabIndex={-1}
        title=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className="pointer-events-none absolute left-0 top-0 h-[300%] w-[300%] origin-top-left scale-[0.3333] border-0"
      />
    </span>
  );
}

/** The first page Workbot's computer rendered; the type's placeholder when there is none. */
function PageThumbnail({ file, kind }: { file: WorkbotAttachment; kind: ArtifactKind }) {
  const preview = useWorkbotPreview(file.id, file.updatedAt);
  const page = useWorkbotPreviewPage(file.id, 1, file.updatedAt, Boolean(preview.data));
  if (!preview.data || !page.data) return <Placeholder kind={kind} />;
  return (
    <span className="grid h-full w-full place-items-center bg-[var(--wb-tray)] px-[10%] pt-[6%]">
      {/* Blob URL from our own API; next/image cannot optimize it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={page.data} alt="" className="workbot-fade-in block h-full w-full rounded-t-[6px] object-cover object-top shadow-[var(--wb-page-shadow)]" />
    </span>
  );
}

/** No picture of this file: a quiet tile tinted by its type, with its icon. */
function Placeholder({ kind }: { kind: ArtifactKind }) {
  const Icon = ICONS[kind];
  const color = artifactColor(kind);
  return (
    <span className="grid h-full w-full place-items-center" style={{ background: `color-mix(in srgb, ${color} 5%, var(--wb-tray))` }} data-workbot-artifact-placeholder={kind}>
      <span className="grid size-14 place-items-center rounded-[14px] bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)]">
        <Icon size={24} strokeWidth={1.5} style={{ color }} />
      </span>
    </span>
  );
}

/** Files Workbot made while answering: one large card, or a two-up grid when there are several. */
export function ArtifactCards({ files }: { files: WorkbotAttachment[] }) {
  return (
    <div className={`workbot-row-enter grid gap-x-4 gap-y-5 pl-1.5 pr-1.5 pt-4 ${files.length > 1 ? "max-w-[600px] grid-cols-2" : "max-w-[440px] grid-cols-1"}`} data-workbot-artifacts>
      {files.map((file) => <ArtifactCard key={file.id} file={file} />)}
    </div>
  );
}
