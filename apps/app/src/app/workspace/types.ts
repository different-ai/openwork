import type { DenTemplate } from "../lib/den";
import type { OpenworkWorkspaceExportWarning } from "../lib/openwork-server";
import type { WorkspacePreset } from "../types";

export type CreateWorkspaceScreen = "chooser" | "local" | "remote" | "shared";

export type RemoteWorkspaceInput = {
  openworkHostUrl?: string | null;
  openworkToken?: string | null;
  openworkClientToken?: string | null;
  openworkHostToken?: string | null;
  directory?: string | null;
  displayName?: string | null;
  closeModal?: boolean;
};

export type CreateWorkspaceProgress = {
  runId: string;
  startedAt: number;
  stage: string;
  error: string | null;
  steps: Array<{
    key: string;
    label: string;
    status: "pending" | "active" | "done" | "error";
    detail?: string | null;
  }>;
  logs: string[];
};

export type CreateWorkspaceModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (preset: WorkspacePreset, folder: string | null) => void;
  onConfirmRemote?: (input: RemoteWorkspaceInput) => Promise<boolean> | boolean | void;
  onConfirmWorker?: (preset: WorkspacePreset, folder: string | null) => void;
  onConfirmTemplate?: (
    template: DenTemplate,
    preset: WorkspacePreset,
    folder: string | null,
  ) => Promise<void> | void;
  onPickFolder: () => Promise<string | null>;
  onImportConfig?: () => void;
  importingConfig?: boolean;
  submitting?: boolean;
  remoteSubmitting?: boolean;
  remoteError?: string | null;
  inline?: boolean;
  showClose?: boolean;
  defaultPreset?: WorkspacePreset;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
  workerLabel?: string;
  workerDisabled?: boolean;
  workerDisabledReason?: string | null;
  workerCtaLabel?: string;
  workerCtaDescription?: string;
  onWorkerCta?: () => void;
  workerRetryLabel?: string;
  onWorkerRetry?: () => void;
  workerDebugLines?: string[];
  workerSubmitting?: boolean;
  submittingProgress?: CreateWorkspaceProgress | null;
  localDisabled?: boolean;
  localDisabledReason?: string | null;
};

export type CreateRemoteWorkspaceModalProps = {
  open: boolean;
  onClose: () => void;
  onConfirm: (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => void;
  initialValues?: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  };
  submitting?: boolean;
  error?: string | null;
  inline?: boolean;
  showClose?: boolean;
  title?: string;
  subtitle?: string;
  confirmLabel?: string;
};

export type ShareField = {
  label: string;
  value: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
};

export type ShareView =
  | "chooser"
  | "template"
  | "template-public"
  | "template-team"
  | "access";

export type ShareWorkspaceModalProps = {
  open: boolean;
  onClose: () => void;
  title?: string;
  workspaceName: string;
  workspaceDetail?: string | null;
  fields: ShareField[];
  remoteAccess?: {
    enabled: boolean;
    busy: boolean;
    error?: string | null;
    onSave: (enabled: boolean) => void | Promise<void>;
  };
  note?: string | null;
  onShareWorkspaceProfile?: () => void;
  shareWorkspaceProfileBusy?: boolean;
  shareWorkspaceProfileUrl?: string | null;
  shareWorkspaceProfileError?: string | null;
  shareWorkspaceProfileDisabledReason?: string | null;
  shareWorkspaceProfileSensitiveWarnings?: OpenworkWorkspaceExportWarning[] | null;
  shareWorkspaceProfileSensitiveMode?: "include" | "exclude" | null;
  onShareWorkspaceProfileSensitiveModeChange?: (mode: "include" | "exclude") => void;
  onShareWorkspaceProfileToTeam?: (name: string) => void | Promise<void>;
  shareWorkspaceProfileToTeamBusy?: boolean;
  shareWorkspaceProfileToTeamError?: string | null;
  shareWorkspaceProfileToTeamSuccess?: string | null;
  shareWorkspaceProfileToTeamDisabledReason?: string | null;
  shareWorkspaceProfileToTeamOrgName?: string | null;
  shareWorkspaceProfileToTeamNeedsSignIn?: boolean;
  onShareWorkspaceProfileToTeamSignIn?: () => void | Promise<void>;
  templateContentSummary?: {
    skillNames: string[];
    commandNames: string[];
    configFiles: string[];
  } | null;
  onShareSkillsSet?: () => void;
  shareSkillsSetBusy?: boolean;
  shareSkillsSetUrl?: string | null;
  shareSkillsSetError?: string | null;
  shareSkillsSetDisabledReason?: string | null;
  onExportConfig?: () => void;
  exportDisabledReason?: string | null;
  onOpenBots?: () => void;
};
