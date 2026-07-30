import { randomUUID } from "node:crypto";
import { constants as fsConstants, type Dirent, type Stats } from "node:fs";
import { copyFile, lstat, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  UI_ARTIFACT_MAX_DATA_BYTES,
  UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES,
  UI_ARTIFACT_MAX_BUNDLE_BYTES,
  UI_ARTIFACT_MAX_MANIFEST_BYTES,
  UI_ARTIFACT_MAX_SOURCE_BYTES,
  UI_ARTIFACT_MAX_STYLES_BYTES,
  UI_ARTIFACT_PROJECT_FILES,
  uiArtifactPinnedBuildSchema,
  uiArtifactProjectFileSchema,
  uiArtifactProjectManifestSchema,
  uiArtifactProjectRevisionSchema,
  uiArtifactProjectSnapshotSchema,
  type UiArtifactPinnedBuild,
  type UiArtifactProjectFile,
  type UiArtifactProjectFiles,
  type UiArtifactProjectSnapshot,
  type UiArtifactProjectSummary,
} from "@openwork/types/ui-artifact-project";
import { ApiError } from "../errors.js";
import type { ArtifactProjectRepositoryPort } from "./ports.js";
import {
  assertSafeArtifactPath,
  ensureSafeDirectory,
  isMissingFileError,
  sha256,
  stableJson,
} from "./filesystem-security.js";

const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_METADATA_MAX_BYTES = 768_000;

const FILE_BYTE_LIMITS: Record<UiArtifactProjectFile, number> = {
  "artifact.json": UI_ARTIFACT_MAX_MANIFEST_BYTES,
  "src/App.tsx": UI_ARTIFACT_MAX_SOURCE_BYTES,
  "styles.css": UI_ARTIFACT_MAX_STYLES_BYTES,
  "data.json": UI_ARTIFACT_MAX_DATA_BYTES,
  "data.schema.json": UI_ARTIFACT_MAX_DATA_SCHEMA_BYTES,
};

function defaultManifest(slug: string): string {
  return JSON.stringify({
    protocol: "openwork.ui-artifact-project",
    schemaVersion: 2,
    apiVersion: 1,
    slug,
    title: slug.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" "),
    runtime: {
      kind: "react",
      entry: "src/App.tsx",
      styles: "styles.css",
    },
    data: {
      value: "data.json",
      schema: "data.schema.json",
    },
    presentation: {
      placement: "both",
      shape: "summary",
    },
    intents: [],
  }, null, 2);
}

function defaultProjectFiles(slug: string): UiArtifactProjectFiles {
  return {
    "artifact.json": defaultManifest(slug),
    "src/App.tsx": [
      "export default function Artifact({ data }) {",
      "  return <main className=\"artifact\"><strong>{String(data?.label ?? \"Ready\")}</strong><p>{String(data?.message ?? \"Customize this summary.\")}</p></main>",
      "}",
      "",
    ].join("\n"),
    "styles.css": "* { box-sizing: border-box; } body { margin: 0; } .artifact { width: 100%; height: 100%; overflow: hidden; padding: 1rem; font-family: system-ui, sans-serif; } .artifact p { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }\n",
    "data.json": JSON.stringify({ label: "Ready", message: "Customize this compact summary." }, null, 2) + "\n",
    "data.schema.json": JSON.stringify({
      type: "object",
      required: ["label", "message"],
      properties: {
        label: { type: "string", maxLength: 80 },
        message: { type: "string", maxLength: 240 },
      },
      additionalProperties: false,
    }, null, 2) + "\n",
  };
}

function parseJson(content: string, code: string, message: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new ApiError(400, code, message);
  }
}

function parseProjectFiles(
  slug: string,
  files: UiArtifactProjectFiles,
  updatedAt: string,
): UiArtifactProjectSnapshot {
  const manifestResult = uiArtifactProjectManifestSchema.safeParse(
    parseJson(files["artifact.json"], "ui_artifact_manifest_invalid", "artifact.json must contain valid JSON"),
  );
  if (!manifestResult.success) {
    throw new ApiError(400, "ui_artifact_manifest_invalid", "artifact.json does not match the artifact project contract", {
      issues: manifestResult.error.issues,
    });
  }
  if (manifestResult.data.slug !== slug) {
    throw new ApiError(400, "ui_artifact_slug_mismatch", "The manifest slug must match the project route slug");
  }

  const data = parseJson(files["data.json"], "ui_artifact_data_invalid", "data.json must contain valid JSON");
  const dataSchema = parseJson(
    files["data.schema.json"],
    "ui_artifact_data_schema_invalid",
    "data.schema.json must contain valid JSON",
  );
  if (typeof dataSchema !== "object" || dataSchema === null || Array.isArray(dataSchema)) {
    throw new ApiError(400, "ui_artifact_data_schema_invalid", "data.schema.json must contain a JSON Schema object");
  }

  const projectRevision = sha256(stableJson(files));
  const parsed = uiArtifactProjectSnapshotSchema.safeParse({
    protocol: "openwork.ui-artifact-project-snapshot",
    schemaVersion: 2,
    enabled: true,
    manifest: manifestResult.data,
    files,
    data,
    dataSchema,
    projectRevision,
    updatedAt,
  });
  if (!parsed.success) {
    throw new ApiError(400, "ui_artifact_project_invalid", "Artifact project files do not match the project contract", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function requireProjectFileSizes(files: UiArtifactProjectFiles): void {
  for (const file of UI_ARTIFACT_PROJECT_FILES) {
    if (Buffer.byteLength(files[file], "utf8") > FILE_BYTE_LIMITS[file]) {
      throw new ApiError(413, "ui_artifact_file_too_large", `${file} exceeds its size limit`);
    }
    if (files[file].includes("\u0000")) {
      throw new ApiError(400, "ui_artifact_file_invalid", `${file} cannot contain null bytes`);
    }
  }
}

export class FilesystemArtifactProjectRepository implements ArtifactProjectRepositoryPort {
  private readonly projectsRoot: string;
  private readonly buildsRoot: string;
  private readonly projectQueues = new Map<string, Promise<void>>();

  constructor(private readonly workspaceRoot: string) {
    this.projectsRoot = join(workspaceRoot, ".opencode", "openwork", "artifacts");
    this.buildsRoot = join(workspaceRoot, ".opencode", "openwork", "artifact-builds");
  }

  private projectRoot(slug: string): string {
    const parsedSlug = uiArtifactProjectManifestSchema.shape.slug.safeParse(slug);
    if (!parsedSlug.success) {
      throw new ApiError(400, "ui_artifact_slug_invalid", "Artifact slug must use lowercase kebab-case");
    }
    return join(this.projectsRoot, parsedSlug.data);
  }

  private buildProjectRoot(slug: string): string {
    const parsedSlug = uiArtifactProjectManifestSchema.shape.slug.safeParse(slug);
    if (!parsedSlug.success) {
      throw new ApiError(400, "ui_artifact_slug_invalid", "Artifact slug must use lowercase kebab-case");
    }
    return join(this.buildsRoot, parsedSlug.data);
  }

  private async withProjectQueue<T>(slug: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.projectQueues.get(slug) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.projectQueues.set(slug, tail);
    try {
      return await result;
    } finally {
      if (this.projectQueues.get(slug) === tail) this.projectQueues.delete(slug);
    }
  }

  private async readFilesUnlocked(slug: string): Promise<{ files: UiArtifactProjectFiles; updatedAt: string }> {
    const projectRoot = this.projectRoot(slug);
    await assertSafeArtifactPath(this.workspaceRoot, projectRoot);
    try {
      const rootInfo = await lstat(projectRoot);
      if (!rootInfo.isDirectory()) {
        throw new ApiError(400, "ui_artifact_project_invalid", "Artifact project path is not a directory");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isMissingFileError(error)) {
        throw new ApiError(404, "ui_artifact_not_found", "Artifact project not found");
      }
      throw error;
    }

    const readProjectFile = async (file: UiArtifactProjectFile): Promise<{ content: string; modifiedAt: number }> => {
      const filePath = join(projectRoot, file);
      await assertSafeArtifactPath(this.workspaceRoot, filePath);
      let info: Stats;
      try {
        info = await lstat(filePath);
      } catch (error) {
        if (isMissingFileError(error)) {
          throw new ApiError(400, "ui_artifact_project_incomplete", `Artifact project is missing ${file}`);
        }
        throw error;
      }
      if (!info.isFile()) {
        throw new ApiError(400, "ui_artifact_project_invalid", `${file} must be a regular file`);
      }
      if (info.size > FILE_BYTE_LIMITS[file]) {
        throw new ApiError(413, "ui_artifact_file_too_large", `${file} exceeds its size limit`);
      }
      return { content: await readFile(filePath, "utf8"), modifiedAt: info.mtimeMs };
    };

    const [manifest, source, styles, data, dataSchema] = await Promise.all([
      readProjectFile("artifact.json"),
      readProjectFile("src/App.tsx"),
      readProjectFile("styles.css"),
      readProjectFile("data.json"),
      readProjectFile("data.schema.json"),
    ]);
    return {
      files: {
        "artifact.json": manifest.content,
        "src/App.tsx": source.content,
        "styles.css": styles.content,
        "data.json": data.content,
        "data.schema.json": dataSchema.content,
      },
      updatedAt: new Date(Math.max(
        manifest.modifiedAt,
        source.modifiedAt,
        styles.modifiedAt,
        data.modifiedAt,
        dataSchema.modifiedAt,
      )).toISOString(),
    };
  }

  async list(): Promise<UiArtifactProjectSummary[]> {
    await assertSafeArtifactPath(this.workspaceRoot, this.projectsRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(this.projectsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }

    const summaries: UiArtifactProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !uiArtifactProjectManifestSchema.shape.slug.safeParse(entry.name).success) continue;
      try {
        const snapshot = await this.get(entry.name);
        const latestBuild = await this.latestBuild(entry.name);
        summaries.push({
          protocol: "openwork.ui-artifact-project-summary",
          schemaVersion: 2,
          slug: entry.name,
          title: snapshot.manifest.title,
          ...(snapshot.manifest.description ? { description: snapshot.manifest.description } : {}),
          enabled: true,
          presentation: snapshot.manifest.presentation,
          projectRevision: snapshot.projectRevision,
          updatedAt: snapshot.updatedAt,
          latestBuild: latestBuild
            ? {
                projectRevision: latestBuild.build.projectRevision,
                buildDigest: latestBuild.build.buildDigest,
                createdAt: latestBuild.build.createdAt,
              }
            : null,
        });
      } catch {
        // Invalid or partially written projects are excluded from the catalog;
        // direct reads still return their precise validation error.
      }
    }
    return summaries.sort((left, right) => {
      if (left.updatedAt < right.updatedAt) return 1;
      if (left.updatedAt > right.updatedAt) return -1;
      return 0;
    });
  }

  private async getUnlocked(slug: string): Promise<UiArtifactProjectSnapshot> {
    const { files, updatedAt } = await this.readFilesUnlocked(slug);
    return parseProjectFiles(slug, files, updatedAt);
  }

  async get(slug: string): Promise<UiArtifactProjectSnapshot> {
    return this.withProjectQueue(slug, () => this.getUnlocked(slug));
  }

  async putFile(input: {
    slug: string;
    file: UiArtifactProjectFile;
    content: string;
    expectedRevision: string | null;
  }): Promise<UiArtifactProjectSnapshot> {
    const fileResult = uiArtifactProjectFileSchema.safeParse(input.file);
    if (!fileResult.success) {
      throw new ApiError(400, "ui_artifact_file_invalid", "Only fixed artifact project files can be updated");
    }
    if (Buffer.byteLength(input.content, "utf8") > FILE_BYTE_LIMITS[fileResult.data]) {
      throw new ApiError(413, "ui_artifact_file_too_large", `${fileResult.data} exceeds its size limit`);
    }
    if (input.content.includes("\u0000")) {
      throw new ApiError(400, "ui_artifact_file_invalid", "Artifact files cannot contain null bytes");
    }

    return this.withProjectQueue(input.slug, async () => {
      const projectRoot = this.projectRoot(input.slug);
      let current: UiArtifactProjectSnapshot | null = null;
      try {
        current = await this.getUnlocked(input.slug);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }

      if (current) {
        if (!input.expectedRevision || input.expectedRevision !== current.projectRevision) {
          throw new ApiError(409, "ui_artifact_revision_conflict", "Artifact project changed since it was loaded", {
            expectedRevision: input.expectedRevision,
            actualRevision: current.projectRevision,
          });
        }
        const nextFiles = { ...current.files, [fileResult.data]: input.content };
        const next = parseProjectFiles(input.slug, nextFiles, new Date().toISOString());
        await assertSafeArtifactPath(this.workspaceRoot, join(projectRoot, fileResult.data));
        const temporaryPath = join(projectRoot, `.openwork-${randomUUID()}.tmp`);
        await writeFile(temporaryPath, input.content, { encoding: "utf8", flag: "wx" });
        try {
          await assertSafeArtifactPath(this.workspaceRoot, temporaryPath);
          await rename(temporaryPath, join(projectRoot, fileResult.data));
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          throw error;
        }
        return { ...next, updatedAt: (await this.getUnlocked(input.slug)).updatedAt };
      }

      if (input.expectedRevision !== null) {
        throw new ApiError(409, "ui_artifact_revision_conflict", "Artifact project does not exist", {
          expectedRevision: input.expectedRevision,
          actualRevision: null,
        });
      }
      await ensureSafeDirectory(this.workspaceRoot, this.projectsRoot);
      await assertSafeArtifactPath(this.workspaceRoot, projectRoot);
      const files = { ...defaultProjectFiles(input.slug), [fileResult.data]: input.content };
      parseProjectFiles(input.slug, files, new Date().toISOString());
      const temporaryRoot = join(this.projectsRoot, `.openwork-${randomUUID()}.tmp`);
      await ensureSafeDirectory(this.workspaceRoot, join(temporaryRoot, "src"));
      try {
        await Promise.all(UI_ARTIFACT_PROJECT_FILES.map((file) =>
          writeFile(join(temporaryRoot, file), files[file], { encoding: "utf8", flag: "wx" }),
        ));
        await rename(temporaryRoot, projectRoot);
      } catch (error) {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
        if (await stat(projectRoot).then(() => true, () => false)) {
          throw new ApiError(409, "ui_artifact_revision_conflict", "Artifact project was created concurrently");
        }
        throw error;
      }
      return this.getUnlocked(input.slug);
    });
  }

  async putProject(input: {
    slug: string;
    files: UiArtifactProjectFiles;
    expectedRevision: string | null;
  }): Promise<UiArtifactProjectSnapshot> {
    requireProjectFileSizes(input.files);
    parseProjectFiles(input.slug, input.files, new Date().toISOString());
    return this.withProjectQueue(input.slug, async () => {
      const projectRoot = this.projectRoot(input.slug);
      let current: UiArtifactProjectSnapshot | null = null;
      try {
        current = await this.getUnlocked(input.slug);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }

      if (!current) {
        if (input.expectedRevision !== null) {
          throw new ApiError(409, "ui_artifact_revision_conflict", "Artifact project does not exist", {
            expectedRevision: input.expectedRevision,
            actualRevision: null,
          });
        }
        await ensureSafeDirectory(this.workspaceRoot, this.projectsRoot);
        const temporaryRoot = join(this.projectsRoot, `.openwork-${randomUUID()}.tmp`);
        await ensureSafeDirectory(this.workspaceRoot, join(temporaryRoot, "src"));
        try {
          await Promise.all(UI_ARTIFACT_PROJECT_FILES.map((file) =>
            writeFile(join(temporaryRoot, file), input.files[file], { encoding: "utf8", flag: "wx" }),
          ));
          await rename(temporaryRoot, projectRoot);
        } catch (error) {
          await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
          if (await stat(projectRoot).then(() => true, () => false)) {
            throw new ApiError(409, "ui_artifact_revision_conflict", "Artifact project was created concurrently");
          }
          throw error;
        }
        return this.getUnlocked(input.slug);
      }

      if (!input.expectedRevision || input.expectedRevision !== current.projectRevision) {
        throw new ApiError(409, "ui_artifact_revision_conflict", "Artifact project changed since it was loaded", {
          expectedRevision: input.expectedRevision,
          actualRevision: current.projectRevision,
        });
      }

      const transactionId = randomUUID();
      const entries = UI_ARTIFACT_PROJECT_FILES.map((file) => ({
        file,
        target: join(projectRoot, file),
        staged: join(projectRoot, `${file}.${transactionId}.staged`),
        backup: join(projectRoot, `${file}.${transactionId}.backup`),
      }));
      try {
        for (const entry of entries) {
          await assertSafeArtifactPath(this.workspaceRoot, entry.target);
          await assertSafeArtifactPath(this.workspaceRoot, entry.staged);
          await assertSafeArtifactPath(this.workspaceRoot, entry.backup);
          await writeFile(entry.staged, input.files[entry.file], { encoding: "utf8", flag: "wx" });
        }
      } catch (error) {
        await Promise.all(entries.map((entry) => rm(entry.staged, { force: true }))).catch(() => undefined);
        throw error;
      }

      const committed: typeof entries = [];
      try {
        for (const entry of entries) {
          await copyFile(entry.target, entry.backup, fsConstants.COPYFILE_EXCL);
        }
        for (const entry of entries) {
          await rename(entry.staged, entry.target);
          committed.push(entry);
        }
      } catch (error) {
        const restored = new Set<string>();
        let rollbackFailed = false;
        for (const entry of committed.reverse()) {
          try {
            await rename(entry.backup, entry.target);
            restored.add(entry.file);
          } catch {
            rollbackFailed = true;
          }
        }
        const committedFiles = new Set(committed.map((entry) => entry.file));
        await Promise.all(entries.map(async (entry) => {
          await rm(entry.staged, { force: true }).catch(() => undefined);
          if (!committedFiles.has(entry.file) || restored.has(entry.file)) {
            await rm(entry.backup, { force: true }).catch(() => undefined);
          }
        }));
        if (rollbackFailed) {
          throw new ApiError(
            500,
            "ui_artifact_atomic_update_failed",
            "Artifact update failed and retained recovery files",
            { transactionId },
          );
        }
        throw error;
      }
      await Promise.all(entries.map((entry) => rm(entry.backup, { force: true })));
      return this.getUnlocked(input.slug);
    });
  }

  private async latestBuild(slug: string): Promise<UiArtifactPinnedBuild | null> {
    const buildsRoot = this.buildProjectRoot(slug);
    await assertSafeArtifactPath(this.workspaceRoot, buildsRoot);
    let entries: Dirent[];
    try {
      entries = await readdir(buildsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw error;
    }
    let latest: UiArtifactPinnedBuild | null = null;
    for (const entry of entries) {
      if (!entry.isDirectory() || !REVISION_PATTERN.test(entry.name)) continue;
      try {
        const candidate = await this.getBuild(slug, entry.name);
        if (!latest || candidate.build.createdAt > latest.build.createdAt) latest = candidate;
      } catch {
        // Ignore incomplete build directories in the summary catalog.
      }
    }
    return latest;
  }

  async getBuild(slug: string, projectRevision: string): Promise<UiArtifactPinnedBuild> {
    const revision = uiArtifactProjectRevisionSchema.safeParse(projectRevision);
    if (!revision.success) {
      throw new ApiError(400, "ui_artifact_revision_invalid", "Artifact project revision is invalid");
    }
    const buildRoot = join(this.buildProjectRoot(slug), revision.data);
    await assertSafeArtifactPath(this.workspaceRoot, buildRoot);
    try {
      const rootInfo = await lstat(buildRoot);
      if (!rootInfo.isDirectory()) {
        throw new ApiError(400, "ui_artifact_build_invalid", "Artifact build path is not a directory");
      }
      const bundlePath = join(buildRoot, "bundle.js");
      const metadataPath = join(buildRoot, "build.json");
      await Promise.all([
        assertSafeArtifactPath(this.workspaceRoot, bundlePath),
        assertSafeArtifactPath(this.workspaceRoot, metadataPath),
      ]);
      const [bundleInfo, metadataInfo] = await Promise.all([lstat(bundlePath), lstat(metadataPath)]);
      if (!bundleInfo.isFile() || !metadataInfo.isFile()) {
        throw new ApiError(400, "ui_artifact_build_invalid", "Artifact build files must be regular files");
      }
      if (
        bundleInfo.size > UI_ARTIFACT_MAX_BUNDLE_BYTES
        || metadataInfo.size > BUILD_METADATA_MAX_BYTES
      ) {
        throw new ApiError(413, "ui_artifact_build_too_large", "Pinned artifact build exceeds its size limit");
      }
      const [bundle, metadataText] = await Promise.all([
        readFile(bundlePath, "utf8"),
        readFile(metadataPath, "utf8"),
      ]);
      const metadata = parseJson(
        metadataText,
        "ui_artifact_build_invalid",
        "Artifact build metadata is invalid",
      );
      const result = uiArtifactPinnedBuildSchema.safeParse(
        typeof metadata === "object" && metadata !== null
          ? { ...metadata, bundle }
          : metadata,
      );
      if (!result.success || result.data.build.projectRevision !== revision.data || result.data.build.slug !== slug) {
        throw new ApiError(400, "ui_artifact_build_invalid", "Artifact build does not match its pinned revision");
      }
      const buildDigest = sha256(stableJson({
        bundle,
        manifest: result.data.manifest,
        styles: result.data.styles,
        data: result.data.data,
        dataSchema: result.data.dataSchema,
      }));
      if (buildDigest !== result.data.build.buildDigest) {
        throw new ApiError(400, "ui_artifact_build_invalid", "Artifact build digest does not match its pinned contents");
      }
      return result.data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (isMissingFileError(error)) {
        throw new ApiError(404, "ui_artifact_build_not_found", "Pinned artifact build not found");
      }
      throw error;
    }
  }

  async saveBuild(build: UiArtifactPinnedBuild): Promise<UiArtifactPinnedBuild> {
    const parsed = uiArtifactPinnedBuildSchema.safeParse(build);
    if (!parsed.success) {
      throw new ApiError(500, "ui_artifact_build_invalid", "Compiler produced an invalid artifact build");
    }
    const buildsRoot = this.buildProjectRoot(parsed.data.build.slug);
    const buildRoot = join(buildsRoot, parsed.data.build.projectRevision);
    return this.withProjectQueue(parsed.data.build.slug, async () => {
      try {
        const existing = await this.getBuild(parsed.data.build.slug, parsed.data.build.projectRevision);
        if (existing.build.buildDigest !== parsed.data.build.buildDigest) {
          throw new ApiError(409, "ui_artifact_build_conflict", "Pinned artifact build is immutable");
        }
        return existing;
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
      }

      await ensureSafeDirectory(this.workspaceRoot, buildsRoot);
      await assertSafeArtifactPath(this.workspaceRoot, buildRoot);
      const temporaryRoot = join(buildsRoot, `.openwork-${randomUUID()}.tmp`);
      await ensureSafeDirectory(this.workspaceRoot, temporaryRoot);
      const { bundle, ...metadata } = parsed.data;
      try {
        await Promise.all([
          writeFile(join(temporaryRoot, "bundle.js"), bundle, { encoding: "utf8", flag: "wx" }),
          writeFile(join(temporaryRoot, "build.json"), JSON.stringify(metadata, null, 2) + "\n", {
            encoding: "utf8",
            flag: "wx",
          }),
        ]);
        await rename(temporaryRoot, buildRoot);
      } catch (error) {
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
        if (await stat(buildRoot).then(() => true, () => false)) {
          const existing = await this.getBuild(parsed.data.build.slug, parsed.data.build.projectRevision);
          if (existing.build.buildDigest === parsed.data.build.buildDigest) return existing;
          throw new ApiError(409, "ui_artifact_build_conflict", "Pinned artifact build is immutable");
        }
        throw error;
      }
      return this.getBuild(parsed.data.build.slug, parsed.data.build.projectRevision);
    });
  }
}
