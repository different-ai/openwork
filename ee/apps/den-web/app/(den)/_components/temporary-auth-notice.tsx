import { shouldShowTemporaryAuthNotice } from "../_lib/temporary-auth-notice";
import { DenNotice } from "./ui/notice";

export function TemporaryAuthNotice() {
  if (!shouldShowTemporaryAuthNotice()) return null;

  return (
    <DenNotice
      tone="warning"
      className="leading-5"
      message={(
        <span className="grid gap-2">
          <span>
            <strong className="font-semibold">Trouble signing in?</strong> We recently changed our authentication system. If sign-in or sign-up does not finish, clear saved site data for <strong className="font-semibold">openworklabs.com</strong>, then force-refresh. We&apos;re sorry for the disruption. Clearing site data signs you out.
          </span>
          <span className="grid gap-1 text-[13px]">
            <span><strong className="font-semibold">Chrome or Edge:</strong> Open the site controls beside the address bar, clear cookies and site data, then press Cmd/Ctrl+Shift+R.</span>
            <span><strong className="font-semibold">Safari:</strong> Safari &gt; Settings &gt; Privacy &gt; Manage Website Data, remove openworklabs.com, then reload.</span>
            <span><strong className="font-semibold">Firefox or another browser:</strong> Clear cookies and site data for openworklabs.com in site settings, then press Cmd/Ctrl+Shift+R.</span>
          </span>
        </span>
      )}
    />
  );
}
