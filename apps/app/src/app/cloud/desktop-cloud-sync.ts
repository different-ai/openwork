import {
  createDenClient,
  readDenSettings,
} from "../lib/den";
import type {
  OpenworkDesktopCloudSyncResult,
  OpenworkServerClient,
} from "../lib/openwork-server";

let desktopCloudSyncQueue: Promise<void> = Promise.resolve();

async function runDesktopCloudSync(input: {
  openworkClient: OpenworkServerClient;
  workspaceId: string;
}): Promise<OpenworkDesktopCloudSyncResult | null> {
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  const activeOrgId = settings.activeOrgId?.trim() ?? "";
  if (!token || !activeOrgId) return null;

  const snapshot = await createDenClient({
    baseUrl: settings.baseUrl,
    apiBaseUrl: settings.apiBaseUrl,
    token,
  }).getResourceSnapshot(activeOrgId);

  return input.openworkClient.syncDesktopCloud(input.workspaceId, snapshot);
}

export function refreshDesktopCloudSync(input: {
  openworkClient: OpenworkServerClient | null | undefined;
  workspaceId: string | null | undefined;
}): Promise<OpenworkDesktopCloudSyncResult | null> {
  const openworkClient = input.openworkClient ?? null;
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (!openworkClient || !workspaceId) return Promise.resolve(null);

  const run = desktopCloudSyncQueue.then(() => runDesktopCloudSync({ openworkClient, workspaceId }));
  desktopCloudSyncQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
