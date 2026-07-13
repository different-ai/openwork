/** @jsxImportSource react */
import { MonitorSmartphone } from "lucide-react";

import { surfaceCardClass } from "../workspace/modal-styles";
import type {
  ExtensionConfigFactory,
  SettingsExtensionDescriptor,
  SettingsExtensionReadyBinding,
  SettingsExtensionRegistration,
} from "./extension-registry";

export const openWorkBrowserConfigFactory: ExtensionConfigFactory = () => <OpenWorkBrowserConfig />;

export const openWorkBrowserSettingsDescriptor = {
  id: "openwork-browser",
  kind: "app.settings-extension",
  contractVersion: 1,
  provenance: { packageName: "@openwork/app", source: "builtin" },
  order: 400,
  settingsPanelRefs: ["openwork.browser.settings", "openwork-browser"],
  connectionRefs: [],
} as const satisfies SettingsExtensionDescriptor;

export const openWorkBrowserSettingsBinding = {
  status: "ready",
  create: () => ({ settingsPanel: openWorkBrowserConfigFactory }),
} as const satisfies SettingsExtensionReadyBinding;

export const openWorkBrowserSettingsContribution = {
  descriptor: openWorkBrowserSettingsDescriptor,
  binding: openWorkBrowserSettingsBinding,
} as const satisfies SettingsExtensionRegistration;

function OpenWorkBrowserConfig() {
  return (
    <div className={`${surfaceCardClass} space-y-3 p-4`}>
      <div className="flex items-start gap-3">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-blue-11" />
        <div className="space-y-1 text-[13px] leading-relaxed text-dls-secondary">
          <div className="font-medium text-dls-text">Ready by default</div>
          <div>The OpenWork Browser runs inside the app, opens visibly for browser tasks, and is the supported browser automation path in OpenWork.</div>
        </div>
      </div>
    </div>
  );
}
