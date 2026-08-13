"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { DenButton } from "../../_components/ui/button";
import { createOrganizationInstallLink } from "../../_lib/install-link-data";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";

const OPEN_APP_URL = "openwork://open";

/**
 * Members have exactly one job on the dashboard: install the app. The
 * install link is minted by the workspace's own den (cloud or self-hosted),
 * so the download is preconfigured to connect to the right server — models,
 * marketplaces, and plugins all sync inside the app after sign-in.
 */
export function MemberDashboardScreen() {
  const { activeOrg, orgId } = useOrgDashboard();
  const [busyAction, setBusyAction] = useState<"download" | "copy" | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const orgName = activeOrg?.name ?? "Your workspace";

  async function mintInstallLink() {
    if (!orgId) {
      throw new Error("No active workspace. Reload and try again.");
    }
    return createOrganizationInstallLink(orgId, false);
  }

  async function handleDownload() {
    setBusyAction("download");
    setError(null);
    try {
      window.open(await mintInstallLink(), "_blank");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : "Could not open the install page.");
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
      setError(copyError instanceof Error ? copyError.message : "Could not copy the install link.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="flex min-h-[72vh] items-center justify-center px-4" data-testid="member-dashboard">
      <div className="flex w-full max-w-xl flex-col items-center pb-12 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gray-500">Your workspace</p>
        <h1 className="mt-3 text-[30px] font-semibold leading-[1.15] tracking-[-0.04em] text-gray-950 sm:text-[34px]">
          {orgName} is set up for you
        </h1>
        <p className="mt-3 max-w-md text-[15px] leading-6 text-gray-500">
          {`Your download is already preconfigured for ${orgName} — open it, sign in, and your team's models and plugins are there.`}
        </p>

        <DenButton
          className="mt-8"
          data-testid="member-download-app"
          icon={Download}
          loading={busyAction === "download"}
          disabled={busyAction !== null}
          onClick={() => void handleDownload()}
        >
          Download OpenWork
        </DenButton>

        <div className="mt-3 flex items-center gap-1.5 text-[12px] text-gray-400">
          <span>macOS · Windows · Linux</span>
          <span aria-hidden className="text-gray-300">
            ·
          </span>
          <button
            type="button"
            data-testid="member-copy-install-link"
            onClick={() => void handleCopyInstallLink()}
            disabled={busyAction !== null}
            className="font-medium text-gray-600 transition hover:text-gray-950"
          >
            {copied ? "Copied" : "Copy install link instead"}
          </button>
        </div>

        {error ? (
          <p role="alert" className="mt-4 text-[13px] text-red-600">
            {error}
          </p>
        ) : null}

        <p className="mt-10 w-full border-t border-gray-100 pt-5 text-[13px] text-gray-500">
          Already installed?{" "}
          <a href={OPEN_APP_URL} className="font-medium text-gray-900 underline-offset-2 hover:underline">
            Open OpenWork →
          </a>
        </p>
      </div>
    </div>
  );
}
