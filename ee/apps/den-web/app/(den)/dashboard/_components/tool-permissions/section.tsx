import { Switch } from "@base-ui/react/switch";
import { TOOL_PERMISSION_EVERY_TOOL, type ToolPermissionAccess, type ToolPermissionSubject } from "@openwork/types/den/tool-permissions";
import { Lock } from "lucide-react";
import { useId, useRef, useState } from "react";
import { DenButton } from "../../../_components/ui/button";
import { DenSkeleton } from "../../../_components/ui/skeleton";
import type { DenOrgContext } from "../../../_lib/den-org";
import { toolTitle } from "../connector-setup";
import type { ExternalMcpTool, useMcpConnectionTools } from "../mcp-connections-data";
import { AudiencePicker, everyone } from "./audience-picker";
import { useSetToolRule, useToolPermissions } from "./data";
import { accessChoices, accessForTool, accessLabels, defaultToolAccess, everyoneLabel, rulesForSubject, toolActivityLabel, withPendingRule } from "./model";

const muted = "text-[13px] text-[var(--dls-text-secondary)]";
const errorText = "text-[13px] text-[var(--ow-danger)]";
const blockAllLabel = "Block this whole connection";
const saveError = "Could not save this change. Try again.";

type AccessMap = ReadonlyMap<string, ToolPermissionAccess>;

function ToolRow({ name, tool, ownRules, orgRules, layers, everyoneSelected, busy, failed, save }: {
  name: string;
  tool?: ExternalMcpTool;
  ownRules: AccessMap;
  orgRules: AccessMap;
  layers: readonly AccessMap[];
  everyoneSelected: boolean;
  busy: boolean;
  failed: boolean;
  save: (rule: ToolPermissionAccess | null) => void;
}) {
  const reasonId = useId();
  const title = tool ? toolTitle(tool) : name;
  const fallback = tool ? defaultToolAccess(tool.annotations) : null;
  const ownRule = ownRules.get(name);
  const organization = accessForTool(name, fallback, [orgRules]);
  const effective = accessForTool(name, fallback, layers);
  const locked = !everyoneSelected && organization.rule === "block"
    ? "Blocked for everyone. An admin can change this under Everyone."
    : ownRules.has(TOOL_PERMISSION_EVERY_TOOL) ? "Turn off the whole connection block to change this." : null;
  return <li data-tool-row={name} className="min-h-11 py-1">
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="min-w-0 text-[13px]">
        <span className="break-words font-medium">{title}</span>
        {tool ? <span className={`ml-2 ${muted}`}>{toolActivityLabel(tool.annotations)}</span> : null}
        {!everyoneSelected ? <div className={muted}>{everyoneLabel(organization)}</div> : null}
        {locked ? <div id={reasonId} className={`flex items-center gap-1.5 ${muted}`}>
          <Lock className="size-4 shrink-0" strokeWidth={1.5} aria-hidden />{locked}
        </div> : null}
      </div>
      <div className="flex flex-wrap items-center gap-x-2">
        {ownRule && ownRule !== effective.access ? <span className={muted}>Saved: {accessLabels[ownRule]}</span> : null}
        {!effective.rule && fallback ? <span className={muted}>Default</span> : null}
        <div role="group" aria-label={`Access for ${title}`} aria-describedby={locked ? reasonId : undefined}
          className="inline-flex items-center rounded-lg bg-[var(--dls-hover)] p-0.5">
          {accessChoices.map((choice) => <DenButton key={choice} size="xs" data-tool-access={choice} aria-pressed={effective.access === choice}
            variant={effective.access === choice ? effective.rule ? "plain" : "ghost" : "ghost"}
            className={effective.access === choice ? "bg-[var(--dls-surface)]" : undefined}
            disabled={busy || !tool || Boolean(locked)} onClick={() => { if (choice !== ownRule) save(choice); }}>
            {accessLabels[choice]}
          </DenButton>)}
        </div>
        {ownRule ? <DenButton variant="ghost" size="xs" data-tool-default="" aria-label={`Use the default for ${title}`}
          disabled={busy} onClick={() => save(null)}>Use the default</DenButton> : null}
      </div>
    </div>
    {failed ? <p role="alert" className={errorText}>{saveError}</p> : null}
  </li>;
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
  const memberTeamRules = subject.kind === "member" ? org.teams.filter(({ memberIds }) => memberIds.includes(subject.id))
    .map(({ id }) => rulesForSubject(rules, connectionId, { kind: "team", id })) : [];
  const layers = everyoneSelected ? [orgRules] : [orgRules, ownRules, ...memberTeamRules];
  const blockAll = ownRules.get(TOOL_PERMISSION_EVERY_TOOL) === "block";
  const liveTools = signedIn ? catalog.data?.tools ?? [] : [];
  const toolsByName = new Map(liveTools.filter(({ name }) => name !== TOOL_PERMISSION_EVERY_TOOL).map((tool) => [tool.name, tool]));
  const names = new Set(toolsByName.keys());
  for (const rule of confirmedRules) {
    if (rule.toolName !== TOOL_PERMISSION_EVERY_TOOL && layers.some((layer) => layer.has(rule.toolName))) names.add(rule.toolName);
  }
  if (mutation.isPending && mutation.variables.toolName !== TOOL_PERMISSION_EVERY_TOOL) names.add(mutation.variables.toolName);
  const busy = !permissions.data || mutation.isPending;
  const failedTool = mutation.isError ? mutation.variables?.toolName : undefined;

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
    <div className="flex min-h-11 items-center justify-between gap-3 border-t border-[var(--dls-border)] text-[13px] font-medium">
      <span>{blockAllLabel}</span>
      <Switch.Root render={<button type="button" />} nativeButton aria-label={blockAllLabel} data-tool-permissions-block-all="" checked={blockAll} disabled={busy}
        onCheckedChange={(checked) => save(TOOL_PERMISSION_EVERY_TOOL, checked ? "block" : null)}
        className="flex h-6 w-10 shrink-0 items-center rounded-full bg-[var(--dls-border)] p-0.5 data-checked:bg-[var(--dls-accent)] disabled:cursor-not-allowed disabled:opacity-60">
        <Switch.Thumb className="size-5 rounded-full bg-[var(--dls-surface)] shadow-xs motion-safe:transition-transform data-checked:translate-x-4" />
      </Switch.Root>
    </div>
    {failedTool === TOOL_PERMISSION_EVERY_TOOL ? <p role="alert" className={errorText}>{saveError}</p> : null}
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
    {permissions.isPending || (signedIn && catalog.isLoading) ? <div aria-busy="true" aria-label="Loading tool permissions" className="space-y-2">
      <DenSkeleton className="h-10 w-full" />
      <DenSkeleton className="h-10 w-full" />
    </div> : null}
    {permissions.data && names.size > 0 ? <ul className="divide-y divide-[var(--dls-border)] border-y border-[var(--dls-border)]">
      {[...names].map((name) => <ToolRow key={name} name={name} tool={toolsByName.get(name)} ownRules={ownRules} orgRules={orgRules}
        layers={layers} everyoneSelected={everyoneSelected} busy={busy} failed={failedTool === name} save={(rule) => save(name, rule)} />)}
    </ul> : null}
    {permissions.data && signedIn && catalog.isSuccess && names.size === 0 ? <p className={muted}>This connection has no tools to manage.</p> : null}
  </section>;
}
