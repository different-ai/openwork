"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Lock } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  AGENT_TOOL_DECISION_COPY,
  type AgentConnectionToolsView,
  type AgentSourcesPolicyInput,
  type AgentToolDecisionView,
} from "@openwork/types/den/workbot-proactive";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenSwitch } from "../../_components/ui/switch";
import type { AgentPolicyScope } from "./workbot-agent-scope";
import { useAgentConnectionTools } from "./workbot-proactive-data";

/**
 * Manage › Workbot › Connectors, under one connection (`workbotAgentBrief`): a read-tools count opens
 * a dialog (DESIGN.md S3) with one row per tool (S2): its name, why it is or isn't allowed, and a switch
 * for the admin's choice. A tool no admin can allow (its provider marks it destructive, or one of Den's own operations
 * that changes things) keeps its row with a lock and the reason (P4). Agents only ever call the allowed ones.
 * The same rows show a team's choices on its Workbot tab (`scope`).
 */

/** "3 read tools", "1 read tool", "No read tools". */
export function readToolsLine(count: number): string {
  if (count === 0) return "No read tools";
  return `${count} read tool${count === 1 ? "" : "s"}`;
}

/** The summary's state: how many tools agents may call, or why that isn't known. */
export function toolsSummary(view: AgentConnectionToolsView | undefined, failed: boolean, name: string): string {
  if (failed) return "Couldn't load its tools";
  if (!view) return "";
  if (view.status === "needs_connection") return `Connect ${name} to see its tools`;
  if (view.status === "unavailable") return `${name} didn't answer`;
  return readToolsLine(view.readTools);
}

/** The admin's choice for one tool, as a sources change: on is "allow", off is "deny". */
export function toolChoiceChange(connectionId: string, tool: string, allowed: boolean): AgentSourcesPolicyInput {
  return { toolOverrides: { [connectionId]: { [tool]: allowed ? "allow" : "deny" } } };
}

/** Back to the automatic decision for every tool on this connection. */
export function automaticToolsChange(connectionId: string): AgentSourcesPolicyInput {
  return { toolOverrides: { [connectionId]: null } };
}

/**
 * In tabbed settings: the same tools and choices, opened from a "Manage tools" button on the connection's own
 * row instead of a second line under it. The row keeps one line (the count beside the button); the dialog has room
 * for each tool's description, why it is or isn't allowed, and its switch.
 */
export function AgentConnectionToolsButton({ orgId, scope, connectionId, name, connectHref, disabled, onChange }: {
  orgId: string;
  /** Whose choices: Everyone's, or one team's. */
  scope?: AgentPolicyScope;
  connectionId: string;
  name: string;
  connectHref: string;
  disabled: boolean;
  onChange: (change: AgentSourcesPolicyInput) => void;
}) {
  const query = useAgentConnectionTools(orgId, connectionId, true, scope);
  return <ConnectionToolsButton view={query.data} failed={query.isError} name={name} connectionId={connectionId} connectHref={connectHref} disabled={disabled} onChange={onChange} />;
}

function DialogToolRow({ tool, connectionId, disabled, onChange }: { tool: AgentToolDecisionView; connectionId: string; disabled: boolean; onChange: (change: AgentSourcesPolicyInput) => void }) {
  const label = tool.title && tool.title !== tool.name ? tool.title : tool.name;
  const reason = tool.locked ? `${AGENT_TOOL_DECISION_COPY[tool.reason]}. No one can allow it.` : AGENT_TOOL_DECISION_COPY[tool.reason];
  return (
    <div className="flex items-start justify-between gap-4 py-3" data-testid={`workbot-agent-tool-${tool.name}`} data-allowed={tool.allowed} data-locked={tool.locked}>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-[13px] font-medium text-gray-900">{label}</span>
        {tool.description ? <span className="line-clamp-2 text-[12px] leading-4 text-gray-600">{tool.description}</span> : null}
        <span className="text-[12px] leading-4 text-gray-500">{reason}</span>
      </span>
      {tool.locked ? (
        <span className="flex h-5 w-9 shrink-0 items-center justify-center">
          <Lock size={14} strokeWidth={1.5} className="text-gray-500" role="img" aria-label={`${tool.name}: ${reason}`} />
        </span>
      ) : (
        <DenSwitch size="sm" aria-label={`Agents may use ${tool.name}`} checked={tool.allowed} disabled={disabled}
          onChange={(allowed) => onChange(toolChoiceChange(connectionId, tool.name, allowed))} />
      )}
    </div>
  );
}

/** The link's words: how many tools agents may call, or why that isn't known, short enough for a row. */
export function toolsLinkLabel(view: AgentConnectionToolsView | undefined, failed: boolean): string {
  if (failed) return "Couldn't load tools";
  if (!view) return "Tools";
  if (view.status === "needs_connection") return "Connect to see tools";
  if (view.status === "unavailable") return "Tools unavailable";
  return readToolsLine(view.readTools);
}

/** The link and its dialog, from a loaded view (rendered without fetching in tests). */
export function ConnectionToolsButton({ view, failed, name, connectionId, connectHref, disabled, onChange, initialOpen = false }: {
  view: AgentConnectionToolsView | undefined;
  failed: boolean;
  name: string;
  connectionId: string;
  connectHref: string;
  disabled: boolean;
  onChange: (change: AgentSourcesPolicyInput) => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <span className="flex min-w-0 items-center" data-testid={`workbot-agent-tools-${connectionId}`} data-read-tools={view?.readTools ?? ""}>
      <button
        type="button"
        aria-label={`Manage tools for ${name}: ${toolsLinkLabel(view, failed)}`}
        onClick={() => setOpen(true)}
        className="truncate rounded text-[12px] text-gray-600 underline decoration-gray-300 underline-offset-2 hover:text-gray-900 hover:decoration-gray-500 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gray-400"
      >
        {toolsLinkLabel(view, failed)}
      </button>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/20" />
          <Dialog.Popup
            data-testid={`workbot-agent-tools-dialog-${connectionId}`}
            className="fixed left-1/2 top-1/2 z-50 flex max-h-[min(640px,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-gray-100 bg-white outline-none"
          >
            <ConnectionToolsContent view={view} failed={failed} name={name} connectionId={connectionId} connectHref={connectHref} disabled={disabled} onChange={onChange} />
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </span>
  );
}

/** The dialog contents, shared with render tests so the real tool rows and permission locks are covered. */
export function ConnectionToolsContent({ view, failed, name, connectionId, connectHref, disabled, onChange }: {
  view: AgentConnectionToolsView | undefined;
  failed: boolean;
  name: string;
  connectionId: string;
  connectHref: string;
  disabled: boolean;
  onChange: (change: AgentSourcesPolicyInput) => void;
}) {
  const state = toolsSummary(view, failed, name);
  const chosen = view?.tools.some((tool) => tool.override !== null) ?? false;
  return (
    <>
      <div className="px-6 pt-5">
        <Dialog.Title className="text-[16px] font-semibold leading-6 text-gray-900">{`${name}: tools agents may use`}</Dialog.Title>
        <Dialog.Description className="mt-1 text-[13px] text-gray-500">
          {state ? `${state}. ` : ""}Choose which tools members' agents may call.
        </Dialog.Description>
      </div>
      <div className="mt-3 min-h-0 flex-1 divide-y divide-gray-100 overflow-y-auto border-t border-gray-100 px-6" data-testid={`workbot-agent-tools-list-${connectionId}`}>
        {view?.status === "needs_connection" ? (
          <p className="py-3 text-[13px] text-gray-500">
            <Link href={connectHref} className="font-medium text-gray-900 underline-offset-2 hover:underline">{`Connect ${name}`}</Link>
            {" to see its tools."}
          </p>
        ) : null}
        {!view && !failed ? <p className="py-3 text-[13px] text-gray-500">Loading tools</p> : null}
        {view?.status === "ready" && view.tools.length === 0 ? <p className="py-3 text-[13px] text-gray-500">It lists no tools.</p> : null}
        {view?.status === "ready" ? view.tools.map((tool) => <DialogToolRow key={tool.name} tool={tool} connectionId={connectionId} disabled={disabled} onChange={onChange} />) : null}
        {view?.coreSourcesElsewhere ? <p className="py-3 text-[12px] text-gray-500">The calendar is read under its own setting.</p> : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-gray-100 px-6 py-4">
        {chosen ? (
          <DenButton variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(automaticToolsChange(connectionId))}>Use automatic choices</DenButton>
        ) : <span />}
        <Dialog.Close className={buttonVariants({ variant: "primary", size: "sm" })}>Done</Dialog.Close>
      </div>
    </>
  );
}
