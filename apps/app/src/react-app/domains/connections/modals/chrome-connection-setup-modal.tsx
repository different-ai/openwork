/** @jsxImportSource react */
import { useCallback, useEffect, useState } from "react";
import {
  Check,
  Chrome,
  ExternalLink,
  Loader2,
  MonitorSmartphone,
  RefreshCw,
} from "lucide-react";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";

export type ChromeConnectionSetupModalProps = {
  open: boolean;
  onClose: () => void;
};

type ChromeStatus = "unknown" | "checking" | "connected" | "unavailable";

async function checkChromeReachable(): Promise<boolean> {
  const results = await Promise.all([9222, 9229].map(async (port) => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }));
  return results.some(Boolean);
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
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="flex max-h-[90vh] min-h-0 w-full max-w-2xl flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-4">
            <div className="space-y-2">
              <div className="inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-11">
                <Chrome size={12} />
                {t("chrome_setup.badge")}
              </div>
              <div>
                <DialogTitle>
                  {t("chrome_setup.title")}
                </DialogTitle>
                <DialogDescription className="max-w-xl">
                  {t("chrome_setup.subtitle")}
                </DialogDescription>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Body */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto">
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
              <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-blue-3 text-blue-11">
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
              <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-gray-3 text-gray-11">
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

        <DialogFooter className="shrink-0">
          <DialogClose render={<Button variant="outline" />}>
            {t("common.cancel")}
          </DialogClose>
          <DialogClose
            render={
              <Button
                disabled={status === "checking"}
              />
            }
            disabled={status === "checking"}
          >
            {status === "connected" ? t("chrome_setup.done") : t("chrome_setup.close")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
