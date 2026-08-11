/** @jsxImportSource react */
import { MonitorSmartphone } from "lucide-react";

import { surfaceCardClass } from "../workspace/modal-styles";
import { t } from "@/i18n";
import { registerExtensionConfig } from "./extension-registry";

const openWorkBrowserConfigFactory = () => <OpenWorkBrowserConfig />;

registerExtensionConfig("openwork.browser.settings", openWorkBrowserConfigFactory);
registerExtensionConfig("openwork-browser", openWorkBrowserConfigFactory);

function OpenWorkBrowserConfig() {
  return (
    <div className={`${surfaceCardClass} space-y-3 p-4`}>
      <div className="flex items-start gap-3">
        <MonitorSmartphone className="mt-0.5 size-4 shrink-0 text-blue-11" />
        <div className="space-y-1 text-[13px] leading-relaxed text-dls-secondary">
          <div className="font-medium text-dls-text">{t("browser_extension.ready_by_default")}</div>
          <div>{t("browser_extension.desc")}</div>
        </div>
      </div>
    </div>
  );
}
