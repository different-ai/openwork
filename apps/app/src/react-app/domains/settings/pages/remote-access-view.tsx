import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, LockKeyhole, Smartphone } from "lucide-react";
import type {
  RemoteAccessStatus,
  RemoteDevice,
  RemotePairing,
  RemoteProjectScope,
} from "@openwork/types/desktop-ipc";
import {
  remoteAccessStatus,
  remoteAccessSetEnabled,
  remoteAccessPair,
  remoteAccessApprove,
  remoteAccessDeny,
  remoteAccessUpdateScope,
  remoteAccessRevoke,
} from "@/app/lib/desktop";
import { isDesktopRuntime } from "@/app/lib/runtime-env";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  LayoutStack,
  LayoutSection,
  LayoutSectionTitle,
} from "../settings-layout";

const recovery: Record<string, string> = {
  TAILSCALE_NOT_INSTALLED:
    "Install Tailscale on this computer and your iPhone, then try again.",
  TAILSCALE_SIGN_IN:
    "Open Tailscale and sign in on this computer, then try again.",
  TAILSCALE_DNS_UNAVAILABLE:
    "Enable MagicDNS and HTTPS in your Tailscale settings, then try again.",
  TAILSCALE_SETUP_REQUIRED:
    "Open Tailscale and finish setting up HTTPS on this computer, then try again.",
  TAILSCALE_PORTS_OCCUPIED:
    "The available connection ports are in use. Free a Tailscale HTTPS port from 9443 to 9453, then try again.",
  TAILSCALE_CONFIGURATION_CHANGED:
    "Tailscale settings changed during setup. Check your existing connections, then try again.",
  PUBLIC_ROUTE_CONFIGURED:
    "This connection has Tailscale Funnel enabled. Turn Funnel off for this connection before trying again.",
  STORE_LOCKED:
    "The standalone Remote bridge is still running. Stop it, then try again here.",
  EADDRINUSE:
    "Another app is using the Remote connection port. Stop the standalone bridge, then try again.",
  ENGINE_V2_REQUIRED:
    "Remote access requires OpenCode v2. Open Settings → Advanced and enable OpenCode v2 for chats, then try again.",
  UPSTREAM_UNAVAILABLE: "Open a local project in OpenWork, then try again.",
  PAIRING_EXPIRED:
    "This pairing code expired. Choose Pair a phone to create another.",
  PAIRING_INVALID:
    "This pairing request is no longer available. Choose Pair a phone to start again.",
  NOT_FOUND:
    "This phone or project is no longer available. Close this panel and try again.",
  FEATURE_DISABLED:
    "Remote access is not enabled for this installation. Your OpenWork administrator can enable this feature.",
};

type AccessEditor = RemoteProjectScope & {
  id: string;
  name: string;
  kind: "claim" | "device";
};

export function RemoteAccessView() {
  const desktop = isDesktopRuntime();
  const query = useQuery({
    queryKey: ["desktop-remote-access"],
    queryFn: remoteAccessStatus,
    enabled: desktop,
    refetchInterval: 2500,
    retry: false,
  });
  const status = query.data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<
    (RemotePairing & { expires: number }) | null
  >(null);
  const [editor, setEditor] = useState<AccessEditor | null>(null);
  const [revoke, setRevoke] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now);
  const ready = status?.phase === "ready";

  useEffect(() => {
    if (!ready) {
      setPairing(null);
      setEditor(null);
      setRevoke(false);
    }
  }, [ready]);
  useEffect(() => {
    if (!pairing) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pairing]);

  const perform = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await query.refetch();
    } catch (failure) {
      const code =
        failure instanceof Error
          ? Object.keys(recovery).find((key) => failure.message.includes(key))
          : undefined;
      setError(
        code ? recovery[code] : "The change could not be completed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const beginPairing = () =>
    perform(async () => {
      const expires = Date.now() + 300000;
      const result = await remoteAccessPair();
      setNow(Date.now());
      setCopied(false);
      setPairing({ ...result, expires });
    });
  const reviewClaim = (claim: RemoteAccessStatus["pending"][number]) => {
    setPairing(null);
    setRevoke(false);
    setError(null);
    setEditor({
      id: claim.id,
      name: claim.deviceName,
      kind: "claim",
      workspaceIds: [],
      allWorkspaces: false,
    });
  };
  const manage = (device: RemoteDevice) => {
    setRevoke(false);
    setError(null);
    setEditor({ ...device, kind: "device" });
  };
  const closeEditor = () => {
    setEditor(null);
    setRevoke(false);
  };
  const save = () =>
    editor &&
    perform(async () => {
      const scope = {
        workspaceIds: editor.workspaceIds.filter((id) =>
          status?.workspaces.some((w) => w.id === id),
        ),
        allWorkspaces: editor.allWorkspaces,
      };
      if (editor.kind === "claim") await remoteAccessApprove(editor.id, scope);
      else await remoteAccessUpdateScope(editor.id, scope);
      closeEditor();
    });
  const errorText =
    error ??
    (query.isError
      ? "Connection status is unavailable. Try again."
      : status?.errorCode
        ? (recovery[status.errorCode] ??
          "Remote access could not start. Check Technical details, then try again.")
        : null);
  const expired = pairing && now >= pairing.expires;
  const minutes = pairing
    ? Math.ceil(Math.max(0, pairing.expires - now) / 60000)
    : 0;
  const currentClaim =
    editor?.kind === "claim"
      ? status?.pending.find((c) => c.id === editor.id)
      : null;
  const canSave =
    editor &&
    (editor.kind === "device" ||
      (currentClaim &&
        (editor.allWorkspaces || editor.workspaceIds.length > 0)));

  return (
    <LayoutStack>
      <div className="flex min-h-12 items-center justify-between gap-4 border-b border-border pb-3">
        <label htmlFor="remote-access-enabled" className="text-sm font-medium">
          Allow phone access
        </label>
        <Switch
          id="remote-access-enabled"
          checked={status?.enabled ?? false}
          disabled={
            busy ||
            !desktop ||
            !status ||
            (!status.available && !status.enabled)
          }
          onCheckedChange={(value) =>
            void perform(() => remoteAccessSetEnabled(value))
          }
        />
      </div>
      {!desktop ? (
        <p className="text-sm text-muted-foreground">
          Open the macOS or Linux desktop app to connect your phone.
        </p>
      ) : query.isPending ? (
        <div
          className="h-9 w-52 animate-pulse rounded-md bg-muted motion-reduce:animate-none"
          aria-label="Checking connection"
        />
      ) : status?.phase === "unavailable" ? (
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <LockKeyhole className="mt-0.5 size-4 shrink-0" />
          Remote access is not enabled for this installation. Your OpenWork
          administrator can enable this feature.
        </p>
      ) : (
        <div className="flex min-h-10 flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground" role="status">
            {ready
              ? "Ready for your phone"
              : status?.phase === "error"
                ? "Needs attention"
                : "Off"}
          </p>
          {ready && (
            <Button disabled={busy} onClick={() => void beginPairing()}>
              <Smartphone className="size-4" />
              Pair a phone
            </Button>
          )}
        </div>
      )}
      {errorText && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 text-sm"
        >
          <p className="max-w-xl">{errorText}</p>
          {!editor && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void perform(() => query.refetch())}
            >
              Try again
            </Button>
          )}
        </div>
      )}
      {status?.phase === "off" && (
        <p className="text-sm text-muted-foreground">
          Paired phones stay saved. OpenWork must be open to connect.
        </p>
      )}
      {status && status.pending.length > 0 && (
        <LayoutSection>
          <LayoutSectionTitle>Waiting for your approval</LayoutSectionTitle>
          {status.pending.map((claim) => (
            <div
              key={claim.id}
              className="flex min-h-12 items-center justify-between gap-3 border-b border-border text-sm"
            >
              <span className="break-words">{claim.deviceName}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy || !ready}
                onClick={() => reviewClaim(claim)}
              >
                Review access
              </Button>
            </div>
          ))}
        </LayoutSection>
      )}
      {status && (
        <LayoutSection>
          <LayoutSectionTitle>Paired phones</LayoutSectionTitle>
          {status.devices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No phones paired.</p>
          ) : (
            <div>
              {status.devices.map((device) => (
                <div
                  key={device.id}
                  className="flex min-h-12 flex-wrap items-center gap-3 border-b border-border py-2 text-sm"
                >
                  <span className="min-w-0 flex-1 break-words font-medium">
                    {device.name}
                  </span>
                  <span className="text-muted-foreground">
                    {!device.active
                      ? "Finishing pairing"
                      : device.allWorkspaces
                        ? "All current and future projects"
                        : `${device.workspaceIds.length} ${device.workspaceIds.length === 1 ? "project" : "projects"}`}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy || !ready || !device.active}
                    onClick={() => manage(device)}
                  >
                    Manage<span className="sr-only"> {device.name}</span>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </LayoutSection>
      )}
      <details className="group text-sm">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 text-muted-foreground">
          <ChevronRight className="size-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
          Technical details
        </summary>
        <dl className="space-y-3 py-3 text-xs text-muted-foreground">
          <div>
            <dt>Connection</dt>
            <dd className="break-all font-mono">
              {status?.origin ?? "Not connected"}
            </dd>
          </div>
          {status?.errorCode && (
            <div>
              <dt>Diagnostic code</dt>
              <dd className="font-mono">{status.errorCode}</dd>
            </div>
          )}
          <div>
            <dt>Availability</dt>
            <dd>
              OpenWork and Tailscale must be running on this computer. Pairing
              codes expire after five minutes. Tool approval requests still need
              a decision.
            </dd>
          </div>
        </dl>
      </details>
      <Dialog
        open={Boolean(pairing)}
        onOpenChange={(open) => {
          if (!open) setPairing(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Scan in OpenWork Remote</DialogTitle>
          </DialogHeader>
          {pairing && !expired ? (
            <div className="flex flex-col items-center gap-4 py-3">
              <img
                src={pairing.qrDataURL}
                alt="One-time phone pairing code"
                width={240}
                height={240}
                className="rounded-xl bg-white p-3"
              />
              <p className="text-sm text-muted-foreground">
                Expires in {minutes} {minutes === 1 ? "minute" : "minutes"}
              </p>
            </div>
          ) : (
            <p className="py-8 text-center text-sm">
              This pairing code expired.
            </p>
          )}
          {status?.pending.map((claim) => (
            <Button key={claim.id} onClick={() => reviewClaim(claim)}>
              Review {claim.deviceName}
            </Button>
          ))}
          <DialogFooter>
            {expired ? (
              <Button onClick={() => void beginPairing()} disabled={busy}>
                Create new code
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    if (pairing) {
                      await navigator.clipboard.writeText(
                        JSON.stringify(pairing.payload),
                      );
                      setCopied(true);
                    }
                  })
                }
              >
                {copied ? "Copied" : "Copy pairing code"}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setPairing(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!open && !busy) closeEditor();
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {revoke
                ? `Disconnect ${editor?.name}?`
                : editor?.kind === "claim"
                  ? `Allow ${editor.name} to access`
                  : `${editor?.name} project access`}
            </DialogTitle>
          </DialogHeader>
          {revoke ? (
            <p className="py-3 text-sm">
              This phone will lose access to every project on this computer.
              Pair it again to reconnect.
            </p>
          ) : (
            <>
              <fieldset disabled={busy} className="space-y-2">
                <legend className="mb-3 text-sm text-muted-foreground">
                  Chats and files in the projects you select.
                </legend>
                {status?.workspaces.map((workspace) => (
                  <label
                    key={workspace.id}
                    className="flex min-h-11 cursor-pointer items-center gap-3 text-sm"
                  >
                    <Checkbox
                      checked={
                        editor?.allWorkspaces ||
                        editor?.workspaceIds.includes(workspace.id) ||
                        false
                      }
                      disabled={editor?.allWorkspaces}
                      onCheckedChange={(checked) =>
                        setEditor(
                          (current) =>
                            current && {
                              ...current,
                              workspaceIds: checked
                                ? [
                                    ...new Set([
                                      ...current.workspaceIds,
                                      workspace.id,
                                    ]),
                                  ]
                                : current.workspaceIds.filter(
                                    (id) => id !== workspace.id,
                                  ),
                            },
                        )
                      }
                    />
                    <span className="break-words">{workspace.name}</span>
                  </label>
                ))}
                {!status?.workspaces.length && (
                  <p className="py-2 text-sm text-muted-foreground">
                    No local projects available.
                  </p>
                )}
                <label className="flex min-h-12 cursor-pointer items-center gap-3 border-t border-border pt-3 text-sm">
                  <Checkbox
                    checked={editor?.allWorkspaces ?? false}
                    onCheckedChange={(checked) =>
                      setEditor(
                        (current) =>
                          current && { ...current, allWorkspaces: checked },
                      )
                    }
                  />
                  <span>Allow all current and future projects</span>
                </label>
              </fieldset>
              {editor?.kind === "claim" && !currentClaim && (
                <p className="text-sm" role="alert">
                  This request expired. Pair the phone again.
                </p>
              )}
              {error && (
                <p className="text-sm" role="alert">
                  {error}
                </p>
              )}
            </>
          )}
          <DialogFooter className="mt-3">
            {revoke ? (
              <>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => setRevoke(false)}
                >
                  Keep connected
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    editor &&
                    void perform(async () => {
                      await remoteAccessRevoke(editor.id);
                      closeEditor();
                    })
                  }
                >
                  Disconnect phone
                </Button>
              </>
            ) : (
              <>
                {editor?.kind === "claim" ? (
                  <Button
                    variant="outline"
                    disabled={busy || !currentClaim}
                    onClick={() =>
                      void perform(async () => {
                        await remoteAccessDeny(editor.id);
                        closeEditor();
                      })
                    }
                  >
                    Deny
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setRevoke(true)}
                  >
                    Disconnect phone
                  </Button>
                )}
                <Button disabled={busy || !canSave} onClick={() => void save()}>
                  {editor?.kind === "claim" ? "Allow access" : "Save changes"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </LayoutStack>
  );
}
