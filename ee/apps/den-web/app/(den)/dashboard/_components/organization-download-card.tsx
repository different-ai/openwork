"use client";

import { Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { createOrganizationInstallLink } from "../../_lib/install-link-data";

export function OrganizationDownloadCard({
  organizationId,
  organizationName,
}: {
  organizationId: string;
  organizationName: string;
}) {
  const [busyAction, setBusyAction] = useState<"open" | "copy" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function mintInstallLink() {
    return createOrganizationInstallLink(organizationId, false);
  }

  async function handleOpenInstallPage() {
    setBusyAction("open");
    setError(null);
    try {
      window.open(await mintInstallLink(), "_blank");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Could not open the workspace install page.");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCopyInstallLink() {
    setBusyAction("copy");
    setError(null);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(await mintInstallLink());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Could not copy the workspace install link.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <section
      className="overflow-hidden rounded-[18px] border border-[#E3E7EE] bg-white shadow-[0_24px_60px_-32px_rgba(7,25,44,0.22)]"
      data-testid="workspace-install-card"
    >
      <div className="grid gap-5 bg-gradient-to-b from-[#FAFBFE] to-white px-6 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <div className="flex items-center gap-2.5">
            <ExternalLink className="h-5 w-5 text-[#07192C]/70" aria-hidden="true" />
            <h2 className="text-[16px] font-semibold text-[#07192C]">Download for this workspace</h2>
          </div>
          <p className="mt-2 max-w-[620px] text-[13px] leading-[1.6] text-[#5A6886]">
            Give teammates a preconfigured OpenWork — the installer connects them to {organizationName}.
          </p>
          {error ? (
            <p className="mt-3 text-[13px] text-red-600" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <DenButton
            className="w-full sm:w-auto"
            data-testid="workspace-install-open"
            icon={ExternalLink}
            loading={busyAction === "open"}
            disabled={busyAction !== null}
            onClick={() => void handleOpenInstallPage()}
          >
            Open install page
          </DenButton>
          <DenButton
            className="w-full sm:w-auto"
            data-testid="workspace-install-copy"
            icon={Copy}
            variant="secondary"
            loading={busyAction === "copy"}
            disabled={busyAction !== null}
            onClick={() => void handleCopyInstallLink()}
          >
            {copied ? "Copied" : "Copy install link"}
          </DenButton>
        </div>
      </div>
    </section>
  );
}
