"use client";

import type { GatewayApiKey } from "@openwork/types/den/gateway-api-keys";
import { gatewayApiKeyExpired } from "@openwork/types/den/gateway-api-keys";
import { gatewayUsageLimitGroups } from "@openwork/types/den/gateway-member-usage";
import { ArrowUpRight, Download, Globe, KeyRound, Lock, MessageCircle, Plus, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState, type ReactNode } from "react";
import { DenBrandMark } from "../../../_components/ui/brand-mark";
import { DenButton } from "../../../_components/ui/button";
import { DASHBOARD_PAGE_CLASS, SECTION_TITLE_CLASS } from "../../../_components/ui/dashboard-styles";
import { DenNotice } from "../../../_components/ui/notice";
import { DenPageHeader } from "../../../_components/ui/page-header";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import {
  getLibraryMyAgentRoute,
  getMyUsageRoute,
  getOrgAccessFlags,
  getWebRoute,
  type DenOrgContext,
} from "../../../_lib/den-org";
import { formatExpiry, formatLastUsed, useMyGatewayApiKeys, useRevokeGatewayApiKey } from "../../_components/gateway-api-keys-data";
import { GatewayToolSetupRow } from "../../_components/gateway-tool-setup-dialog";
import { ItemMenu, ItemRow, ItemRowsSkeleton, LinkButton } from "../../_components/item-list";
import { useLibrary } from "../../_components/library-data";
import { useLibraryModels } from "../../_components/library-models-data";
import { CreateGatewayApiKeyDialog, SetUpGatewayApiKeyDialog } from "../../_components/member-gateway-api-keys-section";
import { myAgentAvailable } from "../../_components/my-agent-availability";
import { useWorkbotEntry } from "../../_components/workbot-entry-dialog";
import { workbotEntryHref } from "../../_lib/workbot-entry";
import { useDenFlow } from "../../../_providers/den-flow-provider";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { useMyComputers } from "../computers/my-computers-data";
import { LimitRow } from "../my-usage/my-usage-screen";
import { useAskForMoreUsage, useMyGatewayLimits } from "../my-usage/my-usage-data";
import { keyExpiresIn, memberHomeNeeds, memberHomeState, type MemberHomeNeed } from "./member-home";

const MUTED = "text-[color:var(--dls-text-secondary)]";
const INK = "text-[color:var(--dls-text-primary)]";
const OPEN_APP_URL = "openwork://open";
const INSTALL_ROUTE = "/install";

export function MemberHomeScreen({ orgContext }: { orgContext: DenOrgContext }) {
  const { orgId, activeOrg } = useOrgDashboard();
  const { runtimeConfigLoaded } = useDenFlow();
  const orgSlug = activeOrg?.slug ?? null;
  const organizationId = orgContext.organization.id;
  const ready = orgId === organizationId;
  const library = useLibrary();
  const models = useLibraryModels(ready);
  const keys = useMyGatewayApiKeys();
  const [creatingKey, setCreatingKey] = useState(false);

  const needs = memberHomeNeeds({
    orgSlug,
    library: library.data ?? [],
    providers: models.data ?? [],
    apiKeys: keys.data?.apiKeys ?? [],
    keysEnabled: keys.data?.enabled === true,
    now: Date.now(),
  });

  return (
    <div className={`${DASHBOARD_PAGE_CLASS} grid max-w-[860px]! gap-10`} data-testid="member-home">
      <DenPageHeader size="compact" title="Home" state={memberHomeState(orgContext.organization.name, needs.length)} />
      <LaunchTiles orgContext={orgContext} orgSlug={orgSlug} ready={ready} showWeb={runtimeConfigLoaded && orgContext.capabilities.openworkWeb} />
      {needs.length > 0 ? (
        <Section title="Needs you" count={needs.length} testId="member-home-needs">
          {needs.map((need) => <NeedRow key={`${need.kind}:${need.id}`} need={need} onReplaceKey={() => setCreatingKey(true)} />)}
        </Section>
      ) : null}
      {ready ? <Spend orgId={organizationId} orgSlug={orgSlug} /> : null}
      <ApiKeys keys={keys} creating={creatingKey} onCreating={setCreatingKey} />
      {myAgentAvailable(orgContext) ? (
        <p className={`text-[12px] leading-5 ${MUTED}`} data-testid="member-home-elsewhere">
          <Link href={getLibraryMyAgentRoute(orgSlug)} className="underline underline-offset-2 hover:text-[color:var(--dls-text-primary)]" data-testid="member-home-my-bot">My bot settings</Link>
        </p>
      ) : null}
    </div>
  );
}

function LaunchTiles({ orgContext, orgSlug, ready, showWeb }: { orgContext: DenOrgContext; orgSlug: string | null; ready: boolean; showWeb: boolean }) {
  const organizationId = orgContext.organization.id;
  const member = orgContext.currentMember;
  const access = getOrgAccessFlags(member.role, member.isOwner, member.permissions);
  const computers = useMyComputers(organizationId, member.id, ready);
  const workbot = useWorkbotEntry({ orgId: organizationId, orgSlug, orgContext, access, enabled: ready });
  const installed = (computers.data?.length ?? 0) > 0;
  const showWorkbot = orgContext.capabilities.workbot === true && workbot.entry.kind !== "off";
  const workbotHref = workbotEntryHref(organizationId);
  const count = 1 + (showWorkbot ? 1 : 0) + (showWeb ? 1 : 0);
  const columns = count === 3 ? "sm:grid-cols-3" : count === 2 ? "sm:grid-cols-2" : "";

  return (
    <div className={`grid grid-cols-1 gap-3 ${columns}`} data-testid="member-home-open">
      <LaunchTile
        primary
        testId="member-home-desktop"
        mark={<img src="/openwork-mark.svg" alt="" aria-hidden className="h-5 w-5" />}
        name="OpenWork Desktop"
        line={installed ? "Open the app on this computer" : `Download the app, already connected to ${orgContext.organization.name}`}
        action={installed ? "Open" : "Download"}
        icon={installed ? ArrowUpRight : Download}
        href={installed ? OPEN_APP_URL : INSTALL_ROUTE}
        secondary={installed ? { label: "Download for another computer", href: INSTALL_ROUTE } : { label: "Already installed? Open it", href: OPEN_APP_URL }}
      />
      {showWorkbot ? (
        <LaunchTile
          testId="member-home-workbot"
          mark={<MessageCircle size={18} className="text-gray-600" aria-hidden />}
          name="Workbot"
          line="Ask your team's agent in chat"
          action="Open"
          icon={ArrowUpRight}
          href={workbotHref}
          onOpen={() => workbot.interceptNavigation(workbotHref)}
        />
      ) : null}
      {showWeb ? (
        <LaunchTile
          testId="member-home-web"
          mark={<Globe size={18} className="text-gray-600" aria-hidden />}
          name="OpenWork Web"
          line="The app, in your browser"
          action="Open"
          icon={ArrowUpRight}
          href={getWebRoute(orgSlug)}
        />
      ) : null}
      {workbot.dialog}
    </div>
  );
}

function LaunchTile({ mark, name, line, action, icon: Icon, href, onOpen, secondary, primary = false, testId }: {
  mark: ReactNode;
  name: string;
  line: string;
  action: string;
  icon: LucideIcon;
  href: string;
  onOpen?: () => boolean;
  secondary?: { label: string; href: string };
  primary?: boolean;
  testId: string;
}) {
  return (
    <div className="group relative flex min-h-[132px] flex-col justify-between gap-4 rounded-2xl border border-[var(--den-shell-line)] bg-[var(--den-shell-topbar)] p-4 transition-colors duration-150 ease-out hover:border-gray-300 has-[[data-tile-link]:focus-visible]:outline has-[[data-tile-link]:focus-visible]:outline-2 has-[[data-tile-link]:focus-visible]:outline-offset-2 has-[[data-tile-link]:focus-visible]:outline-gray-900">
      <span className="flex w-full items-start justify-between gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] border border-[var(--den-shell-line)] bg-white">{mark}</span>
        <span aria-hidden className={`inline-flex h-7 items-center gap-1 rounded-lg px-2.5 text-[12px] font-medium transition-colors ${primary ? "bg-gray-900 text-white" : "text-gray-500 group-hover:bg-[var(--dls-hover)] group-hover:text-gray-900"}`}>
          {action}
          <Icon size={13} aria-hidden />
        </span>
      </span>
      <span className="min-w-0">
        <a
          href={href}
          data-tile-link
          data-testid={testId}
          aria-label={`${action} ${name}`}
          onClick={(event) => { if (onOpen?.()) event.preventDefault(); }}
          className={`block text-[14px] font-semibold leading-5 tracking-[-0.01em] outline-none after:absolute after:inset-0 after:rounded-2xl ${INK}`}
        >
          {name}
        </a>
        <span className={`mt-0.5 block text-[12px] leading-4 ${MUTED}`}>{line}</span>
        {secondary ? (
          <a href={secondary.href} data-testid={`${testId}-secondary`} className={`relative z-10 mt-1.5 inline-block rounded-sm text-[12px] leading-4 underline underline-offset-2 hover:text-[color:var(--dls-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-900 ${MUTED}`}>
            {secondary.label}
          </a>
        ) : null}
      </span>
    </div>
  );
}

function Section({ title, count, meta, action, testId, children }: {
  title: string;
  count?: number;
  meta?: ReactNode;
  action?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col" data-testid={testId}>
      <div className="flex min-h-9 items-center justify-between gap-4 border-b border-[var(--den-list-line)] pb-1.5">
        <h2 id={id} className={`flex items-center gap-2 ${SECTION_TITLE_CLASS}`}>
          {title}
          {count === undefined ? null : <span className={`text-[12px] font-normal tabular-nums ${MUTED}`}>{count}</span>}
        </h2>
        {action ?? (meta ? <p className={`text-[12px] leading-4 ${MUTED}`}>{meta}</p> : null)}
      </div>
      <div className="flex flex-col [&>*]:border-b [&>*]:border-[var(--den-list-line)]">{children}</div>
    </section>
  );
}

function NeedRow({ need, onReplaceKey }: { need: MemberHomeNeed; onReplaceKey: () => void }) {
  if (need.kind === "key") {
    return (
      <ItemRow
        testId="member-home-need"
        logo={<span className="flex size-8 items-center justify-center rounded-lg bg-[var(--dls-hover)] text-gray-500"><KeyRound size={16} aria-hidden /></span>}
        title={`${need.name} ${keyExpiresIn(need.daysLeft)}`}
        wideAction
        action={<DenButton size="sm" variant="secondary" onClick={onReplaceKey}>New key</DenButton>}
      />
    );
  }
  return (
    <ItemRow
      testId="member-home-need"
      logo={need.kind === "connection"
        ? <DenBrandMark name={need.name} serviceUrl={need.serviceUrl} className="size-8 rounded-lg" imageClassName="size-4" />
        : <DenBrandMark name={need.name} simpleIconSlug={need.iconSlug} className="size-8 rounded-lg" imageClassName="size-4" />}
      title={`Sign in to ${need.name}`}
      wideAction
      action={<LinkButton href={need.href} size="sm" variant="secondary">Sign in</LinkButton>}
    />
  );
}

function Spend({ orgId, orgSlug }: { orgId: string; orgSlug: string | null }) {
  const limits = useMyGatewayLimits(orgId);
  const ask = useAskForMoreUsage(orgId);
  const [askingId, setAskingId] = useState<string | null>(null);
  const groups = limits.data ? gatewayUsageLimitGroups(limits.data) : [];
  const labelled = groups.some((group) => group.providerName !== null);
  return (
    <Section
      title="Your spend"
      testId="member-home-limits"
      meta={<Link href={getMyUsageRoute(orgSlug)} className="underline underline-offset-2 hover:text-[color:var(--dls-text-primary)]" data-testid="member-home-usage-link">See all your usage</Link>}
    >
      {limits.isPending ? (
        <div role="status" aria-label="Loading your spend" className="grid gap-2 py-3"><DenSkeleton className="h-4 w-40" /><DenSkeleton className="h-4 w-64" /></div>
      ) : limits.isError ? (
        <div className="flex flex-col items-start gap-3 py-3" role="alert">
          <DenNotice tone="error" message={limits.error.message} />
          <DenButton size="sm" variant="secondary" disabled={limits.isFetching} onClick={() => void limits.refetch()}>Try again</DenButton>
        </div>
      ) : groups.length === 0 ? (
        <div className="flex min-h-12 flex-wrap items-center gap-3 py-2" data-testid="member-home-no-limit">
          <span className={`text-[13px] font-medium ${INK}`}>No limit</span>
          <span className={`text-[13px] ${MUTED}`}>Nothing pauses your models.</span>
        </div>
      ) : groups.map((group) => (
        <div key={group.key}>
          {labelled ? <h3 className={`pt-3 text-[12px] font-medium ${INK}`}>{group.providerName === null ? "Other providers" : `Only ${group.providerName}`}</h3> : null}
          <ul className="[&>li]:px-0">
            {group.buckets.map((bucket) => (
              <LimitRow key={bucket.id} bucket={bucket} asking={askingId === bucket.id} stale={limits.isError}
                pending={ask.isPending} error={ask.isError ? ask.error.message : null}
                onAsk={() => { ask.reset(); setAskingId(bucket.id); }}
                onCancel={() => { ask.reset(); setAskingId(null); }}
                onSubmit={(reason) => ask.mutate({ bucketId: bucket.id, reason }, { onSuccess: () => setAskingId(null) })} />
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

function ApiKeys({ keys, creating, onCreating }: { keys: ReturnType<typeof useMyGatewayApiKeys>; creating: boolean; onCreating: (open: boolean) => void }) {
  const revoke = useRevokeGatewayApiKey("mine");
  const [settingUp, setSettingUp] = useState<GatewayApiKey | null>(null);

  if (keys.isPending) {
    return <Section title="API keys for other tools" testId="member-home-keys"><ItemRowsSkeleton label="Loading your API keys" rows={2} /></Section>;
  }
  if (!keys.data) return null;
  const { enabled, baseUrl, apiKeys } = keys.data;
  if (!enabled && apiKeys.length === 0) return null;

  return (
    <Section
      title="API keys for other tools"
      count={apiKeys.length}
      testId="member-home-keys"
      action={enabled ? <DenButton size="sm" variant="secondary" icon={Plus} onClick={() => onCreating(true)} data-testid="member-home-create-key">Create key</DenButton> : null}
    >
      {!enabled ? (
        <p className="flex items-center gap-1.5 py-3 text-[13px] text-gray-500" data-testid="member-home-keys-disabled">
          <Lock size={12} aria-hidden="true" />
          Turned off by your organization. Your keys don&apos;t work until an admin turns 3rd party tools back on in Settings.
        </p>
      ) : null}
      {apiKeys.length === 0 ? (
        <div className="flex flex-col gap-1 py-3" data-testid="member-home-keys-empty">
          <p className={`text-[13px] ${MUTED}`}>Use your team&apos;s models in the tools you already have. Pick one to set it up.</p>
          <div className="-mx-2"><GatewayToolSetupRow enabled={enabled} baseUrl={baseUrl} /></div>
        </div>
      ) : apiKeys.map((apiKey) => (
        <ItemRow
          key={apiKey.id}
          testId="member-home-key"
          logo={<span className="flex size-8 items-center justify-center rounded-lg bg-[var(--dls-hover)] text-gray-500"><KeyRound size={16} aria-hidden /></span>}
          title={apiKey.name}
          description={<span className="font-mono">{apiKey.prefix}…</span>}
          status={gatewayApiKeyExpired(apiKey.expiresAt)
            ? <span className="font-medium text-red-600">{formatExpiry(apiKey.expiresAt)}</span>
            : <span className="inline-flex gap-3"><span>{formatExpiry(apiKey.expiresAt)}</span><span>{formatLastUsed(apiKey.lastUsedAt)}</span></span>}
          action={(
            <ItemMenu
              label={`Actions for ${apiKey.name}`}
              entries={[{ label: "Set up", onSelect: () => setSettingUp(apiKey) }, {
                label: "Revoke",
                destructive: true,
                confirm: {
                  title: `Revoke ${apiKey.name}?`,
                  description: "Tools using this key stop working right away. This can't be undone.",
                  action: "Revoke key",
                },
                onSelect: async () => { await revoke.mutateAsync(apiKey.id); },
              }]}
            />
          )}
        />
      ))}
      <CreateGatewayApiKeyDialog open={creating} baseUrl={baseUrl} onClose={() => onCreating(false)} />
      <SetUpGatewayApiKeyDialog apiKey={settingUp} baseUrl={baseUrl} onClose={() => setSettingUp(null)} />
    </Section>
  );
}
