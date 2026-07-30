/** @jsxImportSource react */
import { lazy, Suspense, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Download, ExternalLink, FolderOpen, X } from "lucide-react";

import { OpenworkServerError, type OpenworkServerClient } from "@/app/lib/openwork-server";
import { getDesktopFileIcon, openDesktopPath, revealDesktopItemInDir } from "@/app/lib/desktop";
import { isElectronRuntime } from "@/app/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatFileSize } from "@/lib/utils";
import { usePlatform } from "@/react-app/kernel/platform";
import { type ArtifactPanelTab, usePanelTabStore } from "../panel/panel-tab-store";
import { ArtifactAutosaveController } from "./artifact-autosave";
import { serializeSpreadsheet, type SpreadsheetRows } from "./artifact-spreadsheet-model";
import { isCollectibleArtifactTarget, type BinaryData, type Data, type OpenTarget, type TextData } from "./open-target";
import { HTMLPreview, ImagePreview, MarkdownPreview, PdfPreview, PlainText, PreviewError, PreviewLoading, PreviewUnavailable } from "./preview";

const ArtifactTextEditor = lazy(() =>
  import("./artifact-text-editor").then((module) => ({ default: module.ArtifactTextEditor })),
);
const ArtifactSpreadsheetEditor = lazy(() =>
  import("./artifact-spreadsheet-editor").then((module) => ({ default: module.ArtifactSpreadsheetEditor })),
);

const EMPTY_TRANSCRIPT_TARGETS: OpenTarget[] = [];
const MARKDOWN_PRIMITIVE_EVAL_ARTIFACT_PATH = "artifacts/markdown-primitive-proof.md";
const MARKDOWN_PRIMITIVE_EVAL_ARTIFACT_NAME = "markdown-primitive-proof.md";

function isMarkdownPrimitiveEvalArtifact(target: OpenTarget) {
  return import.meta.env.DEV &&
    target.kind === "file" &&
    target.reason === "eval" &&
    target.value === MARKDOWN_PRIMITIVE_EVAL_ARTIFACT_PATH &&
    target.name === MARKDOWN_PRIMITIVE_EVAL_ARTIFACT_NAME;
}

type ArtifactPanelProps = {
  sessionId: string;
  tab: ArtifactPanelTab;
  client: OpenworkServerClient | null;
  workspaceId: string | null;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  onClose: () => void;
};

type ArtifactPanelViewProps = {
  client: OpenworkServerClient;
  workspaceId: string;
  workspaceRoot: string;
  isRemoteWorkspace?: boolean;
  target: OpenTarget;
  onClose: () => void;
};

type ArtifactQueryState =
  | (TextData & { updatedAt: number | null })
  | (BinaryData & { contentType: string | null; updatedAt: number | null });

type SpreadsheetDraft = { kind: "spreadsheet"; rows: SpreadsheetRows };
type ArtifactDraft = Data | SpreadsheetDraft;

const autosaveControllers = new WeakMap<OpenworkServerClient, Map<string, ArtifactAutosaveController<ArtifactDraft>>>();
const dirtyAutosaves = new Set<ArtifactAutosaveController<ArtifactDraft>>();

function flushRetainedAutosaves() {
  for (const autosave of dirtyAutosaves) autosave.flush();
}

function hasDirtyRetainedAutosave() {
  return dirtyAutosaves.size > 0;
}

function absoluteWorkspacePath(root: string, path: string) {
  const cleanRoot = root.trim().replace(/[/\\]+$/, "");
  const cleanPath = path.trim().replace(/^\.\//, "");
  
  return cleanRoot ? `${cleanRoot}/${cleanPath}` : cleanPath;
}

function isTextContent(target: OpenTarget): boolean {
  return ["markdown", "text", "sheet", "html"].includes(target.preview) && !/\.(xlsx|xls|ods)$/i.test(target.value);
}

function dataEquals(left: ArtifactDraft, right: ArtifactDraft) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "spreadsheet" && right.kind === "spreadsheet") {
    return left.rows.length === right.rows.length && left.rows.every((row, rowIndex) => {
      const other = right.rows[rowIndex];
      return other !== undefined && row.length === other.length && row.every((cell, columnIndex) => cell === other[columnIndex]);
    });
  }
  if (left.kind === "text" && right.kind === "text") return left.data === right.data;
  if (left.kind !== "binary" || right.kind !== "binary") return false;
  if (left.data.byteLength !== right.data.byteLength) return false;
  const leftBytes = new Uint8Array(left.data);
  const rightBytes = new Uint8Array(right.data);
  return leftBytes.every((value, index) => value === rightBytes[index]);
}

function isConflict(error: unknown) {
  return error instanceof OpenworkServerError && error.status === 409;
}

function conflictUpdatedAt(error: unknown) {
  if (!(error instanceof OpenworkServerError) || !error.details || typeof error.details !== "object") return null;
  if (!("currentUpdatedAt" in error.details)) return null;
  const value = error.details.currentUpdatedAt;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function editablePayload(data: ArtifactQueryState): ArtifactDraft {
  return data.kind === "text"
    ? { kind: "text", data: data.data }
    : { kind: "binary", data: data.data };
}

export function ArtifactPanel({ sessionId, tab, client, workspaceId, workspaceRoot, isRemoteWorkspace = false, onClose }: ArtifactPanelProps) {
  const transcriptTargets = usePanelTabStore((state) => state.transcriptArtifactTargets[sessionId] ?? EMPTY_TRANSCRIPT_TARGETS);
  const artifactTargets = useMemo(() => transcriptTargets.filter(isCollectibleArtifactTarget), [transcriptTargets]);
  const target = artifactTargets.find((item) => item.id === tab.id) ?? null;

  if (!target || !client || !workspaceId) {
    return null;
  }

  return (
    <ArtifactPanelView
      client={client}
      workspaceId={workspaceId}
      workspaceRoot={workspaceRoot}
      isRemoteWorkspace={isRemoteWorkspace}
      target={target}
      onClose={onClose}
    />
  );
}

function ArtifactPanelView({ client, workspaceId, workspaceRoot, isRemoteWorkspace = false, target, onClose }: ArtifactPanelViewProps) {
  const platform = usePlatform();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [reloading, setReloading] = useState(false);
  const isDirectTextEdit = isTextContent(target) && target.preview === "markdown" && !isMarkdownPrimitiveEvalArtifact(target);
  const externalPath = useMemo(() => target.kind === "file" ? absoluteWorkspacePath(workspaceRoot, target.value) : target.value, [target.kind, target.value, workspaceRoot]);
  const canUseDesktopFileActions = target.kind === "file" && !isRemoteWorkspace && platform.capabilities.revealInFileManager;

  const { data: fileIcon } = useQuery<string | null>({
    queryKey: ["desktop-file-icon", externalPath] as const,
    queryFn: async () => getDesktopFileIcon(externalPath, "small"),
    enabled: canUseDesktopFileActions && isElectronRuntime(),
    staleTime: Infinity,
    gcTime: 5 * 60 * 1000,
  });

  const { data, error, isError, isLoading } = useQuery<ArtifactQueryState>({
    queryKey: ["artifact-panel", workspaceId, target.id, target.updatedAt ?? null] as const,
    queryFn: async () => {
      if (target.kind === "url") {
        throw new Error("URLs open in browser tabs.");
      }
      else if (target.exists === false) {
        throw new Error("File not found in this workspace.");
      }

      if (isTextContent(target)) {
        const result = await client.readWorkspaceFile(workspaceId, target.value);

        return { kind: "text", data: result.content, updatedAt: result.updatedAt ?? null };
      }

      const before = await client.statWorkspaceFile(workspaceId, target.value);
      const result = await client.downloadWorkspaceFile(workspaceId, target.value);
      const after = await client.statWorkspaceFile(workspaceId, target.value);
      if (before.updatedAt !== after.updatedAt) {
        throw new Error("The file changed while it was loading. Try again.");
      }

      return { kind: "binary", data: result.data, contentType: result.contentType, updatedAt: after.updatedAt ?? null };
    },
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const autosave = useMemo(() => {
    let controllers = autosaveControllers.get(client);
    if (!controllers) {
      controllers = new Map();
      autosaveControllers.set(client, controllers);
    }
    const key = `${workspaceId}:${target.id}:${target.value}`;
    const existing = controllers.get(key);
    if (existing) return existing;

    const queryKey = ["artifact-panel", workspaceId, target.id, target.updatedAt ?? null] as const;
    const created = new ArtifactAutosaveController<ArtifactDraft>({
      initialValue: isTextContent(target)
        ? { kind: "text", data: "" }
        : { kind: "binary", data: new ArrayBuffer(0) },
      initialUpdatedAt: target.updatedAt ?? null,
      equals: dataEquals,
      isConflict,
      write: async (payload, baseUpdatedAt) => {
        if (target.kind !== "file") throw new Error("Cannot save non-file artifact.");
        const serialized = payload.kind === "spreadsheet"
          ? await serializeSpreadsheet(target.name, payload.rows)
          : payload;
        if (serialized.kind === "text") {
          return client.writeWorkspaceFile(workspaceId, {
            path: target.value,
            content: serialized.data,
            baseUpdatedAt,
          });
        }
        return client.writeWorkspaceBinaryFile(workspaceId, {
          path: target.value,
          data: serialized.data,
          baseUpdatedAt,
        });
      },
      onSaved: (payload, result) => {
        if (payload.kind === "spreadsheet") return;
        queryClient.setQueryData<ArtifactQueryState>(queryKey, (current) => payload.kind === "text"
          ? { kind: "text", data: payload.data, updatedAt: result.updatedAt }
          : {
              kind: "binary",
              data: payload.data,
              contentType: current?.kind === "binary" ? current.contentType : null,
              updatedAt: result.updatedAt,
            });
      },
    });
    controllers.set(key, created);
    created.subscribe(() => {
      if (created.getSnapshot().dirty) dirtyAutosaves.add(created);
      else dirtyAutosaves.delete(created);
    });
    return created;
  }, [client, queryClient, target.id, target.kind, target.value, workspaceId]);
  const autosaveState = useSyncExternalStore(autosave.subscribe, autosave.getSnapshot, autosave.getSnapshot);

  const [binaryObjectUrl, setBinaryObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data || data.kind !== "binary") {
      setBinaryObjectUrl(null);

      return;
    }

    const fallbackType = target.preview === "pdf" ? "application/pdf" : "application/octet-stream";
    const url = URL.createObjectURL(new Blob([data.data], { type: data.contentType ?? fallbackType }));

    setBinaryObjectUrl(url);

    return () => URL.revokeObjectURL(url);
  }, [data, target.preview]);

  useEffect(() => {
    setEditing(false);
  }, [target.id, workspaceId]);

  useEffect(() => {
    if (!data) return;
    autosave.acceptExternal(editablePayload(data), data.updatedAt);
  }, [autosave, data]);

  useEffect(() => {
    const flush = () => flushRetainedAutosaves();
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (!hasDirtyRetainedAutosave()) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [autosave]);

  const download = async () => {
    if (target.kind === "url") {
      return;
    }
    
    const result = await client.downloadWorkspaceFile(workspaceId, target.value);
    const url = URL.createObjectURL(new Blob([result.data], { type: result.contentType ?? "application/octet-stream" }));
    const anchor = document.createElement("a");

    anchor.href = url;
    anchor.download = target.name;
    anchor.click();

    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const openExternal = async () => {
    if (target.kind === "url") {
      window.open(target.value, "_blank", "noopener,noreferrer");

      return;
    }
    else if (!isRemoteWorkspace) {
      try {
        await openDesktopPath(externalPath);
      } catch (cause) {
        toast.error(cause instanceof Error ? cause.message : "Could not open this file.");
      }

      return;
    }

    await download();
  };

  const revealExternal = async () => {
    if (target.kind !== "file" || isRemoteWorkspace) return;
    try {
      await revealDesktopItemInDir(externalPath);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not show this file in your file manager.");
    }
  };

  const reloadExternal = async () => {
    if (target.kind !== "file") return;
    setReloading(true);
    try {
      let next: ArtifactQueryState;
      if (isTextContent(target)) {
        const result = await client.readWorkspaceFile(workspaceId, target.value);
        const after = await client.statWorkspaceFile(workspaceId, target.value);
        if (result.updatedAt !== after.updatedAt) {
          throw new Error("The file changed while it was reloading. Try again.");
        }
        next = { kind: "text", data: result.content, updatedAt: result.updatedAt };
      } else {
        const before = await client.statWorkspaceFile(workspaceId, target.value);
        const result = await client.downloadWorkspaceFile(workspaceId, target.value);
        const after = await client.statWorkspaceFile(workspaceId, target.value);
        if (before.updatedAt !== after.updatedAt) {
          throw new Error("The file changed while it was reloading. Try again.");
        }
        next = {
          kind: "binary",
          data: result.data,
          contentType: result.contentType,
          updatedAt: after.updatedAt ?? null,
        };
      }
      autosave.applyReload(editablePayload(next), next.updatedAt);
      queryClient.setQueryData(
        ["artifact-panel", workspaceId, target.id, target.updatedAt ?? null] as const,
        next,
      );
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Could not reload this file.");
    } finally {
      setReloading(false);
    }
  };

  const close = () => {
    autosave.flush();
    onClose();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border bg-background mac:bg-background/80 mac:backdrop-blur-2xl mac:backdrop-saturate-150">
        <div className="flex h-10 items-center gap-2 pe-2 ps-4">
          <div className="min-w-0 flex-1 flex items-center gap-1.5">
            {fileIcon ? (
              <img src={fileIcon} alt="" className="h-4 w-4 shrink-0 object-contain" />
            ) : null}
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground">
              {target.name}
            </h3>
            <span className="shrink-0 text-xs text-muted-foreground">
              {target.exists === false ? "missing" : target.size !== undefined ? `${formatFileSize(target.size)}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
          {isTextContent(target) && autosaveState.ready && !isDirectTextEdit ? (
            editing ? (
              <Button variant="ghost" size="sm" onClick={() => { autosave.flush(); setEditing(false); }}>Done</Button>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={(
                    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button>
                  )}
                />
                <TooltipContent>Edit artifact</TooltipContent>
              </Tooltip>
            )
          ) : null}
          {target.kind === "file" ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={() => void download()} aria-label="Download artifact">
                    <Download />
                  </Button>
                )}
              />
              <TooltipContent>Download artifact</TooltipContent>
            </Tooltip>
          ) : null}
          {canUseDesktopFileActions ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={() => void revealExternal()} aria-label="Show in folder">
                    <FolderOpen />
                  </Button>
                )}
              />
              <TooltipContent>Show in folder</TooltipContent>
            </Tooltip>
          ) : null}
          {target.kind === "url" || isRemoteWorkspace || canUseDesktopFileActions ? (
            <Tooltip>
              <TooltipTrigger
                render={(
                  <Button variant="ghost" size="icon-sm" onClick={() => void openExternal()} aria-label={isRemoteWorkspace ? "Download artifact" : "Open externally"}>
                    <ExternalLink />
                  </Button>
                )}
              />
              <TooltipContent>{isRemoteWorkspace ? "Download artifact" : "Open externally"}</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={(
                <Button variant="ghost" size="icon-sm" onClick={close} aria-label="Close artifact">
                  <X />
                </Button>
              )}
            />
            <TooltipContent>Close artifact</TooltipContent>
          </Tooltip>
          </div>
        </div>
      </div>
      {autosaveState.failure ? (
        <div className="shrink-0 border-b border-border p-2">
          <Alert variant="warning" className="rounded-lg py-2">
            <AlertTriangle />
            <AlertTitle>{autosaveState.failure === "conflict" ? "This file changed outside OpenWork" : "Changes could not be saved"}</AlertTitle>
            <AlertDescription>
              <p>
                {autosaveState.failure === "conflict"
                  ? "Review the external version, then reload it or retry with your newest edits."
                  : autosaveState.error instanceof Error ? autosaveState.error.message : "Your newest edits are still here."}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {autosaveState.failure === "conflict" ? (
                  <Button variant="outline" size="xs" disabled={reloading || autosaveState.status === "saving"} onClick={() => void reloadExternal()}>
                    {reloading ? "Reloading" : "Reload external version"}
                  </Button>
                ) : null}
                <Button
                  variant="default"
                  size="xs"
                  disabled={reloading || autosaveState.status === "saving"}
                  onClick={() => autosave.retry(conflictUpdatedAt(autosaveState.error) ?? autosaveState.baseUpdatedAt)}
                >
                  {autosaveState.status === "saving" ? "Retrying" : "Retry newest changes"}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        {(!autosaveState.ready && isLoading) || (target.preview !== "sheet" && data?.kind === "binary" && !binaryObjectUrl) ? (
          <PreviewLoading />
        ) : isError && !autosaveState.ready ? (
          <PreviewError message={error instanceof Error ? error.message : "Failed to load artifact" } />
        ) : autosaveState.value.kind === "text" && (editing || isDirectTextEdit) ? (
          <TextEditor
            key={`${workspaceId}:${target.id}`}
            value={autosaveState.value.data}
            language={target.preview === "markdown" ? "markdown" : "text"}
            onChange={(value) => autosave.edit({ kind: "text", data: value })}
          />
        ) : target.preview === "markdown" && autosaveState.value.kind === "text" ? (
          <MarkdownPreview content={autosaveState.value.data} />
        ) : target.preview === "sheet" && autosaveState.ready ? (
          <SheetEditor
            key={`${workspaceId}:${target.id}`}
            name={target.name}
            source={autosaveState.value.kind === "spreadsheet"
              ? { kind: "rows", rows: autosaveState.value.rows }
              : { kind: "content", content: autosaveState.value, revision: autosaveState.sourceRevision }}
            onChange={(rows) => autosave.edit({ kind: "spreadsheet", rows })}
          />
        ) : target.preview === "html" && data?.kind === "text" ? (
          <HTMLPreview type="text" title={target.name} content={data.data} />
        ) : target.preview === "image" && data?.kind === "binary" && binaryObjectUrl ? (
          <ImagePreview src={binaryObjectUrl} alt={target.name} />
        ) : target.preview === "pdf" && data?.kind === "binary" && binaryObjectUrl ? (
          <PdfPreview url={binaryObjectUrl} title={target.name} />
        ) : data?.kind === "binary" && binaryObjectUrl && target.preview === "html" ? (
          <HTMLPreview type="binary" title={target.name} url={binaryObjectUrl} />
        ) : data?.kind === "text" ? (
          <PlainText content={data.data} />
        ) : (
          <PreviewUnavailable />
        )}
      </div>
    </div>
  );
}

interface TextEditorProps extends React.ComponentProps<typeof ArtifactTextEditor> {
  value: string;
  language: "markdown" | "text";
  onChange: (value: string) => void;
}

function TextEditor({ value, language, onChange, ...props }: TextEditorProps) {
  return (
    <Suspense fallback={<PreviewLoading />}>
      <ArtifactTextEditor value={value} language={language} onChange={onChange} {...props} />
    </Suspense>
  );
}

interface SheetEditorProps extends React.ComponentProps<typeof ArtifactSpreadsheetEditor> {
  
}

function SheetEditor({ className, ...props }: SheetEditorProps) {
  return (
    <Suspense fallback={<PreviewLoading />}>
      <ArtifactSpreadsheetEditor
        className={className}
        {...props}
      />
    </Suspense>
  );
}
