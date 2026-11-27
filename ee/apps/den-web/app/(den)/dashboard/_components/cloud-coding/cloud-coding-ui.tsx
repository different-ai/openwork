import { CLOUD_CODING_CALLBACK_ERROR_REASONS, type CloudCodingCallbackErrorReason } from "@openwork/types/den/cloud-coding";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { DenBrandMark } from "../../../_components/ui/brand-mark";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";

const githubErrors: Record<CloudCodingCallbackErrorReason, string> = {
  state_invalid: "That GitHub link expired. Try connecting again.",
  not_your_installation: "Your GitHub account can't manage that installation. Ask a GitHub owner to connect it.",
  installation_in_use: "That GitHub account is already connected to another OpenWork organization.",
  account_in_use: "That GitHub account is already linked to someone else in this organization.",
  different_account: "This GitHub link was started from a different OpenWork account or organization. Start again from where you began.",
  not_allowed: "Only admins can connect GitHub.",
  not_installed: "OpenWork isn't installed on a GitHub account you can reach yet. Choose Connect GitHub to install it.",
  not_configured: "GitHub couldn't be reached. Try again in a minute.",
  github_error: "GitHub couldn't be reached. Try again in a minute.",
};

export function githubCallbackError(reason: string | null) {
  const known = CLOUD_CODING_CALLBACK_ERROR_REASONS.find((value) => value === reason);
  return githubErrors[known ?? "github_error"];
}

export function GithubMark({ inline = false }: { inline?: boolean }) {
  return <DenBrandMark name="GitHub" simpleIconSlug="github" className={inline ? "border-0! bg-transparent!" : "size-7 rounded-md border-0! bg-[var(--dls-hover)]!"} imageClassName="size-3.5" />;
}

export function Locked({ children, id }: { children: ReactNode; id?: string }) {
  return <span id={id} className="inline-flex items-center gap-1.5 text-[13px] text-[var(--dls-text-secondary)]"><Lock className="size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />{children}</span>;
}

export function CloudCodingLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <DenNotice tone="error" message={message} action={<DenButton variant="secondary" size="sm" onClick={onRetry}>Try again</DenButton>} />;
}
