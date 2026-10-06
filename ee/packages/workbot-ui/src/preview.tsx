"use client";

import { extractOfficeText, openXlsxWorkbook, sheetGridRows, type XlsxWorkbook } from "@openwork/workbook";
import { Download, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { downloadWorkbotFile, useWorkbotFileBytes, useWorkbotFileUrl, useWorkbotImageUrl, useWorkbotPreview, useWorkbotPreviewPage, type WorkbotAttachment, type WorkbotPreview } from "./data";
import { FileBadge, formatSize, isImage, kindLabel } from "./files";
import { WorkbotMarkdown } from "./markdown";

/**
 * A file opened beside the conversation: it shows the file itself, read in the browser, never a list of
 * properties. Slides and documents show the PDF Workbot's computer rendered from them, or their text when
 * there is none. Opened only by the person (DESIGN S5); docked on wide screens, a sheet on small ones.
 */

type Kind = "image" | "pdf" | "video" | "audio" | "markdown" | "text" | "csv" | "sheet" | "slides" | "document" | "html" | "other";

const extensionOf = (name: string) => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");

function kindOf(file: WorkbotAttachment): Kind {
  const extension = extensionOf(file.name);
  const type = file.mediaType.toLowerCase();
  if (isImage(type) || ["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image";
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("video/") || ["mp4", "mov", "webm", "m4v"].includes(extension)) return "video";
  if (type.startsWith("audio/") || ["mp3", "wav", "m4a", "ogg"].includes(extension)) return "audio";
  if (["md", "markdown"].includes(extension)) return "markdown";
  if (["csv", "tsv"].includes(extension)) return "csv";
  if (extension === "xlsx") return "sheet";
  if (extension === "pptx") return "slides";
  if (extension === "docx") return "document";
  if (["html", "htm"].includes(extension)) return "html";
  if (type.startsWith("text/") || ["txt", "json", "yaml", "yml", "xml", "log", "py", "js", "ts", "sql"].includes(extension)) return "text";
  return "other";
}

/** True for a few seconds after the open file gets a new version, to say so in the header. */
function useJustUpdated(version: number | undefined) {
  const [first] = useState(version);
  const [updated, setUpdated] = useState(false);
  useEffect(() => {
    if (version === undefined || version === first) return;
    setUpdated(true);
    const timer = setTimeout(() => setUpdated(false), 4_000);
    return () => clearTimeout(timer);
  }, [version, first]);
  return updated;
}

export function PreviewPanel({ file, onClose }: { file: WorkbotAttachment; onClose: () => void }) {
  const justUpdated = useJustUpdated(file.updatedAt);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <aside
      aria-label={file.name}
      className="workbot-panel-enter fixed inset-0 z-50 flex flex-col overflow-hidden bg-[var(--wb-surface)] lg:static lg:z-auto lg:mb-3 lg:mr-3 lg:w-[min(50vw,800px)] lg:shrink-0 lg:rounded-[18px] lg:shadow-[var(--wb-panel-shadow)]"
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-[var(--wb-hairline)] pl-4 pr-2.5">
        <FileBadge name={file.name} mediaType={file.mediaType} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-semibold leading-5 tracking-[-0.01em] text-[var(--wb-text)]">{file.name}</span>
          <span className="text-[12px] leading-4 text-[var(--wb-muted)]" aria-live="polite">
            {justUpdated ? <span className="workbot-subtitle-enter inline-block text-[var(--wb-text)]">Updated just now</span> : `${kindLabel(file.name, file.mediaType)}, ${formatSize(file.size)}`}
          </span>
        </span>
        <button
          type="button"
          onClick={() => void downloadWorkbotFile(file)}
          className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          <Download size={14} strokeWidth={1.75} aria-hidden />
          Download
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close preview"
          className="grid size-8 place-items-center rounded-full text-[var(--wb-muted)] transition-colors duration-150 hover:bg-[var(--wb-chip)] hover:text-[var(--wb-text)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          <X size={15} strokeWidth={1.75} aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--wb-tray)]">
        <FilePreview key={file.id} file={file} />
      </div>
    </aside>
  );
}

function FilePreview({ file }: { file: WorkbotAttachment }) {
  const kind = kindOf(file);
  if (kind === "image") return <ImagePreview file={file} />;
  if (kind === "pdf") return <PdfPreview file={file} />;
  if (kind === "video" || kind === "audio") return <MediaPreview file={file} kind={kind} />;
  if (kind === "slides" || kind === "document") return <OfficePreview file={file} kind={kind} />;
  if (kind === "other") return <NoPreview file={file} />;
  return <BytesPreview file={file} kind={kind} />;
}

function Loading() {
  return (
    <div className="flex flex-col gap-3 p-6" aria-busy="true">
      <span className="aspect-video w-full rounded-xl bg-[var(--wb-chip)]" />
      <span className="h-3 w-2/3 rounded bg-[var(--wb-chip)]" />
    </div>
  );
}

function NoPreview({ file, reason }: { file: WorkbotAttachment; reason?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <FileBadge name={file.name} mediaType={file.mediaType} />
      <p className="text-[13px] leading-5 text-[var(--wb-muted)]">{reason ?? "This kind of file can't be shown here."}</p>
      <button
        type="button"
        onClick={() => void downloadWorkbotFile(file)}
        className="rounded-full bg-[var(--wb-ink)] px-4 py-2 text-[13px] font-medium text-[var(--wb-on-ink)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
      >
        Download
      </button>
    </div>
  );
}

function ImagePreview({ file }: { file: WorkbotAttachment }) {
  const url = useWorkbotImageUrl(file.id, file.updatedAt);
  if (!url) return <Loading />;
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      {/* Blob URL from our own API; next/image cannot optimize it. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={file.name} className="max-h-full max-w-full rounded-lg object-contain outline outline-1 -outline-offset-1 outline-black/10" />
    </div>
  );
}

/** The browser's own PDF viewer, without its toolbar, pages fitted to the panel's width. */
function PdfFrame({ url, title }: { url: string; title: string }) {
  return <iframe src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={title} className="block h-full min-h-[70vh] w-full border-0 bg-[var(--wb-bg)]" />;
}

/** PDFs show as pages like slides; without a rendering, the browser's own viewer. */
function PdfPreview({ file }: { file: WorkbotAttachment }) {
  const preview = useWorkbotPreview(file.id, file.updatedAt);
  const url = useWorkbotFileUrl(preview.isSuccess && !preview.data ? file.id : null, file.updatedAt);
  if (preview.data) return <Pages file={file} preview={preview.data} kind="document" />;
  if (url.isError) return <NoPreview file={file} reason="This file couldn't load." />;
  if (!url.data) return <Loading />;
  return <PdfFrame url={url.data} title={file.name} />;
}

function MediaPreview({ file, kind }: { file: WorkbotAttachment; kind: "video" | "audio" }) {
  const url = useWorkbotFileUrl(file.id, file.updatedAt);
  if (url.isError) return <NoPreview file={file} reason="This file couldn't load." />;
  if (!url.data) return <Loading />;
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      {kind === "video" ? <video src={url.data} controls className="max-h-full w-full rounded-lg bg-black" /> : <audio src={url.data} controls className="w-full" />}
    </div>
  );
}

/** Slides and documents: the pages its computer rendered when there are some, else the text, slide by slide. */
function OfficePreview({ file, kind }: { file: WorkbotAttachment; kind: "slides" | "document" }) {
  const preview = useWorkbotPreview(file.id, file.updatedAt);
  const bytes = useWorkbotFileBytes(preview.isSuccess && !preview.data ? file.id : null, file.updatedAt);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!bytes.data) return;
    let cancelled = false;
    extractOfficeText(kind === "slides" ? "pptx" : "docx", bytes.data)
      .then((value) => !cancelled && setText(value))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [bytes.data, kind]);
  if (preview.data) return <Pages file={file} preview={preview.data} kind={kind} />;
  if (failed || bytes.isError) return <NoPreview file={file} reason="This file is too large to show here." />;
  if (text === null) return <Loading />;
  return kind === "slides" ? <SlidesOutline text={text} /> : <DocumentText text={text} />;
}

/** Rendered pages, one under the other like a deck in presenter view, each at its true proportions. */
function Pages({ file, preview, kind }: { file: WorkbotAttachment; preview: WorkbotPreview; kind: "slides" | "document" }) {
  return (
    <ol className={`mx-auto flex flex-col gap-5 px-6 py-6 ${kind === "document" ? "max-w-[720px]" : ""}`} aria-label={`${file.name}, ${preview.pages} ${kind === "slides" ? "slides" : "pages"}`}>
      {Array.from({ length: preview.pages }, (_, index) => (
        <li key={index} className="flex flex-col gap-2">
          <PageImage fileId={file.id} page={index + 1} version={file.updatedAt} ratio={`${preview.width} / ${preview.height}`} />
          {preview.pages > 1 ? <span className="pl-0.5 text-[11.5px] tabular-nums leading-4 text-[var(--wb-faint)]">{index + 1}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function PageImage({ fileId, page, version, ratio }: { fileId: string; page: number; version?: number; ratio: string }) {
  const url = useWorkbotPreviewPage(fileId, page, version);
  return (
    <div className="overflow-hidden rounded-[10px] bg-[var(--wb-surface)] shadow-[var(--wb-page-shadow)]" style={{ aspectRatio: ratio }}>
      {url.data ? (
        // Blob URL from our own API; next/image cannot optimize it.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url.data} alt={`Page ${page}`} className="workbot-fade-in block h-full w-full object-contain" />
      ) : (
        <span className="block h-full w-full animate-pulse bg-[var(--wb-chip)] motion-reduce:animate-none" />
      )}
    </div>
  );
}

/** `extractOfficeText` marks each slide's text with its part name; notes parts are left out. */
function slidesFrom(text: string) {
  return text
    .split(/^\[(ppt\/[^\]]+)\]\n/m)
    .reduce<Array<{ part: string; body: string }>>((slides, chunk, index, parts) => {
      if (index % 2 === 1 && /ppt\/slides\/slide\d+\.xml/.test(chunk)) slides.push({ part: chunk, body: (parts[index + 1] ?? "").trim() });
      return slides;
    }, []);
}

function SlidesOutline({ text }: { text: string }) {
  const slides = useMemo(() => slidesFrom(text), [text]);
  if (slides.length === 0) return <DocumentText text={text} />;
  return (
    <ol className="flex flex-col gap-4 p-6">
      {slides.map((slide, index) => {
        const [title = "", ...lines] = slide.body.split("\n").map((line) => line.trim()).filter(Boolean);
        return (
          <li key={slide.part} className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium tabular-nums text-[var(--wb-faint)]">{index + 1}</span>
            <div className="flex aspect-video flex-col gap-2 overflow-hidden rounded-xl bg-[var(--wb-surface)] p-[6%] shadow-[var(--wb-card-shadow)]">
              <p className="text-[17px] font-semibold leading-6 tracking-[-0.01em] text-[var(--wb-text)]">{title}</p>
              <ul className="flex flex-col gap-1">
                {lines.slice(0, 8).map((line, lineIndex) => (
                  <li key={lineIndex} className="text-[13px] leading-5 text-[var(--wb-muted)]">{line}</li>
                ))}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function DocumentText({ text }: { text: string }) {
  const body = text.replace(/^\[[^\]]+\]\n/gm, "");
  return (
    <div className="mx-auto max-w-[680px] whitespace-pre-wrap p-8 text-[14px] leading-6 text-[var(--wb-text)]">{body}</div>
  );
}

/** Files read straight from their bytes: text, markdown, CSV, Excel and HTML. */
function BytesPreview({ file, kind }: { file: WorkbotAttachment; kind: Exclude<Kind, "image" | "pdf" | "video" | "audio" | "slides" | "document" | "other"> }) {
  const bytes = useWorkbotFileBytes(file.id, file.updatedAt);
  if (bytes.isError) return <NoPreview file={file} reason="This file couldn't load." />;
  if (!bytes.data) return <Loading />;
  if (kind === "sheet") return <SheetPreview file={file} bytes={bytes.data} />;
  const text = new TextDecoder().decode(bytes.data.subarray(0, 2_000_000));
  if (kind === "markdown") {
    return (
      <div className="mx-auto max-w-[680px] p-8">
        <WorkbotMarkdown text={text} />
      </div>
    );
  }
  if (kind === "csv") return <Grid rows={parseDelimited(text, extensionOf(file.name) === "tsv" ? "\t" : ",")} />;
  // Untrusted HTML runs only in an opaque-origin frame: scripts, but no access to this page (never allow-same-origin).
  if (kind === "html") return <iframe srcDoc={text} sandbox="allow-scripts" title={file.name} className="block h-full min-h-[70vh] w-full border-0 bg-white" />;
  return <pre className="whitespace-pre-wrap break-words p-6 font-mono text-[12px] leading-5 text-[var(--wb-text)]">{text}</pre>;
}

function SheetPreview({ file, bytes }: { file: WorkbotAttachment; bytes: Uint8Array }) {
  const [workbook, setWorkbook] = useState<XlsxWorkbook | null>(null);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    openXlsxWorkbook(bytes)
      .then((value) => !cancelled && setWorkbook(value))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  const visible = useMemo(() => workbook?.sheets.filter((sheet) => !sheet.hidden) ?? [], [workbook]);
  useEffect(() => {
    const sheet = visible[sheetIndex];
    if (!workbook || !sheet) return;
    let cancelled = false;
    setRows(null);
    workbook
      .readSheet(sheet)
      .then((data) => !cancelled && setRows(sheetGridRows(data)))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [workbook, visible, sheetIndex]);
  if (failed) return <NoPreview file={file} reason="This workbook is too large to show here." />;
  if (!rows) return <Loading />;
  return (
    <div className="flex min-h-full flex-col">
      {visible.length > 1 ? (
        <div className="flex shrink-0 gap-1 px-5 pt-4" role="tablist" aria-label="Sheets">
          {visible.map((sheet, index) => (
            <button
              key={sheet.name}
              type="button"
              role="tab"
              aria-selected={index === sheetIndex}
              onClick={() => setSheetIndex(index)}
              className={`rounded-full px-3 py-1 text-[12px] font-medium transition-colors duration-150 ${index === sheetIndex ? "bg-[var(--wb-ink)] text-[var(--wb-on-ink)]" : "text-[var(--wb-muted)] hover:bg-[var(--wb-chip)]"}`}
            >
              {sheet.name}
            </button>
          ))}
        </div>
      ) : null}
      <Grid rows={rows} />
    </div>
  );
}

/** A read-only grid: a sticky header row, hairlines, tabular numbers, and a row cap so huge sheets stay quick. */
function Grid({ rows }: { rows: string[][] }) {
  const [header = [], ...body] = rows.slice(0, 1_000);
  const columns = Math.max(header.length, ...body.map((row) => row.length));
  return (
    <div className="overflow-auto p-5">
      <table className="min-w-full border-separate border-spacing-0 overflow-hidden rounded-xl bg-[var(--wb-surface)] text-left text-[12.5px] leading-5 shadow-[var(--wb-card-shadow)]">
        <thead className="sticky top-0">
          <tr>
            {Array.from({ length: columns }, (_, index) => (
              <th key={index} className="whitespace-nowrap border-b border-[var(--wb-hairline)] bg-[var(--wb-tray)] px-3 py-2 font-semibold text-[var(--wb-text)]">{header[index] ?? ""}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {Array.from({ length: columns }, (_, index) => (
                <td key={index} className="whitespace-nowrap border-b border-[var(--wb-row-line)] px-3 py-1.5 tabular-nums text-[var(--wb-text)]">{row[index] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** CSV/TSV with quoted cells and escaped quotes (the desktop app's artifact parser). */
function parseDelimited(content: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.length ? rows : [[""]];
}
