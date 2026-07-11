/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";

import { t } from "../../../i18n";
import { Button } from "../../../components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../../components/ui/collapsible";
import { Input } from "../../../components/ui/input";
import { useBootState } from "../../shell/boot-state";
import { useConnectLink } from "./connect-link-provider";
import { saveControlPlaneUrl } from "../settings/cloud/control-plane-url";

/**
 * First-run screen of the enterprise build: the app ships unconfigured and
 * waits for the organization's signed connect link. The email button is the
 * happy path; pasting the link and typing a server URL by hand are the
 * fallbacks.
 */
export function ReadyToConnectPage() {
  const { markRouteReady } = useBootState();
  const connectLink = useConnectLink();

  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [serverDraft, setServerDraft] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    markRouteReady();
  }, [markRouteReady]);

  useEffect(() => {
    document.title = "OpenWork Enterprise";
  }, []);

  const submitPaste = useCallback(() => {
    if (!pasteValue.trim()) return;
    const accepted = connectLink.submitManualConnectLink(pasteValue);
    if (!accepted) {
      setPasteError(t("connect.paste_invalid"));
      return;
    }
    setPasteError(null);
    setPasteValue("");
  }, [connectLink, pasteValue]);

  const submitServerUrl = useCallback(async () => {
    if (!serverDraft.trim() || serverBusy) return;
    setServerBusy(true);
    setServerError(null);
    try {
      const persisted = await saveControlPlaneUrl(serverDraft);
      if (!persisted) {
        setServerError(t("den.error_base_url"));
      }
      // On success the bootstrap config becomes `configured`, the gate in
      // app-root re-evaluates, and the forced sign-in flow takes over.
    } catch (error) {
      setServerError(error instanceof Error ? error.message : t("den.error_base_url"));
    } finally {
      setServerBusy(false);
    }
  }, [serverBusy, serverDraft]);

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background" data-testid="ready-to-connect-page">
      <div className="w-full max-w-md space-y-6 rounded-xl border bg-card p-8 shadow-sm">
        <div className="space-y-2 text-center">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
            OpenWork Enterprise
          </p>
          <h1 className="text-2xl font-semibold" data-testid="ready-to-connect-title">
            {t("connect.ready_title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("connect.ready_body")}</p>
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="connect-link-paste">
            {t("connect.paste_label")}
          </label>
          <div className="flex gap-2">
            <Input
              id="connect-link-paste"
              value={pasteValue}
              placeholder="openwork://connect?token=…"
              onChange={(event) => {
                setPasteValue(event.target.value);
                setPasteError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submitPaste();
              }}
              data-testid="connect-link-paste-input"
            />
            <Button onClick={submitPaste} disabled={!pasteValue.trim()} data-testid="connect-link-paste-submit">
              {t("connect.paste_cta")}
            </Button>
          </div>
          {pasteError ? (
            <p className="text-sm text-destructive" data-testid="connect-link-paste-error">{pasteError}</p>
          ) : null}
        </div>

        <Collapsible>
          <CollapsibleTrigger className="text-sm text-muted-foreground underline-offset-4 hover:underline">
            {t("connect.advanced_toggle")}
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 space-y-2">
            <p className="text-xs text-muted-foreground">{t("connect.advanced_hint")}</p>
            <div className="flex gap-2">
              <Input
                value={serverDraft}
                placeholder="https://openwork.example.com"
                onChange={(event) => {
                  setServerDraft(event.target.value);
                  setServerError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void submitServerUrl();
                }}
                data-testid="connect-server-url-input"
              />
              <Button
                variant="outline"
                onClick={() => {
                  void submitServerUrl();
                }}
                disabled={serverBusy || !serverDraft.trim()}
                data-testid="connect-server-url-submit"
              >
                {serverBusy ? t("connect.advanced_saving") : t("connect.advanced_save")}
              </Button>
            </div>
            {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
