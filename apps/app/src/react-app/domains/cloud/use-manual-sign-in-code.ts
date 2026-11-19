import { useCallback, useState } from "react";

import { exchangeHandoffAndSignIn } from "@/app/lib/den-handoff";
import { readDenSettings } from "@/app/lib/den";
import { markDesktopSignInInitiated } from "@/app/lib/den-sign-in-intent";
import { parseManualAuthInput } from "@/app/lib/manual-auth-input";
import { t } from "@/i18n";
import { useDenAuth } from "./den-auth-provider";

/**
 * The pasted sign-in link or one-time code, shared by the account menu and the
 * in-conversation "Finish signing in" notice. Pasted codes are
 * desktop-initiated sign-ins; `onBeforeExchange` runs right before the grant
 * is exchanged (for example to record where to return) and may return an
 * undo that runs if the exchange fails.
 */
export function useManualSignInCode(options: { onBeforeExchange?: () => (() => void) | void } = {}) {
  const denAuth = useDenAuth();
  const { onBeforeExchange } = options;
  const [code, setCodeState] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setCode = useCallback((value: string) => {
    setCodeState(value);
    setError(null);
  }, []);

  const submit = useCallback(async () => {
    const parsed = parseManualAuthInput(code);
    if (!parsed) {
      setError(t("den.error_paste_valid_code"));
      return false;
    }
    setBusy(true);
    setError(null);
    const undo = onBeforeExchange?.();
    markDesktopSignInInitiated();
    const result = await exchangeHandoffAndSignIn(parsed.grant, {
      baseUrl: parsed.baseUrl ?? readDenSettings().baseUrl,
      desktopInitiated: true,
      fallbackErrorMessage: t("den.error_no_token"),
    });
    setBusy(false);
    if (!result.ok) {
      undo?.();
      setError(result.error);
      return false;
    }
    setCodeState("");
    void denAuth.refresh();
    return true;
  }, [code, denAuth, onBeforeExchange]);

  return { code, setCode, busy, error, submit };
}
