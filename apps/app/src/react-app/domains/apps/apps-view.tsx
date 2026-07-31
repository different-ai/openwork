/** @jsxImportSource react */
import * as React from "react";
import { AlertTriangle, Download, Loader2, ShieldAlert, Trash2 } from "lucide-react";

import type { AppPermission, InstalledAppRecord } from "@openwork/app-contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

import {
  lifecycleGuidance,
  lifecyclePhase,
  type AppPreview,
  type AppRequirement,
  type AppsClient,
} from "./apps-client";
import {
  approvedPermissions,
  describeDelta,
  groupPermissions,
  initialInstallState,
  reduceInstall,
  reviewIsLive,
  type InstallStep,
} from "./install-flow";

// Preferences → Apps.
//
// The screen is deliberately unhurried at exactly one point: the trust review.
// Everything before it is a text field, and everything after it is a list. The
// review is where a person decides whether to give a stranger's code the
// microphone, so it says what is being asked for, who is asking, and which
// exact commit the bytes came from — and the confirm button says what it does.

export interface AppsViewProps {
  client: AppsClient;
  /** Opens the host's environment-variable editor for a specific key. */
  onEditEnvironment: (key: string) => void;
  now?: () => number;
}

export function AppsView({ client, onEditEnvironment, now = () => Date.now() }: AppsViewProps) {
  const [installed, setInstalled] = React.useState<InstalledAppRecord[]>([]);
  const [requirements, setRequirements] = React.useState<Record<string, AppRequirement[] | undefined>>(
    {},
  );
  const [flow, setFlow] = React.useState<InstallStep>(initialInstallState);
  const [url, setUrl] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const result = await client.list();
    setInstalled(result.items);
    setRequirements(result.requirements ?? {});
  }, [client]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const dispatch = React.useCallback(
    (event: Parameters<typeof reduceInstall>[1]) => {
      setFlow((current) => reduceInstall(current, event, now()));
    },
    [now],
  );

  const resolve = React.useCallback(
    async (repositoryUrl: string) => {
      dispatch({ type: "submit", repositoryUrl });
      try {
        dispatch({ type: "resolved", preview: await client.preview(repositoryUrl) });
      } catch (error) {
        dispatch({ type: "failed", message: messageOf(error), diagnostics: diagnosticsOf(error) });
      }
    },
    [client, dispatch],
  );

  const confirm = React.useCallback(
    async (preview: AppPreview) => {
      dispatch({ type: "confirm" });
      try {
        const result = await client.install(preview.candidateId, approvedPermissions(preview));
        dispatch({ type: "installed", record: result.record });
        await refresh();
      } catch (error) {
        dispatch({ type: "failed", message: messageOf(error), diagnostics: diagnosticsOf(error) });
      }
    },
    [client, dispatch, refresh],
  );

  const act = React.useCallback(
    async (appId: string, action: () => Promise<unknown>) => {
      setBusy(appId);
      try {
        await action();
        await refresh();
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">Install an app</h2>
          <p className="text-muted-foreground text-xs">
            Paste a public GitHub repository. OpenWork reads its released package and shows you what
            it asks for. Nothing from the repository runs until you install it.
          </p>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) void resolve(url.trim());
          }}
        >
          <Label className="sr-only" htmlFor="openwork-app-url">
            Repository URL
          </Label>
          <Input
            id="openwork-app-url"
            value={url}
            placeholder="https://github.com/owner/repository"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setUrl(event.target.value)}
          />
          <Button type="submit" disabled={flow.step === "resolving" || !url.trim()}>
            {flow.step === "resolving" ? <Loader2 className="size-4 animate-spin" /> : "Look up"}
          </Button>
        </form>
      </section>

      {flow.step === "review" ? (
        <TrustReview
          preview={flow.preview}
          now={now()}
          onCancel={() => dispatch({ type: "cancel" })}
          onConfirm={() => void confirm(flow.preview)}
        />
      ) : null}

      {flow.step === "installing" ? (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Loader2 className="size-3 animate-spin" /> Installing {flow.preview.manifest.name}…
        </p>
      ) : null}

      {flow.step === "setup" ? (
        <Alert>
          <AlertTitle>{flow.record.app_id} is installed and switched off</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span>Add what it needs, then turn it on.</span>
            {flow.preview.environment
              .filter((entry) => entry.required && !entry.configured)
              .map((entry) => (
                <Button
                  key={entry.key}
                  size="sm"
                  variant="outline"
                  className="self-start"
                  onClick={() => onEditEnvironment(entry.key)}
                >
                  Set {entry.label}
                </Button>
              ))}
          </AlertDescription>
        </Alert>
      ) : null}

      {flow.step === "failed" ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Nothing was installed</AlertTitle>
          <AlertDescription className="flex flex-col gap-1">
            <span>{flow.message}</span>
            {flow.diagnostics.slice(0, 6).map((line) => (
              <span key={line} className="text-xs opacity-80">
                {line}
              </span>
            ))}
            <Button
              size="sm"
              variant="outline"
              className="mt-2 self-start"
              onClick={() => dispatch({ type: "cancel" })}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Separator />

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Installed apps</h2>
        {installed.length === 0 ? (
          <p className="text-muted-foreground text-xs">No apps installed yet.</p>
        ) : (
          installed.map((record) => (
            <InstalledAppRow
              key={record.app_id}
              record={record}
              requirements={requirements[record.app_id] ?? []}
              onEditEnvironment={onEditEnvironment}
              busy={busy === record.app_id}
              onEnable={() => void act(record.app_id, () => client.enable(record.app_id))}
              onDisable={() => void act(record.app_id, () => client.disable(record.app_id))}
              onRollback={() => void act(record.app_id, () => client.rollback(record.app_id))}
              onApproveUpdate={() =>
                void act(record.app_id, () => client.approvePendingUpdate(record.app_id))
              }
              onRevoke={(permission) =>
                void act(record.app_id, () => client.revokePermission(record.app_id, permission))
              }
              onUninstall={(deleteData) =>
                void act(record.app_id, () => client.uninstall(record.app_id, deleteData))
              }
            />
          ))
        )}
      </section>
    </div>
  );
}

function TrustReview({
  preview,
  now,
  onCancel,
  onConfirm,
}: {
  preview: AppPreview;
  now: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const groups = groupPermissions(preview);
  const live = reviewIsLive(preview, now);

  return (
    <section className="border-border flex flex-col gap-4 rounded-md border p-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium">{preview.manifest.name}</h3>
          <Badge variant="outline">{preview.manifest.version}</Badge>
          {preview.source.prerelease ? <Badge variant="outline">Prerelease</Badge> : null}
        </div>
        <p className="text-muted-foreground text-xs">{preview.manifest.description}</p>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Publisher</dt>
        <dd>{preview.manifest.publisher.name}</dd>
        <dt className="text-muted-foreground">Source</dt>
        <dd className="font-mono">{preview.source.repository}</dd>
        <dt className="text-muted-foreground">Release</dt>
        <dd className="font-mono">
          {preview.source.releaseTag} · {preview.source.commit.slice(0, 12)}
        </dd>
        <dt className="text-muted-foreground">Licence</dt>
        <dd>{preview.manifest.license}</dd>
        <dt className="text-muted-foreground">Package</dt>
        <dd className="font-mono break-all">{preview.archiveDigest}</dd>
      </dl>

      {/*
        Said plainly, because a checksum badge reads as an identity guarantee to
        most people and it is not one.
      */}
      <p className="text-muted-foreground text-xs">
        OpenWork verified these bytes came from that release and that commit. It cannot verify who
        wrote them — this is not a signed publisher identity.
      </p>

      {groups.map((group) => (
        <div key={group.risk} className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-xs font-medium">
            {group.risk === "critical" ? <ShieldAlert className="size-3.5" /> : null}
            {group.heading}
          </h4>
          {group.items.map((entry) => (
            <div key={entry.permission.id} className="flex flex-col">
              <span className="text-xs font-medium">{entry.label}</span>
              <span className="text-muted-foreground text-xs">{entry.reason}</span>
              {entry.detail ? (
                <span className="text-muted-foreground font-mono text-[11px]">{entry.detail}</span>
              ) : null}
            </div>
          ))}
        </div>
      ))}

      {preview.environment.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="text-xs font-medium">Needs from you</h4>
          {preview.environment.map((entry) => (
            <span key={entry.key} className="text-muted-foreground text-xs">
              {entry.label} — {entry.configured ? "already set" : "not set yet"}
            </span>
          ))}
          <span className="text-muted-foreground text-xs">
            OpenWork keeps these. The app is told whether they are set, never what they are.
          </span>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <h4 className="text-xs font-medium">What it does with your data</h4>
        <p className="text-muted-foreground text-xs">{preview.manifest.privacy.summary}</p>
        <p className="text-muted-foreground text-xs">
          {preview.manifest.privacy.retention.description}
        </p>

        {/*
          The categories and recipients the app declares. Without these the screen
          showed only prose the app wrote, so a manifest could ask for the
          microphone while never naming what it collects or who receives it.
        */}
        {preview.manifest.privacy.data_handled.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            <span className="text-foreground">Data it handles: </span>
            {preview.manifest.privacy.data_handled.join(", ")}
          </p>
        ) : null}

        {preview.manifest.privacy.third_parties.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            <span className="text-foreground text-xs">Sends data to</span>
            {preview.manifest.privacy.third_parties.map((party) => (
              <span key={`${party.name}/${party.host}`} className="text-muted-foreground text-xs">
                {party.name} (<span className="font-mono">{party.host}</span>) — {party.purpose}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">
            It declares no third-party recipients.
          </p>
        )}
      </div>

      {preview.warnings.map((warning) => (
        <Alert key={warning} variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription className="text-xs">{warning}</AlertDescription>
        </Alert>
      ))}

      {preview.installed ? (
        <p className="text-muted-foreground text-xs">
          {preview.installed.version} is already installed. {describeDelta(preview.installed.delta)}
        </p>
      ) : null}

      <footer className="flex items-center gap-2">
        <Button onClick={onConfirm} disabled={!preview.compatible || !live}>
          <Download className="size-4" />
          {preview.compatible
            ? `Trust this publisher and install ${preview.manifest.name}`
            : "Cannot run on this version"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        {live ? null : (
          <span className="text-muted-foreground text-xs">
            This review expired. Look it up again.
          </span>
        )}
      </footer>
      <p className="text-muted-foreground text-xs">
        It will be installed switched off. You decide when to turn it on.
      </p>
    </section>
  );
}

function InstalledAppRow({
  record,
  requirements,
  onEditEnvironment,
  busy,
  onEnable,
  onDisable,
  onRollback,
  onApproveUpdate,
  onRevoke,
  onUninstall,
}: {
  record: InstalledAppRecord;
  requirements: AppRequirement[];
  onEditEnvironment: (key: string) => void;
  busy: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onRollback: () => void;
  onApproveUpdate: () => void;
  onRevoke: (permission: AppPermission["id"]) => void;
  onUninstall: (deleteData: boolean) => void;
}) {
  const phase = lifecyclePhase(record);
  const [confirmingUninstall, setConfirmingUninstall] = React.useState(false);

  return (
    <div className="border-border flex flex-col gap-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <span className="text-sm font-medium">{record.app_id}</span>
          <span className="text-muted-foreground text-xs">
            {record.active.app_version} · {lifecycleGuidance(record)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={phase === "enabled" ? "default" : "outline"}>{phase.replace(/_/g, " ")}</Badge>
          {phase === "enabled" ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={onDisable}>
              Turn off
            </Button>
          ) : phase === "disabled" ? (
            <Button size="sm" disabled={busy} onClick={onEnable}>
              Turn on
            </Button>
          ) : null}
        </div>
      </div>

      {phase === "update_pending_review" && record.pending ? (
        <Alert>
          <AlertTitle className="text-xs">
            Update to {record.pending.app_version} is waiting for you
          </AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <span className="text-xs">
              It asks for more than you approved, so it has not been applied.
            </span>
            <Button size="sm" className="self-start" disabled={busy} onClick={onApproveUpdate}>
              Review and apply
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/*
        What this app still needs, in the app author's own words. Shown whenever
        anything is outstanding — not only in the `needs_setup` phase — because
        an optional requirement that is unset is why a feature is quietly
        missing, and that is worth saying before the user goes looking.
      */}
      {requirements.some((requirement) => !requirement.configured) ? (
        <div className="border-border/60 flex flex-col gap-2 rounded-md border border-dashed p-2">
          <span className="text-xs font-medium">What this app needs</span>
          {requirements.map((requirement) => (
            <div key={requirement.key} className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-col">
                <span className="text-xs">
                  {requirement.label}
                  <span className="text-muted-foreground">
                    {" — "}
                    {requirement.configured
                      ? "set"
                      : requirement.required
                        ? "needed before this app can run"
                        : "optional"}
                  </span>
                </span>
                {requirement.description ? (
                  <span className="text-muted-foreground text-xs">{requirement.description}</span>
                ) : null}
                {requirement.docsUrl ? (
                  <a
                    className="text-muted-foreground text-xs underline"
                    href={requirement.docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Where to get this
                  </a>
                ) : null}
              </div>
              {requirement.configured ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={() => onEditEnvironment(requirement.key)}
                >
                  Set it
                </Button>
              )}
            </div>
          ))}
          <span className="text-muted-foreground text-xs">
            OpenWork keeps these values. This app is only told whether they are set.
          </span>
        </div>
      ) : null}

      {record.granted_permissions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {record.granted_permissions.map((permission) => (
            <Button
              key={permission.id}
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[11px]"
              disabled={busy}
              onClick={() => onRevoke(permission.id)}
              title="Take this back. The app stops until you turn it on again."
            >
              {permission.id} ✕
            </Button>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        {record.previous ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={onRollback}>
            Roll back to {record.previous.app_version}
          </Button>
        ) : null}
        {confirmingUninstall ? (
          <>
            <span className="text-muted-foreground text-xs">Keep this app&rsquo;s data?</span>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onUninstall(false)}>
              Keep it
            </Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => onUninstall(true)}>
              Delete it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmingUninstall(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setConfirmingUninstall(true)}
          >
            <Trash2 className="size-3.5" /> Uninstall
          </Button>
        )}
      </div>
    </div>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "That did not work.";
}

function diagnosticsOf(error: unknown): string[] {
  if (!(error instanceof Error)) return [];
  const details = (error as { details?: { diagnostics?: Array<{ message?: string }> } }).details;
  return (details?.diagnostics ?? [])
    .map((entry) => entry.message)
    .filter((message): message is string => typeof message === "string");
}
