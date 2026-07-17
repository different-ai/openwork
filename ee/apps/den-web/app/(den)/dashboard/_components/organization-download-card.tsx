"use client";

import { Download } from "lucide-react";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDownload() {
    setBusy(true);
    setError(null);
    try {
      const installPageUrl = await createOrganizationInstallLink(organizationId);
      window.location.assign(installPageUrl);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Could not open the workspace download.");
      setBusy(false);
    }
  }

  return (
    <section
      className="overflow-hidden rounded-[18px] border border-[#E3E7EE] bg-white shadow-[0_24px_60px_-32px_rgba(7,25,44,0.22)]"
      data-testid="organization-download-card"
    >
      <div className="grid gap-5 bg-gradient-to-b from-[#FAFBFE] to-white px-6 py-5 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <div className="flex items-center gap-2.5">
            <Download className="h-5 w-5 text-[#07192C]/70" aria-hidden="true" />
            <h2 className="text-[16px] font-semibold text-[#07192C]">Download OpenWork for {organizationName}</h2>
          </div>
          <p className="mt-2 max-w-[620px] text-[13px] leading-[1.6] text-[#5A6886]">
            Download the standard app, then connect it to this workspace and sign in.
          </p>
          {error ? (
            <p className="mt-3 text-[13px] text-red-600" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <DenButton
          className="w-full sm:w-auto"
          data-testid="organization-download-button"
          icon={Download}
          loading={busy}
          onClick={() => void handleDownload()}
        >
          Download for this workspace
        </DenButton>
      </div>
    </section>
  );
}
