"use client";

import { Dialog } from "@base-ui/react/dialog";
import type { CloudCodingOverview } from "@openwork/types/den/cloud-coding";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenNotice } from "../../../_components/ui/notice";
import { getCloudCodingRoute } from "../../../_lib/den-org";
import { markFeatureUsed } from "../../../_lib/feature-usage";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import type { AccessDraft } from "../access-summary";
import { useDenToast } from "../den-toast";
import { WhoCanUseIt } from "../who-can-use-it";
import {
  useCloudCodingAdminRequest,
  useCloudCodingInstallations,
  useCloudCodingInstallComplete,
  useCloudCodingInstallStart,
  useCloudCodingLinkStart,
  useCloudCodingOverview,
  useCloudCodingSendLink,
  useCloudCodingSettings,
  useCloudCodingSync,
} from "./cloud-coding-data";
import { githubCallbackError } from "./cloud-coding-ui";
import { CloudCodingView } from "./cloud-coding-view";

const sessionEvent = "cloud-coding-session-change";
const sessionFallback = new Map<string, string>();
function subscribeSession(callback: () => void) {
  window.addEventListener(sessionEvent, callback);
  return () => window.removeEventListener(sessionEvent, callback);
}
function getSession(key: string) {
  try { return window.sessionStorage.getItem(key); } catch { return sessionFallback.get(key) ?? null; }
}
function setSession(key: string, value: string | null) {
  try {
    if (value === null) window.sessionStorage.removeItem(key);
    else window.sessionStorage.setItem(key, value);
  } catch {
    if (value === null) sessionFallback.delete(key);
    else sessionFallback.set(key, value);
  }
  window.dispatchEvent(new Event(sessionEvent));
}

export function CloudCodingScreen({ orgId }: { orgId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const github = params.get("github");
  const toast = useDenToast();
  const { orgContext, reauthDialogOpen } = useOrgDashboard();
  const overviewQuery = useCloudCodingOverview(orgId);
  const overview = overviewQuery.data;
  const sessionKey = `cloud-coding:${orgId}:${overview?.me.memberId ?? ""}`;
  const installKey = `${sessionKey}:install`;
  const asked = useSyncExternalStore(subscribeSession, () => getSession(`${sessionKey}:asked`) === "1", () => false);
  const finishConnecting = useSyncExternalStore(subscribeSession, () => getSession(installKey) === "1", () => false);
  const sent = useSyncExternalStore(subscribeSession, () => getSession(`${sessionKey}:sent`) ?? "", () => "");
  const choose = github === "choose" && overview?.canManage === true && overview.configured && !overview.connection;
  const installations = useCloudCodingInstallations(orgId, choose);
  const installStart = useCloudCodingInstallStart(orgId);
  const installComplete = useCloudCodingInstallComplete(orgId);
  const ask = useCloudCodingAdminRequest(orgId);
  const link = useCloudCodingLinkStart(orgId);
  const send = useCloudCodingSendLink(orgId);
  const settings = useCloudCodingSettings(orgId);
  const { mutate: sync, isPending: syncPending, error: syncError } = useCloudCodingSync(orgId);
  const [audience, setAudience] = useState<AccessDraft | null>(null);
  const [audienceError, setAudienceError] = useState<string>();
  const [settingsError, setSettingsError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const handledCallback = useRef(false);
  const awaitingGithubFocus = useRef(false);
  const { refetch } = overviewQuery;

  useEffect(() => {
    if (github !== "connected" || handledCallback.current) return;
    handledCallback.current = true;
    toast({ title: "GitHub connected" });
    router.replace(getCloudCodingRoute(), { scroll: false });
    void refetch();
  }, [github, refetch, router, toast]);

  useEffect(() => {
    if (overview?.connection && finishConnecting) setSession(installKey, null);
  }, [finishConnecting, installKey, overview?.connection]);

  const canSync = overview?.canManage === true && !!overview.connection;
  useEffect(() => {
    if (!canSync) return;
    function onFocus() {
      if (!awaitingGithubFocus.current || syncPending) return;
      awaitingGithubFocus.current = false;
      sync();
    }
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [canSync, sync, syncPending]);

  function openGithub() {
    if (!overview?.connection) return;
    if (overview.canManage) awaitingGithubFocus.current = true;
    window.open(overview.connection.settingsUrl, "_blank", "noopener,noreferrer");
  }

  function install(existing: boolean) {
    setActionError(undefined);
    markFeatureUsed("cloudCoding");
    installStart.mutate(existing, {
      onSuccess: ({ redirectUrl }) => {
        setSession(installKey, "1");
        window.location.assign(redirectUrl);
      },
      onError: () => setActionError("Couldn't open GitHub. Try again."),
    });
  }

  function completeInstall(installationId: number) {
    setActionError(undefined);
    markFeatureUsed("cloudCoding");
    installComplete.mutate(installationId, {
      onSuccess: () => {
        setSession(installKey, null);
        toast({ title: "GitHub connected" });
        router.replace(getCloudCodingRoute(), { scroll: false });
      },
      onError: () => setActionError("Couldn't connect that GitHub account. Try again."),
    });
  }

  function askAdmin() {
    setActionError(undefined);
    ask.mutate(undefined, {
      onSuccess: () => {
        setSession(`${sessionKey}:asked`, "1");
        toast({ title: "Asked your admins to connect GitHub" });
      },
      onError: () => setActionError("Couldn't ask your admins. Try again."),
    });
  }

  function sendLink(person: CloudCodingOverview["people"][number]) {
    setActionError(undefined);
    markFeatureUsed("cloudCoding");
    send.mutate(person.memberId, {
      onSuccess: () => {
        const key = `${sessionKey}:sent`;
        setSession(key, [getSession(key), encodeURIComponent(person.memberId)].filter(Boolean).join(","));
        toast({ title: `Sent ${person.name.trim().split(/\s+/)[0]} a link to connect GitHub` });
      },
      onError: () => setActionError("Couldn't send the GitHub link. Try again."),
    });
  }

  return (
    <>
      <CloudCodingView
        overview={overview}
        loadError={overviewQuery.isError ? "Couldn't load Cloud coding. Try again." : undefined}
        callbackError={github === "error" ? githubCallbackError(params.get("reason")) : undefined}
        actionError={actionError ?? (syncError ? "Couldn't refresh repositories from GitHub. Open GitHub again to retry." : undefined)}
        settingsError={settingsError}
        installations={choose ? {
          accounts: installations.data?.installations,
          error: installations.isError ? "Couldn't load GitHub accounts. Try again." : undefined,
          pending: installComplete.isPending,
          onRetry: () => { void installations.refetch(); },
          onConnect: completeInstall,
        } : undefined}
        finishConnecting={finishConnecting}
        installPending={installStart.isPending}
        asked={asked}
        askPending={ask.isPending}
        settingsPending={settings.isPending || syncPending}
        linkPending={link.isPending}
        sentMemberIds={sent ? sent.split(",").map(decodeURIComponent) : []}
        sendPending={send.isPending}
        onRetry={() => { void refetch(); }}
        onInstall={install}
        onAsk={askAdmin}
        onOpenGithub={openGithub}
        onToggle={(enabled) => {
          setSettingsError(undefined);
          settings.mutate({ enabled }, { onError: () => setSettingsError("Couldn't save Cloud coding settings. Try again.") });
        }}
        onChangeAudience={() => {
          if (!overview) return;
          setAudienceError(undefined);
          setAudience(overview.access);
        }}
        onLink={() => {
          setActionError(undefined);
          markFeatureUsed("cloudCoding");
          link.mutate(undefined, {
            onSuccess: ({ redirectUrl }) => window.location.assign(redirectUrl),
            onError: () => setActionError("Couldn't open GitHub. Try again."),
          });
        }}
        onSendLink={sendLink}
      />
      {overview?.canManage && overview.connection && audience ? (
        <Dialog.Root open={!reauthDialogOpen} onOpenChange={(open) => { if (!open && !settings.isPending) setAudience(null); }}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
            <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-2xl border border-[var(--dls-border)] bg-white p-5 outline-none">
              <Dialog.Title className="text-[15px] font-semibold text-[var(--dls-text-primary)]">Who can use Cloud coding</Dialog.Title>
              <form className="flex flex-col gap-4" onSubmit={(event) => {
                event.preventDefault();
                if (settings.isPending) return;
                setAudienceError(undefined);
                setSettingsError(undefined);
                settings.mutate({ access: audience }, {
                  onSuccess: () => setAudience(null),
                  onError: () => setAudienceError("Couldn't save who can use Cloud coding. Try again."),
                });
              }}>
                <WhoCanUseIt value={audience} onChange={setAudience} members={orgContext?.members ?? []} teams={orgContext?.teams ?? []} canShareWithEveryone owner={null} everyoneOffDescription="Off. Only the people and teams below can use it." disabled={settings.isPending} />
                {audienceError ? <DenNotice tone="error" message={audienceError} /> : null}
                <div className="flex justify-end gap-2">
                  <Dialog.Close render={<DenButton variant="secondary" size="sm" disabled={settings.isPending} />}>Cancel</Dialog.Close>
                  <DenButton type="submit" size="sm" disabled={settings.isPending}>Save changes</DenButton>
                </div>
              </form>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
    </>
  );
}
