/** @jsxImportSource react */
import { MonitorSmartphone } from "lucide-react";

import { surfaceCardClass } from "../workspace/modal-styles";
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
          <div className="font-medium text-dls-text">Ready by default</div>
          <div>Each conversation uses its own tabs in the built-in browser. The first time a session uses the browser, OpenWork asks once whether to allow it and remembers your answer, even after a restart; after that the session can navigate, read, click, type and use website tools without asking again. Choose Take over to pause the agent and sign in; Resume browser hands control back.</div>
          <div>Sign in directly in the built-in browser; your session stays available across browser tasks. Your regular browser profile stays separate. Site tools support the imperative WebMCP document API; declarative forms and external browser control are not supported yet.</div>
        </div>
      </div>
    </div>
  );
}
