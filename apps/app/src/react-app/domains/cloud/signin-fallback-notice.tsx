/** @jsxImportSource react */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { t } from "../../../i18n";

export function SignInFallbackNotice({ url }: { url: string }) {
  // Presentation-only copy feedback; DenSignInSurface stays stateless.
  const [copied, setCopied] = useState(false);

  const copyLink = () => {
    void navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }).catch((error) => {
      console.error("[den-auth] failed to copy sign-in link:", error);
    });
  };

  return (
    <div className="rounded-xl border border-red-7/30 bg-red-1/40 px-3 py-2 text-xs text-red-11">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div>{t("den.error_browser_open_failed")}</div>
          <div>{t("den.browser_open_failed_hint")}</div>
        </div>
        <Button variant="outline" size="sm" onClick={copyLink}>
          {copied ? t("den.signin_link_copied") : t("den.copy_signin_link")}
        </Button>
      </div>
    </div>
  );
}
