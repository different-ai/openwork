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
          <div>Each conversation uses its own tabs in the built-in browser. Allow browser control once for the thread to navigate, read and scroll. Clicks, typing and keys still need your confirmation. Choose Take over to revoke control and sign in; Resume browser lets the thread request access again. Website tools and sharing their results still need separate approval.</div>
          <div>Sign in directly in the built-in browser; your session stays available across browser tasks. Your regular browser profile and login syncing are separate. Site tools support the imperative WebMCP document API; declarative forms and external browser control are not supported yet.</div>
        </div>
      </div>
    </div>
  );
}
