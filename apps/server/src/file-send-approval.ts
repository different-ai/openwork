import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { agentPermissionDenialMessage, decideAgentPermission, type AgentPermissionRule } from "@openwork/types/den/agent-permissions";
import { ApiError } from "./errors.js";

/**
 * One approval for every tool that sends a local file to a connected account:
 * Drive uploads, saves back to Drive, OneDrive and SharePoint, and Gmail and
 * Outlook drafts with attachments. No tool has its own rules.
 *
 * The administrator's decision (Agents tab, "Send files to connected
 * accounts") comes first: Block refuses, Allow sends without asking, Ask
 * first asks every time. Otherwise the member decides in the calling chat:
 * Allow once, Allow for this chat, or Always allow.
 *
 * - This chat: the same tool, account and agent, for files in the chat's
 *   workspace folder. A file outside it is remembered only as that exact
 *   version. Held in memory, gone when the engine restarts.
 * - Always: the same tool and named account, for files in that workspace
 *   folder, for this member of this organization on this computer. Stored
 *   privately on disk; listed and removed in Settings. Never offered for an
 *   unnamed default account or a file outside the workspace.
 *
 * The engine's prompt is only how the question is shown. Its saved rules
 * never authorize a send: every decision here is one this host witnessed.
 */

export type FileSendPolicy = {
  enabled: boolean;
  scope: { baseUrl: string; organizationId: string; memberId: string } | null;
  rules: AgentPermissionRule[];
};

export type FileSendRemember = "session" | "always";

export type FileSendRequest = {
  /** The tool's engine permission name, such as drive_upload_file. */
  kind: string;
  directory: string;
  sessionId: string;
  agent?: string;
  /** Where the chat's engine runs; part of what "this chat" means. */
  engineUrl?: string;
  /** Files as the tool names them: absolute, or relative to the directory. */
  paths: readonly string[];
  /** The verified version of one file outside the workspace, when the host holds it. */
  fileIdentity?: string;
  /** The named account. Absent means the member's default, which is never remembered for good. */
  account?: string;
};

export type FileSendAsk = (prompt: {
  /** Engine resources: the files, plus one that no saved rule can match. */
  resources: string[];
  /** Non-empty when the member may remember this answer. */
  save: string[];
  metadata: { fileSend: { kind: string; remember: FileSendRemember[] } };
  /** The engine's request id, once the question is showing. */
  asked(requestId: string): void;
}) => Promise<"once" | "always">;

export type FileSendDecision = "administrator" | "remembered" | "once" | FileSendRemember;

export type FileSendGrant = { id: string; kind: string; account: string; directory: string; createdAt: string };

const grantSchema = z.object({
  id: z.string().min(1).max(64), kind: z.string().min(1).max(128), account: z.string().min(1).max(255),
  directory: z.string().min(1).max(4096), createdAt: z.string().min(1).max(64),
});
const grantFileSchema = z.object({ version: z.literal(1), grants: z.array(grantSchema).max(500) });

async function inside(directory: string, path: string): Promise<boolean> {
  try {
    const root = await realpath(directory);
    const real = await realpath(isAbsolute(path) ? path : resolve(directory, path));
    return real.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}

export function createFileSendApprovals(options: {
  policy: () => Promise<FileSendPolicy>;
  /** Private folder for remembered approvals, one file per signed-in member. */
  storageDir: string;
}) {
  const epoch = randomBytes(16).toString("hex");
  const sessionGrants = new Set<string>();
  /** Open questions, and whether the member chose Always allow for each. */
  const asking = new Map<string, { always: boolean; offered: boolean }>();
  let writes: Promise<unknown> = Promise.resolve();

  const grantPath = (scope: NonNullable<FileSendPolicy["scope"]>) =>
    join(options.storageDir, `${createHash("sha256").update(JSON.stringify([scope.baseUrl, scope.organizationId, scope.memberId])).digest("hex")}.json`);

  /** Unreadable storage holds no approvals: the member is asked again. */
  async function readGrants(scope: NonNullable<FileSendPolicy["scope"]>): Promise<FileSendGrant[]> {
    try {
      const parsed = grantFileSchema.safeParse(JSON.parse(await readFile(grantPath(scope), "utf8")));
      return parsed.success ? parsed.data.grants : [];
    } catch {
      return [];
    }
  }

  function updateGrants(scope: NonNullable<FileSendPolicy["scope"]>, change: (grants: FileSendGrant[]) => FileSendGrant[]) {
    const job = async () => {
      const path = grantPath(scope);
      const next = change(await readGrants(scope));
      await mkdir(options.storageDir, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${randomUUID()}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: 1, grants: next }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, path);
      return next;
    };
    const result = writes.then(job, job);
    writes = result.catch(() => undefined);
    return result;
  }

  return {
    /** Null while the rollout is off or nobody is signed in: the tool keeps its earlier prompt. */
    async policy(): Promise<FileSendPolicy | null> {
      const policy = await options.policy();
      return policy.enabled && policy.scope ? policy : null;
    },

    /**
     * Resolves only when this send is authorized. `nothing` finishes the
     * refusal sentence ("nothing was uploaded").
     */
    async approve(policy: FileSendPolicy, request: FileSendRequest, nothing: string, ask: FileSendAsk): Promise<FileSendDecision> {
      const scope = policy.scope;
      if (!scope) throw new ApiError(403, "policy_unavailable", `Your account could not be verified, so ${nothing}.`);
      const decision = decideAgentPermission(policy.rules, "file_send", ["*"]);
      if (decision.effect === "deny") {
        throw new ApiError(403, "file_send_blocked", decision.rule
          ? `${agentPermissionDenialMessage(decision.rule, "*")} So ${nothing}.`
          : `Your organization blocks sending files to connected accounts, so ${nothing}.`);
      }
      if (decision.effect === "allow") return "administrator";

      const inWorkspace = request.paths.length > 0
        && (await Promise.all(request.paths.map(path => inside(request.directory, path)))).every(Boolean);
      const account = request.account ?? "default";
      // An administrator's Ask first asks every time; nothing is remembered.
      const remember: FileSendRemember[] = decision.rule ? []
        : inWorkspace ? request.account ? ["session", "always"] : ["session"]
        : request.fileIdentity && request.account ? ["session"] : [];
      const sessionKey = createHash("sha256").update(JSON.stringify([
        epoch, scope, request.engineUrl ?? null, request.directory, request.sessionId, request.agent ?? null,
        request.kind, account, inWorkspace ? "workspace" : [request.paths, request.fileIdentity ?? null],
      ])).digest("hex");

      if (remember.includes("always")) {
        const directory = await realpath(request.directory);
        const granted = (await readGrants(scope)).some(grant => grant.kind === request.kind && grant.account === account && grant.directory === directory);
        if (granted) return "remembered";
      }
      if (remember.includes("session") && sessionGrants.has(sessionKey)) return "remembered";

      let requestId: string | undefined;
      try {
        const reply = await ask({
          resources: [...request.paths, `file-send-request:${randomBytes(16).toString("hex")}`],
          save: remember.length > 0 ? [`file-send:${sessionKey}`] : [],
          metadata: { fileSend: { kind: request.kind, remember } },
          asked: id => { requestId = id; asking.set(id, { always: false, offered: remember.includes("always") }); },
        });
        if (reply === "once" || remember.length === 0) return "once";
        if (requestId && asking.get(requestId)?.always && remember.includes("always")) {
          const directory = await realpath(request.directory);
          await updateGrants(scope, grants => [
            ...grants.filter(grant => !(grant.kind === request.kind && grant.account === account && grant.directory === directory)),
            { id: randomUUID(), kind: request.kind, account, directory, createdAt: new Date().toISOString() },
          ]);
          return "always";
        }
        sessionGrants.add(sessionKey);
        return "session";
      } finally {
        if (requestId) asking.delete(requestId);
      }
    },

    /** The member chose Always allow on this open question, just before answering it. */
    chooseAlways(requestId: string): boolean {
      const open = asking.get(requestId);
      if (!open?.offered) return false;
      open.always = true;
      return true;
    },

    /** What this member remembered for good on this computer. */
    async grants(): Promise<{ enabled: boolean; grants: FileSendGrant[] }> {
      const policy = await options.policy();
      if (!policy.enabled || !policy.scope) return { enabled: false, grants: [] };
      return { enabled: true, grants: await readGrants(policy.scope) };
    },

    async revoke(id: string): Promise<{ enabled: boolean; grants: FileSendGrant[] }> {
      const policy = await options.policy();
      if (!policy.enabled || !policy.scope) return { enabled: false, grants: [] };
      return { enabled: true, grants: await updateGrants(policy.scope, grants => grants.filter(grant => grant.id !== id)) };
    },
  };
}

export type FileSendApprovals = ReturnType<typeof createFileSendApprovals>;

// Only the native bridge's in-process host dispatch can mark a request as
// approved in the chat. JSON bodies, headers and engine credentials cannot.
const approvedRequests = new WeakSet<Request>();
export function markFileSendApproved(request: Request) {
  approvedRequests.add(request);
}
export function takeFileSendApproved(request: Request): boolean {
  return approvedRequests.delete(request);
}
