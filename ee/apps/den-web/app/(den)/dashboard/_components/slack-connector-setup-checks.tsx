"use client";

import { ChevronRight, ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { DenButton } from "../../_components/ui/button";
import { DenSwitch } from "../../_components/ui/switch";
import type { ConnectorTarget, useConnectorSetup } from "./connector-setup";
import { useCheckMcpConnection } from "./mcp-connections-data";
import { type SetupCheck, SetupChecks } from "./setup-checks";
import { useSlackAssistantSetupQuery } from "./slack-assistant-setup";
import {
  isSlackMcpUrl,
  SLACK_APPS_URL,
  type SlackSetupStep,
  type SlackScopeChoice,
  slackAssistantStatus,
  slackCreateAppUrl,
  slackScopesFor,
  slackSetupProgress,
  slackSetupSteps,
  slackUserOAuthManifest,
} from "./slack-connector-setup";

function CopyValue({ label, value, display }: { label: string; value: string; display?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  return (
    <div className="flex min-h-10 items-center gap-3 border-b border-gray-100 py-1.5 last:border-b-0">
      <span className="w-28 shrink-0 text-[12px] font-medium text-gray-700">{label}</span>
      <code className="min-w-0 flex-1 break-all font-mono text-[12px] text-gray-600">{display ?? value}</code>
      <DenButton size="xs" variant="secondary" onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? "Copied" : failed ? "Copy failed" : "Copy"}
      </DenButton>
    </div>
  );
}

/** For an app that already exists: the values to add to it by hand. Collapsed by default (P3). */
function ExistingAppDetails({ callbackUrl, scopes }: { callbackUrl: string; scopes: readonly string[] }) {
  const manifest = JSON.stringify(slackUserOAuthManifest({ redirectUrl: callbackUrl, scopes }), null, 2);
  return (
    <details className="group" data-testid="slack-setup-existing-app">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12px] font-medium text-gray-600 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-3.5 w-3.5 text-gray-500 transition-transform group-open:rotate-90" aria-hidden />
        Use an existing Slack app
      </summary>
      <div className="mt-2 flex flex-col">
        <CopyValue label="Redirect URL" value={callbackUrl} />
        <CopyValue label="User scopes" value={scopes.join(" ")} />
        <CopyValue label="App manifest" value={manifest} display="JSON, for Create app › From a manifest" />
      </div>
    </details>
  );
}

export type SlackSetupChecklistProps = {
  steps: SlackSetupStep[];
  callbackUrl: string | null;
  scopes: readonly string[];
  mcpConfirmed: boolean;
  onConfirmMcp: (confirmed: boolean) => void;
  /** The client ID and secret fields, owned by the setup screen. */
  oauthAppFields: ReactNode;
  onSignIn: () => void;
  onCheckAgain: () => void;
  checking: boolean;
  /** Shared checks to show first, e.g. OpenWork could not reach Slack at all. */
  leading?: SetupCheck[];
  scopeChoice: SlackScopeChoice | null;
  onChooseScopes: (choice: SlackScopeChoice) => void;
};

const SCOPE_CHOICES: { value: SlackScopeChoice; title: string; recommended?: boolean; consent: string }[] = [
  {
    value: "read_and_act",
    title: "Read and act",
    recommended: true,
    consent: "Searches and reads messages, files and canvases, and posts, reacts and creates channels as each person who signs in.",
  },
  {
    value: "read_only",
    title: "Read only",
    consent: "Searches and reads messages, files and canvases as each person who signs in. Can't post or change anything in Slack.",
  },
];

/** The explicit access choice: nothing preselected, one line of consent per option (P9). */
function ScopeChoice({ value, onChange }: { value: SlackScopeChoice | null; onChange: (choice: SlackScopeChoice) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="What OpenWork can do in Slack" data-testid="slack-setup-scope-choice">
      {SCOPE_CHOICES.map((option) => {
        const selected = option.value === value;
        return (
          <label
            key={option.value}
            className={`flex cursor-pointer items-start gap-3 rounded-2xl border bg-white px-4 py-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-gray-200 ${selected ? "border-gray-400" : "border-gray-100 hover:border-gray-200"}`}
          >
            <input
              type="radio"
              name="slack-scope-choice"
              value={option.value}
              checked={selected}
              onChange={() => onChange(option.value)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-gray-900"
              data-testid={`slack-setup-scope-${option.value}`}
            />
            <span className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 text-[14px] font-medium leading-5 text-gray-900">
                {option.title}
                {option.recommended ? <span className="text-[12px] font-normal text-gray-500">Recommended</span> : null}
              </span>
              <span className="text-[13px] leading-[18px] text-gray-500">{option.consent}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** The one Slack setup list: each step reports what OpenWork knows and offers the next action. */
export function SlackSetupChecklist({
  steps,
  callbackUrl,
  scopes,
  mcpConfirmed,
  onConfirmMcp,
  oauthAppFields,
  onSignIn,
  onCheckAgain,
  checking,
  leading = [],
  scopeChoice,
  onChooseScopes,
}: SlackSetupChecklistProps) {
  const checks: SetupCheck[] = steps.map((step) => {
    const offers = new Set(step.offers);
    let action: ReactNode = null;
    const body: ReactNode[] = [];

    if (offers.has("scope-choice")) body.push(<ScopeChoice key="scopes" value={scopeChoice} onChange={onChooseScopes} />);

    if (offers.has("create-app") && callbackUrl) {
      action = (
        <DenButton
          size="sm"
          href={slackCreateAppUrl(slackUserOAuthManifest({ redirectUrl: callbackUrl, scopes }))}
          target="_blank"
          rel="noopener noreferrer"
          icon={ExternalLink}
          data-testid="slack-setup-create-app"
        >
          Create app in Slack
        </DenButton>
      );
    }
    if (offers.has("existing-app-details") && callbackUrl) {
      body.push(<ExistingAppDetails key="existing" callbackUrl={callbackUrl} scopes={scopes} />);
    }
    if (offers.has("open-slack-apps")) {
      const link = (
        <DenButton
          key="open"
          size="sm"
          variant="secondary"
          href={SLACK_APPS_URL}
          target="_blank"
          rel="noopener noreferrer"
          icon={ExternalLink}
          data-testid="slack-setup-open-apps"
        >
          Open Slack apps
        </DenButton>
      );
      if (offers.has("check-again")) body.push(<div key="open" className="flex">{link}</div>);
      else action = link;
    }
    if (offers.has("confirm-mcp")) {
      body.push(
        <div key="confirm" className="flex items-center gap-2.5 text-[13px] text-gray-700">
          <DenSwitch
            size="sm"
            checked={mcpConfirmed}
            onChange={onConfirmMcp}
            aria-label="MCP is on in my Slack app"
            testId="slack-setup-confirm-mcp"
          />
          <span aria-hidden>MCP is on in my Slack app</span>
        </div>,
      );
    }
    if (offers.has("oauth-app-fields")) body.push(<div key="fields">{oauthAppFields}</div>);
    if (offers.has("sign-in") || offers.has("sign-in-again")) {
      action = (
        <DenButton
          size="sm"
          onClick={onSignIn}
          data-testid="slack-setup-sign-in"
        >
          {offers.has("sign-in-again") ? "Sign in again" : "Sign in with Slack"}
        </DenButton>
      );
    }
    if (offers.has("check-again")) {
      action = (
        <DenButton size="sm" variant="secondary" loading={checking} onClick={onCheckAgain} data-testid="slack-setup-check-again">
          Check again
        </DenButton>
      );
    }

    return {
      id: step.id,
      title: step.title,
      description: step.description,
      status: step.status,
      ...(action ? { action } : {}),
      ...(body.length > 0 ? { body: <div className="flex flex-col gap-3">{body}</div> } : {}),
    };
  });
  return <SetupChecks checks={[...leading, ...checks]} />;
}

/**
 * Slack-only state around the shared connector setup: the admin's MCP
 * confirmation, the recorded check after their test sign-in (asked for once
 * if the callback's own check hasn't landed), and whether the optional
 * @openwork assistant applies to this connection.
 */
export function useSlackSetupState(setup: ReturnType<typeof useConnectorSetup>, target: ConnectorTarget | null, scopeChoice: SlackScopeChoice | null) {
  const slack = Boolean(target?.preset && isSlackMcpUrl(target.url));
  const checkConnection = useCheckMcpConnection();
  const [mcpConfirmed, setMcpConfirmed] = useState(false);
  const requestedCheck = useRef<string | null>(null);
  const connection = setup.connection;
  const readiness = connection?.readiness;
  const assistantQuery = useSlackAssistantSetupQuery(setup.connectionId, slack && connection !== null);

  useEffect(() => {
    // The sign-in callback records a check; if it hasn't shown up (older server, a race), ask for one, once.
    if (!slack || !connection || !setup.signedIn || readiness !== null || requestedCheck.current === connection.id) return;
    requestedCheck.current = connection.id;
    checkConnection.mutate(connection.id);
  }, [checkConnection, connection, readiness, setup.signedIn, slack]);

  // The manifest and the new connection share one list: the admin's choice, nothing before it.
  const scopes = slackScopesFor(scopeChoice, target?.preset);
  const callbackUrl = target?.preset?.oauthCallbackUrl ?? null;
  const steps = slackSetupSteps({
    callbackUrl,
    scopeChoice,
    scopes,
    savedScopeCount: connection ? connection.requestedScopes?.length ?? 0 : null,
    appSaved: connection !== null,
    mcpConfirmed,
    signedIn: setup.signedIn,
    signingIn: setup.signingIn,
    signInError: setup.signInError,
    accountLabel: connection?.externalAccountId ?? null,
    readiness: readiness ?? null,
    checking: checkConnection.isPending,
    assistant: slackAssistantStatus(assistantQuery.data),
  });

  return {
    slack,
    steps,
    progress: slackSetupProgress(steps),
    callbackUrl,
    scopes,
    mcpConfirmed,
    setMcpConfirmed,
    checking: checkConnection.isPending,
    checkAgain: () => {
      if (connection) checkConnection.mutate(connection.id);
    },
    assistant: assistantQuery.data ?? null,
  };
}
