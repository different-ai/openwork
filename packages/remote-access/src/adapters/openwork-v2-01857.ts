import { UpstreamControls } from "./controls.js";
import { createHash } from "node:crypto";
import {
  BridgeError,
  PreflightError,
  assertContract,
  normalizeBlock,
  record,
  type Host,
  type ModelSelection,
  type Capabilities,
  type Session,
  type Message,
  type Approval,
} from "../contract/index.js";
import type { OpenWorkAdapter } from "./types.js";
interface Connection {
  origin: string;
  token: string;
}
const safeId = (id: string) => {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(id))
    throw new BridgeError("INVALID_REQUEST", 400);
  return encodeURIComponent(id);
};
const iso = (v: unknown) =>
  new Date(typeof v === "number" && Number.isFinite(v) ? v : 0).toISOString();
function obj(v: unknown): Record<string, unknown> {
  if (!record(v)) throw new BridgeError("INVALID_UPSTREAM", 502);
  return v;
}
function list(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new BridgeError("INVALID_UPSTREAM", 502);
  return v;
}
function string(v: unknown): string {
  if (typeof v !== "string") throw new BridgeError("INVALID_UPSTREAM", 502);
  return v;
}
function nextCursor(v: unknown): string | null {
  const next = record(v) ? v.next : null;
  if (typeof next !== "string" || next === "") return null;
  if (Buffer.byteLength(next) > 4096)
    throw new BridgeError("INVALID_UPSTREAM", 502);
  return next;
}
export class OpenWorkV2 implements OpenWorkAdapter {
  version = "unknown";
  capabilities: Capabilities = {
    readSessions: true,
    readMessages: true,
    readStatus: true,
    events: false,
    createSession: false,
    sendText: false,
    stop: false,
    readApprovals: true,
    replyApproval: false,
    maxPromptBytes: 32768,
    protocolVersion: 1,
  };
  get compatibility(): Host["compatibility"] {
    const expected = this.bundledServerVersion ?? "0.18.57";
    return this.version !== "unknown" && this.version === expected
      ? "supported"
      : "incompatible";
  }
  private connection?: Connection;
  constructor(
    private discover: () => Promise<Connection>,
    private qualifiedWrites = true,
    // Supplied only by a desktop embedding its own same-source server. External
    // installations keep the independently qualified stable-version boundary.
    private bundledServerVersion?: string,
  ) {}
  private validate(c: Connection) {
    const u = new URL(c.origin);
    if (
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      !u.port ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw new BridgeError("UPSTREAM_UNAVAILABLE");
    return c;
  }
  private async response(
    route: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
    reload = true,
  ): Promise<Response> {
    try {
      this.connection ??= this.validate(await this.discover());
      const c = this.connection;
      const r = await fetch(c.origin + route, {
        method,
        redirect: "error",
        signal: signal ?? AbortSignal.timeout(method === "GET" ? 15000 : 30000),
        headers: {
          Authorization: `Bearer ${c.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (r.status === 401 && reload && method === "GET") {
        await r.body?.cancel();
        this.connection = this.validate(await this.discover());
        return this.response(route, method, body, signal, false);
      }
      return r;
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      if (reload && method === "GET" && !signal?.aborted) {
        this.connection = this.validate(await this.discover());
        return this.response(route, method, body, signal, false);
      }
      throw new BridgeError("UPSTREAM_UNAVAILABLE", 503, true);
    }
  }
  private async request(
    route: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    const r = await this.response(route, method, body);
    if (!r.ok) {
      await r.body?.cancel();
      throw new BridgeError(
        r.status === 404
          ? "NOT_FOUND"
          : r.status === 401
            ? "UPSTREAM_AUTH_FAILED"
            : "UPSTREAM_REJECTED",
        r.status === 404 ? 404 : r.status === 401 ? 503 : 502,
      );
    }
    const reader = r.body?.getReader();
    let bytes = 0,
      text = "";
    const decoder = new TextDecoder();
    if (!reader) return null;
    try {
      for (;;) {
        const x = await reader.read();
        if (x.done) break;
        bytes += x.value.byteLength;
        if (bytes > 8 * 1024 * 1024)
          throw new BridgeError("SNAPSHOT_TOO_LARGE", 413);
        text += decoder.decode(x.value, { stream: true });
      }
      text += decoder.decode();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      await reader.cancel().catch(() => {});
      if (e instanceof BridgeError) throw e;
      throw new BridgeError("INVALID_UPSTREAM", 502);
    }
  }
  private base(wid: string) {
    return `/workspace/${safeId(wid)}/opencode2/api`;
  }
  /** Readiness only: never enables or migrates an existing desktop engine. */
  async requireChatEngine() {
    const status = obj(
      await this.request("/experimental/engine-v2-preview/status"),
    );
    if (status.enabled !== true || status.chatRouting !== true)
      throw new BridgeError("ENGINE_V2_REQUIRED", 503);
    if (status.running !== true)
      throw new BridgeError("UPSTREAM_UNAVAILABLE", 503, true);
  }
  async health() {
    const h = obj(await this.request("/health"));
    if (h.ok !== true || typeof h.version !== "string")
      throw new BridgeError("INVALID_UPSTREAM", 502);
    this.version = h.version;
    const supported = this.compatibility === "supported";
    this.capabilities = {
      ...this.capabilities,
      events: supported,
      createSession: supported && this.qualifiedWrites,
      renameSession: supported && this.qualifiedWrites,
      sendText: supported && this.qualifiedWrites,
      stop: supported && this.qualifiedWrites,
      replyApproval: supported && this.qualifiedWrites,
      modelSettings: supported && this.qualifiedWrites,
      savedPermissions: supported && this.qualifiedWrites,
    };
  }
  async listWorkspaces() {
    const j = obj(await this.request("/workspaces"));
    return assertContract(
      "WorkspaceList",
      list(j.items).map((v) => {
        const w = obj(v);
        return { id: string(w.id), name: string(w.name) };
      }),
    );
  }
  private session(v: unknown, wid: string): Session {
    const s = obj(v),
      time = obj(s.time),
      model = record(s.model) ? s.model : null;
    return assertContract("Session", {
      id: string(s.id),
      workspaceId: wid,
      title: typeof s.title === "string" ? s.title : "Untitled chat",
      updatedAt: iso(time.updated ?? time.created),
      modelLabel: model && typeof model.id === "string" ? model.id : null,
      status: "unknown",
    });
  }
  async listSessions(wid: string, cursor?: string) {
    const q = new URLSearchParams({
      limit: "50",
      ...(cursor ? { cursor } : {}),
    });
    const j = obj(await this.request(this.base(wid) + "/session?" + q));
    const data = list(j.data).map((v) => this.session(v, wid));
    if (data.length > 50) throw new BridgeError("INVALID_UPSTREAM", 502);
    return {
      data: assertContract("SessionList", data),
      cursor: nextCursor(j.cursor),
    };
  }
  async readSession(wid: string, sid: string) {
    const j = obj(
      await this.request(this.base(wid) + "/session/" + safeId(sid)),
    );
    const s = this.session(j.data, wid);
    if (s.id !== sid) throw new BridgeError("NOT_FOUND", 404);
    return s;
  }
  async rename(wid: string, sid: string, title: string, previousTitle: string) {
    if (!this.capabilities.renameSession)
      throw new PreflightError("UNSUPPORTED_ACTION", 422);
    const current = await this.readSession(wid, sid);
    if (current.title === title) return;
    if (current.title !== previousTitle)
      throw new PreflightError("STALE_TITLE", 409);
    await this.request(`${this.base(wid)}/session/${safeId(sid)}/rename`, "POST", { title });
  }
  async readMessages(wid: string, sid: string, cursor?: string) {
    const q = new URLSearchParams({
      limit: "50",
      ...(cursor ? { cursor } : {}),
    });
    const j = obj(
      await this.request(
        `${this.base(wid)}/session/${safeId(sid)}/message?${q}`,
      ),
    );
    const rows = list(j.data);
    if (rows.length > 50) throw new BridgeError("INVALID_UPSTREAM", 502);
    const data: Message[] = rows
      .flatMap((v) => {
        const m = obj(v);
        const type = string(m.type);
        if (type !== "user" && type !== "assistant" && type !== "system")
          return [];
        const time = obj(m.time);
        return [
          {
            id: string(m.id),
            sessionId: sid,
            role: type,
            createdAt: iso(time.created),
            blocks: Array.isArray(m.content)
              ? m.content.map(normalizeBlock)
              : typeof m.text === "string"
                ? [normalizeBlock({ type: "text", text: m.text })]
                : [],
            state:
              m.finish === "error"
                ? record(m.error) && m.error.type === "aborted"
                  ? "cancelled"
                  : "error"
                : type === "assistant" && !m.finish
                  ? "streaming"
                  : "complete",
          } as Message,
        ];
      })
      .reverse();
    return {
      data: assertContract("MessageList", data),
      cursor: nextCursor(j.cursor),
    };
  }
  async readStatus(wid: string, sid: string) {
    await this.readSession(wid, sid);
    const j = obj(await this.request(this.base(wid) + "/session/active")),
      a = obj(j.data);
    const active = record(a[sid]) ? a[sid] : null;
    const permissions = await this.readApprovals(wid, sid);
    let phase: "waitingApproval" | "running" | "idle" | "error" =
      permissions.length
        ? "waitingApproval"
        : active?.type === "running"
          ? "running"
          : "idle";
    if (phase === "idle") {
      const messages = await this.readMessages(wid, sid);
      const latest = messages.data.findLast((m) => m.role === "assistant");
      if (latest?.state === "error") phase = "error";
    }
    return assertContract("SessionStatus", {
      phase,
      observedAt: new Date().toISOString(),
      activeTurnId: typeof active?.id === "string" ? active.id : null,
      errorCode: phase === "error" ? "MODEL_ERROR" : null,
    });
  }
  async readApprovals(wid: string, sid: string): Promise<Approval[]> {
    const j = obj(
      await this.request(`${this.base(wid)}/session/${safeId(sid)}/permission`),
    );
    return assertContract(
      "ApprovalList",
      list(j.data).map((v) => {
        const a = obj(v);
        if (a.sessionID !== sid) throw new BridgeError("INVALID_UPSTREAM", 502);
        const action = string(a.action),
          resources = list(a.resources).map(string);
        const detail = [action, ...resources].join("\n").slice(0, 32768);
        return {
          id: string(a.id),
          sessionId: sid,
          kind: action,
          title:
            action === "external_directory"
              ? "Review folder access"
              : "Continue on computer",
          details: detail,
          revision: createHash("sha256")
            .update(JSON.stringify(a))
            .digest("hex"),
          supportedDecisions:
            this.capabilities.replyApproval && action === "external_directory"
              ? ["allowOnce", "deny"]
              : [],
          createdAt: new Date(0).toISOString(),
        };
      }),
    );
  }
  private enabled(key: keyof Capabilities) {
    if (this.capabilities[key] !== true)
      throw new BridgeError("UNSUPPORTED_ACTION", 422);
  }
  async create(wid: string) {
    this.enabled("createSession");
    const d = obj(
      await this.request(`/workspace/${safeId(wid)}/default-model`),
    );
    const model = obj(d.model);
    const providerID = string(model.providerID),
      id = string(model.modelID);
    const j = obj(
      await this.request(this.base(wid) + "/session", "POST", {
        model: {
          providerID,
          id,
          ...(typeof model.variant === "string"
            ? { variant: model.variant }
            : {}),
        },
      }),
    );
    return this.session(j.data, wid).id;
  }
  async send(wid: string, sid: string, text: string) {
    this.enabled("sendText");
    const s = obj(
      await this.request(`${this.base(wid)}/session/${safeId(sid)}`),
    );
    const model = obj(obj(s.data).model);
    if (typeof model.id !== "string" || typeof model.providerID !== "string")
      throw new BridgeError("MODEL_REQUIRED", 422);
    // Match the desktop's model handshake so Auto can associate this send with
    // the session. Reuse the current selection; never change the user's default.
    await this.request(
      `${this.base(wid)}/session/${safeId(sid)}/model`,
      "POST",
      {
        model: {
          providerID: model.providerID,
          id: model.id,
          ...(typeof model.variant === "string"
            ? { variant: model.variant }
            : {}),
        },
      },
    );
    const j = obj(
      await this.request(
        `${this.base(wid)}/session/${safeId(sid)}/prompt`,
        "POST",
        { text },
      ),
    );
    const admission = obj(j.data);
    if (typeof admission.id !== "string" || admission.sessionID !== sid)
      throw new BridgeError("INVALID_UPSTREAM", 502);
  }
  async stop(wid: string, sid: string) {
    this.enabled("stop");
    await this.readSession(wid, sid);
    const j = obj(
      await this.request(
        `${this.base(wid)}/session/${safeId(sid)}/interrupt`,
        "POST",
        {},
      ),
    );
    if (typeof j.interrupted !== "boolean")
      throw new BridgeError("INVALID_UPSTREAM", 502);
    return j.interrupted;
  }
  async reply(
    wid: string,
    sid: string,
    aid: string,
    decision: "allowOnce" | "deny",
    revision: string,
  ) {
    this.enabled("replyApproval");
    const pending = (await this.readApprovals(wid, sid)).find(
      (a) => a.id === aid,
    );
    if (!pending || pending.revision !== revision)
      throw new PreflightError("STALE_APPROVAL", 409);
    if (!pending.supportedDecisions.includes(decision))
      throw new PreflightError("UNSUPPORTED_ACTION", 422);
    await this.request(
      `${this.base(wid)}/session/${safeId(sid)}/permission/${safeId(aid)}/reply`,
      "POST",
      { reply: decision === "allowOnce" ? "once" : "reject" },
    );
  }
  private controls(wid: string) {
    return new UpstreamControls(
      (route, method, body) => this.request(route, method, body),
      this.base(wid),
    );
  }
  async readModelSettings(wid: string, sid: string) {
    this.enabled("modelSettings");
    return this.controls(wid).model(safeId(sid));
  }
  async setModel(
    wid: string,
    sid: string,
    model: ModelSelection,
    revision: string,
  ) {
    this.enabled("modelSettings");
    await this.controls(wid).setModel(safeId(sid), model, revision);
  }
  async readSavedPermissions(wid: string, sid: string) {
    this.enabled("savedPermissions");
    return this.controls(wid).permissions(safeId(sid));
  }
  async revokeSavedPermission(
    wid: string,
    sid: string,
    id: string,
    revision: string,
  ) {
    this.enabled("savedPermissions");
    await this.controls(wid).revoke(safeId(sid), safeId(id), revision);
  }
  async subscribe(wid: string, signal: AbortSignal) {
    if (!this.capabilities.events)
      throw new BridgeError("UNSUPPORTED_ACTION", 422);
    const r = await this.response(
      this.base(wid) + "/event",
      "GET",
      undefined,
      signal,
    );
    if (
      !r.ok ||
      !r.headers.get("content-type")?.includes("text/event-stream")
    ) {
      await r.body?.cancel();
      throw new BridgeError("INVALID_UPSTREAM", 502);
    }
    return r;
  }
}
