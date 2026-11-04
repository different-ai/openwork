/** @jsxImportSource react */
import type * as React from "react";
import { useEffect, useState } from "react";
import { FileWarning } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { MarkdownBlock } from "../surface/markdown";
import type { OfficeBlock, OfficePreview, OfficeSlide } from "./office-preview";

/** Rendered documents read in one comfortable column, like a page. */
const READING_COLUMN = "mx-auto w-full max-w-[72ch] px-6 py-6 [overflow-wrap:anywhere]";

/** Wait this long before showing a skeleton, so fast local reads never flash. */
const SKELETON_DELAY_MS = 150;

export type PreviewLoadingShape = "document" | "sheet" | "media";

interface PreviewLoadingProps extends React.ComponentProps<"div"> {
  shape?: PreviewLoadingShape;
}

const DOCUMENT_LINE_WIDTHS = ["w-11/12", "w-full", "w-10/12", "w-full", "w-8/12"];

/** Layout-matching skeleton for the artifact panel (DESIGN.md States). */
export function PreviewLoading({ shape = "document", className, ...props }: PreviewLoadingProps) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), SKELETON_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      aria-label="Loading preview"
      data-testid="artifact-preview-loading"
      data-shape={shape}
      className={cn(
        "h-full overflow-hidden opacity-0 transition-opacity duration-150 ease-out motion-reduce:transition-none",
        visible && "opacity-100",
        className,
      )}
      {...props}
    >
      {shape === "sheet" ? (
        <div className="flex flex-col gap-px p-3">
          {Array.from({ length: 8 }, (_, row) => (
            <div key={row} className="grid grid-cols-4 gap-px">
              {Array.from({ length: 4 }, (_, column) => <Skeleton key={column} className="h-7 rounded-sm" />)}
            </div>
          ))}
        </div>
      ) : shape === "media" ? (
        <div className="flex h-full items-center justify-center p-6">
          <Skeleton className="aspect-[3/4] h-full max-h-[32rem] rounded-md" />
        </div>
      ) : (
        <div className={cn(READING_COLUMN, "flex flex-col gap-3")}>
          <Skeleton className="mb-2 h-5 w-1/2 rounded-md" />
          {[0, 1].map((paragraph) => (
            <div key={paragraph} className="flex flex-col gap-2 pb-3">
              {DOCUMENT_LINE_WIDTHS.map((width, line) => <Skeleton key={line} className={cn("h-3 rounded-sm", width)} />)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface PreviewErrorProps extends React.ComponentProps<"div"> {
  message: string;
}

export function PreviewError({ message, className, ...props }: PreviewErrorProps) {
  return <div className={cn("p-4 text-sm text-muted-foreground", className)} {...props}>{message}</div>;
}

interface PlainTextProps extends React.ComponentProps<"pre"> {
  content: string;
}

export function PlainText({ content, className, ...props }: PlainTextProps) {
  return <pre className={cn("h-full overflow-auto p-4 text-xs leading-5 text-foreground whitespace-pre-wrap", className)} {...props}>{content}</pre>;
}

interface MarkdownPreviewProps extends React.ComponentProps<"div"> {
  content: string;
  mermaidSource?: boolean;
}

function mermaidSourceMarkdown(content: string) {
  let longestBacktickRun = 2;
  let currentBacktickRun = 0;
  for (const character of content) {
    currentBacktickRun = character === "`" ? currentBacktickRun + 1 : 0;
    if (currentBacktickRun > longestBacktickRun) longestBacktickRun = currentBacktickRun;
  }
  const fence = "`".repeat(longestBacktickRun + 1);
  return `${fence}mermaid\n${content}\n${fence}`;
}

export function MarkdownPreview({ content, mermaidSource = false, className, ...props }: MarkdownPreviewProps) {
  return (
    <div data-openwork-markdown-preview="" data-openwork-mermaid-artifact={mermaidSource ? "" : undefined} className={cn("h-full overflow-auto", className)} {...props}>
      <div className={READING_COLUMN}>
        <MarkdownBlock text={mermaidSource ? mermaidSourceMarkdown(content) : content} />
      </div>
    </div>
  );
}

interface TextHTMLPreviewProps {
  type: "text";
  title: string;
  content: string;
}

interface BinaryHTMLPreviewProps {
  type: "binary";
  title: string;
  url: string;
}

type HTMLPreviewProps = { className?: string } & (TextHTMLPreviewProps | BinaryHTMLPreviewProps);

// Workspace HTML is untrusted. srcdoc and app-created blob: URLs inherit the
// app's origin, so the frame must never get allow-same-origin: it would run as
// the main window and reach the desktop bridge. Scripts run in an opaque origin.
export const HTML_PREVIEW_SANDBOX = "allow-scripts";

export function HTMLPreview({ className, ...props }: HTMLPreviewProps) {
  if (props.type === "text") {
    return <iframe srcDoc={props.content} title={props.title} className={cn("h-full w-full border-0", className)} sandbox={HTML_PREVIEW_SANDBOX} />;
  }

  return <iframe src={props.url} title={props.title} className={cn("h-full w-full border-0", className)} sandbox={HTML_PREVIEW_SANDBOX} />;
}

interface PdfPreviewProps {
  url: string;
  title: string;
  className?: string;
}

export function PdfPreview({ url, title, className }: PdfPreviewProps) {
  // Chromium's built-in PDF viewer (enabled via webPreferences.plugins) renders
  // reliably through <embed>; <object>/sandboxed <iframe> show a blank frame.
  // The blob URL comes from a trusted workspace file.
  return <embed src={url} type="application/pdf" title={title} data-testid="artifact-pdf-preview" className={cn("h-full w-full border-0", className)} />;
}

interface ImagePreviewProps extends React.ComponentProps<"div"> {
  src: string;
  alt: string;
}

export function ImagePreview({ src, alt, className, ...props }: ImagePreviewProps) {
  return (
    <div className={cn("flex h-full items-center justify-center overflow-auto bg-muted/30 p-3", className)} {...props}>
      <img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

interface PreviewUnavailableProps extends React.ComponentProps<"div"> {
  /** What happened, e.g. "This file is too large to preview." */
  reason?: string;
  onOpenExternally?: () => void;
}

export function PreviewUnavailable({ reason, onOpenExternally, className, ...props }: PreviewUnavailableProps) {
  return (
    <div className={cn("flex h-full flex-col items-center justify-center gap-3 p-6 text-center", className)} {...props}>
      <FileWarning className="size-4 text-muted-foreground" aria-hidden />
      <p className="max-w-xs text-sm text-muted-foreground">
        {reason ?? "This file can't be previewed here."}
        {onOpenExternally ? null : " Download it to open it in another app."}
      </p>
      {onOpenExternally ? (
        <Button variant="outline" size="sm" onClick={onOpenExternally}>Open in default app</Button>
      ) : null}
    </div>
  );
}

function OfficeRuns({ block }: { block: Extract<OfficeBlock, { type: "paragraph" }> }) {
  return (
    <>
      {block.runs.map((run, index) => (
        <span
          key={index}
          className={cn(run.bold && "font-semibold", run.italic && "italic", run.underline && "underline underline-offset-2")}
        >
          {run.text}
        </span>
      ))}
    </>
  );
}

function OfficeDocumentBlocks({ blocks }: { blocks: OfficeBlock[] }) {
  const nodes: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  const flushList = () => {
    if (!listItems.length) return;
    nodes.push(<ul key={`list-${nodes.length}`} className="my-2 list-disc space-y-1 ps-5">{listItems}</ul>);
    listItems = [];
  };

  blocks.forEach((block, index) => {
    if (block.type === "paragraph" && block.list) {
      listItems.push(<li key={index}><OfficeRuns block={block} /></li>);
      return;
    }
    flushList();
    if (block.type === "heading") {
      const size = block.level === 1 ? "text-xl" : block.level === 2 ? "text-base" : "text-sm";
      nodes.push(
        <p key={index} role="heading" aria-level={block.level} className={cn("mt-6 mb-2 font-semibold tracking-tight text-foreground first:mt-0", size)}>
          {block.text}
        </p>,
      );
    } else if (block.type === "paragraph") {
      nodes.push(<p key={index} className="my-2 whitespace-pre-wrap"><OfficeRuns block={block} /></p>);
    } else {
      nodes.push(
        <div key={index} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-border">
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={cn("whitespace-pre-wrap px-2 py-1.5 align-top", rowIndex === 0 && "font-medium")}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    }
  });
  flushList();
  return <>{nodes}</>;
}

function OfficeSlides({ slides }: { slides: OfficeSlide[] }) {
  return (
    <ol className="flex flex-col gap-4">
      {slides.map((slide) => (
        <li key={slide.number} className="rounded-lg bg-muted/40 px-5 py-4" aria-label={`Slide ${slide.number}`}>
          <div className="mb-2 flex items-baseline gap-3">
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">{slide.number}</span>
            <p className="min-w-0 font-semibold tracking-tight text-foreground">{slide.title || `Slide ${slide.number}`}</p>
          </div>
          {slide.body.length ? (
            <ul className="ms-6 list-disc space-y-1 ps-4">
              {slide.body.map((line, index) => <li key={index}>{line}</li>)}
            </ul>
          ) : null}
          {slide.notes.length ? (
            <div className="ms-6 mt-3 border-t border-border pt-2 text-xs text-muted-foreground">
              {slide.notes.map((line, index) => <p key={index}>{line}</p>)}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

interface OfficePreviewViewProps extends React.ComponentProps<"div"> {
  preview: OfficePreview;
  onOpenExternally?: () => void;
}

/** Read-only text view of a Word document or PowerPoint deck. */
export function OfficePreviewView({ preview, onOpenExternally, className, ...props }: OfficePreviewViewProps) {
  const empty = preview.kind === "document" ? preview.blocks.length === 0 : preview.slides.length === 0;
  if (empty) {
    return <PreviewUnavailable reason="This file has no text to show." onOpenExternally={onOpenExternally} />;
  }
  return (
    <div data-testid="artifact-office-preview" data-kind={preview.kind} className={cn("h-full overflow-auto", className)} {...props}>
      <div className={cn(READING_COLUMN, "text-sm leading-relaxed text-foreground select-text")}>
        {preview.kind === "document" ? <OfficeDocumentBlocks blocks={preview.blocks} /> : <OfficeSlides slides={preview.slides} />}
        {preview.truncated ? (
          <p className="mt-6 border-t border-border pt-3 text-xs text-muted-foreground">
            Showing the beginning of this file.
            {onOpenExternally ? <> <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={onOpenExternally}>Open it</button> to read the rest.</> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
