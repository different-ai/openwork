/** @jsxImportSource react */
import {
  DenSettingsPanel,
  type DenSettingsPanelProps,
} from "../panels/den-settings-panel";

export type DenViewProps = DenSettingsPanelProps;

export function DenView(props: DenViewProps) {
  return (
    <section className="space-y-6 max-w-3xl w-full">
      <DenSettingsPanel {...props} />
    </section>
  );
}
