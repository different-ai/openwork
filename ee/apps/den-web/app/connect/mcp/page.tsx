"use client";

import { Check, Folder } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useState } from "react";
import { AuthPanel } from "../../(den)/_components/auth-panel";
import { OnboardingTexture } from "../../(den)/_components/onboarding-texture";
import { SetupFrame } from "../../(den)/_components/setup-frame";
import {
  SetupAppMark,
  SetupErrorLine,
  SetupFacts,
  SetupLetterTile,
  SetupLine,
  SetupPanelBody,
  SetupPanelTitle,
  SetupSkeletonRows,
  SetupStatus,
  SetupStoryTile,
  SetupStoryTiles,
} from "../../(den)/_components/setup-frame-parts";
import { safeMcpAuthorizationUrl } from "../../(den)/dashboard/_components/mcp-authorization-url";
import { denApiCredentials, denBrowserEndpoint } from "../../(den)/_lib/den-api-origin";
import { ORG_SCOPE_HEADER } from "../../(den)/_lib/org-scope";
import { getRuntimeConfig } from "../../(den)/_lib/runtime-config";
import { DenFlowProvider, useDenFlow } from "../../(den)/_providers/den-flow-provider";
import { type ConnectMcpLink, readConnectMcpLink, readConnectStartResult, readWorkspaceName } from "./connect-mcp-link";

type ViewState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "connected" }
  | { kind: "unavailable"; message: string }
  | { kind: "error"; message: string };

function ConnectFrame({ link, workspaceName, linked = false, children }: { link: ConnectMcpLink | null; workspaceName: string | null; linked?: boolean; children: ReactNode }) {
  const title = link ? `Connect ${link.name}.` : "Connect a tool.";
  const description = link
    ? `Your agent added ${link.name} to ${workspaceName ?? "your workspace"}.`
    : "Your agent sent you a sign-in link.";
  return (
    <SetupFrame
      title={title}
      description={description}
      panelVisual={<OnboardingTexture />}
      aside={link ? (
        <SetupStoryTiles
          linked={linked}
          from={{ label: link.name, mark: <SetupStoryTile><SetupAppMark name={link.name} size={26} /></SetupStoryTile> }}
          to={workspaceName
            ? { label: workspaceName, mark: <SetupLetterTile name={workspaceName} size="lg" /> }
            : { label: "Your workspace", mark: <SetupStoryTile><Folder className="size-5 text-[var(--dls-text-secondary)]" strokeWidth={1.5} /></SetupStoryTile> }}
        />
      ) : undefined}
    >
      <div data-testid="connect-mcp">{children}</div>
    </SetupFrame>
  );
}

/**
 * One-click sign-in for a single connection. Agents that cannot render a
 * connection card (terminal hosts) hand this link to the person; the click
 * here is the user gesture that starts the provider sign-in in this tab.
 * Signed-out people sign in right here and stay on the same link.
 */
function ConnectMcpContent() {
  const searchParams = useSearchParams();
  const link = readConnectMcpLink(new URLSearchParams(searchParams.toString()));
  const { user, sessionHydrated } = useDenFlow();
  const [state, setState] = useState<ViewState>({ kind: "idle" });
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);

  useEffect(() => {
    if (!user || !link) return;
    let cancelled = false;
    void (async () => {
      await getRuntimeConfig();
      const endpoint = denBrowserEndpoint("/v1/me/orgs");
      const response = await fetch(endpoint, { credentials: denApiCredentials(endpoint) }).catch(() => null);
      const payload: unknown = response?.ok ? await response.json().catch(() => null) : null;
      if (!cancelled) setWorkspaceName(readWorkspaceName(payload, link.organizationId));
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id, link?.organizationId]);

  if (!link) {
    return (
      <ConnectFrame link={null} workspaceName={null}>
        <SetupPanelBody gap="md">
          <SetupPanelTitle>This sign-in link is incomplete</SetupPanelTitle>
          <SetupLine>Ask your agent for a new link to this connection.</SetupLine>
        </SetupPanelBody>
      </ConnectFrame>
    );
  }

  const name = link.name;

  if (!sessionHydrated) {
    return (
      <ConnectFrame link={link} workspaceName={null}>
        <SetupPanelBody>
          <SetupPanelTitle>{`Connect ${name}`}</SetupPanelTitle>
          <SetupSkeletonRows count={1} />
        </SetupPanelBody>
      </ConnectFrame>
    );
  }

  if (!user) {
    return (
      <ConnectFrame link={link} workspaceName={null}>
        <SetupPanelBody>
          <SetupFacts rows={[{ label: "Connecting", value: <><SetupAppMark name={name} /><span className="truncate">{name}</span></> }]} />
          <AuthPanel
            bare
            emailFirstFlow
            socialFirst
            socialProviders={["google"]}
            emailStepContent={{ title: "Sign in to OpenWork" }}
          />
        </SetupPanelBody>
      </ConnectFrame>
    );
  }

  async function startSignIn() {
    if (!link) return;
    setState({ kind: "starting" });
    try {
      await getRuntimeConfig();
      const endpoint = denBrowserEndpoint(`/v1/mcp-connections/${encodeURIComponent(link.connectionId)}/connect/start`);
      const response = await fetch(endpoint, {
        credentials: denApiCredentials(endpoint),
        headers: { [ORG_SCOPE_HEADER]: link.organizationId },
      });
      const payload: unknown = await response.json().catch(() => null);
      const result = readConnectStartResult(payload, response.ok, name);
      if (result.kind === "redirect") {
        window.location.assign(safeMcpAuthorizationUrl(result.authorizeUrl));
        return;
      }
      setState(result);
    } catch {
      setState({ kind: "error", message: `${name} did not open a sign-in page. Try again.` });
    }
  }

  if (state.kind === "connected") {
    return (
      <ConnectFrame link={link} workspaceName={workspaceName} linked>
        <SetupStatus icon={<Check className="size-5" strokeWidth={1.5} />} title={`${name} is connected`} line="Your agent can use it now. You can close this tab." />
      </ConnectFrame>
    );
  }

  if (state.kind === "unavailable") {
    return (
      <ConnectFrame link={link} workspaceName={workspaceName}>
        <SetupPanelBody gap="md">
          <SetupPanelTitle>{`${name} can\u2019t be connected`}</SetupPanelTitle>
          <SetupLine>{state.message}</SetupLine>
        </SetupPanelBody>
      </ConnectFrame>
    );
  }

  return (
    <ConnectFrame link={link} workspaceName={workspaceName}>
      <SetupPanelBody>
        <SetupPanelTitle>{`Connect ${name}`}</SetupPanelTitle>
        <SetupFacts
          rows={[
            { label: "Connection", value: <><SetupAppMark name={name} /><span className="truncate">{name}</span></> },
            { label: "Workspace", value: workspaceName ?? "…" },
            { label: "Account", value: user.email },
          ]}
        />
        {state.kind === "error" ? <SetupErrorLine>{state.message}</SetupErrorLine> : <SetupLine>{`Sign in to ${name} so your agent can use it as you.`}</SetupLine>}
        <button type="button" className="den-button-primary w-full" disabled={state.kind === "starting"} onClick={() => void startSignIn()}>
          {state.kind === "starting" ? "Opening sign-in…" : `Sign in to ${name}`}
        </button>
      </SetupPanelBody>
    </ConnectFrame>
  );
}

export default function ConnectMcpPage() {
  return (
    <DenFlowProvider>
      <Suspense fallback={null}>
        <ConnectMcpContent />
      </Suspense>
    </DenFlowProvider>
  );
}
