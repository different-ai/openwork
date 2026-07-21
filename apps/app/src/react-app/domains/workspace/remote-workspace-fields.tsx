/** @jsxImportSource react */
import type { Ref } from "react";
import { Globe } from "lucide-react";
import { t } from "../../../i18n";

import {
  iconTileClass,
  inputClass,
  inputHintClass,
  inputLabelClass,
  pillSecondaryClass,
  surfaceCardClass,
} from "./modal-styles";

export type RemoteWorkspaceFieldsProps = {
  hostUrl: string;
  onHostUrlInput: (value: string) => void;
  token: string;
  tokenVisible: boolean;
  onTokenInput: (value: string) => void;
  onToggleTokenVisible: () => void;
  displayName: string;
  onDisplayNameInput: (value: string) => void;
  directory?: string;
  onDirectoryInput?: (value: string) => void;
  showDirectory?: boolean;
  submitting?: boolean;
  hostInputRef?: Ref<HTMLInputElement>;
  title: string;
  description: string;
};

export function RemoteWorkspaceFields({
  hostUrl,
  onHostUrlInput,
  token,
  tokenVisible,
  onTokenInput,
  onToggleTokenVisible,
  displayName,
  onDisplayNameInput,
  directory,
  onDirectoryInput,
  showDirectory,
  submitting,
  hostInputRef,
  title,
  description,
}: RemoteWorkspaceFieldsProps) {
  return (
    <div className={surfaceCardClass}>
      <div className="flex items-start gap-3">
        <div className={iconTileClass}>
          <Globe size={17} />
        </div>
        <div className="min-w-0">
          <div className="text-[15px] font-medium tracking-[-0.2px] text-dls-text">
            {title}
          </div>
          <div className="mt-1 text-[13px] leading-relaxed text-dls-secondary">
            {description}
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-4">
        <label className="grid gap-2">
          <span className={inputLabelClass}>{t("remote_fields.worker_url")}</span>
          <input
            ref={hostInputRef}
            type="url"
            value={hostUrl}
            onChange={(event) => onHostUrlInput(event.currentTarget.value)}
            placeholder="https://worker.example.com"
            disabled={submitting}
            className={inputClass}
          />
          <span className={inputHintClass}>
            {t("remote_fields.worker_url_hint")}
          </span>
        </label>

        <label className="grid gap-2">
          <span className={inputLabelClass}>{t("remote_fields.access_token")}</span>
          <div className="flex items-center gap-2 rounded-xl border border-dls-border bg-dls-surface p-1.5">
            <input
              type={tokenVisible ? "text" : "password"}
              value={token}
              onChange={(event) => onTokenInput(event.currentTarget.value)}
              placeholder={t("remote_fields.optional_placeholder")}
              disabled={submitting}
              className="min-w-0 flex-1 border-none bg-transparent px-2 py-1.5 text-[14px] text-dls-text outline-none placeholder:text-dls-secondary"
            />
            <button
              type="button"
              className={pillSecondaryClass}
              onClick={onToggleTokenVisible}
              disabled={submitting}
            >
              {tokenVisible ? t("common.hide") : t("common.show")}
            </button>
          </div>
          <span className={inputHintClass}>
            {t("remote_fields.access_token_hint")}
          </span>
        </label>

        {showDirectory ? (
          <label className="grid gap-2">
            <span className={inputLabelClass}>{t("remote_fields.remote_directory")}</span>
            <input
              type="text"
              value={directory ?? ""}
              onChange={(event) => onDirectoryInput?.(event.currentTarget.value)}
              placeholder={t("remote_fields.optional_placeholder")}
              disabled={submitting}
              className={inputClass}
            />
            <span className={inputHintClass}>
              {t("remote_fields.remote_directory_hint")}
            </span>
          </label>
        ) : null}

        <label className="grid gap-2">
          <span className={inputLabelClass}>
            {t("remote_fields.display_name")}{" "}
            <span className="font-normal text-dls-secondary">{t("remote_fields.optional")}</span>
          </span>
          <input
            type="text"
            value={displayName}
            onChange={(event) => onDisplayNameInput(event.currentTarget.value)}
            placeholder={t("remote_fields.display_name")}
            disabled={submitting}
            className={inputClass}
          />
        </label>
      </div>
    </div>
  );
}
