import { Switch } from "@base-ui/react/switch";
import { TOOL_PERMISSION_EVERY_TOOL, type ToolPermissionAccess, type ToolPermissionSubject } from "@openwork/types/den/tool-permissions";
import { Lock } from "lucide-react";
import { type ReactNode, useId, useRef, useState } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import type { DenOrgContext } from "../../../_lib/den-org";
import { toolTitle } from "../connector-setup";
import type { ExternalMcpTool, useMcpConnectionTools } from "../mcp-connections-data";
import { AudiencePicker, everyone } from "./audience-picker";
import { useSetToolRule, useToolPermissions } from "./data";
import { accessChoices, accessLabels, defaultToolAccess, rulesForSubject, toolActivityLabel, toolRowAccess, withPendingRule } from "./model";

const muted = "text-[13px] text-[var(--dls-text-secondary)]";
const errorText = "text-[13px] text-[var(--ow-danger)]";
const blockAllLabel = "Block this whole connection";
const textLine = "min-w-0 truncate leading-5";
const listClass = "@container divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]";

function ToolRowLayout({ name, primary, secondary, control }: {
  name?: string;
  primary: ReactNode;
  secondary?: ReactNode;
  control: ReactNode;
}) {
  return <li data-tool-row={name} className="grid min-h-11 grid-cols-1 items-center gap-x-4 gap-y-1 py-1 @[40rem]:grid-cols-[minmax(0,1fr)_23rem]">
    <div className="min-w-0 text-[13px]">{primary}{secondary}</div>
    {control}
  </li>;
}

function ToolRow({ access, name, tool, busy, connectionBlockId, save }: {
  access: ReturnType<typeof toolRowAccess>;
  name: string;
  tool?: ExternalMcpTool;
  busy: boolean;
  connectionBlockId?: string;
  save: (rule: ToolPermissionAccess | null) => void;
}) {
  const reasonId = useId();
  const title = tool ? toolTitle(tool) : name;
  const { pressed, defaultLabel, notice, lockedByEveryone } = access;
  return <ToolRowLayout name={name}
    primary={<div className={textLine} title={title}>
      <span className="font-medium">{title}</span>
      {tool ? <span className={`ml-2 ${muted}`}>{toolActivityLabel(tool.annotations)}</span> : null}
    </div>}
    secondary={notice ? <div id={reasonId} className={`flex items-center gap-1.5 ${muted}`}>
      {lockedByEveryone && !connectionBlockId ? <Lock className="size-4 shrink-0" strokeWidth={1.5} aria-hidden /> : null}
      <span className={textLine} title={notice}>{notice}</span>
    </div> : null}
    control={<div role="group" aria-label={`Access for ${title}`} aria-describedby={connectionBlockId ?? (lockedByEveryone ? reasonId : undefined)}
      className="grid w-full grid-cols-[minmax(6rem,1fr)_repeat(3,minmax(0,1fr))] rounded-lg bg-[var(--dls-hover)] p-0.5">
      {accessChoices.map((choice) => <DenButton key={choice} size="inline" data-tool-access={choice} data-tool-default={choice === "default" ? "" : undefined}
        aria-pressed={pressed === choice} variant={pressed === choice ? "plain" : "ghost"}
        className="aria-pressed:bg-[var(--dls-surface)] focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--dls-accent)] motion-reduce:transition-none"
        disabled={busy || Boolean(connectionBlockId) || lockedByEveryone || (!tool && (choice !== "default" || pressed === "default"))}
        onClick={() => { if (choice !== pressed) save(choice === "default" ? null : choice); }}>
        {choice === "default" ? defaultLabel : accessLabels[choice]}
      </DenButton>)}
    </div>} />;
}

function ToolRowsSkeleton({ everyoneSelected }: { everyoneSelected: boolean }) {
  return <ul aria-busy="true" aria-label="Loading tool permissions" className={listClass}>
    {[0, 1].map((index) => <ToolRowLayout key={index}
      primary={<div className="flex h-5 items-center"><DenSkeleton className="h-3 w-32" /></div>}
      secondary={everyoneSelected ? null : <div className="flex h-5 items-center"><DenSkeleton className="h-3 w-40" /></div>}
      control={<DenSkeleton className="h-9 w-full" />} />)}
  </ul>;
}

function audienceName(org: DenOrgContext, subject: ToolPermissionSubject) {
  if (subject.kind === "organization") return "everyone";
  if (subject.kind === "team") {
    const team = org.teams.find(({ id }) => id === subject.id);
    return team ? `the team ${team.name}` : "this team";
  }
  const user = org.members.find(({ id }) => id === subject.id)?.user;
  return user?.name.trim() || user?.email || "this person";
}

export function ToolPermissionsSection({ org, connectionId, signedIn, catalog, onSignIn, signInLabel, signingIn }: {
  org: DenOrgContext;
  connectionId: string;
  signedIn: boolean;
  catalog: ReturnType<typeof useMcpConnectionTools>;
  onSignIn: () => void;
  signInLabel: string;
  signingIn: boolean;
}) {
  const headingId = useId();
  const connectionBlockId = useId();
  const [subject, setSubject] = useState<ToolPermissionSubject>(everyone);
  const orgId = org.organization.id;
  const permissions = useToolPermissions(orgId, connectionId);
  const mutation = useSetToolRule(orgId, connectionId);
  const saving = useRef(false);
  const everyoneSelected = subject.kind === "organization";
  const confirmedRules = permissions.data?.rules ?? [];
  const rules = withPendingRule(confirmedRules, mutation.isPending ? mutation.variables : undefined);
  const orgRules = rulesForSubject(rules, connectionId, everyone);
  const ownRules = everyoneSelected ? orgRules : rulesForSubject(rules, connectionId, subject);
  const memberTeams = subject.kind === "member" ? org.teams.filter(({ memberIds }) => memberIds.includes(subject.id))
    .map(({ id, name }) => ({ name, rules: rulesForSubject(rules, connectionId, { kind: "team", id }) })) : [];
  const layers = [orgRules, ownRules, ...memberTeams.map(({ rules }) => rules)];
  const blockAll = ownRules.get(TOOL_PERMISSION_EVERY_TOOL) === "block";
  const connectionBlocked = layers.some((layer) => layer.get(TOOL_PERMISSION_EVERY_TOOL) === "block");
  const liveTools = signedIn ? catalog.data?.tools ?? [] : [];
  const toolsByName = new Map(liveTools.filter(({ name }) => name !== TOOL_PERMISSION_EVERY_TOOL).map((tool) => [tool.name, tool]));
  const ruleOnlyNames = new Set<string>();
  for (const layer of layers) {
    for (const name of layer.keys()) {
      if (name !== TOOL_PERMISSION_EVERY_TOOL && !toolsByName.has(name)) ruleOnlyNames.add(name);
    }
  }
  if (mutation.isPending && mutation.variables.toolName !== TOOL_PERMISSION_EVERY_TOOL && !toolsByName.has(mutation.variables.toolName)) {
    ruleOnlyNames.add(mutation.variables.toolName);
  }
  const names = [...toolsByName.keys(), ...[...ruleOnlyNames].sort()];
  const loading = permissions.isPending || (signedIn && catalog.isLoading);
  const busy = !permissions.data || mutation.isPending;
  const failedTool = mutation.isError ? mutation.variables?.toolName : undefined;
  const failedCatalogTool = failedTool ? toolsByName.get(failedTool) : undefined;
  const saveError = failedTool === TOOL_PERMISSION_EVERY_TOOL ? "Could not save the connection block. Try again."
    : failedTool ? `Could not save ${failedCatalogTool ? toolTitle(failedCatalogTool) : failedTool}. Try again.` : "";
  const blockStatus = connectionBlocked ? `Every tool of this connection is blocked for ${audienceName(org, subject)}.` : "";

  function save(toolName: string, rule: ToolPermissionAccess | null) {
    if (saving.current || !permissions.data) return;
    saving.current = true;
    void mutation.mutateAsync({ subject, connectionId, toolName, rule }).catch(() => undefined).finally(() => { saving.current = false; });
  }

  return <section data-tool-permissions="" aria-labelledby={headingId} className="space-y-2">
    <h2 id={headingId} className="text-base font-semibold">Tool permissions</h2>
    <p className={muted}>A block always wins. Then Ask, then Allow. With no rule, tools that only read are allowed and tools that change something ask first.</p>
    <p className={muted}>Applies to chats, Automations, Workbot and agents.</p>
    <AudiencePicker org={org} subject={subject} disabled={mutation.isPending} onChange={(next) => {
      if (saving.current) return;
      mutation.reset();
      setSubject(next);
    }} />
    <div>
      <div className="flex min-h-11 items-center justify-between gap-3 border-t border-[var(--dls-border)] text-[13px] font-medium">
        <span>{blockAllLabel}</span>
        <Switch.Root render={<button type="button" />} nativeButton aria-label={blockAllLabel} data-tool-permissions-block-all="" checked={blockAll} disabled={busy}
          onCheckedChange={(checked) => save(TOOL_PERMISSION_EVERY_TOOL, checked ? "block" : null)}
          className="flex h-6 w-10 shrink-0 items-center rounded-full bg-[var(--dls-border)] p-0.5 data-checked:bg-[var(--dls-accent)] disabled:cursor-not-allowed disabled:opacity-60">
          <Switch.Thumb className="size-5 rounded-full bg-[var(--dls-surface)] shadow-xs motion-safe:transition-transform data-checked:translate-x-4" />
        </Switch.Root>
      </div>
      <div data-tool-permissions-status="" className="grid min-h-5 min-w-0 grid-cols-1">
        <p id={connectionBlockId} role="status" className={saveError ? "sr-only" : `${textLine} ${muted} col-start-1 row-start-1`} title={blockStatus}>{blockStatus}</p>
        <p role="alert" className={`${textLine} ${errorText} col-start-1 row-start-1`} title={saveError}>{saveError}</p>
      </div>
    </div>
    {permissions.isError ? <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className={errorText}>Could not load tool permissions.{permissions.data ? ` Last checked ${new Date(permissions.dataUpdatedAt).toLocaleString()}.` : ""}</p>
      <DenButton size="xs" variant="secondary" onClick={() => void permissions.refetch()}>Try again</DenButton>
    </div> : null}
    {!signedIn ? <div className="flex flex-wrap items-center gap-2">
      <p className={muted}>Finish connecting or sign in to see all tools. You can still remove saved rules.</p>
      <DenButton size="xs" variant="secondary" onClick={onSignIn} loading={signingIn}>{signInLabel}</DenButton>
    </div> : catalog.isError ? <div className="flex flex-wrap items-center gap-2">
      <p role="alert" className={errorText}>Could not load the tools.{catalog.data ? ` Last checked ${new Date(catalog.dataUpdatedAt).toLocaleString()}.` : " Check the connection and try again."}</p>
      <DenButton size="xs" variant="secondary" onClick={() => void catalog.refetch()}>Try again</DenButton>
    </div> : null}
    {loading ? <ToolRowsSkeleton everyoneSelected={everyoneSelected} /> : permissions.data && names.length > 0 ? <ul className={listClass}>
      {names.map((name) => {
        const tool = toolsByName.get(name);
        const access = toolRowAccess({ toolName: name, fallback: tool ? defaultToolAccess(tool.annotations) : null,
          ownRules, orgRules, memberTeams, everyoneSelected });
        return <ToolRow key={name} name={name} tool={tool} access={access} busy={busy}
          connectionBlockId={connectionBlocked ? connectionBlockId : undefined} save={(rule) => save(name, rule)} />;
      })}
    </ul> : permissions.data && signedIn && catalog.isSuccess ? <p className={muted}>This connection has no tools to manage.</p> : null}
  </section>;
}
