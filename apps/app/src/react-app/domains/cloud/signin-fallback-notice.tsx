/** @jsxImportSource react */
import { BrowserHandoffFallback } from "@/components/browser-handoff-fallback";
import { t } from "../../../i18n";

export function SignInFallbackNotice({ url }: { url: string }) {
  return (
    <BrowserHandoffFallback
      url={url}
      title="Continue in your browser"
      description={`${t("den.browser_open_failed_hint")} The full link stays available here even if browser launch or copy is blocked.`}
      openLabel="Open sign-in again"
      className="border-red-7/30 bg-red-1/40"
    />
  );
}
