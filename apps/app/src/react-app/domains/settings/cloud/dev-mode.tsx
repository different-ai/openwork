/** @jsxImportSource react */
import { ArrowUpRight } from "lucide-react";

import { DEFAULT_DEN_BASE_URL } from "../../../../app/lib/den";
import { Button } from "@/components/ui/button";
import { TextInput } from "../../../design-system/text-input";
import { t } from "@/i18n";

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
  const controlsDisabled = [props.authBusy, props.sessionBusy].some(Boolean);

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
      <TextInput
        label={t("den.cloud_control_plane_url_label")}
        value={props.baseUrlDraft}
        onChange={(event) => props.onBaseUrlDraftChange(event.currentTarget.value)}
        placeholder={DEFAULT_DEN_BASE_URL}
        hint={t("den.cloud_control_plane_url_hint")}
        disabled={controlsDisabled}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={props.onResetBaseUrl}
          disabled={controlsDisabled}
        >
          {t("den.cloud_control_plane_reset")}
        </Button>
        <Button
          size="sm"
          onClick={props.onApplyBaseUrl}
          disabled={controlsDisabled}
        >
          {t("den.cloud_control_plane_save")}
        </Button>
        <Button variant="outline" size="sm" onClick={props.onOpenControlPlane}>
          {t("den.cloud_control_plane_open")}
          <ArrowUpRight size={13} />
        </Button>
      </div>
    </div>
  );
}
