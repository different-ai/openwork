import type { ComposerAttachment, WorkspacePreset } from "../../../app/types";

export type CreateWorkspaceScreen = "chooser" | "local";

export type CreateWorkspaceOptions = {
  /** Saved as the first session's composer draft after the workspace is created. */
  firstTaskPrompt?: string | null;
  /** Seeded into the first session's composer with the draft, then sent by auto-send. */
  firstTaskAttachments?: ComposerAttachment[] | null;
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
  onConfirm: (preset: WorkspacePreset, folder: string | null, options?: CreateWorkspaceOptions) => void;
  onConfirmWorker?: (preset: WorkspacePreset, folder: string | null, options?: CreateWorkspaceOptions) => void;
  onPickFolder: () => Promise<string | null>;
  onImportConfig?: () => void;
  importingConfig?: boolean;
  submitting?: boolean;
  localError?: string | null;
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
