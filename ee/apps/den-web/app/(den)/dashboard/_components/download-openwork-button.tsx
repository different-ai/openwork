"use client";

import { Popover } from "@base-ui/react/popover";
import { Copy, Download, ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { installPageUrl } from "../../_lib/install-download";

export function DownloadOpenWorkButton({
  organization,
}: {
  organization?: { id: string; name: string };
}) {
  if (organization) {
    return <OrganizationDownloadPopover />;
  }

  return (
    <DenButton
      href="/install"
      size="sm"
      icon={Download}
      aria-label="Download OpenWork"
      data-testid="den-download-openwork"
      className="shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
    >
      <span className="hidden sm:inline">Download OpenWork</span>
    </DenButton>
  );
}

function OrganizationDownloadPopover() {
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  function handleOpenInstallPage() {
    setError(null);
    const installWindow = window.open(installPageUrl(), "_blank");
    if (!installWindow) {
      setError("Allow popups to open the install page, or copy the install link.");
      return;
    }
    installWindow.opener = null;
  }

  async function handleCopyInstallLink() {
    setCopying(true);
    setError(null);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(installPageUrl());
      setCopied(true);
    } catch {
      setError("Your browser didn't give permission to copy. Allow clipboard access and try again, or open the install page.");
    } finally {
      setCopying(false);
    }
  }

  return (
    <Popover.Root>
      <Popover.Trigger
        render={<DenButton size="sm" icon={Download} />}
        aria-label="Download OpenWork"
        data-testid="den-download-openwork"
        className="shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
      >
        <span className="hidden sm:inline">Download OpenWork</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-50">
          <Popover.Popup
            className="w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white p-4 text-gray-900"
            data-testid="workspace-install-popover"
          >
            <Popover.Title className="text-[13px] font-semibold">Download OpenWork</Popover.Title>
            <Popover.Description className="mt-1 text-[13px] text-gray-500">
              Recipients sign in and choose an organization they can access. This link does not grant access.
            </Popover.Description>
            {error ? (
              <p className="mt-3 text-[13px] text-red-600" role="alert">
                {error}
              </p>
            ) : null}
            <div className="mt-4 flex flex-col gap-2">
              <DenButton
                className="w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                data-testid="workspace-install-open"
                icon={ExternalLink}
                onClick={handleOpenInstallPage}
              >
                Open install page
              </DenButton>
              <DenButton
                className="w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900"
                data-testid="workspace-install-copy"
                icon={Copy}
                variant="secondary"
                loading={copying}
                disabled={copying}
                onClick={() => void handleCopyInstallLink()}
              >
                {copied ? "Copied" : "Copy install link"}
              </DenButton>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
