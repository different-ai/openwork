import { t } from "@/i18n";
import { ControlPlaneUrlEditor } from "./control-plane-url-editor";

type CloudDevModeProps = {
  authBusy: boolean;
  baseUrlBusy: boolean;
  baseUrlDraft: string;
  onApplyBaseUrl: () => void | Promise<void>;
  onBaseUrlDraftChange: (value: string) => void;
  onOpenControlPlane: () => void;
  onResetBaseUrl: () => void | Promise<void>;
  sessionBusy: boolean;
};

export function CloudDevMode(props: CloudDevModeProps) {
  const controlsDisabled = [props.authBusy, props.baseUrlBusy, props.sessionBusy].some(Boolean);

  return (
    <ControlPlaneUrlEditor
      disabled={controlsDisabled}
      hint={t("den.cloud_control_plane_url_hint")}
      label={t("den.cloud_control_plane_url_label")}
      onOpenControlPlane={props.onOpenControlPlane}
      onReset={props.onResetBaseUrl}
      onSave={props.onApplyBaseUrl}
      onValueChange={props.onBaseUrlDraftChange}
      resetLabel={t("den.cloud_control_plane_reset")}
      saveLabel={t("den.cloud_control_plane_save")}
      value={props.baseUrlDraft}
    />
  );
}
