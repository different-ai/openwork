"use client";

import { useEffect, type AnchorHTMLAttributes } from "react";
import { capturePosthogEvent } from "../lib/posthog-client";

type Action = "announcement" | "early_access" | "how_it_works" | "models" | "member_sign_in" | "email_early_access" | "source" | "releases";

export function CoworkerAnnouncementView() {
  useEffect(() => {
    capturePosthogEvent("coworker_announcement_viewed", { campaign: "coworker", version: "2026-09", availability: "early_access" });
  }, []);
  return null;
}

/** Native links keep working without analytics, hydration, or an account. */
export function CoworkerAction({ action, placement, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & {
  action: Action;
  placement: "homepage" | "nav" | "hero" | "models" | "footer" | "demo";
}) {
  return <a {...props} data-coworker-action={action} data-placement={placement} onClick={() => {
    // Deliberately bounded properties: no email, prompt, query string, or destination URL.
    capturePosthogEvent("coworker_announcement_cta_clicked", { campaign: "coworker", action, placement, availability: "early_access" });
  }} />;
}
