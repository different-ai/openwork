import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiArtifactProjectManifestSchema } from "@openwork/types/ui-artifact-project";
import { FilesystemArtifactProjectRepository } from "./filesystem-repository.js";
import { createArtifactProjectService } from "./index.js";
import { SafeJsonSchemaDataValidator } from "./json-schema-validator.js";
import { TypeScriptArtifactCompiler } from "./typescript-compiler.js";

const SLUG = "launch-radar";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifest(): string {
  return JSON.stringify({
    protocol: "openwork.ui-artifact-project",
    schemaVersion: 2,
    apiVersion: 1,
    slug: SLUG,
    title: "Launch Radar",
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
      shape: "collection",
    },
    intents: [{
      id: "launch.watch",
      title: "Watch launch",
      description: "Stage a request to watch a launch",
      arguments: [{
        name: "launchId",
        type: "string",
        required: true,
      }],
      effects: {
        data: "write",
        ui: "focus",
        external: false,
      },
      confirmation: "destructive",
    }],
  }, null, 2);
}

async function withWorkspace(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "openwork-ui-artifacts-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createLaunchRadar(root: string, options: { enableBuilder?: boolean } = {}) {
  const service = createArtifactProjectService({ workspaceRoot: root, workspaceId: "ws_test" });
  const snapshot = await service.putFile(SLUG, {
    file: "artifact.json",
    content: manifest(),
    expectedRevision: null,
  });
  if (options.enableBuilder !== false) {
    const settings = await service.getSettings();
    await service.updateSettings({
      expectedRevision: settings.settingsRevision,
      builderSkillEnabled: true,
    });
  }
  return { service, snapshot };
}

describe("dynamic artifact projects", () => {
  test("enforces host-owned chat shapes and their action budgets", () => {
    const collection = JSON.parse(manifest()) as Record<string, unknown>;
    expect(uiArtifactProjectManifestSchema.safeParse(collection).success).toBe(true);

    const arbitraryDimensions = {
      ...collection,
      presentation: {
        placement: "both",
        preferredWidth: "full",
        preferredHeight: 2_000,
        resizable: true,
      },
    };
    expect(uiArtifactProjectManifestSchema.safeParse(arbitraryDimensions).success).toBe(false);

    const declaredIntent = (collection.intents as Array<Record<string, unknown>>)[0]!;
    const metricWithTwoActions = {
      ...collection,
      presentation: { placement: "both", shape: "metric" },
      intents: [
        declaredIntent,
        { ...declaredIntent, id: "launch.watch-second" },
      ],
    };
    expect(uiArtifactProjectManifestSchema.safeParse(metricWithTwoActions).success).toBe(false);
  });

  test("persists fixed files and reloads the same revision", async () => {
    await withWorkspace(async (root) => {
      const { snapshot } = await createLaunchRadar(root);
      const reloaded = await new FilesystemArtifactProjectRepository(root).get(SLUG);
      expect(reloaded.projectRevision).toBe(snapshot.projectRevision);
      expect(reloaded.manifest.title).toBe("Launch Radar");
      expect(reloaded.files["src/App.tsx"]).toContain("export default");
    });
  });

  test("applies coordinated five-file edits once and preserves pinned builds", async () => {
    await withWorkspace(async (root) => {
      const { service, snapshot } = await createLaunchRadar(root);
      const pinned = await service.build(SLUG);
      const updatePromise = service.putProject(SLUG, {
        expectedRevision: snapshot.projectRevision,
        files: {
          ...snapshot.files,
          "data.json": JSON.stringify({ countdown: "three" }),
          "data.schema.json": JSON.stringify({
            type: "object",
            properties: { countdown: { type: "string" } },
            required: ["countdown"],
            additionalProperties: false,
          }),
        },
      });
      const readPromise = service.get(SLUG);
      const [updated, observed] = await Promise.all([updatePromise, readPromise]);
      expect(updated.data).toEqual({ countdown: "three" });
      expect(updated.projectRevision).not.toBe(snapshot.projectRevision);
      expect(observed.projectRevision).toBe(updated.projectRevision);
      expect((await service.getBuild(SLUG, pinned.build.projectRevision)).build.buildDigest)
        .toBe(pinned.build.buildDigest);
    });
  });

  test("keeps pinned builds immutable when source data changes", async () => {
    await withWorkspace(async (root) => {
      const { service, snapshot } = await createLaunchRadar(root);
      const first = await service.build(SLUG, { expectedProjectRevision: snapshot.projectRevision });
      const changed = await service.putFile(SLUG, {
        file: "data.json",
        content: JSON.stringify({ label: "Changed", message: "Customize this compact summary." }),
        expectedRevision: snapshot.projectRevision,
      });
      const second = await service.build(SLUG, { expectedProjectRevision: changed.projectRevision });
      const pinned = await service.getBuild(SLUG, first.build.projectRevision);

      expect(second.build.projectRevision).not.toBe(first.build.projectRevision);
      expect(pinned.build.buildDigest).toBe(first.build.buildDigest);
      expect(pinned.data).toEqual({ label: "Ready", message: "Customize this compact summary." });

      const metadataPath = join(
        root,
        ".opencode",
        "openwork",
        "artifact-builds",
        SLUG,
        first.build.projectRevision,
        "build.json",
      );
      const metadata: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
      if (!isRecord(metadata)) throw new Error("Expected build metadata object");
      metadata.styles = "main { display: none; }";
      await writeFile(metadataPath, JSON.stringify(metadata), "utf8");
      await expect(service.getBuild(SLUG, first.build.projectRevision)).rejects.toMatchObject({
        code: "ui_artifact_build_invalid",
      });
    });
  });

  test("validates data against the bounded JSON Schema adapter before build", async () => {
    await withWorkspace(async (root) => {
      const { service, snapshot } = await createLaunchRadar(root);
      const schemaSnapshot = await service.putFile(SLUG, {
        file: "data.schema.json",
        content: JSON.stringify({
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        }),
        expectedRevision: snapshot.projectRevision,
      });
      const invalidData = await service.putFile(SLUG, {
        file: "data.json",
        content: JSON.stringify({ title: 42 }),
        expectedRevision: schemaSnapshot.projectRevision,
      });
      await expect(service.build(SLUG, {
        expectedProjectRevision: invalidData.projectRevision,
      })).rejects.toMatchObject({
        code: "ui_artifact_data_contract_failed",
      });
    });
  });

  test("JSON Schema required checks ignore inherited object properties", () => {
    const result = new SafeJsonSchemaDataValidator().validate({
      type: "object",
      required: ["toString"],
    }, {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        keyword: "required",
        path: "/toString",
      }));
    }
  });

  test("rejects imports, dynamic imports, network, navigation, and DOM escape hatches", () => {
    const compiler = new TypeScriptArtifactCompiler();
    const result = compiler.compile([
      "import React from \"react\"",
      "const module = import(\"elsewhere\")",
      "const value = require(\"package\")",
      "fetch(\"https://example.com\")",
      "new WebSocket(\"wss://example.com\")",
      "window.location.href = \"https://example.com/leak\"",
      "document.createElement(\"iframe\")",
      "export default function Artifact() { return <iframe>{module}{value}</iframe> }",
    ].join("\n"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(91001);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(91003);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(91004);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(91007);
    }
  });

  test("requires a component default export and rejects obvious unbounded execution", () => {
    const compiler = new TypeScriptArtifactCompiler();
    const result = compiler.compile([
      "while (true) {}",
      "const value = ({})['constructor'];",
      "export default 42;",
    ].join("\n"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(91004);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(91009);
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(91010);
    }
  });

  test("rejects traversal slugs and symlinked project roots", async () => {
    await withWorkspace(async (root) => {
      const repository = new FilesystemArtifactProjectRepository(root);
      await expect(repository.get("../escape")).rejects.toMatchObject({
        code: "ui_artifact_slug_invalid",
      });

      const projectsRoot = join(root, ".opencode", "openwork", "artifacts");
      const outside = await mkdtemp(join(tmpdir(), "openwork-ui-artifact-outside-"));
      try {
        await mkdir(projectsRoot, { recursive: true });
        await writeFile(join(outside, "artifact.json"), manifest(), "utf8");
        await symlink(outside, join(projectsRoot, SLUG), "dir");
        await expect(repository.get(SLUG)).rejects.toMatchObject({
          code: "ui_artifact_symlink_rejected",
        });
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  test("enforces optimistic state revisions", async () => {
    await withWorkspace(async (root) => {
      const { service } = await createLaunchRadar(root);
      const receipt = await service.publish(SLUG, {
        instanceId: "launch-instance",
        initialState: { watching: false },
      });
      const originalRevision = receipt.attachment.stateRevision;
      const updated = await service.updateState(SLUG, "launch-instance", {
        expectedRevision: originalRevision,
        state: { watching: true },
      });
      expect(updated.state).toEqual({ watching: true });
      await expect(service.updateState(SLUG, "launch-instance", {
        expectedRevision: originalRevision,
        state: { watching: false },
      })).rejects.toMatchObject({
        code: "ui_artifact_state_conflict",
      });
    });
  });

  test("does not move an existing instance across pinned project revisions", async () => {
    await withWorkspace(async (root) => {
      const { service, snapshot } = await createLaunchRadar(root);
      await service.publish(SLUG, { instanceId: "pinned-instance" });
      const changed = await service.putFile(SLUG, {
        file: "styles.css",
        content: "main { color: rebeccapurple; }\n",
        expectedRevision: snapshot.projectRevision,
      });
      await expect(service.publish(SLUG, {
        instanceId: "pinned-instance",
        expectedProjectRevision: changed.projectRevision,
      })).rejects.toMatchObject({
        code: "ui_artifact_instance_revision_conflict",
      });
      const original = await service.getState(SLUG, "pinned-instance");
      expect(original.projectRevision).toBe(snapshot.projectRevision);
    });
  });

  test("stages only allowlisted intents as prompts without executing effects", async () => {
    await withWorkspace(async (root) => {
      const { service } = await createLaunchRadar(root);
      await service.publish(SLUG, { instanceId: "intent-instance" });
      const unknown = await service.stageIntent(SLUG, "intent-instance", {
        intentId: "launch.delete",
        payload: {},
      });
      expect(unknown).toMatchObject({ ok: false, code: "unknown-intent" });

      const invalid = await service.stageIntent(SLUG, "intent-instance", {
        intentId: "launch.watch",
        payload: { launchId: 42 },
      });
      expect(invalid).toMatchObject({ ok: false, code: "invalid-payload" });

      const staged = await service.stageIntent(SLUG, "intent-instance", {
        intentId: "launch.watch",
        payload: { launchId: "launch-1" },
      });
      expect(staged).toMatchObject({
        ok: true,
        intentId: "launch.watch",
        requiresConfirmation: true,
      });
      if (staged.ok) {
        expect(staged.prompt).toContain("Do not execute tools or external effects automatically");
        expect(staged.prompt).toContain("\"launchId\":\"launch-1\"");
      }
    });
  });

  test("persists managed skill and project enablement while preserving pinned cards", async () => {
    await withWorkspace(async (root) => {
      const { service } = await createLaunchRadar(root, { enableBuilder: false });
      const defaults = await service.getSettings();
      expect(defaults).toMatchObject({
        builderSkillEnabled: false,
        projectOverrides: {},
        updatedAt: null,
      });
      expect((await service.get(SLUG)).enabled).toBe(true);
      await expect(service.getAgentSkill()).rejects.toMatchObject({
        code: "ui_artifact_builder_skill_disabled",
      });
      await expect(service.build(SLUG)).rejects.toMatchObject({
        code: "ui_artifact_builder_skill_disabled",
      });
      await expect(service.publish(SLUG, {})).rejects.toMatchObject({
        code: "ui_artifact_builder_skill_disabled",
      });

      const skillEnabled = await service.updateSettings({
        expectedRevision: defaults.settingsRevision,
        builderSkillEnabled: true,
      });
      const skill = await service.getAgentSkill();
      expect(skill.name).toBe("openwork-react-artifact-builder");
      expect(skill.content.startsWith("---\nname: openwork-react-artifact-builder\n")).toBe(true);
      expect(skill.content).toContain("# React Artifact Builder");
      expect(skill.content).toContain("You are not designing a web page");
      expect(skill.content).toContain("presentation.shape");
      expect(skill.content).toContain("Show no more than 5 visible rows");
      expect(skill.content).toContain("never bypass, rewrite, or silently toggle the setting");
      expect(skill.settingsRevision).toBe(skillEnabled.settingsRevision);
      const receipt = await service.publish(SLUG, {
        instanceId: "settings-instance",
        initialState: { watching: false },
      });

      const projectDisabled = await service.updateSettings({
        expectedRevision: skillEnabled.settingsRevision,
        project: { slug: SLUG, enabled: false },
      });
      expect(projectDisabled.projectOverrides).toEqual({ [SLUG]: false });
      expect((await service.get(SLUG)).enabled).toBe(false);
      expect((await service.list())[0]?.enabled).toBe(false);
      await expect(service.build(SLUG)).rejects.toMatchObject({
        code: "ui_artifact_project_disabled",
      });
      await expect(service.publish(SLUG, {})).rejects.toMatchObject({
        code: "ui_artifact_project_disabled",
      });
      await expect(service.updateSettings({
        expectedRevision: defaults.settingsRevision,
        project: { slug: SLUG, enabled: true },
      })).rejects.toMatchObject({
        code: "ui_artifact_settings_conflict",
      });

      await rm(join(root, ".opencode", "openwork", "artifacts", SLUG), {
        recursive: true,
        force: true,
      });
      expect((await service.getBuild(SLUG, receipt.build.projectRevision)).build.buildDigest)
        .toBe(receipt.build.buildDigest);
      const state = await service.getState(SLUG, "settings-instance");
      const updated = await service.updateState(SLUG, "settings-instance", {
        expectedRevision: state.stateRevision,
        state: { watching: true },
      });
      expect(updated.state).toEqual({ watching: true });
      expect(await service.stageIntent(SLUG, "settings-instance", {
        intentId: "launch.watch",
        payload: { launchId: "launch-1" },
      })).toMatchObject({ ok: true });

      const reloaded = createArtifactProjectService({ workspaceRoot: root, workspaceId: "ws_test" });
      expect((await reloaded.getSettings()).settingsRevision).toBe(projectDisabled.settingsRevision);
    });
  });
});
