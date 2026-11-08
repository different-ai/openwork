"use client";

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { combinedDocumentsEditor, combinedDocumentsProvider, documentSourceFileId, googleDocumentsEditor, googleDriveProvider, microsoftDocumentsEditor, microsoftOneDriveProvider, type DocumentOpenOutcome, type DocumentOpenRequest, type DocumentsViewContext } from "@openwork/documents";
import type { WorkbotViewContext } from "@openwork/types/workbot-context";
import { DocumentsBrowser, prefetchRecentDocuments } from "@openwork/documents/react";
import { workbotHost } from "./host";
import { useWorkbotConnect, WorkbotConnectAction } from "./connect";
import { useWorkbotConnections } from "./data";

/**
 * The person's connected document sources, as Documents and the navigation drawer both read them: Google Drive, and
 * OneDrive where the workspace has a Microsoft 365 connector. One provider and one cache scope, so the drawer's
 * Recent documents and the Documents tab list the same files.
 */
export function useWorkbotDocumentsSource() {
  const host = workbotHost();
  const connections = useWorkbotConnections({ enabled: host.documents === true, waiting: false });
  const microsoft = connections.data?.some(connection => connection.nativeProviderKey === "microsoft-365") ?? false;
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
  const organizationId = host.identity?.organizationId ?? "";
  const principalId = host.identity?.principalId ?? "";
  const scope = useMemo(() => [host.homeHref, organizationId, principalId] as const, [host.homeHref, organizationId, principalId]);
  return { provider, editor, scope, microsoft, ready: host.documents === true && host.identity !== undefined };
}

/**
 * Warms Documents before it opens: called when the pointer or keyboard reaches its tab, so the first listing is
 * already read by the click. Does nothing while Documents is off or nobody is signed in.
 */
export function usePrefetchWorkbotDocuments() {
  const client = useQueryClient();
  const { provider, scope, ready } = useWorkbotDocumentsSource();
  return useCallback(() => { if (ready) void prefetchRecentDocuments(client, { provider, scope }); }, [client, provider, scope, ready]);
}

/** Workbot supplies authentication and identity; the document browser is reusable by other hosts. */
export function WorkbotDocuments({ onDirtyChange, onContextChange, openDocument, onOpenSettled }: { onDirtyChange?(dirty: boolean): void; onContextChange?(context: WorkbotViewContext | null): void; openDocument?: DocumentOpenRequest; onOpenSettled?(requestId: string, outcome: DocumentOpenOutcome): void }) {
  const host = workbotHost();
  const connect = useWorkbotConnect();
  const { provider, editor, scope } = useWorkbotDocumentsSource();
  const identity = host.identity;
  const contextChanged = useCallback((context: DocumentsViewContext | null) => {
    onContextChange?.(!context ? null : context.kind === "file"
      ? { kind: "document", provider: context.item.source?.id === "microsoft-365" ? "microsoft-365" : "google-drive", fileId: documentSourceFileId(context.item), title: context.item.name.slice(0, 512) || "Untitled", mimeType: context.item.mimeType.slice(0, 255), unsaved: context.unsaved }
      : { kind: "documents", view: context.view, folderId: context.folderId, folderName: context.folderName.slice(0, 512), query: context.query });
  }, [onContextChange]);
  return <DocumentsBrowser key={`${identity?.organizationId}:${identity?.principalId}`} provider={provider} editor={editor} scope={scope} onDirtyChange={onDirtyChange} onContextChange={onContextChange ? contextChanged : undefined} openDocument={openDocument} onOpenSettled={onOpenSettled} editingEnabled={host.documentEditing === true} enabled={host.documents === true && identity !== undefined} connectionsHref={host.connectionsHref} signInHref={host.signInHref} verifyScope={host.verifyDocumentIdentity} authorization={host.documentAuthorization} renderConnect={(connectionId, reconnect) => connectionId === "microsoft-365"
    ? <WorkbotConnectAction flow={connect} provider="microsoft-365" label={reconnect ? "Reconnect OneDrive" : "Connect OneDrive"} fallbackHref={host.connectionsHref} />
    : <WorkbotConnectAction flow={connect} provider="google-workspace" connectionId={connectionId} label={reconnect ? "Reconnect Google Drive" : "Connect Google Drive"} fallbackHref={host.connectionsHref} />} />;
}
