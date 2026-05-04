/** @jsxImportSource react */
import { ArrowUpRight } from "lucide-react";

import { DEFAULT_DEN_BASE_URL } from "../../../../app/lib/den";
import { Button } from "../../../design-system/button";
import { TextInput } from "../../../design-system/text-input";
import { useTranslate } from "@/hooks/use-translate";

type CloudDevModeProps = {
  authBusy: boolean;
  baseUrlDraft: string;
  onApplyBaseUrl: () => void;
  onBaseUrlDraftChange: (value: string) => void;
  onOpenControlPlane: () => void;
  onResetBaseUrl: () => void;
  sessionBusy: boolean;
};

export function CloudDevMode(props: CloudDevModeProps) {
  const { tr } = useTranslate();
  const controlsDisabled = [props.authBusy, props.sessionBusy].some(Boolean);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <TextInput
        label={tr("den.cloud_control_plane_url_label")}
        value={props.baseUrlDraft}
        onChange={(event) => props.onBaseUrlDraftChange(event.currentTarget.value)}
        placeholder={DEFAULT_DEN_BASE_URL}
        hint={tr("den.cloud_control_plane_url_hint")}
        disabled={controlsDisabled}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          className="h-9 px-3 text-xs"
          onClick={props.onResetBaseUrl}
          disabled={controlsDisabled}
        >
          {tr("den.cloud_control_plane_reset")}
        </Button>
        <Button
          variant="secondary"
          className="h-9 px-3 text-xs"
          onClick={props.onApplyBaseUrl}
          disabled={controlsDisabled}
        >
          {tr("den.cloud_control_plane_save")}
        </Button>
        <Button variant="outline" className="h-9 px-3 text-xs" onClick={props.onOpenControlPlane}>
          {tr("den.cloud_control_plane_open")}
          <ArrowUpRight size={13} />
        </Button>
      </div>
    </div>
  );
}
