/** @jsxImportSource react */
import { ArrowUpRight } from "lucide-react";

import { DEFAULT_DEN_BASE_URL } from "@/app/lib/den";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { TextInput } from "../../../design-system/text-input";

type ControlPlaneUrlEditorProps = {
  disabled: boolean;
  hint: string;
  label: string;
  onReset: () => void | Promise<void>;
  onSave: () => void | Promise<void>;
  onValueChange: (value: string) => void;
  value: string;
  onOpenControlPlane?: () => void;
  placeholder?: string;
  resetDisabled?: boolean;
  resetLabel?: string;
  saveDisabled?: boolean;
  saveLabel?: string;
};

export function ControlPlaneUrlEditor(props: ControlPlaneUrlEditorProps) {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <TextInput
        label={props.label}
        value={props.value}
        onChange={(event) => props.onValueChange(event.currentTarget.value)}
        placeholder={props.placeholder ?? DEFAULT_DEN_BASE_URL}
        hint={props.hint}
        disabled={props.disabled}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void props.onReset()}
          disabled={props.disabled || props.resetDisabled === true}
        >
          {props.resetLabel ?? t("den.cloud_control_plane_reset")}
        </Button>
        <Button
          size="sm"
          onClick={() => void props.onSave()}
          disabled={props.disabled || props.saveDisabled === true}
        >
          {props.saveLabel ?? t("den.cloud_control_plane_save")}
        </Button>
        {props.onOpenControlPlane ? (
          <Button variant="outline" size="sm" onClick={props.onOpenControlPlane}>
            {t("den.cloud_control_plane_open")}
            <ArrowUpRight size={13} />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
