/**
 * Shared wire contract for workspace records.
 *
 * Producers:
 * - openwork-server (apps/server): `GET /workspaces` and friends — emits plain
 *   optionals (never null) plus the `opencode*` engine credential fields.
 * - desktop Electron IPC bridge (apps/desktop main.mjs): emits explicit nulls
 *   and the desktop-managed `openworkClientToken`/`openworkHostToken`.
 *
 * Consumers (apps/app) must treat every optional field as possibly absent,
 * undefined, or null. Producer-side types assert assignability against this
 * shape (see apps/server/src/types.ts) so drift fails typecheck instead of
 * surfacing as runtime undefined-field bugs.
 */
export type WorkspaceKind = "local" | "remote";

export type WorkspaceRemoteKind = "opencode" | "openwork";

export type WorkspaceWire = {
  id: string;
  name: string;
  path: string;
  preset: string;
  workspaceType: WorkspaceKind;
  remoteType?: WorkspaceRemoteKind | null;
  baseUrl?: string | null;
  directory?: string | null;
  displayName?: string | null;
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  /** Desktop IPC only: tokens for desktop-managed remote workspaces. */
  openworkClientToken?: string | null;
  openworkHostToken?: string | null;
  openworkWorkspaceId?: string | null;
  openworkWorkspaceName?: string | null;
  /**
   * Vocabulary differs per producer today ("docker" | "microsandbox" on the
   * desktop, "none" | "docker" | "container" in openwork-server), so the wire
   * stays a plain string until the backends converge.
   */
  sandboxBackend?: string | null;
  sandboxRunId?: string | null;
  sandboxContainerName?: string | null;
  /** openwork-server only: credentials for the proxied opencode engine. */
  opencodeUsername?: string | null;
  opencodePassword?: string | null;
  opencode?: {
    baseUrl?: string;
    directory?: string;
    username?: string;
    password?: string;
  } | null;
};
