import type { OpenworkWorkspaceExport } from "../lib/openwork-server";
import type { WorkspacePreset } from "../types";

export type SkillBundleItem = {
  name: string;
  description?: string;
  content: string;
  trigger?: string;
};

export type SkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  description?: string;
  trigger?: string;
  content: string;
};

export type SkillsSetBundleV1 = {
  schemaVersion: 1;
  type: "skills-set";
  name: string;
  description?: string;
  skills: SkillBundleItem[];
};

export type WorkspaceProfileBundleV1 = {
  schemaVersion: 1;
  type: "workspace-profile";
  name: string;
  description?: string;
  workspace: OpenworkWorkspaceExport;
};

export type BundleV1 = SkillBundleV1 | SkillsSetBundleV1 | WorkspaceProfileBundleV1;

export type BundleImportIntent = "new_worker" | "import_current";

export type BundleRequest = {
  bundleUrl?: string | null;
  intent: BundleImportIntent;
  source?: string;
  label?: string;
};

export type BundleImportTarget = {
  workspaceId?: string | null;
  localRoot?: string | null;
  directoryHint?: string | null;
};

export type BundleCreateWorkspaceRequest = {
  request: BundleRequest;
  bundle: BundleV1;
  defaultPreset: WorkspacePreset;
};

export type BundleStartRequest = {
  request: BundleRequest;
  bundle: WorkspaceProfileBundleV1;
  defaultPreset: WorkspacePreset;
};

export type SkillDestinationRequest = {
  request: BundleRequest;
  bundle: SkillBundleV1;
};

export type SkillSuccessToast = {
  title: string;
  description: string;
};

export type BundleImportChoice = {
  request: BundleRequest;
  bundle: BundleV1;
};

export type BundleWorkerOption = {
  id: string;
  label: string;
  detail: string;
  badge: string;
  current: boolean;
  disabledReason?: string | null;
};

export type BundleImportSummary = {
  title: string;
  description: string;
  items: string[];
};
