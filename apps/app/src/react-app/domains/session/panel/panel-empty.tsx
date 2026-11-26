/** @jsxImportSource react */
import * as React from "react";
import { ArrowLeft, ArrowRight, FileCode, FileImage, FileSpreadsheet, FileText, Globe, MessagesSquare, Puzzle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn, formatFileSize } from "@/lib/utils";
import { formatRelativeTime } from "@/app/utils";
import type { OpenTarget, OpenTargetPreview } from "../artifacts/open-target";

import type { EmptyPanelView } from "./files-rail";

export type PanelEmptyActions = {
  onOpenBrowser?: () => void;
  onOpenFiles: () => void;
  onOpenExtensions?: () => void;
  onOpenSideChat?: () => void;
};

export function handlePanelEscape(key: string, onClose: () => void) {
  if (key !== "Escape") return false;
  onClose();
  return true;
}

type PanelDestination = {
  id: "browser" | "files" | "extensions" | "side-chat";
  label: string;
  description: string;
  icon: React.ReactNode;
  activate: () => void;
};

export function getPanelDestinations(actions: PanelEmptyActions): PanelDestination[] {
  const destinations: PanelDestination[] = [];

  if (actions.onOpenBrowser) {
    destinations.push({
      id: "browser",
      label: "Browser",
      description: "Open a new page in the built-in browser.",
      icon: <Globe aria-hidden="true" />,
      activate: actions.onOpenBrowser,
    });
  }

  destinations.push({
    id: "files",
    label: "Files & artifacts",
    description: "View files and artifacts created in this session.",
    icon: <FileText aria-hidden="true" />,
    activate: actions.onOpenFiles,
  });

  if (actions.onOpenSideChat) {
    destinations.push({
      id: "side-chat",
      label: t("session_management.split_view"),
      description: t("side_question.destination_description"),
      icon: <MessagesSquare aria-hidden="true" />,
      activate: actions.onOpenSideChat,
    });
  }

  if (actions.onOpenExtensions) {
    destinations.push({
      id: "extensions",
      label: "Library",
      description: "Browse the skills and connections available to your agent.",
      icon: <Puzzle aria-hidden="true" />,
      activate: actions.onOpenExtensions,
    });
  }

  return destinations;
}

function fileIcon(preview: OpenTargetPreview) {
  if (preview === "sheet") return <FileSpreadsheet aria-hidden="true" />;
  if (preview === "code" || preview === "html") return <FileCode aria-hidden="true" />;
  if (preview === "image") return <FileImage aria-hidden="true" />;
  if (preview === "browser" || preview === "external") return <Globe aria-hidden="true" />;
  return <FileText aria-hidden="true" />;
}

function fileDetails(target: OpenTarget) {
  const parts = [target.kind === "url" ? target.value : target.value.split("/").slice(0, -1).join("/") || target.value];
  if (target.size !== undefined) parts.push(formatFileSize(target.size));
  if (target.updatedAt !== undefined) parts.push(formatRelativeTime(target.updatedAt));
  return parts.join(" · ");
}

function FileSection({ title, description, files, onOpenFile }: {
  title: string;
  description: string;
  files: OpenTarget[];
  onOpenFile: (target: OpenTarget) => void;
}) {
  return (
    <section className="mt-6 first:mt-0">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">{files.length === 1 ? "1 file" : `${files.length} files`}</span>
      </div>
      <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-background">
        {files.map((target) => (
          <button
            key={target.id}
            type="button"
            className="flex w-full items-center gap-3 border-b border-border/60 px-3 py-2.5 text-left transition-colors last:border-b-0 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
            onClick={() => onOpenFile(target)}
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground shadow-xs [&_svg]:size-4 [&_svg]:stroke-[1.5]">
              {fileIcon(target.preview)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-foreground">{target.name}</span>
              <span className="block truncate font-mono text-xs text-muted-foreground">{fileDetails(target)}</span>
            </span>
            <span className="shrink-0 text-xs font-medium text-foreground">Open</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function CompactFiles({ files, onOpenFile, onBack, workspaceTree }: {
  files: OpenTarget[];
  onOpenFile?: (target: OpenTarget) => void;
  onBack: () => void;
  workspaceTree?: React.ReactNode;
}) {
  const sessionFiles = files.filter((target) => target.fileScope !== "workspace");
  const workspaceFiles = files.filter((target) => target.fileScope === "workspace");
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-6 pt-3">
      <Button variant="ghost" size="xs" className="-ms-2 w-fit gap-1.5 text-muted-foreground" onClick={onBack}>
        <ArrowLeft />
        All destinations
      </Button>
      <h2 className="mt-4 text-lg font-semibold text-foreground">Files</h2>
      <p className="mt-1 text-sm leading-6 text-muted-foreground">
        Files and artifacts your agent created or used in this session.
      </p>
      <div className="mt-6">
        {files.length > 0 && onOpenFile ? (
          <>
            {sessionFiles.length > 0 ? (
              <FileSection title="In this session" description="Created or changed while you worked here." files={sessionFiles} onOpenFile={onOpenFile} />
            ) : null}
            {workspaceFiles.length > 0 ? (
              <FileSection title="In your workspace" description="Files in this workspace that the session referenced." files={workspaceFiles} onOpenFile={onOpenFile} />
            ) : null}
          </>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
              <FileText aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm text-foreground">No files from this session yet</span>
              <span className="block text-xs text-muted-foreground">Files your agent creates or changes will show up here.</span>
            </span>
          </div>
        )}
        {workspaceTree ? (
          <section className="mt-6">
            <h3 className="text-sm font-medium text-foreground">Working folder</h3>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">Everything in the folder this session works in.</p>
            <div className="mt-3">{workspaceTree}</div>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function PanelEmpty({
  view,
  onShowChooser,
  onOpenBrowser,
  onOpenFiles,
  onOpenExtensions,
  onOpenSideChat,
  onOpenFile,
  files = [],
  compact = false,
  workspaceTree,
}: PanelEmptyActions & {
  view: EmptyPanelView;
  onShowChooser: () => void;
  compact?: boolean;
  workspaceTree?: React.ReactNode;
  files?: OpenTarget[];
  onOpenFile?: (target: OpenTarget) => void;
}) {
  const [compactFilesOpen, setCompactFilesOpen] = React.useState(false);

  if (compact && (compactFilesOpen || view === "files")) {
    return (
      <CompactFiles
        files={files}
        onOpenFile={onOpenFile}
        workspaceTree={workspaceTree}
        onBack={() => {
          setCompactFilesOpen(false);
          onShowChooser();
        }}
      />
    );
  }

  if (view === "files") {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
        <Button
          variant="ghost"
          size="sm"
          className="mb-6 w-fit gap-2"
          onClick={onShowChooser}
        >
          <ArrowLeft />
          All destinations
        </Button>
        <div className="m-auto max-w-sm text-center">
          <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-xl bg-muted text-muted-foreground">
            <FileText aria-hidden="true" />
          </span>
          <h2 className="text-base font-medium text-foreground">No files or artifacts yet</h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Files and artifacts created in this session will appear here automatically.
          </p>
        </div>
      </div>
    );
  }

  const destinations = getPanelDestinations({ onOpenBrowser, onOpenFiles: compact ? () => setCompactFilesOpen(true) : onOpenFiles, onOpenExtensions, onOpenSideChat });

  if (compact) {
    return (
      <div className="flex min-h-0 flex-1 overflow-y-auto p-6">
        <div className={cn("m-auto grid w-full max-w-[356px] gap-2.5", destinations.length === 3 ? "grid-cols-3" : "grid-cols-2")} aria-label="Panel destinations">
          {[...destinations.filter((item) => item.id === "files"), ...destinations.filter((item) => item.id !== "files")].map((item) => (
            <Button
              key={item.id}
              variant="outline"
              className="h-20 flex-col gap-2 rounded-lg bg-transparent font-normal shadow-none hover:bg-muted [&_svg]:size-4 [&_svg]:stroke-[1.5] [&_svg]:text-muted-foreground"
              onClick={() => item.activate()}
            >
              {item.icon}
              {item.id === "files" ? "Files" : item.label}
            </Button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
      <div className="my-auto w-full max-w-xl self-center">
        <h2 className="text-base font-medium text-foreground">Choose a destination</h2>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">
          Open a tool or return here whenever you want to switch.
        </p>
        <div className="mt-5 grid gap-2" aria-label="Panel destinations">
          {destinations.map((item) => (
            <button
              key={item.id}
              type="button"
              className={cn(
                "group flex min-h-16 w-full items-center gap-3 rounded-xl border border-border bg-background p-3 text-left",
                "transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
              onClick={() => item.activate()}
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">{item.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{item.description}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
