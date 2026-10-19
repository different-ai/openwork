"use client";

import { useCallback, useMemo } from "react";
import { combinedDocumentsEditor, combinedDocumentsProvider, documentSourceFileId, googleDocumentsEditor, googleDriveProvider, microsoftDocumentsEditor, microsoftOneDriveProvider, type DocumentOpenRequest, type DocumentsViewContext } from "@openwork/documents";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import { DocumentsBrowser } from "@openwork/documents/react";
import { workbotHost } from "./host";
import { useWorkbotConnect, WorkbotConnectAction } from "./connect";

/** Workbot supplies authentication and identity; the document browser is reusable by other hosts. */
export function WorkbotDocuments({ onDirtyChange, onContextChange, openDocument }: { onDirtyChange?(dirty: boolean): void; onContextChange?(context: WorkbotViewContext | null): void; openDocument?: DocumentOpenRequest }) {
  const host = workbotHost();
  const connect = useWorkbotConnect();
  // OneDrive joins Google Drive only where the workspace has a Microsoft 365 connector.
  const microsoft = connect.connections.data?.some(connection => connection.nativeProviderKey === "microsoft-365") ?? false;
  const provider = useMemo(() => {
    const list = (path: string, signal?: AbortSignal) => host.requestJson(`/v1/workbot/documents${path}`, { signal });
    return combinedDocumentsProvider([googleDriveProvider(list), ...(microsoft ? [microsoftOneDriveProvider(list)] : [])]);
  }, [host, microsoft]);
  const editor = useMemo(() => {
    const request = (path: string, init?: RequestInit) => host.requestJson(`/v1/workbot/documents${path}`, init);
    const contentUrl = (path: string) => `/v1/workbot/documents${path}`;
    return combinedDocumentsEditor([
      { id: "google-drive", editor: googleDocumentsEditor(request, contentUrl) },
      ...(microsoft ? [{ id: "microsoft-365", editor: microsoftDocumentsEditor(request, contentUrl) }] : []),
    ]);
  }, [host, microsoft]);
  const identity = host.identity;
  const contextChanged = useCallback((context: DocumentsViewContext | null) => {
    onContextChange?.(!context ? null : context.kind === "file"
      ? { kind: "document", provider: context.item.source?.id === "microsoft-365" ? "microsoft-365" : "google-drive", fileId: documentSourceFileId(context.item), title: context.item.name.slice(0, 512) || "Untitled", mimeType: context.item.mimeType.slice(0, 255), unsaved: context.unsaved }
      : { kind: "documents", view: context.view, folderId: context.folderId, folderName: context.folderName.slice(0, 512), query: context.query });
  }, [onContextChange]);
  return <DocumentsBrowser key={`${identity?.organizationId}:${identity?.principalId}`} provider={provider} editor={editor} scope={[host.homeHref, identity?.organizationId ?? "", identity?.principalId ?? ""]} onDirtyChange={onDirtyChange} onContextChange={onContextChange ? contextChanged : undefined} openDocument={openDocument} enabled={host.documents === true && identity !== undefined} connectionsHref={host.connectionsHref} signInHref={host.signInHref} verifyScope={host.verifyDocumentIdentity} authorization={host.documentAuthorization} renderConnect={(connectionId, reconnect) => connectionId === "microsoft-365"
    ? <WorkbotConnectAction flow={connect} provider="microsoft-365" label={reconnect ? "Reconnect OneDrive" : "Connect OneDrive"} fallbackHref={host.connectionsHref} />
    : <WorkbotConnectAction flow={connect} provider="google-workspace" connectionId={connectionId} label={reconnect ? "Reconnect Google Drive" : "Connect Google Drive"} fallbackHref={host.connectionsHref} />} />;
}
