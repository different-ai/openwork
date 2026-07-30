import { randomUUID } from "node:crypto";
import {
  UI_ARTIFACT_BUILDER_SKILL_NAME,
  UI_ARTIFACT_MAX_INTENT_PROMPT_BYTES,
  UI_ARTIFACT_SHAPE_SPECS,
  uiArtifactAgentSkillSchema,
  uiArtifactBuildSchema,
  uiArtifactIntentRequestSchema,
  uiArtifactProjectFileUpdateSchema,
  uiArtifactProjectUpdateSchema,
  type UiArtifactBuildRequest,
  type UiArtifactAgentSkill,
  type UiArtifactAttachment,
  type UiArtifactInstanceState,
  type UiArtifactIntentDeclaration,
  type UiArtifactIntentRequest,
  type UiArtifactIntentResult,
  type UiArtifactPinnedBuild,
  type UiArtifactProjectFileUpdate,
  type UiArtifactProjectSnapshot,
  type UiArtifactProjectSummary,
  type UiArtifactProjectUpdate,
  type UiArtifactPublishReceipt,
  type UiArtifactPublishRequest,
  type UiArtifactSettings,
  type UiArtifactSettingsUpdate,
  type UiArtifactStateUpdate,
} from "@openwork/types/ui-artifact-project";
import { ApiError } from "../errors.js";
import { sha256, stableJson } from "./filesystem-security.js";
import type {
  ArtifactCompilerPort,
  ArtifactDataValidatorPort,
  ArtifactProjectRepositoryPort,
  ArtifactSettingsStorePort,
  ArtifactStateStorePort,
} from "./ports.js";

const ARTIFACT_BUILDER_SKILL_DESCRIPTION =
  "Build, validate, publish, and safely evolve bounded chat-native React artifacts in the current OpenWork workspace.";

const ARTIFACT_BUILDER_SKILL_CONTENT = `---
name: ${UI_ARTIFACT_BUILDER_SKILL_NAME}
description: ${ARTIFACT_BUILDER_SKILL_DESCRIPTION}
---

# React Artifact Builder

Use this managed skill only when the user asks for an interactive, reusable visual artifact.

## Project contract

Create exactly these workspace files under \`.opencode/openwork/artifacts/<slug>/\`:

- \`artifact.json\`
- \`src/App.tsx\`
- \`styles.css\`
- \`data.json\`
- \`data.schema.json\`

The manifest uses protocol \`openwork.ui-artifact-project\`, schema version 2, API version 1, runtime kind \`react\`, and entry \`src/App.tsx\`. Use lowercase kebab-case slugs. Declare every intent with explicit arguments, effects, and confirmation.

## Chat-card shape contract

You are not designing a web page, landing page, full dashboard, or scrolling application. You are designing one small, self-contained artifact box that must sit comfortably inside a chat message. The OpenWork host already provides the outer card, title, description, revision, refresh control, and editor control; never duplicate that page chrome inside the component.

Every manifest must use \`presentation.placement\` \`inline\` or \`both\` and choose exactly one host-enforced \`presentation.shape\`:

- \`metric\`: ${UI_ARTIFACT_SHAPE_SPECS.metric.frameHeight}px high and at most ${UI_ARTIFACT_SHAPE_SPECS.metric.maxWidth}px wide. Show one primary result and no more than ${UI_ARTIFACT_SHAPE_SPECS.metric.maxVisibleItems} short values with ${UI_ARTIFACT_SHAPE_SPECS.metric.maxActions} action.
- \`summary\`: ${UI_ARTIFACT_SHAPE_SPECS.summary.frameHeight}px high and at most ${UI_ARTIFACT_SHAPE_SPECS.summary.maxWidth}px wide. Show one concise answer with no more than ${UI_ARTIFACT_SHAPE_SPECS.summary.maxVisibleItems} compact content blocks and ${UI_ARTIFACT_SHAPE_SPECS.summary.maxActions} actions.
- \`collection\`: ${UI_ARTIFACT_SHAPE_SPECS.collection.frameHeight}px high and at most ${UI_ARTIFACT_SHAPE_SPECS.collection.maxWidth}px wide. Show no more than ${UI_ARTIFACT_SHAPE_SPECS.collection.maxVisibleItems} visible rows and ${UI_ARTIFACT_SHAPE_SPECS.collection.maxActions} actions. Summarize overflow as \`+ N more\` instead of growing or scrolling.

Choose the smallest shape that communicates the answer. The host owns the exact dimensions; artifacts cannot resize themselves.
At runtime the selected value is exposed as \`data-openwork-artifact-shape\` on both the document root and React root, so CSS may adapt density for that declared shape without measuring or resizing the frame.

Design content against the selected budget before writing JSX:

- Make the component root exactly \`width: 100%; height: 100%; overflow: hidden\` and use \`box-sizing: border-box\`.
- Never use viewport units, document-level navigation, sidebars, hero sections, footers, large empty decoration, nested scroll regions, or minimum heights that can exceed the shape.
- Keep labels short, truncate single-line values, line-clamp prose to two lines, and keep controls compact.
- Slice data to the shape's visible-item limit and render an explicit remainder count. Do not map an unbounded collection into the visible box.
- Preserve essential meaning at narrow chat widths. Use responsive wrapping or a single column rather than horizontal overflow.

## Authoring rules

- Default-export one React component from \`src/App.tsx\`.
- Do not import modules or access network/process APIs. React is injected by the isolated renderer.
- Treat \`data.json\` as immutable input and validate it with \`data.schema.json\`.
- Keep durable user interaction state in the provided artifact state bridge.
- Request side effects only through declared intents. Intents are staged as prompts and are never executed directly by the artifact.
- Prefer the atomic full-project update when changing coordinated files.
- For a substantial UI, delegate a bounded component or data-design task to a subagent when delegation is available, then inspect and integrate the result yourself.

## Workflow

1. Always list artifact projects first. Reuse and enhance an existing project when it matches the user's intent.
2. Read the selected project's enabled status and current revision from the artifact affordances.
3. For a new project, create exactly the five required files. For an existing project, edit and enhance them with the atomic full-project update and expected revision.
4. Resolve every compiler or data-contract diagnostic.
5. Build with the expected project revision, then publish to receive a small revision-pinned chat attachment and instance state.
6. Reuse an instance only for the same project revision. Publish a new instance when the project revision changes.

The managed builder skill is disabled by default at workspace scope. Each project is enabled by default and can be disabled independently. Both controls are human-owned UI settings. If either is disabled, report that status and ask the user to enable it in the artifact UI; never bypass, rewrite, or silently toggle the setting.

Never place credentials, absolute workspace paths, worktree paths, or unbounded data in an artifact project or attachment.
`;

function intentPayloadMatches(
  declaration: UiArtifactIntentDeclaration,
  payload: Record<string, unknown>,
): boolean {
  const argumentsByName = new Map(declaration.arguments.map((argument) => [argument.name, argument]));
  if (Object.keys(payload).some((key) => !argumentsByName.has(key))) return false;
  for (const argument of declaration.arguments) {
    const value = payload[argument.name];
    if (value === undefined) {
      if (argument.required) return false;
      continue;
    }
    if (argument.type === "unknown") continue;
    if (argument.type === "array") {
      if (!Array.isArray(value)) return false;
      continue;
    }
    if (argument.type === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      continue;
    }
    if (typeof value !== argument.type) return false;
  }
  return true;
}

function requiresIntentConfirmation(declaration: UiArtifactIntentDeclaration): boolean {
  if (declaration.confirmation === "always") return true;
  if (declaration.confirmation === "never") return false;
  return declaration.effects.data === "write" || declaration.effects.external;
}

export class ArtifactProjectService {
  constructor(
    private readonly workspaceId: string,
    private readonly projects: ArtifactProjectRepositoryPort,
    private readonly compiler: ArtifactCompilerPort,
    private readonly dataValidator: ArtifactDataValidatorPort,
    private readonly settings: ArtifactSettingsStorePort,
    private readonly states: ArtifactStateStorePort,
  ) {}

  async list(): Promise<UiArtifactProjectSummary[]> {
    const [projects, settings] = await Promise.all([this.projects.list(), this.settings.get()]);
    return projects.map((project) => ({
      ...project,
      enabled: settings.projectOverrides[project.slug] !== false,
    }));
  }

  async get(slug: string): Promise<UiArtifactProjectSnapshot> {
    const [project, settings] = await Promise.all([this.projects.get(slug), this.settings.get()]);
    return {
      ...project,
      enabled: settings.projectOverrides[slug] !== false,
    };
  }

  getSettings(): Promise<UiArtifactSettings> {
    return this.settings.get();
  }

  updateSettings(update: UiArtifactSettingsUpdate): Promise<UiArtifactSettings> {
    return this.settings.update(update);
  }

  async getAgentSkill(): Promise<UiArtifactAgentSkill> {
    const settings = await this.settings.get();
    if (!settings.builderSkillEnabled) {
      throw new ApiError(404, "ui_artifact_builder_skill_disabled", "The managed React Artifact Builder skill is disabled");
    }
    return uiArtifactAgentSkillSchema.parse({
      protocol: "openwork.ui-artifact-agent-skill",
      schemaVersion: 2,
      name: UI_ARTIFACT_BUILDER_SKILL_NAME,
      description: ARTIFACT_BUILDER_SKILL_DESCRIPTION,
      content: ARTIFACT_BUILDER_SKILL_CONTENT,
      settingsRevision: settings.settingsRevision,
    });
  }

  putFile(slug: string, update: UiArtifactProjectFileUpdate): Promise<UiArtifactProjectSnapshot> {
    const parsed = uiArtifactProjectFileUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new ApiError(400, "ui_artifact_file_update_invalid", "Artifact file update is invalid", {
        issues: parsed.error.issues,
      });
    }
    return this.projects.putFile({ slug, ...parsed.data });
  }

  putProject(slug: string, update: UiArtifactProjectUpdate): Promise<UiArtifactProjectSnapshot> {
    const parsed = uiArtifactProjectUpdateSchema.safeParse(update);
    if (!parsed.success) {
      throw new ApiError(400, "ui_artifact_project_update_invalid", "Artifact project update is invalid", {
        issues: parsed.error.issues,
      });
    }
    return this.projects.putProject({ slug, ...parsed.data });
  }

  async build(slug: string, request: UiArtifactBuildRequest = {}): Promise<UiArtifactPinnedBuild> {
    const settings = await this.settings.get();
    if (!settings.builderSkillEnabled) {
      throw new ApiError(409, "ui_artifact_builder_skill_disabled", "Enable the managed React Artifact Builder skill before building artifacts");
    }
    if (settings.projectOverrides[slug] === false) {
      throw new ApiError(409, "ui_artifact_project_disabled", "Enable this artifact project before building it");
    }
    const snapshot = await this.projects.get(slug);
    if (
      request.expectedProjectRevision
      && request.expectedProjectRevision !== snapshot.projectRevision
    ) {
      throw new ApiError(409, "ui_artifact_revision_conflict", "Artifact project changed before it could be built", {
        expectedRevision: request.expectedProjectRevision,
        actualRevision: snapshot.projectRevision,
      });
    }
    try {
      return await this.projects.getBuild(slug, snapshot.projectRevision);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    const dataValidation = this.dataValidator.validate(snapshot.dataSchema, snapshot.data);
    if (!dataValidation.ok) {
      throw new ApiError(
        422,
        "ui_artifact_data_contract_failed",
        "Artifact data does not satisfy data.schema.json",
        { diagnostics: dataValidation.diagnostics },
      );
    }
    const result = this.compiler.compile(snapshot.files["src/App.tsx"]);
    if (!result.ok) {
      throw new ApiError(422, "ui_artifact_compile_failed", "Artifact component could not be compiled", {
        diagnostics: result.diagnostics,
      });
    }

    const createdAt = new Date().toISOString();
    const styles = snapshot.manifest.runtime.styles ? snapshot.files["styles.css"] : "";
    const buildDigest = sha256(stableJson({
      bundle: result.bundle,
      manifest: snapshot.manifest,
      styles,
      data: snapshot.data,
      dataSchema: snapshot.dataSchema,
    }));
    const buildResult = uiArtifactBuildSchema.safeParse({
      protocol: "openwork.ui-artifact-build",
      schemaVersion: 2,
      slug,
      projectRevision: snapshot.projectRevision,
      buildDigest,
      status: "ready",
      compiler: result.compiler,
      bundleBytes: Buffer.byteLength(result.bundle, "utf8"),
      createdAt,
    });
    if (!buildResult.success) {
      throw new ApiError(500, "ui_artifact_build_invalid", "Compiler produced invalid build metadata");
    }
    return this.projects.saveBuild({
      protocol: "openwork.ui-artifact-pinned-build",
      schemaVersion: 2,
      build: buildResult.data,
      manifest: snapshot.manifest,
      bundle: result.bundle,
      styles,
      data: snapshot.data,
      dataSchema: snapshot.dataSchema,
    });
  }

  async publish(slug: string, request: UiArtifactPublishRequest): Promise<UiArtifactPublishReceipt> {
    const pinned = await this.build(slug, {
      expectedProjectRevision: request.expectedProjectRevision,
    });
    const instanceId = request.instanceId ?? randomUUID();
    const state = await this.states.initialize({
      workspaceId: this.workspaceId,
      slug,
      instanceId,
      projectRevision: pinned.build.projectRevision,
      state: request.initialState ?? {},
    });
    const attachment: UiArtifactAttachment = {
      protocol: "openwork.ui-artifact-attachment",
      schemaVersion: 2,
      workspaceId: this.workspaceId,
      slug,
      title: pinned.manifest.title,
      ...(pinned.manifest.description ? { description: pinned.manifest.description } : {}),
      projectRevision: pinned.build.projectRevision,
      buildDigest: pinned.build.buildDigest,
      instanceId,
      presentation: pinned.manifest.presentation,
      buildPath: `/workspace/${encodeURIComponent(this.workspaceId)}/ui-artifacts/${encodeURIComponent(slug)}/builds/${encodeURIComponent(pinned.build.projectRevision)}`,
      stateRevision: state.stateRevision,
    };
    return {
      protocol: "openwork.ui-artifact-publish-receipt",
      schemaVersion: 2,
      attachment,
      build: pinned.build,
      publishedAt: new Date().toISOString(),
    };
  }

  getBuild(slug: string, projectRevision: string): Promise<UiArtifactPinnedBuild> {
    return this.projects.getBuild(slug, projectRevision);
  }

  async getState(slug: string, instanceId: string): Promise<UiArtifactInstanceState> {
    const state = await this.states.get({
      workspaceId: this.workspaceId,
      slug,
      instanceId,
    });
    await this.projects.getBuild(slug, state.projectRevision);
    return state;
  }

  async updateState(
    slug: string,
    instanceId: string,
    update: UiArtifactStateUpdate,
  ): Promise<UiArtifactInstanceState> {
    const current = await this.states.get({
      workspaceId: this.workspaceId,
      slug,
      instanceId,
    });
    await this.projects.getBuild(slug, current.projectRevision);
    return this.states.update({
      workspaceId: this.workspaceId,
      slug,
      instanceId,
      expectedRevision: update.expectedRevision,
      state: update.state,
    });
  }

  async stageIntent(
    slug: string,
    instanceId: string,
    request: UiArtifactIntentRequest,
  ): Promise<UiArtifactIntentResult> {
    const parsedRequest = uiArtifactIntentRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new ApiError(400, "ui_artifact_intent_invalid", "Artifact intent request is invalid", {
        issues: parsedRequest.error.issues,
      });
    }
    const state = await this.states.get({
      workspaceId: this.workspaceId,
      slug,
      instanceId,
    });
    if (
      parsedRequest.data.expectedStateRevision
      && parsedRequest.data.expectedStateRevision !== state.stateRevision
    ) {
      return {
        protocol: "openwork.ui-artifact-intent-result",
        schemaVersion: 2,
        ok: false,
        intentId: parsedRequest.data.intentId,
        code: "state-conflict",
        message: "Artifact state changed before the intent could be staged",
        stateRevision: state.stateRevision,
      };
    }

    const pinned = await this.projects.getBuild(slug, state.projectRevision);
    const declaration = pinned.manifest.intents.find(
      (candidate) => candidate.id === parsedRequest.data.intentId,
    );
    if (!declaration) {
      return {
        protocol: "openwork.ui-artifact-intent-result",
        schemaVersion: 2,
        ok: false,
        intentId: parsedRequest.data.intentId,
        code: "unknown-intent",
        message: "This artifact did not declare the requested intent",
        stateRevision: state.stateRevision,
      };
    }
    if (!intentPayloadMatches(declaration, parsedRequest.data.payload)) {
      return {
        protocol: "openwork.ui-artifact-intent-result",
        schemaVersion: 2,
        ok: false,
        intentId: parsedRequest.data.intentId,
        code: "invalid-payload",
        message: "Intent payload does not match the declared arguments",
        stateRevision: state.stateRevision,
      };
    }

    const prompt = [
      "Stage this OpenWork artifact intent for the agent. Do not execute tools or external effects automatically.",
      `Artifact: ${pinned.manifest.title} (${slug})`,
      `Instance: ${instanceId}`,
      `Intent: ${declaration.title} (${declaration.id})`,
      `Description: ${declaration.description}`,
      `Effects: ${stableJson(declaration.effects)}`,
      `Confirmation policy: ${declaration.confirmation}`,
      `Payload: ${stableJson(parsedRequest.data.payload)}`,
      `Current state revision: ${state.stateRevision}`,
    ].join("\n");
    if (Buffer.byteLength(prompt, "utf8") > UI_ARTIFACT_MAX_INTENT_PROMPT_BYTES) {
      throw new ApiError(413, "ui_artifact_intent_too_large", "Staged artifact intent prompt exceeds its size limit");
    }
    return {
      protocol: "openwork.ui-artifact-intent-result",
      schemaVersion: 2,
      ok: true,
      intentId: declaration.id,
      requiresConfirmation: requiresIntentConfirmation(declaration),
      effects: declaration.effects,
      prompt,
      stateRevision: state.stateRevision,
    };
  }
}
