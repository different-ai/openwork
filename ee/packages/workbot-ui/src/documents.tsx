"use client";

import { useCallback, useMemo } from "react";
import { googleDocumentsEditor, googleDriveProvider, type DocumentOpenRequest, type DocumentsViewContext } from "@openwork/documents";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import { DocumentsBrowser } from "@openwork/documents/react";
import { workbotHost } from "./host";

/** Workbot supplies authentication and identity; the document browser is reusable by other hosts. */
export function WorkbotDocuments({ onDirtyChange, onContextChange, openDocument }: { onDirtyChange?(dirty: boolean): void; onContextChange?(context: WorkbotViewContext | null): void; openDocument?: DocumentOpenRequest }) {
  const host = workbotHost();
  const provider = useMemo(() => googleDriveProvider((path, signal) => host.requestJson(`/v1/workbot/documents${path}`, { signal })), [host]);
  const editor = useMemo(() => googleDocumentsEditor((path, init) => host.requestJson(`/v1/workbot/documents${path}`, init), path => `/v1/workbot/documents${path}`), [host]);
  const identity = host.identity;
  const contextChanged = useCallback((context: DocumentsViewContext | null) => {
    onContextChange?.(!context ? null : context.kind === "file"
      ? { kind: "document", provider: "google-drive", fileId: context.item.id, title: context.item.name.slice(0, 512) || "Untitled", mimeType: context.item.mimeType.slice(0, 255), unsaved: context.unsaved }
      : { kind: "documents", view: context.view, folderId: context.folderId, folderName: context.folderName.slice(0, 512), query: context.query });
  }, [onContextChange]);
  return <DocumentsBrowser key={`${identity?.organizationId}:${identity?.principalId}`} provider={provider} editor={editor} scope={[host.homeHref, identity?.organizationId ?? "", identity?.principalId ?? ""]} onDirtyChange={onDirtyChange} onContextChange={onContextChange ? contextChanged : undefined} openDocument={openDocument} enabled={host.documents === true && identity !== undefined} connectionsHref={host.connectionsHref} signInHref={host.signInHref} verifyScope={host.verifyDocumentIdentity} authorization={host.documentAuthorization} />;
}
