import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  ScheduledTaskExecutionEvent,
  ScheduledTaskExecutionRequest,
} from "@openwork/types/scheduled-tasks";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import {
  createOpencodeScheduledTaskExecutionAdapter,
  type OpencodeScheduledTaskExecutionAdapterOptions,
} from "./opencode-execution-adapter.js";
import {
  SCHEDULED_TASK_SAFE_WRITE_TOOL_ID,
  SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID,
  SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID,
} from "./execution.js";

type ClientFactory = OpencodeScheduledTaskExecutionAdapterOptions["createClient"];
type FakeClient = ReturnType<ClientFactory>;

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createFixture() {
  const workspacePath = await mkdtemp(path.join(tmpdir(), "openwork-scheduled-adapter-"));
  temporaryDirectories.push(workspacePath);
  const workspace: WorkspaceInfo = {
    id: "workspace-1",
    name: "Scheduled workspace",
    path: workspacePath,
    preset: "default",
    workspaceType: "local",
  };
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 8787,
    token: "server-token-not-visible-to-adapter-results",
    hostToken: "host-token-not-visible-to-adapter-results",
    opencodeBaseUrl: "http://127.0.0.1:4096",
    opencodeUsername: "engine-user",
    opencodePassword: "engine-password",
    approval: { mode: "manual", timeoutMs: 30_000 },
    corsOrigins: [],
    workspaces: [workspace],
    authorizedRoots: [workspacePath],
    readOnly: false,
    startedAt: 1,
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "json",
    logRequests: false,
  };
  return { config, workspace, workspacePath };
}

function executionRequest(
  workspacePath: string,
  input: {
    capabilities?: string[];
    providerId?: string | null;
    modelId?: string | null;
    agent?: string | null;
    writeAccess?: boolean;
  } = {},
): ScheduledTaskExecutionRequest {
  const model = {
    providerId: input.providerId ?? "anthropic",
    modelId: input.modelId ?? "claude-sonnet",
    agent: input.agent ?? "openwork",
  };
  return {
    runId: "run-1",
    attemptId: "attempt-1",
    idempotencyKey: "task-1:revision-1:occurrence-1",
    taskRevision: {
      id: "task-revision-1",
      taskId: "task-1",
      revision: 1,
      definition: {
        name: "Prepare status",
        description: "Prepare a bounded status artifact.",
        prompt: "Create the reviewed status artifact.",
        workspaceId: "workspace-1",
        schedule: { kind: "manual", timezone: "UTC" },
        model,
        maximumRuntimeMs: 10_000,
        overlapPolicy: "skip",
        retryPolicy: { maximumAttempts: 1, delayMs: 0 },
        missedRunPolicy: {
          kind: "skip",
          graceMs: 0,
          maximumRecoverableOccurrences: 1,
        },
      },
      createdAt: 1,
      createdBy: "owner",
      reviewedAt: 2,
      reviewedBy: "owner",
    },
    grantRevision: {
      id: "grant-1",
      taskId: "task-1",
      revision: 1,
      taskRevisionId: "task-revision-1",
      workspaceId: "workspace-1",
      authorizedWorkspaceRoots: [workspacePath],
      capabilityIds: input.capabilities ?? [
        SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID,
      ],
      actionClasses: input.writeAccess ? ["read", "write"] : ["read"],
      filesystem: { read: true, write: input.writeAccess ?? false },
      maximumRuntimeMs: 10_000,
      model,
      communicationPolicy: "deny",
      destructiveActionPolicy: "deny",
      selfModificationPolicy: "deny",
      grantor: "owner",
      reviewedAt: 2,
      expiresAt: null,
      revokedAt: null,
      revocationReason: null,
      createdAt: 2,
    },
  };
}

function successfulAssistantMessage(sessionId: string) {
  return {
    info: {
      id: "assistant-1",
      sessionID: sessionId,
      role: "assistant",
      time: { created: 3, completed: 4 },
      parentID: "user-1",
      modelID: "claude-sonnet",
      providerID: "anthropic",
      mode: "primary",
      agent: "openwork",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0.001,
      tokens: {
        input: 10,
        output: 20,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      finish: "stop",
    },
    parts: [
      {
        id: "patch-1",
        sessionID: sessionId,
        messageID: "assistant-1",
        type: "patch",
        hash: "hash",
        files: ["status.md"],
      },
    ],
  };
}

function successfulBoundedWriterMessage(sessionId: string) {
  return {
    info: {
      ...successfulAssistantMessage(sessionId).info,
      id: "assistant-bounded-writer",
    },
    parts: [
      {
        id: "tool-bounded-writer",
        sessionID: sessionId,
        messageID: "assistant-bounded-writer",
        type: "tool",
        tool: SCHEDULED_TASK_SAFE_WRITE_TOOL_ID,
        state: {
          status: "completed",
          input: {
            path: "scheduled-task-eval-report.md",
            content: "# Scheduled report",
          },
          output: JSON.stringify({
            ok: true,
            path: "scheduled-task-eval-report.md",
            bytes: 18,
          }),
        },
      },
    ],
  };
}

function emptyEventStream() {
  return {
    async *[Symbol.asyncIterator]() {
      return;
    },
  };
}

function fakeClient(input: {
  operations?: string[];
  toolIds?: string[] | (() => string[] | Promise<string[]>);
  connectedProviders?: string[] | (() => string[] | Promise<string[]>);
  createSessionId?: string;
  status?: () => Promise<Record<string, unknown>>;
  messages?: (sessionId: string) => Promise<unknown[]>;
  permissionRequests?: (sessionId: string) => Promise<unknown[]>;
  questionRequests?: (sessionId: string) => Promise<unknown[]>;
  abort?: () => Promise<boolean | SdkUnsupported>;
  onCreate?: (parameters: Record<string, unknown>) => void;
  onPrompt?: (parameters: Record<string, unknown>) => void;
}): FakeClient {
  const sessionId = input.createSessionId ?? "session-1";
  const response = () => new Response(null, { status: 200 });
  const unsupportedResponse = () => new Response(null, { status: 404 });
  return {
    tool: {
      ids: async () => ({
        data:
          typeof input.toolIds === "function"
            ? await input.toolIds()
            : (input.toolIds ?? ["read"]),
        error: undefined,
        response: response(),
      }),
    },
    provider: {
      list: async () => ({
        data: {
          all: [],
          default: {},
          connected:
            typeof input.connectedProviders === "function"
              ? await input.connectedProviders()
              : (input.connectedProviders ?? ["anthropic"]),
        },
        error: undefined,
        response: response(),
      }),
    },
    event: {
      subscribe: async () => ({ stream: emptyEventStream() }),
    },
    permission: {
      list: async () => ({ data: [], error: undefined, response: response() }),
    },
    question: {
      list: async () => ({ data: [], error: undefined, response: response() }),
    },
    v2: {
      session: {
        permission: {
          list: async ({ sessionID }: { sessionID: string }) => ({
            data: (await input.permissionRequests?.(sessionID)) ?? [],
            error: undefined,
            response: response(),
          }),
        },
        question: {
          list: async ({ sessionID }: { sessionID: string }) => ({
            data: (await input.questionRequests?.(sessionID)) ?? [],
            error: undefined,
            response: response(),
          }),
        },
      },
    },
    session: {
      create: async (parameters: Record<string, unknown>) => {
        input.operations?.push("session.create");
        input.onCreate?.(parameters);
        return {
          data: { id: sessionId },
          error: undefined,
          response: response(),
        };
      },
      promptAsync: async (parameters: Record<string, unknown>) => {
        input.operations?.push("session.promptAsync");
        input.onPrompt?.(parameters);
        return { data: undefined, error: undefined, response: response() };
      },
      status: async () => ({
        data: (await input.status?.()) ?? { [sessionId]: { type: "idle" } },
        error: undefined,
        response: response(),
      }),
      messages: async ({ sessionID }: { sessionID: string }) => ({
        data:
          (await input.messages?.(sessionID)) ??
          [successfulAssistantMessage(sessionID)],
        error: undefined,
        response: response(),
      }),
      abort: async () => {
        input.operations?.push("session.abort");
        const aborted = (await input.abort?.()) ?? true;
        return aborted === SDK_UNSUPPORTED
          ? {
              data: undefined,
              error: { name: "NotFoundError" },
              response: unsupportedResponse(),
            }
          : { data: aborted, error: undefined, response: response() };
      },
    },
  } as unknown as FakeClient;
}

const SDK_UNSUPPORTED = Symbol("sdk-unsupported");
type SdkUnsupported = typeof SDK_UNSUPPORTED;

function adapterOptions(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  client: FakeClient,
  overrides: Partial<OpencodeScheduledTaskExecutionAdapterOptions> = {},
): OpencodeScheduledTaskExecutionAdapterOptions {
  return {
    authorizedRoots: config.authorizedRoots,
    resolveWorkspace: async () => workspace,
    createClient: () => client,
    pollIntervalMs: 25,
    maximumPollIterations: 4,
    sleep: async () => {},
    ...overrides,
  };
}

describe("OpenCode scheduled-task execution adapter", () => {
  test("persists a fresh session before dispatch and applies the reviewed policy", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    const events: ScheduledTaskExecutionEvent[] = [];
    const captured: { createParameters?: Record<string, unknown> } = {};
    let promptParameters: Record<string, unknown> | null = null;
    let statusReads = 0;
    const client = fakeClient({
      operations,
      status: async () => {
        statusReads += 1;
        return {
          "session-1": { type: statusReads === 1 ? "busy" : "idle" },
        };
      },
      messages: async (sessionId) =>
        statusReads === 1 ? [] : [successfulAssistantMessage(sessionId)],
      onCreate: (parameters) => {
        captured.createParameters = parameters;
      },
      onPrompt: (parameters) => {
        promptParameters = parameters;
      },
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client, {
        resolveArtifacts: async ({ candidates }) =>
          candidates.map((candidate, index) => ({
            id: `artifact-${index + 1}`,
            kind: "file",
            value: candidate,
            name: path.basename(candidate),
          })),
      }),
    );

    const result = await adapter.execute(executionRequest(workspacePath), {
      signal: new AbortController().signal,
      onEvent: async (event) => {
        events.push(event);
        if (event.type === "session-created") {
          operations.push("persist-session:start");
          await Promise.resolve();
          operations.push("persist-session:done");
        }
      },
    });

    expect(result.status).toBe("completed");
    expect(operations.indexOf("persist-session:done")).toBeLessThan(
      operations.indexOf("session.promptAsync"),
    );
    expect(events.map((event) => event.type)).toEqual([
      "session-created",
      "dispatched",
      "running",
      "terminal",
    ]);
    expect(captured.createParameters).toMatchObject({
      title: "Scheduled: Prepare status",
      agent: "openwork",
      model: { providerID: "anthropic", id: "claude-sonnet" },
      metadata: {
        openworkScheduledTask: true,
        scheduledTaskRunId: "run-1",
        scheduledTaskAttemptId: "attempt-1",
      },
    });
    const permission = captured.createParameters?.permission;
    expect(Array.isArray(permission)).toBe(true);
    expect(permission).toContainEqual({
      permission: "*",
      pattern: "*",
      action: "deny",
    });
    expect(permission).toContainEqual({
      permission: "read",
      pattern: "*",
      action: "allow",
    });
    expect(permission).not.toContainEqual({
      permission: SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID,
      pattern: "*",
      action: "allow",
    });
    expect(permission).not.toContainEqual({
      permission: "glob",
      pattern: "*",
      action: "allow",
    });
    expect(permission).toContainEqual({
      permission: SCHEDULED_TASK_SAFE_WRITE_TOOL_ID,
      pattern: "*",
      action: "ask",
    });
    expect(permission).toContainEqual({
      permission: "edit",
      pattern: "*",
      action: "deny",
    });
    expect(permission).toContainEqual({
      permission: "bash",
      pattern: "*",
      action: "deny",
    });
    expect(permission).toContainEqual({
      permission: "code_mode",
      pattern: "*",
      action: "deny",
    });
    expect(permission).toContainEqual({
      permission: "openwork_execute",
      pattern: "*",
      action: "deny",
    });
    expect(promptParameters).toMatchObject({
      sessionID: "session-1",
      agent: "openwork",
      model: { providerID: "anthropic", modelID: "claude-sonnet" },
      parts: [{ type: "text", text: "Create the reviewed status artifact." }],
    });
    expect(promptParameters).not.toHaveProperty("tools");
    if (result.status === "completed") {
      expect(result.boundedUsage).toEqual({
        inputTokens: 10,
        outputTokens: 20,
        costMicros: 1_000,
      });
      expect(result.artifacts.map((artifact) => artifact.value)).toEqual([
        "status.md",
      ]);
    }
  });

  test("records artifacts written through the bounded Scheduled Tasks writer", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    let statusReads = 0;
    const client = fakeClient({
      toolIds: ["read", SCHEDULED_TASK_SAFE_WRITE_TOOL_ID],
      status: async () => {
        statusReads += 1;
        return {
          "session-1": { type: statusReads === 1 ? "busy" : "idle" },
        };
      },
      messages: async (sessionId) =>
        statusReads === 1 ? [] : [successfulBoundedWriterMessage(sessionId)],
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client, {
        resolveArtifacts: async ({ candidates }) =>
          candidates.map((candidate, index) => ({
            id: `artifact-${index + 1}`,
            kind: "file",
            value: candidate,
            name: path.basename(candidate),
          })),
      }),
    );

    const result = await adapter.execute(
      executionRequest(workspacePath, {
        capabilities: [
          SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID,
          SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID,
        ],
        writeAccess: true,
      }),
      { signal: new AbortController().signal },
    );

    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.artifacts.map((artifact) => artifact.value)).toEqual([
        "scheduled-task-eval-report.md",
      ]);
    }
  });

  test("turns an unattended permission into needs-attention without replying", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    const client = fakeClient({
      operations,
      status: async () => ({ "session-1": { type: "busy" } }),
      messages: async () => [],
      permissionRequests: async (sessionId) => [
        { id: "permission-1", sessionID: sessionId },
      ],
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client),
    );

    const result = await adapter.execute(executionRequest(workspacePath), {
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("needs-attention");
    if (result.status === "needs-attention") {
      expect(result.attention.code).toBe("approval-required");
      expect(result.sessionId).toBe("session-1");
    }
    expect(operations).toContain("session.abort");
    expect(operations.some((operation) => operation.includes("reply"))).toBe(false);
  });

  test("maps a neutral write grant only to the bounded OpenWork write tool", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const captured: { createParameters?: Record<string, unknown> } = {};
    const client = fakeClient({
      toolIds: [SCHEDULED_TASK_SAFE_WRITE_TOOL_ID, "edit", "bash"],
      onCreate: (parameters) => {
        captured.createParameters = parameters;
      },
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client),
    );

    const result = await adapter.execute(
      executionRequest(workspacePath, {
        capabilities: [SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID],
        writeAccess: true,
      }),
      { signal: new AbortController().signal },
    );

    expect(result.status).toBe("completed");
    const permission = captured.createParameters?.permission;
    expect(permission).toContainEqual({
      permission: SCHEDULED_TASK_SAFE_WRITE_TOOL_ID,
      pattern: "*",
      action: "allow",
    });
    expect(permission).toContainEqual({
      permission: "edit",
      pattern: "*",
      action: "deny",
    });
    expect(permission).toContainEqual({
      permission: "apply_patch",
      pattern: "*",
      action: "deny",
    });
    expect(permission).not.toContainEqual({
      permission: SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID,
      pattern: "*",
      action: "allow",
    });
  });

  test("distinguishes a confirmed cancellation from abort false", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    let releaseStatus!: () => void;
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve;
    });
    const confirmedClient = fakeClient({
      status: async () => {
        await statusGate;
        return { "session-1": { type: "busy" } };
      },
      messages: async () => [],
      abort: async () => true,
    });
    const confirmedAdapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, confirmedClient),
    );
    let dispatched!: () => void;
    const dispatchedEvent = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const execution = confirmedAdapter.execute(executionRequest(workspacePath), {
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === "dispatched") dispatched();
      },
    });
    await dispatchedEvent;
    const cancellation = await confirmedAdapter.cancel({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      reason: "user",
    });
    releaseStatus();

    expect(cancellation.status).toBe("cancelled");
    expect((await execution).status).toBe("cancelled");

    let releaseSecondStatus!: () => void;
    const secondStatusGate = new Promise<void>((resolve) => {
      releaseSecondStatus = resolve;
    });
    const notRunningClient = fakeClient({
      status: async () => {
        await secondStatusGate;
        return { "session-1": { type: "idle" } };
      },
      messages: async (sessionId) => [successfulAssistantMessage(sessionId)],
      abort: async () => false,
    });
    const notRunningAdapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, notRunningClient),
    );
    let secondDispatched!: () => void;
    const secondDispatchedEvent = new Promise<void>((resolve) => {
      secondDispatched = resolve;
    });
    const secondExecution = notRunningAdapter.execute(
      executionRequest(workspacePath),
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === "dispatched") secondDispatched();
        },
      },
    );
    await secondDispatchedEvent;
    const notRunning = await notRunningAdapter.cancel({
      runId: "run-1",
      attemptId: "attempt-1",
      sessionId: "session-1",
      reason: "user",
    });
    releaseSecondStatus();

    expect(notRunning.status).toBe("not-running");
    expect((await secondExecution).status).toBe("completed");
  });

  test("fails closed before session creation when a reviewed capability disappears", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    const client = fakeClient({ operations, toolIds: ["bash"] });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client),
    );

    const result = await adapter.execute(
      executionRequest(workspacePath, {
        capabilities: [SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID],
      }),
      { signal: new AbortController().signal },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("capability-unavailable");
      expect(result.sessionId).toBeNull();
      expect(result.error.details).toEqual({
        capabilityIds: [SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID],
      });
    }
    expect(operations).not.toContain("session.create");
  });

  test("rechecks a neutral capability against live OpenCode tools after dispatch", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    const events: ScheduledTaskExecutionEvent[] = [];
    let toolReads = 0;
    const client = fakeClient({
      operations,
      toolIds: () => {
        toolReads += 1;
        return toolReads <= 2 ? ["read"] : [];
      },
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client),
    );

    const result = await adapter.execute(executionRequest(workspacePath), {
      signal: new AbortController().signal,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.status).toBe("needs-attention");
    if (result.status === "needs-attention") {
      expect(result.attention.code).toBe("capability-lost");
      expect(result.sessionId).toBe("session-1");
    }
    expect(toolReads).toBe(3);
    expect(operations).toContain("session.promptAsync");
    expect(operations).toContain("session.abort");
    expect(events.map((event) => event.type)).toEqual([
      "session-created",
      "dispatched",
      "needs-attention",
    ]);
  });

  test("rechecks provider connectivity after dispatch", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    let providerReads = 0;
    const client = fakeClient({
      operations,
      connectedProviders: () => {
        providerReads += 1;
        return providerReads <= 2 ? ["anthropic"] : [];
      },
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client),
    );

    const result = await adapter.execute(executionRequest(workspacePath), {
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("needs-attention");
    if (result.status === "needs-attention") {
      expect(result.attention.code).toBe("credential-unavailable");
      expect(result.sessionId).toBe("session-1");
    }
    expect(providerReads).toBe(3);
    expect(operations).toContain("session.promptAsync");
    expect(operations).toContain("session.abort");
  });

  test("checks authority again after artifact resolution and immediately before completion", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    const events: ScheduledTaskExecutionEvent[] = [];
    let authorityInspections = 0;
    let artifactResolutions = 0;
    const client = fakeClient({ operations });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client, {
        inspectAuthority: async () => {
          authorityInspections += 1;
          return artifactResolutions === 0
            ? { ok: true }
            : {
                ok: false,
                error: {
                  code: "grant-revoked",
                  message: "The scheduled-task grant was revoked.",
                  retryable: false,
                  ambiguous: false,
                },
              };
        },
        resolveArtifacts: async () => {
          artifactResolutions += 1;
          return [];
        },
      }),
    );

    const result = await adapter.execute(executionRequest(workspacePath), {
      signal: new AbortController().signal,
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result.status).toBe("needs-attention");
    if (result.status === "needs-attention") {
      expect(result.attention.code).toBe("grant-revoked");
    }
    expect(authorityInspections).toBe(5);
    expect(artifactResolutions).toBe(1);
    expect(operations).toContain("session.abort");
    expect(events.map((event) => event.type)).toEqual([
      "session-created",
      "dispatched",
      "needs-attention",
    ]);
  });

  test("rejects an unknown external capability before activation can become execution", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    const client = fakeClient({
      operations,
      toolIds: ["read", "lookup_records"],
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client),
    );

    const result = await adapter.execute(
      executionRequest(workspacePath, {
        capabilities: [
          SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID,
          "lookup_records",
        ],
      }),
      { signal: new AbortController().signal },
    );

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error.code).toBe("invalid-grant");
      expect(result.error.details).toEqual({
        capabilityIds: ["lookup_records"],
      });
    }
    expect(operations).not.toContain("session.create");
  });

  test("rejects semantic execution gateways even when a grant lists them", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const operations: string[] = [];
    const client = fakeClient({
      operations,
      toolIds: ["read", "openwork_execute", "code_mode"],
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client),
    );

    for (const capability of ["openwork_execute", "code_mode"]) {
      const result = await adapter.execute(
        executionRequest(workspacePath, {
          capabilities: [SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID, capability],
        }),
        { signal: new AbortController().signal },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.error.code).toBe("invalid-grant");
        expect(result.sessionId).toBeNull();
      }
    }
    expect(operations).not.toContain("session.create");
  });

  test("returns ambiguous when polling and abort cannot establish a terminal outcome", async () => {
    const { config, workspace, workspacePath } = await createFixture();
    const client = fakeClient({
      status: async () => ({ "session-1": { type: "idle" } }),
      messages: async () => [],
      abort: async () => false,
    });
    const adapter = createOpencodeScheduledTaskExecutionAdapter(
      adapterOptions(config, workspace, client, {
        maximumPollIterations: 2,
      }),
    );

    const result = await adapter.execute(executionRequest(workspacePath), {
      signal: new AbortController().signal,
    });

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.error.code).toBe("ambiguous-outcome");
      expect(result.error.ambiguous).toBe(true);
      expect(result.sessionId).toBe("session-1");
    }
  });
});
