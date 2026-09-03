import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import vitestConfig from "../vitest.config.ts";
import { isQuarantined, listQuarantined } from "../scripts/quarantine.mjs";

const quarantinePath = fileURLToPath(new URL("./quarantine.json", import.meta.url));
const specsDirectory = fileURLToPath(new URL("./", import.meta.url));
const singlesScript = fileURLToPath(new URL("../scripts/list-singles-tests.mjs", import.meta.url));
const categories = new Set(["unmigrated", "pre-existing-red", "product-finding", "needs-topology"]);
const evidenceCategories = new Set(["pre-existing-red", "product-finding"]);
const expectedEnabled = `
active-session-workspace-storm.e2e.test.ts
app-den-tls-fault.e2e.test.ts
app-smoke.e2e.test.ts
artifact-code-browser.e2e.test.ts
attachment-upload-loading-state.e2e.test.ts
automation-revision-revert.e2e.test.ts
chat-loading-shimmer.e2e.test.ts
cloud-provider-local-credential-fallback.e2e.test.ts
cloud-provider-sync-contract.e2e.test.ts
compatible-release-picker.e2e.test.ts
composer-connections-menu.e2e.test.ts
composer-draft-reload.e2e.test.ts
composer-model-picker-no-subscribe-promo.e2e.test.ts
config-object-large-skill.e2e.test.ts
connect-readiness-preseeded.e2e.test.ts
connector-tool-call-branding.e2e.test.ts
cross-server-handoff-atomic-commit.e2e.test.ts
cross-workspace-split-view.e2e.test.ts
first-run-cloud-share.e2e.test.ts
first-run-local.e2e.test.ts
library-add-connector-discovery.e2e.test.ts
library-signed-in-render-stability.e2e.test.ts
live-tool-visible-after-session-switch.e2e.test.ts
llm-provider-access-parity.e2e.test.ts
org-api-key-authenticates.e2e.test.ts
org-model-analytics.e2e.test.ts
org-team-lifecycle-critical-path.e2e.test.ts
parent-child-permission-approval.e2e.test.ts
reliable-app-recovery.e2e.test.ts
responsive-session-layout.e2e.test.ts
saved-script-automations.e2e.test.ts
sidebar-title-overflow-fade.e2e.test.ts
task-activity-shimmer.e2e.test.ts
two-daytona-desktops.e2e.test.ts
unfinished-tool-lifecycle.e2e.test.ts
welcome-one-field.e2e.test.ts
workspace-new-task-hit-target.e2e.test.ts
workspace-storm-auth-coherence.e2e.test.ts
`.trim().split("\n");

interface QuarantineEntry {
  spec: string;
  category: string;
  reason: string;
  evidence?: string;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return value;
}

function quarantineManifest(): { version: number; entries: QuarantineEntry[] } {
  const manifest = objectValue(JSON.parse(readFileSync(quarantinePath, "utf8")), "quarantine manifest");
  const version = Reflect.get(manifest, "version");
  const rawEntries = Reflect.get(manifest, "entries");
  if (typeof version !== "number" || !Array.isArray(rawEntries)) {
    throw new Error("quarantine manifest must have a numeric version and entries array");
  }
  const entries = rawEntries.map((rawEntry, index) => {
    const entry = objectValue(rawEntry, `quarantine entry ${index}`);
    const spec = Reflect.get(entry, "spec");
    const category = Reflect.get(entry, "category");
    const reason = Reflect.get(entry, "reason");
    const evidence = Reflect.get(entry, "evidence");
    if (typeof spec !== "string" || typeof category !== "string" || typeof reason !== "string") {
      throw new Error(`quarantine entry ${index} must have spec, category, and reason strings`);
    }
    if (evidence !== undefined && typeof evidence !== "string") {
      throw new Error(`quarantine entry ${index} evidence must be a string`);
    }
    return { spec, category, reason, evidence };
  });
  return { version, entries };
}

function configuredE2eExcludes(config: unknown): string[] {
  const root = objectValue(config, "vitest config");
  const rootTest = objectValue(Reflect.get(root, "test"), "vitest config test");
  const projects = Reflect.get(rootTest, "projects");
  if (!Array.isArray(projects)) throw new Error("vitest config test.projects must be an array");

  for (const rawProject of projects) {
    const project = objectValue(rawProject, "vitest project");
    const projectTest = objectValue(Reflect.get(project, "test"), "vitest project test");
    if (Reflect.get(projectTest, "name") === "e2e") {
      return stringArray(Reflect.get(projectTest, "exclude"), "e2e project exclude");
    }
  }
  throw new Error("vitest config has no e2e project");
}

test("the quarantine manifest is complete and reviewable", ({ evidence }) => {
  const { version, entries } = quarantineManifest();
  const specs = entries.map((entry) => entry.spec);
  const missingFiles = specs.filter((spec) => !existsSync(new URL(spec, new URL("./", import.meta.url))));
  const duplicates = specs.filter((spec, index) => specs.indexOf(spec) !== index);
  const invalidCategories = entries.filter((entry) => !categories.has(entry.category));
  const emptyReasons = entries.filter((entry) => entry.reason.trim().length === 0);
  const missingEvidence = entries.filter((entry) => evidenceCategories.has(entry.category) && !entry.evidence?.trim());

  expect(version).toBe(1);
  expect(missingFiles).toEqual([]);
  expect(duplicates).toEqual([]);
  expect(invalidCategories).toEqual([]);
  expect(emptyReasons).toEqual([]);
  expect(missingEvidence).toEqual([]);
  expect(specs).toEqual([...specs].sort());
  expect(listQuarantined()).toEqual(specs);
  expect(specs.every((spec) => isQuarantined(spec))).toBe(true);

  evidence.recordAssertionEvidence(
    "Every quarantined E2E spec is explicit and reviewable",
    `All ${entries.length} sorted entries name existing files, use an allowed category, carry a reason, and include required control or product evidence.`,
    true,
  );
});

test("all E2E selectors exclude exactly the quarantine", ({ evidence }) => {
  const quarantined = listQuarantined();
  const configured = configuredE2eExcludes(vitestConfig).map((pattern) => basename(pattern)).sort();
  const singles = execFileSync(process.execPath, [singlesScript], { encoding: "utf8" })
    .split("\n")
    .filter((name) => name.length > 0);
  const quarantinedSingles = singles.filter((name) => isQuarantined(name));

  expect(configured).toEqual(quarantined);
  expect(quarantinedSingles).toEqual([]);

  evidence.recordAssertionEvidence(
    "Vitest and Daytona singles select only trusted E2E specs",
    `The E2E project's ${configured.length} resolved excludes equal quarantine.json, and the singles CLI emitted no quarantined spec.`,
    true,
  );
});

test("the enabled E2E set equals the evidence-backed inventory", ({ evidence }) => {
  const allE2e = readdirSync(specsDirectory)
    .filter((name) => name.endsWith(".e2e.test.ts"))
    .sort();
  const enabled = allE2e.filter((name) => !isQuarantined(name));

  expect(enabled).toEqual(expectedEnabled);
  expect(enabled).toHaveLength(allE2e.length - listQuarantined().length);

  evidence.recordAssertionEvidence(
    "The trusted E2E suite equals the evidence-backed inventory",
    `Exactly ${enabled.length} branch-verified, scheduled-CI-green, or nightly-green E2E specs remain enabled.`,
    true,
  );
});
