/** @jsxImportSource react */
import {
  DenSettingsPanel,
  type DenSettingsPanelProps,
} from "../panels/den-settings-panel";

export type DenViewProps = DenSettingsPanelProps;

export function DenView(props: DenViewProps) {
  return <DenSettingsPanel {...props} />;
}
