import { realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { ScheduledTaskArtifactReference, ScheduledTaskTypedError } from "@openwork/types/scheduled-tasks";
import { ApiError } from "../errors.js";
import {
  registerScheduledTaskRoutes,
  type RegisterScheduledTaskRoutesOptions,
} from "../routes/scheduled-tasks.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { hashToken } from "../utils.js";
import {
  validateScheduledTaskCapabilityGrant,
  type ScheduledTaskExecutionAdapter,
} from "./execution.js";
import {
  createOpencodeScheduledTaskExecutionAdapter,
  type OpencodeScheduledTaskExecutionAdapterOptions,
} from "./opencode-execution-adapter.js";
import {
  createScheduledTaskScheduler,
  type ScheduledTaskScheduler,
} from "./scheduled-task-scheduler.js";
import {
  createScheduledTaskService,
  type ScheduledTaskAuthorityValidation,
  type ScheduledTaskService,
} from "./scheduled-task-service.js";
import {
  createScheduledTaskStore,
  type ScheduledTaskStore,
} from "./scheduled-task-store.js";

type ScheduledTaskLogger = {
  log(
    level: "error",
    message: string,
    attributes?: Record<string, unknown>,
  ): void;
};

type ScheduledTaskRouteDependencies = Omit<
  RegisterScheduledTaskRoutesOptions,
  "config" | "scheduler" | "service"
>;

export interface CreateScheduledTasksModuleOptions {
  config: ServerConfig;
  logger: ScheduledTaskLogger;
  resolveWorkspace(workspaceId: string): Promise<WorkspaceInfo>;
  createExecutionAdapter?: (
    options: OpencodeScheduledTaskExecutionAdapterOptions,
  ) => ScheduledTaskExecutionAdapter;
  createClient: OpencodeScheduledTaskExecutionAdapterOptions["createClient"];
}

export interface ScheduledTasksModule {
  readonly service: ScheduledTaskService;
  registerRoutes(options: ScheduledTaskRouteDependencies): void;
  onWorkspaceRemoved(workspaceId: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

function pathContains(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot
    || normalizedCandidate.startsWith(normalizedRoot + sep);
}

function authorityFailure(
  code: ScheduledTaskTypedError["code"],
  message: string,
) {
  return {
    ok: false as const,
    error: {
      code,
      message,
      retryable: false,
      ambiguous: false,
    },
  };
}

async function resolveArtifacts(input: {
  workspace: WorkspaceInfo;
  candidates: string[];
}): Promise<ScheduledTaskArtifactReference[]> {
  let workspaceRoot: string;
  try {
    workspaceRoot = await realpath(input.workspace.path);
  } catch {
    return [];
  }

  const artifacts: ScheduledTaskArtifactReference[] = [];
  const seen = new Set<string>();
  for (const rawCandidate of input.candidates.slice(0, 200)) {
    const candidate = rawCandidate.trim();
    if (!candidate) continue;
    let canonical: string;
    try {
      canonical = await realpath(resolve(workspaceRoot, candidate));
      if (!pathContains(workspaceRoot, canonical) || !(await stat(canonical)).isFile()) {
        continue;
      }
    } catch {
      continue;
    }

    const workspaceRelativePath = relative(workspaceRoot, canonical)
      .split(sep)
      .join("/");
    if (!workspaceRelativePath || seen.has(workspaceRelativePath)) continue;
    seen.add(workspaceRelativePath);
    artifacts.push({
      id: `artifact_${hashToken(workspaceRelativePath).slice(0, 24)}`,
      kind: "file",
      value: workspaceRelativePath,
      name: basename(canonical),
    });
  }
  return artifacts;
}

async function validateAuthority(
  options: CreateScheduledTasksModuleOptions,
  input: ScheduledTaskAuthorityValidation,
): Promise<void> {
  const workspace = await options.resolveWorkspace(input.task.workspaceId);
  if (workspace.workspaceType !== "local") {
    throw new ApiError(
      409,
      "scheduled_task_workspace_inaccessible",
      "Scheduled tasks currently require a local workspace owned by this server",
    );
  }
  if (
    input.revision.taskId !== input.task.id
    || input.revision.definition.workspaceId !== input.task.workspaceId
  ) {
    throw new ApiError(
      409,
      "scheduled_task_invalid_revision",
      "The scheduled-task revision does not match its workspace",
    );
  }
  if (!input.grant) return;

  const grant = input.grant;
  const definition = input.revision.definition;
  const placement = grant.placement ?? definition.placement;
  if (
    placement
    && (
      placement.target.kind !== "local-workspace"
      || placement.target.workspaceId !== definition.workspaceId
      || placement.schedulerOwner !== "local-server"
    )
  ) {
    throw new ApiError(
      409,
      "scheduled_task_invalid_placement",
      "This local server can only review tasks placed in its local workspace",
    );
  }
  if (
    grant.model.providerId !== definition.model.providerId
    || grant.model.modelId !== definition.model.modelId
    || grant.model.agent !== definition.model.agent
  ) {
    throw new ApiError(
      409,
      "scheduled_task_invalid_grant",
      "The reviewed model must exactly match the scheduled-task revision",
    );
  }
  if (
    (grant.filesystem.read && !grant.actionClasses.includes("read"))
    || (grant.filesystem.write && !grant.actionClasses.includes("write"))
  ) {
    throw new ApiError(
      409,
      "scheduled_task_invalid_grant",
      "The reviewed filesystem scope exceeds its allowed action classes",
    );
  }
  const capabilityGrant = validateScheduledTaskCapabilityGrant(grant.capabilityIds);
  if (!capabilityGrant.ok) {
    throw new ApiError(
      409,
      "scheduled_task_invalid_grant",
      "Scheduled tasks may only use the reviewed local filesystem capability set",
      { capabilityIds: capabilityGrant.unsupportedCapabilityIds },
    );
  }

  let canonicalWorkspace: string;
  try {
    canonicalWorkspace = await realpath(workspace.path);
  } catch {
    throw new ApiError(
      409,
      "scheduled_task_workspace_inaccessible",
      "The scheduled-task workspace is no longer accessible",
    );
  }
  const serverRoots: string[] = [];
  for (const root of options.config.authorizedRoots) {
    try {
      serverRoots.push(await realpath(root));
    } catch {
      // A stale configured root grants no authority.
    }
  }
  const reviewedRoots: string[] = [];
  for (const root of grant.authorizedWorkspaceRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(root);
    } catch {
      throw new ApiError(
        409,
        "scheduled_task_workspace_inaccessible",
        "A reviewed workspace root is no longer accessible",
      );
    }
    if (!serverRoots.some((serverRoot) => pathContains(serverRoot, canonicalRoot))) {
      throw new ApiError(
        409,
        "scheduled_task_invalid_grant",
        "A reviewed workspace root is outside the server's authorized roots",
      );
    }
    if (!pathContains(canonicalWorkspace, canonicalRoot)) {
      throw new ApiError(
        409,
        "scheduled_task_invalid_grant",
        "Scheduled-task roots must stay inside their owning workspace",
      );
    }
    reviewedRoots.push(canonicalRoot);
  }
  if (!reviewedRoots.some((root) => pathContains(root, canonicalWorkspace))) {
    throw new ApiError(
      409,
      "scheduled_task_invalid_grant",
      "The reviewed grant must include the scheduled-task workspace root",
    );
  }
}

function createLiveAuthorityInspector(
  options: CreateScheduledTasksModuleOptions,
  store: ScheduledTaskStore,
): NonNullable<OpencodeScheduledTaskExecutionAdapterOptions["inspectAuthority"]> {
  return async ({ request, availableCapabilityIds, connectedProviderIds }) => {
    const task = store.getTask(request.taskRevision.taskId);
    const grant = store.getGrant(request.grantRevision.id);
    const workspaceStillPresent = options.config.workspaces.some(
      (workspace) => workspace.id === request.taskRevision.definition.workspaceId,
    );
    if (!workspaceStillPresent) {
      return authorityFailure(
        "workspace-removed",
        "The scheduled-task workspace was removed from OpenWork",
      );
    }
    if (!task || task.deletedAt !== null) {
      return authorityFailure(
        "grant-revoked",
        "The scheduled task no longer authorizes execution",
      );
    }
    if (!grant || grant.revokedAt !== null) {
      return authorityFailure("grant-revoked", "The scheduled-task grant was revoked");
    }
    if (grant.expiresAt !== null && grant.expiresAt <= Date.now()) {
      return authorityFailure("grant-expired", "The scheduled-task grant expired");
    }
    if (
      task.activeRevisionId !== request.taskRevision.id
      || task.activeGrantId !== request.grantRevision.id
    ) {
      return authorityFailure(
        "invalid-revision",
        "The scheduled task now points to a different reviewed revision",
      );
    }
    if (grant.capabilityIds.some((capabilityId) => !availableCapabilityIds.has(capabilityId))) {
      return authorityFailure(
        "capability-unavailable",
        "A reviewed scheduled-task capability is no longer available",
      );
    }
    if (grant.model.providerId && !connectedProviderIds.has(grant.model.providerId)) {
      return authorityFailure(
        "credential-unavailable",
        "The reviewed model provider is no longer connected",
      );
    }
    try {
      await validateAuthority(options, {
        phase: "execute",
        task,
        revision: request.taskRevision,
        grant,
        now: Date.now(),
      });
    } catch (error) {
      return authorityFailure(
        error instanceof ApiError && error.code.includes("workspace")
          ? "workspace-inaccessible"
          : "invalid-grant",
        error instanceof Error
          ? error.message
          : "Scheduled-task authority is no longer valid",
      );
    }
    return { ok: true };
  };
}

export async function createScheduledTasksModule(
  options: CreateScheduledTasksModuleOptions,
): Promise<ScheduledTasksModule | null> {
  if (options.config.readOnly) return null;

  const store = await createScheduledTaskStore({ config: options.config });
  let scheduler: ScheduledTaskScheduler | null = null;
  try {
    const createExecutionAdapter = options.createExecutionAdapter
      ?? createOpencodeScheduledTaskExecutionAdapter;
    const execution = createExecutionAdapter({
      authorizedRoots: options.config.authorizedRoots,
      resolveWorkspace: options.resolveWorkspace,
      createClient: options.createClient,
      inspectAuthority: createLiveAuthorityInspector(options, store),
      resolveArtifacts,
    });
    const service = createScheduledTaskService({
      store,
      execution,
      validateAuthority: (input) => validateAuthority(options, input),
    });
    const scheduledTaskScheduler = createScheduledTaskScheduler({
      service,
      onError: (error) => {
        options.logger.log("error", "Scheduled task scheduler tick failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    });
    scheduler = scheduledTaskScheduler;

    let stopped = false;
    return {
      service,
      registerRoutes(routeOptions) {
        registerScheduledTaskRoutes({
          ...routeOptions,
          config: options.config,
          service,
          scheduler: scheduledTaskScheduler,
        });
      },
      async onWorkspaceRemoved(workspaceId) {
        await service.markWorkspaceUnavailable(workspaceId);
      },
      start() {
        scheduledTaskScheduler.start({ immediate: true });
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        try {
          await scheduledTaskScheduler.stop();
        } finally {
          store.close();
        }
      },
    };
  } catch (error) {
    try {
      await scheduler?.stop();
    } finally {
      store.close();
    }
    throw error;
  }
}
