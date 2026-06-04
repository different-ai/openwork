import type { WorkspacePreset } from "../../../app/types";

export type CreateWorkspaceScreen = "chooser" | "local" | "remote";

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
  onPickFolder: () => Promise<string | null>;
  onImportConfig?: () => void;
  importingConfig?: boolean;
  submitting?: boolean;
  localError?: string | null;
  remoteSubmitting?: boolean;
  remoteError?: string | null;
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

export type ShareView = "chooser" | "access";

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
    status?: string | null;
    onSave: (enabled: boolean) => void | Promise<void>;
  };
  note?: string | null;
  onExportConfig?: () => void;
  exportDisabledReason?: string | null;
};
