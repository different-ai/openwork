import type {
  Host,
  ModelSelection,
  ModelSettings,
  SavedPermissions,
  Workspace,
  Session,
  Message,
  SessionStatus,
  Approval,
  Capabilities,
  Page,
} from "../contract/index.js";
export interface OpenWorkAdapter {
  version: string;
  readonly compatibility: Host["compatibility"];
  capabilities: Capabilities;
  health(): Promise<void>;
  listWorkspaces(): Promise<Workspace[]>;
  listSessions(wid: string, cursor?: string): Promise<Page<Session[]>>;
  readSession(wid: string, sid: string): Promise<Session>;
  readMessages(
    wid: string,
    sid: string,
    cursor?: string,
  ): Promise<Page<Message[]>>;
  readStatus(wid: string, sid: string): Promise<SessionStatus>;
  readApprovals(wid: string, sid: string): Promise<Approval[]>;
  create(wid: string): Promise<string>;
  rename(wid: string, sid: string, title: string, previousTitle: string): Promise<void>;
  send(wid: string, sid: string, text: string): Promise<void>;
  stop(wid: string, sid: string): Promise<boolean>;
  reply(
    wid: string,
    sid: string,
    aid: string,
    decision: "allowOnce" | "deny",
    revision: string,
  ): Promise<void>;
  readModelSettings(wid: string, sid: string): Promise<ModelSettings>;
  setModel(
    wid: string,
    sid: string,
    model: ModelSelection,
    revision: string,
  ): Promise<void>;
  readSavedPermissions(wid: string, sid: string): Promise<SavedPermissions>;
  revokeSavedPermission(
    wid: string,
    sid: string,
    id: string,
    revision: string,
  ): Promise<void>;
  subscribe(wid: string, signal: AbortSignal): Promise<Response>;
}
