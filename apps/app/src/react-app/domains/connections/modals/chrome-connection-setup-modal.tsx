/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Chrome,
  ExternalLink,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
  X,
} from "lucide-react";

import { t } from "../../../../i18n";
import { Button } from "../../../design-system/button";
import { isElectronRuntime } from "../../../../app/utils";

export type ChromeConnectionSetupModalProps = {
  open: boolean;
  onClose: () => void;
};

type ChromeStatus = "unknown" | "checking" | "connected" | "unavailable";

async function checkChromeReachable(): Promise<boolean> {
  for (const port of [9222, 9229]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) return true;
    } catch {
      // not available on this port
    }
  }
  return false;
}

export function ChromeConnectionSetupModal(props: ChromeConnectionSetupModalProps) {
  const [status, setStatus] = useState<ChromeStatus>("unknown");

  const testConnection = useCallback(async () => {
    setStatus("checking");
    const reachable = await checkChromeReachable();
    setStatus(reachable ? "connected" : "unavailable");
  }, []);

  useEffect(() => {
    if (!props.open) {
      setStatus("unknown");
      return;
    }
    void testConnection();
  }, [props.open, testConnection]);

  if (!props.open) return null;

  const statusColor =
    status === "connected"
      ? "bg-green-3 text-green-11 border-green-6"
      : status === "unavailable"
        ? "bg-amber-3 text-amber-11 border-amber-6"
        : "bg-gray-3 text-gray-11 border-gray-6";

  const statusLabel =
    status === "checking"
      ? t("chrome_setup.status_checking")
      : status === "connected"
        ? t("chrome_setup.status_connected")
        : status === "unavailable"
          ? t("chrome_setup.status_unavailable")
          : t("chrome_setup.status_unknown");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-gray-1/70 backdrop-blur-sm"
        onClick={props.onClose}
      />

      <div className="relative w-full max-w-2xl overflow-hidden rounded-2xl border border-gray-6/70 bg-gray-2 shadow-2xl">
        {/* Header */}
        <div className="border-b border-gray-6 px-6 py-5 sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-11">
                <Chrome size={12} />
                {t("chrome_setup.badge")}
              </div>
              <div>
                <h2 className="text-xl font-semibold text-gray-12 sm:text-2xl">
                  {t("chrome_setup.title")}
                </h2>
                <p className="mt-1 max-w-xl text-sm leading-6 text-gray-11">
                  {t("chrome_setup.subtitle")}
                </p>
              </div>
            </div>
            <button
              type="button"
              className="rounded-xl p-2 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
              onClick={props.onClose}
              aria-label={t("common.cancel")}
            >
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="space-y-5 px-6 py-6 sm:px-7">
          {/* Connection status */}
          <div className={`flex items-center gap-3 rounded-xl border px-4 py-3 ${statusColor}`}>
            {status === "checking" ? (
              <Loader2 size={16} className="animate-spin" />
            ) : status === "connected" ? (
              <Check size={16} />
            ) : (
              <MonitorSmartphone size={16} />
            )}
            <span className="text-sm font-medium">{statusLabel}</span>
            {status !== "checking" ? (
              <button
                type="button"
                className="ml-auto rounded-lg p-1.5 transition-colors hover:bg-black/10"
                onClick={testConnection}
                aria-label={t("chrome_setup.test_connection")}
              >
                <RefreshCw size={14} />
              </button>
            ) : null}
          </div>

          {/* Step 1: Enable remote debugging */}
          <div className="rounded-2xl border border-gray-6 bg-gray-1/40 p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11">
                <span className="text-sm font-bold">1</span>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-gray-12">
                  {t("chrome_setup.step_one_title")}
                </h3>
                <p className="mt-1 text-sm text-gray-11">
                  {t("chrome_setup.step_one_hint")}
                </p>
                <ol className="mt-3 space-y-2 text-sm leading-6 text-gray-12">
                  <li>
                    1.{" "}
                    {t("chrome_setup.step_one_open_inspect")}{" "}
                    <code className="rounded bg-gray-4 px-1.5 py-0.5 text-xs font-mono">
                      chrome://inspect/#remote-debugging
                    </code>
                  </li>
                  <li>2. {t("chrome_setup.step_one_enable")}</li>
                  <li>3. {t("chrome_setup.step_one_allow")}</li>
                </ol>
                <a
                  href="https://developer.chrome.com/docs/devtools/remote-debugging"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-11 transition-colors hover:text-blue-12"
                >
                  {t("chrome_setup.docs_link")}
                  <ExternalLink size={12} />
                </a>
              </div>
            </div>
          </div>

          {/* Step 2: Test connection */}
          <div className="rounded-2xl border border-gray-6 bg-gray-1/40 p-5">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gray-3 text-gray-11">
                <span className="text-sm font-bold">2</span>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-gray-12">
                  {t("chrome_setup.step_two_title")}
                </h3>
                <p className="mt-1 text-sm leading-6 text-gray-11">
                  {t("chrome_setup.step_two_hint")}
                </p>

                <Button
                  variant="outline"
                  className="mt-3"
                  onClick={testConnection}
                  disabled={status === "checking"}
                >
                  {status === "checking" ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RefreshCw size={14} />
                  )}
                  {t("chrome_setup.test_connection")}
                </Button>

                {status === "connected" ? (
                  <div className="mt-3 rounded-xl border border-green-6 bg-green-2/50 px-4 py-2.5 text-sm text-green-11">
                    {t("chrome_setup.connected_message")}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* Info: what this enables */}
          <div className="rounded-xl border border-dashed border-gray-6 bg-gray-2/70 px-4 py-3 text-xs leading-5 text-gray-11">
            {t("chrome_setup.info_what_this_enables")}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col-reverse gap-3 border-t border-gray-6 bg-gray-2/80 px-6 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-7">
          <Button variant="ghost" onClick={props.onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="secondary"
            onClick={props.onClose}
            disabled={status === "checking"}
          >
            {status === "connected" ? t("chrome_setup.done") : t("chrome_setup.close")}
          </Button>
        </div>
      </div>
    </div>
  );
}
