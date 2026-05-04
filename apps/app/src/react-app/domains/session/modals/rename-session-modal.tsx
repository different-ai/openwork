/** @jsxImportSource react */
import { useEffect, useRef } from "react";
import { X } from "lucide-react";

import { currentLocale, t } from "../../../../i18n";
import {
  inputClass,
  pillGhostClass,
  pillPrimaryClass,
  pillSecondaryClass,
} from "../../workspace/modal-styles";

export type RenameSessionModalProps = {
  open: boolean;
  title: string;
  busy: boolean;
  canSave: boolean;
  onClose: () => void;
  onSave: () => void;
  onTitleChange: (value: string) => void;
};

export function RenameSessionModal(props: RenameSessionModalProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const translate = (key: string) => t(key, currentLocale());

  useEffect(() => {
    if (!props.open) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [props.open]);

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 bg-gray-1/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-gray-2 border border-gray-6/70 w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
        <div className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-12">
                {translate("session.rename_title")}
              </h3>
              <p className="text-sm text-gray-11 mt-1">
                {translate("session.rename_description")}
              </p>
            </div>
            <button
              type="button"
              className={`${pillGhostClass} !p-2 rounded-full`}
              onClick={props.onClose}
            >
              <X size={16} />
            </button>
          </div>

          <div className="mt-6">
            <label className="mb-1.5 block text-[13px] font-medium text-dls-text">
              {translate("session.rename_label")}
            </label>
            <input
              ref={inputRef}
              type="text"
              value={props.title}
              onChange={(event) => props.onTitleChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.nativeEvent.isComposing ||
                  event.keyCode === 229
                )
                  return;
                event.preventDefault();
                if (props.canSave) props.onSave();
              }}
              placeholder={translate("session.rename_placeholder")}
              className={`${inputClass} bg-gray-3`}
            />
          </div>

          <div className="mt-6 flex justify-end gap-2">
            <button
              type="button"
              className={pillSecondaryClass}
              onClick={props.onClose}
              disabled={props.busy}
            >
              {translate("common.cancel")}
            </button>
            <button
              type="button"
              className={pillPrimaryClass}
              onClick={props.onSave}
              disabled={!props.canSave}
            >
              {translate("common.save")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
