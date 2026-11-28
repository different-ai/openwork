"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { markFeatureUsed } from "../../../_lib/feature-usage";
import { useDenToast } from "../den-toast";
import { ConfirmDialog } from "../item-list";
import { useCloudCodingLinkStart, useCloudCodingOverview, useCloudCodingUnlink } from "./cloud-coding-data";
import { CloudCodingLinkView } from "./cloud-coding-link-view";
import { githubCallbackError } from "./cloud-coding-ui";

export function CloudCodingLinkScreen({ orgId }: { orgId: string }) {
  const params = useSearchParams();
  const github = params.get("github");
  const overview = useCloudCodingOverview(orgId);
  const link = useCloudCodingLinkStart(orgId);
  const unlink = useCloudCodingUnlink(orgId);
  const toast = useDenToast();
  const [confirm, setConfirm] = useState(false);
  const [dismissSuccess, setDismissSuccess] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const handledCallback = useRef(false);
  const { refetch } = overview;

  useEffect(() => {
    if (github !== "linked" || handledCallback.current) return;
    handledCallback.current = true;
    toast({ title: "GitHub linked" });
    void refetch();
  }, [github, refetch, toast]);

  return (
    <>
      <CloudCodingLinkView overview={overview.data}
        loadError={overview.isError ? "Couldn't load your GitHub account. Try again." : undefined}
        actionError={actionError}
        callbackError={github === "error" ? githubCallbackError(params.get("reason")) : undefined}
        linked={github === "linked" && !dismissSuccess}
        pending={link.isPending || unlink.isPending}
        onRetry={() => { void refetch(); }}
        onLink={() => {
          setActionError(undefined);
          markFeatureUsed("cloudCoding");
          link.mutate(undefined, {
            onSuccess: ({ redirectUrl }) => window.location.assign(redirectUrl),
            onError: () => setActionError("Couldn't open GitHub. Try again."),
          });
        }}
        onUnlink={() => { setActionError(undefined); setConfirm(true); }}
      />
      <ConfirmDialog
        confirm={confirm ? { title: "Unlink your GitHub account?", description: "OpenWork will stop opening pull requests in your name until you link it again.", action: "Unlink" } : null}
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try { await unlink.mutateAsync(); } catch { throw new Error("Couldn't unlink GitHub. Try again."); }
          setDismissSuccess(true);
        }}
      />
    </>
  );
}
