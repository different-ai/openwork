"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Download, FileText, Paperclip, Trash2, X } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { workbotHost } from "./host";
import {
  downloadWorkbotFile,
  uploadWorkbotFile,
  useDeleteWorkbotFile,
  useWorkbotFiles,
  useWorkbotImageUrl,
  type WorkbotAttachment,
  type WorkbotFile,
} from "./data";
import { OpenFileContext } from "./open-file";
import { dayLabel } from "./format";

/** Files in Workbot (Paper v5: screens 5–8). */

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isImage = (mediaType: string) => IMAGE_TYPES.has(mediaType);

export function formatSize(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function extensionOf(name: string) {
  return name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "";
}

/** The short label and color a file type shows on its badge. */
function badgeFor(name: string, mediaType: string): { label: string; color: string } {
  const extension = extensionOf(name);
  if (mediaType === "application/pdf" || extension === "pdf") return { label: "PDF", color: "var(--wb-type-pdf)" };
  if (["doc", "docx", "rtf", "pages"].includes(extension)) return { label: "DOC", color: "var(--wb-type-doc)" };
  if (["xls", "xlsx", "numbers"].includes(extension)) return { label: "XLSX", color: "var(--wb-type-sheet)" };
  if (["ppt", "pptx", "key"].includes(extension)) return { label: extension === "key" ? "KEY" : "PPT", color: "var(--wb-type-slides)" };
  if (["csv", "tsv"].includes(extension)) return { label: "CSV", color: "var(--wb-type-sheet)" };
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(extension)) return { label: extension.toUpperCase().slice(0, 4), color: "var(--wb-type-image)" };
  const label = (extension || mediaType.split("/").pop() || "file").slice(0, 4).toUpperCase();
  return { label, color: "var(--wb-muted)" };
}

/** A file type's color (PDF red, Word blue, …) from its name, for small icons. */
export function fileTypeColor(name: string) {
  return badgeFor(name, "").color;
}

const KIND_NAMES: Record<string, string> = { DOC: "Document", XLSX: "Spreadsheet", CSV: "Spreadsheet", PPT: "Presentation", KEY: "Presentation", MD: "Note", TXT: "Text" };

/** What kind of file it is, in plain words, for a meta line: "Presentation · 47 KB". */
export function kindLabel(name: string, mediaType: string) {
  if (isImage(mediaType)) return "Image";
  const label = badgeFor(name, mediaType).label;
  return KIND_NAMES[label] ?? label;
}

/** A small square thumbnail of a kept image, for cards. */
export function ImageThumb({ id, className }: { id: string; className: string }) {
  return <Thumbnail src={useWorkbotImageUrl(id)} className={className} />;
}

export function FileBadge({ name, mediaType }: { name: string; mediaType: string }) {
  const badge = badgeFor(name, mediaType);
  return (
    <span aria-hidden className="flex h-9 w-8 shrink-0 items-end justify-center rounded-[7px] bg-[var(--wb-surface)] pb-[5px] shadow-[inset_0_0_0_1px_var(--wb-ring)]">
      <span className="text-[9px] font-bold leading-3 tracking-[0.04em]" style={{ color: badge.color }}>{badge.label}</span>
    </span>
  );
}

function Thumbnail({ src, className }: { src: string | null; className: string }) {
  return src ? (
    // Blob URLs from our own API; next/image cannot optimize them.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt="" className={`object-cover ${className}`} />
  ) : (
    <span aria-hidden className={`block bg-[image:var(--wb-thumb)] ${className}`} />
  );
}

/** A connected app's logo, bare (no tile), for headers, step lines and chips. */
export function AppMark({ name, size = 12 }: { name: string; size?: number }) {
  const [failed, setFailed] = useState(0);
  const candidates = useMemo(() => workbotHost().appIcons(name), [name]);
  const src = candidates[failed];
  if (!src) return <span aria-hidden className="rounded-full bg-[var(--wb-disabled)]" style={{ width: size - 4, height: size - 4 }} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} onError={() => setFailed((count) => count + 1)} className="shrink-0 object-contain" />;
}

// ---------------------------------------------------------------- uploads

export type Upload = {
  key: string;
  file: File;
  /** Local preview for images, before the upload finishes. */
  previewUrl: string | null;
  loaded: number;
  status: "uploading" | "done" | "failed";
  error: string | null;
  saved: WorkbotFile | null;
};

/**
 * Files picked, dropped or pasted into the composer. Each uploads right away; the message can be sent while
 * they finish, and waits for them.
 */
export function useUploads() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const waiters = useRef(new Map<string, { promise: Promise<WorkbotFile | null>; controller: AbortController }>());

  const update = (key: string, patch: Partial<Upload>) => setUploads((current) => current.map((upload) => (upload.key === key ? { ...upload, ...patch } : upload)));

  const start = useCallback((file: File, key: string = crypto.randomUUID()) => {
    const controller = new AbortController();
    const promise = uploadWorkbotFile(file, (loaded) => update(key, { loaded }), controller.signal)
      .then((saved) => {
        update(key, { status: "done", saved, loaded: file.size });
        return saved;
      })
      .catch((error: unknown) => {
        update(key, { status: "failed", error: error instanceof Error ? error.message : "Couldn't upload." });
        return null;
      });
    waiters.current.set(key, { promise, controller });
    return key;
  }, []);

  const add = useCallback((files: FileList | File[]) => {
    const added = Array.from(files).map((file) => ({
      key: crypto.randomUUID(),
      file,
      previewUrl: isImage(file.type) ? URL.createObjectURL(file) : null,
      loaded: 0,
      status: "uploading" as const,
      error: null,
      saved: null,
    }));
    setUploads((current) => [...current, ...added]);
    for (const upload of added) start(upload.file, upload.key);
  }, [start]);

  const retry = (key: string) => {
    const upload = uploads.find((entry) => entry.key === key);
    if (!upload) return;
    update(key, { status: "uploading", error: null, loaded: 0 });
    start(upload.file, key);
  };

  const remove = (key: string) => {
    waiters.current.get(key)?.controller.abort();
    waiters.current.delete(key);
    setUploads((current) => current.filter((upload) => upload.key !== key));
  };

  /** Hands the tray's files to a message and clears the tray. Resolves once every upload settled. */
  const take = () => {
    const taken = uploads;
    const pending = taken.map((upload) => waiters.current.get(upload.key)?.promise ?? Promise.resolve(upload.saved));
    waiters.current.clear();
    setUploads([]);
    return { taken, settled: Promise.all(pending).then((files) => files.flatMap((file) => (file ? [file] : []))) };
  };

  return { uploads, add, retry, remove, take };
}

function ProgressRing({ value }: { value: number }) {
  const circumference = 2 * Math.PI * 8;
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" className="shrink-0 -rotate-90" aria-hidden>
      <circle cx="10" cy="10" r="8" fill="none" stroke="var(--wb-bubble)" strokeWidth="2.25" />
      <circle cx="10" cy="10" r="8" fill="none" stroke="var(--wb-ink)" strokeWidth="2.25" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - Math.max(0.04, value))} className="transition-[stroke-dashoffset] duration-200 ease-out" />
    </svg>
  );
}

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-[var(--wb-surface)] text-[var(--wb-muted)] shadow-[0_0_0_1px_var(--wb-ring)] opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)] [@media(hover:none)]:opacity-100"
    >
      <X size={10} strokeWidth={2.5} aria-hidden />
    </button>
  );
}

/** The files waiting in the composer (Paper v5, screen 5). */
export function UploadTray({ uploads, onRemove, onRetry }: { uploads: Upload[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Files to send">
      {uploads.map((upload) =>
        upload.previewUrl ? (
          <div key={upload.key} className="group relative h-14 w-14 shrink-0" title={upload.file.name}>
            <Thumbnail src={upload.previewUrl} className="h-14 w-14 rounded-xl shadow-[inset_0_0_0_1px_var(--wb-hairline)]" />
            {upload.status === "uploading" ? (
              <span className="absolute bottom-1 right-1 rounded-full bg-[var(--wb-surface)] p-0.5"><ProgressRing value={upload.loaded / Math.max(1, upload.file.size)} /></span>
            ) : null}
            {upload.status === "failed" ? (
              <button type="button" onClick={() => onRetry(upload.key)} className="absolute inset-0 grid place-items-center rounded-xl bg-[var(--wb-bg)]/80 text-[12px] font-medium text-[var(--wb-text)]">Retry</button>
            ) : null}
            <RemoveButton onClick={() => onRemove(upload.key)} label={`Remove ${upload.file.name}`} />
          </div>
        ) : (
          <div key={upload.key} className="group relative flex h-14 max-w-[300px] items-center gap-2.5 rounded-xl bg-[var(--wb-tray)] pl-2.5 pr-3.5 shadow-[inset_0_0_0_1px_var(--wb-hairline)]">
            <FileBadge name={upload.file.name} mediaType={upload.file.type} />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="truncate text-[13px] font-medium leading-4 text-[var(--wb-text)]">{upload.file.name}</span>
              <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">
                {upload.status === "uploading"
                  ? `Uploading · ${formatSize(upload.loaded)} of ${formatSize(upload.file.size)}`
                  : upload.status === "failed"
                    ? <>{upload.error ?? "Couldn't upload."} <button type="button" onClick={() => onRetry(upload.key)} className="font-medium text-[var(--wb-text)] underline underline-offset-2">Retry</button></>
                    : `${kindLabel(upload.file.name, upload.file.type)} · ${formatSize(upload.file.size)}`}
              </span>
            </span>
            {upload.status === "uploading" ? <span className="ml-1.5"><ProgressRing value={upload.loaded / Math.max(1, upload.file.size)} /></span> : null}
            <RemoveButton onClick={() => onRemove(upload.key)} label={`Remove ${upload.file.name}`} />
          </div>
        ),
      )}
    </div>
  );
}

/** The paperclip: picks files, or, when this server keeps no files, says so and who can change it (DESIGN P4). */
export function AttachButton({ enabled, onFiles }: { enabled: boolean; onFiles: (files: FileList) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [showLock, setShowLock] = useState(false);
  if (!enabled) {
    return (
      <span className="relative shrink-0">
        <button
          type="button"
          aria-disabled="true"
          aria-label="Attach files. Files aren't set up on this server; your admin can turn them on."
          onClick={() => setShowLock((open) => !open)}
          onBlur={() => setShowLock(false)}
          onMouseEnter={() => setShowLock(true)}
          onMouseLeave={() => setShowLock(false)}
          className="grid h-9 w-9 place-items-center rounded-full bg-[var(--wb-chip)] text-[var(--wb-disabled)] focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)]"
        >
          <Paperclip size={18} strokeWidth={1.75} aria-hidden />
        </button>
        {showLock ? (
          <span role="tooltip" className="absolute bottom-[calc(100%+10px)] left-0 z-10 flex w-[300px] items-center gap-2 rounded-xl bg-[var(--wb-text)] px-3 py-2 text-[13px] leading-4 text-[var(--wb-mark-text)]">
            <LockGlyph />
            Files aren&apos;t set up on this server. Your admin can turn them on.
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={() => input.current?.click()}
        aria-label="Attach files"
        title="Attach files"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)]"
      >
        <Paperclip size={18} strokeWidth={1.75} aria-hidden />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          if (event.target.files?.length) onFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}

function LockGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden className="shrink-0">
      <rect x="5" y="11" width="14" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

// ---------------------------------------------------------------- in the thread

function SentImage({ attachment, localUrl }: { attachment: WorkbotAttachment; localUrl?: string | null }) {
  const remote = useWorkbotImageUrl(localUrl ? null : attachment.id);
  const open = useContext(OpenFileContext);
  return (
    <button
      type="button"
      onClick={() => !attachment.id.startsWith("local-") && open(attachment)}
      title={attachment.name}
      aria-label={`Open ${attachment.name}`}
      className="overflow-hidden rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)]"
    >
      <Thumbnail src={localUrl ?? remote} className="h-24 w-[132px] rounded-2xl shadow-[inset_0_0_0_1px_var(--wb-hairline)]" />
    </button>
  );
}

export function FileChip({ attachment, detail, onClick }: { attachment: WorkbotAttachment; detail?: ReactNode; onClick?: () => void }) {
  const open = useContext(OpenFileContext);
  return (
    <button
      type="button"
      onClick={onClick ?? (() => !attachment.id.startsWith("local-") && open(attachment))}
      title={`Open ${attachment.name}`}
      className="flex h-14 max-w-[300px] items-center gap-2.5 rounded-2xl bg-[var(--wb-surface)] pl-2.5 pr-3.5 text-left shadow-[0_0_0_1px_var(--wb-ring)] transition-shadow duration-150 hover:shadow-[0_0_0_1px_var(--wb-disabled)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)]"
    >
      <FileBadge name={attachment.name} mediaType={attachment.mediaType} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13px] font-medium leading-4 text-[var(--wb-text)]">{attachment.name}</span>
        <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">{detail ?? `${kindLabel(attachment.name, attachment.mediaType)} · ${formatSize(attachment.size)}`}</span>
      </span>
    </button>
  );
}

/** Files sent with a message, right-aligned above its bubble (Paper v5, screen 6). */
export function SentAttachments({ attachments, localUrls }: { attachments: WorkbotAttachment[]; localUrls?: Record<string, string | null> }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap items-end justify-end gap-1.5 pb-[3px]">
      {attachments.map((attachment) =>
        isImage(attachment.mediaType) ? (
          <SentImage key={attachment.id} attachment={attachment} localUrl={localUrls?.[attachment.id]} />
        ) : (
          <FileChip key={attachment.id} attachment={attachment} />
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the Files panel

export function FilesButton({ open, onOpen }: { open: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={open}
      className={`flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium leading-4 transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--wb-ink)] ${open ? "bg-[var(--wb-chip)] text-[var(--wb-text)]" : "text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)]"}`}
    >
      <FileText size={15} strokeWidth={1.75} aria-hidden />
      Files
    </button>
  );
}

function FileRow({ file, assistantName, onOpen }: { file: WorkbotFile; assistantName: string; onOpen: (file: WorkbotFile) => void }) {
  const remove = useDeleteWorkbotFile();
  const thumb = useWorkbotImageUrl(isImage(file.mediaType) ? file.id : null);
  const when = dayLabel(file.createdAt);
  return (
    <li className="group flex h-14 items-center gap-3 border-b border-[var(--wb-row-line)] pl-1 pr-1">
      {isImage(file.mediaType) ? <Thumbnail src={thumb} className="h-9 w-8 shrink-0 rounded-[7px] shadow-[inset_0_0_0_1px_var(--wb-hairline)]" /> : <FileBadge name={file.name} mediaType={file.mediaType} />}
      <button type="button" onClick={() => onOpen(file)} className="flex min-w-0 flex-1 flex-col gap-0.5 rounded text-left focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)]">
        <span className="truncate text-[13px] font-medium leading-4 text-[var(--wb-text)] group-hover:underline group-hover:decoration-[var(--wb-disabled)] group-hover:underline-offset-2">{file.name}</span>
        <span className="truncate text-[12px] leading-4 text-[var(--wb-muted)]">
          {file.source === "agent" ? `Made by ${assistantName} · ` : ""}{when} · {formatSize(file.size)}
        </span>
      </button>
      <button
        type="button"
        onClick={() => remove.mutate(file.id)}
        disabled={remove.isPending}
        aria-label={`Delete ${file.name}`}
        title="Delete"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] opacity-0 transition-opacity duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-danger)] group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)] [@media(hover:none)]:opacity-100"
      >
        <Trash2 size={15} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => void downloadWorkbotFile(file)}
        aria-label={`Download ${file.name}`}
        title="Download"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)]"
      >
        <Download size={15} strokeWidth={1.75} aria-hidden />
      </button>
    </li>
  );
}

/** Everything kept, newest first (Paper v5, screen 7). */
export function FilesPanel({ open, onClose, assistantName, onOpenFile }: { open: boolean; onClose: () => void; assistantName: string; onOpenFile: (file: WorkbotFile) => void }) {
  const files = useWorkbotFiles(open);
  const list = files.data?.files ?? [];
  const total = list.reduce((sum, file) => sum + file.size, 0);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Popup className="workbot fixed inset-y-0 right-0 z-50 flex w-full max-w-[400px] flex-col bg-[var(--wb-surface)] shadow-[var(--wb-sheet-shadow)] outline-none transition-transform duration-200 ease-out data-[ending-style]:translate-x-full data-[starting-style]:translate-x-full motion-reduce:transition-none">
          <div className="flex h-15 shrink-0 items-center justify-between border-b border-[var(--wb-hairline)] pl-6 pr-4">
            <Dialog.Title className="text-[15px] font-semibold leading-[18px] tracking-[-0.01em] text-[var(--wb-text)]">Files</Dialog.Title>
            <Dialog.Close aria-label="Close" className="grid h-8 w-8 place-items-center rounded-full text-[var(--wb-muted)] hover:bg-[var(--wb-chip)] focus-visible:outline-2 focus-visible:outline-[var(--wb-ink)]">
              <X size={14} strokeWidth={2} aria-hidden />
            </Dialog.Close>
          </div>
          <div className="flex-1 overflow-y-auto pb-2 pl-5 pr-4 pt-2">
            {files.isPending ? (
              <ul aria-busy="true">
                {[0, 1, 2].map((index) => (
                  <li key={index} className="flex h-14 items-center gap-3 border-b border-[var(--wb-row-line)] pl-1">
                    <span className="h-9 w-8 rounded-[7px] bg-[var(--wb-chip)]" />
                    <span className="flex flex-col gap-1.5"><span className="h-3 w-40 rounded bg-[var(--wb-chip)]" /><span className="h-3 w-24 rounded bg-[var(--wb-chip)]" /></span>
                  </li>
                ))}
              </ul>
            ) : files.isError ? (
              <p className="px-1 py-4 text-[13px] text-[var(--wb-muted)]">
                Couldn&apos;t load your files.{" "}
                <button type="button" onClick={() => void files.refetch()} className="font-medium text-[var(--wb-text)] underline underline-offset-2">Try again</button>
              </p>
            ) : list.length === 0 ? (
              <p className="px-1 py-4 text-[13px] leading-5 text-[var(--wb-muted)]">Files you send {assistantName}, and files it makes for you, are kept here.</p>
            ) : (
              <ul>{list.map((file) => <FileRow key={file.id} file={file} assistantName={assistantName} onOpen={onOpenFile} />)}</ul>
            )}
          </div>
          {list.length > 0 ? (
            <div className="flex h-[52px] shrink-0 items-center justify-between border-t border-[var(--wb-hairline)] px-6 text-[12px] leading-4 text-[var(--wb-muted)]">
              <span>{list.length} {list.length === 1 ? "file" : "files"} · {formatSize(total)}</span>
              <span>Kept until you delete them</span>
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Lets files be dropped anywhere on the page. */
export function useFileDrop(enabled: boolean, onFiles: (files: FileList) => void) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let depth = 0;
    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      if (event.dataTransfer?.files.length) onFiles(event.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, [enabled, onFiles]);
  return dragging;
}
