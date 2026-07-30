import { lstat, readFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { join } from "node:path";
import {
  uiArtifactSettingsSchema,
  uiArtifactSettingsUpdateSchema,
  type UiArtifactSettings,
  type UiArtifactSettingsUpdate,
} from "@openwork/types/ui-artifact-project";
import { ApiError } from "../errors.js";
import {
  assertSafeArtifactPath,
  atomicWriteText,
  ensureSafeDirectory,
  isMissingFileError,
  sha256,
  stableJson,
} from "./filesystem-security.js";
import type { ArtifactSettingsStorePort } from "./ports.js";

const SETTINGS_FILE_MAX_BYTES = 64_000;

function revisionFor(settings: {
  builderSkillEnabled: boolean;
  projectOverrides: Record<string, boolean>;
}): string {
  return sha256(stableJson(settings));
}

function defaultSettings(): UiArtifactSettings {
  const value = {
    builderSkillEnabled: false,
    projectOverrides: {},
  };
  return {
    protocol: "openwork.ui-artifact-settings",
    schemaVersion: 2,
    ...value,
    settingsRevision: revisionFor(value),
    updatedAt: null,
  };
}

export class JsonArtifactSettingsStore implements ArtifactSettingsStorePort {
  private readonly settingsPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly workspaceRoot: string) {
    this.settingsPath = join(workspaceRoot, ".opencode", "openwork", "artifact-settings.json");
  }

  private async withQueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async getUnlocked(): Promise<UiArtifactSettings> {
    await assertSafeArtifactPath(this.workspaceRoot, this.settingsPath);
    let info: Stats;
    try {
      info = await lstat(this.settingsPath);
    } catch (error) {
      if (isMissingFileError(error)) return defaultSettings();
      throw error;
    }
    if (!info.isFile()) {
      throw new ApiError(400, "ui_artifact_settings_invalid", "Artifact settings must be a regular file");
    }
    if (info.size > SETTINGS_FILE_MAX_BYTES) {
      throw new ApiError(413, "ui_artifact_settings_too_large", "Artifact settings exceed their size limit");
    }
    let json: unknown;
    try {
      json = JSON.parse(await readFile(this.settingsPath, "utf8"));
    } catch {
      throw new ApiError(400, "ui_artifact_settings_invalid", "Artifact settings contain invalid JSON");
    }
    const parsed = uiArtifactSettingsSchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, "ui_artifact_settings_invalid", "Artifact settings do not match the settings contract");
    }
    const expectedRevision = revisionFor({
      builderSkillEnabled: parsed.data.builderSkillEnabled,
      projectOverrides: parsed.data.projectOverrides,
    });
    if (expectedRevision !== parsed.data.settingsRevision) {
      throw new ApiError(400, "ui_artifact_settings_invalid", "Artifact settings revision is invalid");
    }
    return parsed.data;
  }

  get(): Promise<UiArtifactSettings> {
    return this.withQueue(() => this.getUnlocked());
  }

  update(update: UiArtifactSettingsUpdate): Promise<UiArtifactSettings> {
    const parsed = uiArtifactSettingsUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new ApiError(400, "ui_artifact_settings_update_invalid", "Artifact settings update is invalid", {
        issues: parsed.error.issues,
      });
    }
    return this.withQueue(async () => {
      const current = await this.getUnlocked();
      if (parsed.data.expectedRevision !== current.settingsRevision) {
        throw new ApiError(409, "ui_artifact_settings_conflict", "Artifact settings changed since they were loaded", {
          expectedRevision: parsed.data.expectedRevision,
          actualRevision: current.settingsRevision,
        });
      }
      const projectOverrides = { ...current.projectOverrides };
      if (parsed.data.project) {
        if (parsed.data.project.enabled) delete projectOverrides[parsed.data.project.slug];
        else projectOverrides[parsed.data.project.slug] = false;
      }
      const value = {
        builderSkillEnabled: parsed.data.builderSkillEnabled ?? current.builderSkillEnabled,
        projectOverrides,
      };
      const next = uiArtifactSettingsSchema.parse({
        protocol: "openwork.ui-artifact-settings",
        schemaVersion: 2,
        ...value,
        settingsRevision: revisionFor(value),
        updatedAt: new Date().toISOString(),
      });
      await ensureSafeDirectory(this.workspaceRoot, join(this.workspaceRoot, ".opencode", "openwork"));
      await atomicWriteText(this.workspaceRoot, this.settingsPath, JSON.stringify(next, null, 2) + "\n");
      return next;
    });
  }
}
