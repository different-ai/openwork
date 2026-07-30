import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  UI_ARTIFACT_MAX_STATE_BYTES,
  uiArtifactInstanceStateSchema,
  uiArtifactProjectManifestSchema,
  type UiArtifactInstanceState,
} from "@openwork/types/ui-artifact-project";
import { ApiError } from "../errors.js";
import {
  assertSafeArtifactPath,
  atomicWriteText,
  ensureSafeDirectory,
  isMissingFileError,
  jsonByteLength,
  sha256,
  stableJson,
} from "./filesystem-security.js";
import type { ArtifactStateStorePort } from "./ports.js";

export class JsonArtifactStateStore implements ArtifactStateStorePort {
  private static readonly MAX_STATE_FILE_BYTES = UI_ARTIFACT_MAX_STATE_BYTES + 8_192;
  private readonly stateRoot: string;
  private readonly instanceQueues = new Map<string, Promise<void>>();

  constructor(private readonly workspaceRoot: string) {
    this.stateRoot = join(workspaceRoot, ".opencode", "openwork", "artifact-state");
  }

  private statePath(slug: string, instanceId: string): string {
    if (!uiArtifactProjectManifestSchema.shape.slug.safeParse(slug).success) {
      throw new ApiError(400, "ui_artifact_slug_invalid", "Artifact slug must use lowercase kebab-case");
    }
    if (!uiArtifactInstanceStateSchema.shape.instanceId.safeParse(instanceId).success) {
      throw new ApiError(400, "ui_artifact_instance_invalid", "Artifact instance id is invalid");
    }
    return join(this.stateRoot, slug, `${instanceId}.json`);
  }

  private async withInstanceQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.instanceQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.instanceQueues.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.instanceQueues.get(key) === tail) this.instanceQueues.delete(key);
    }
  }

  async get(input: {
    workspaceId: string;
    slug: string;
    instanceId: string;
  }): Promise<UiArtifactInstanceState> {
    const path = this.statePath(input.slug, input.instanceId);
    await assertSafeArtifactPath(this.workspaceRoot, path);
    try {
      const info = await lstat(path);
      if (!info.isFile()) {
        throw new ApiError(400, "ui_artifact_state_invalid", "Artifact state must be a regular file");
      }
      if (info.size > JsonArtifactStateStore.MAX_STATE_FILE_BYTES) {
        throw new ApiError(413, "ui_artifact_state_too_large", "Artifact instance state exceeds its size limit");
      }
      const parsed = uiArtifactInstanceStateSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      if (
        !parsed.success
        || parsed.data.workspaceId !== input.workspaceId
        || parsed.data.slug !== input.slug
        || parsed.data.instanceId !== input.instanceId
      ) {
        throw new ApiError(400, "ui_artifact_state_invalid", "Artifact instance state is invalid");
      }
      const expectedRevision = sha256(stableJson({
        projectRevision: parsed.data.projectRevision,
        state: parsed.data.state,
      }));
      if (expectedRevision !== parsed.data.stateRevision) {
        throw new ApiError(400, "ui_artifact_state_invalid", "Artifact state revision is invalid");
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isMissingFileError(error)) {
        throw new ApiError(404, "ui_artifact_state_not_found", "Artifact instance state not found");
      }
      if (error instanceof SyntaxError) {
        throw new ApiError(400, "ui_artifact_state_invalid", "Artifact instance state is invalid");
      }
      throw error;
    }
  }

  async initialize(input: {
    workspaceId: string;
    slug: string;
    instanceId: string;
    projectRevision: string;
    state: unknown;
  }): Promise<UiArtifactInstanceState> {
    const key = `${input.slug}\0${input.instanceId}`;
    return this.withInstanceQueue(key, async () => {
      let existing: UiArtifactInstanceState | null = null;
      try {
        existing = await this.get(input);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }
      if (existing && existing.projectRevision !== input.projectRevision) {
        throw new ApiError(
          409,
          "ui_artifact_instance_revision_conflict",
          "Artifact instances are pinned to one project revision; publish the new revision as a new instance",
          {
            instanceId: input.instanceId,
            pinnedProjectRevision: existing.projectRevision,
            requestedProjectRevision: input.projectRevision,
          },
        );
      }
      const state = existing?.state ?? input.state;
      return this.write({
        workspaceId: input.workspaceId,
        slug: input.slug,
        instanceId: input.instanceId,
        projectRevision: input.projectRevision,
        state,
      });
    });
  }

  async update(input: {
    workspaceId: string;
    slug: string;
    instanceId: string;
    expectedRevision: string;
    state: unknown;
  }): Promise<UiArtifactInstanceState> {
    const key = `${input.slug}\0${input.instanceId}`;
    return this.withInstanceQueue(key, async () => {
      const current = await this.get(input);
      if (input.expectedRevision !== current.stateRevision) {
        throw new ApiError(409, "ui_artifact_state_conflict", "Artifact instance state changed since it was loaded", {
          expectedRevision: input.expectedRevision,
          actualRevision: current.stateRevision,
        });
      }
      return this.write({
        workspaceId: input.workspaceId,
        slug: input.slug,
        instanceId: input.instanceId,
        projectRevision: current.projectRevision,
        state: input.state,
      });
    });
  }

  private async write(input: {
    workspaceId: string;
    slug: string;
    instanceId: string;
    projectRevision: string;
    state: unknown;
  }): Promise<UiArtifactInstanceState> {
    if (jsonByteLength(input.state) > UI_ARTIFACT_MAX_STATE_BYTES) {
      throw new ApiError(413, "ui_artifact_state_too_large", "Artifact instance state exceeds its size limit");
    }
    const stateRevision = sha256(stableJson({
      projectRevision: input.projectRevision,
      state: input.state,
    }));
    const result = uiArtifactInstanceStateSchema.safeParse({
      protocol: "openwork.ui-artifact-instance-state",
      schemaVersion: 2,
      ...input,
      stateRevision,
      updatedAt: new Date().toISOString(),
    });
    if (!result.success) {
      throw new ApiError(400, "ui_artifact_state_invalid", "Artifact instance state does not match the state contract", {
        issues: result.error.issues,
      });
    }
    const path = this.statePath(input.slug, input.instanceId);
    await ensureSafeDirectory(this.workspaceRoot, join(this.stateRoot, input.slug));
    await atomicWriteText(this.workspaceRoot, path, JSON.stringify(result.data, null, 2) + "\n");
    return result.data;
  }
}
