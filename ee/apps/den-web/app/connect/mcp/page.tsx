"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { DenStatusScreen } from "../../../components/den-status-screen";
import { DenButton } from "../../(den)/_components/ui/button";
import { safeMcpAuthorizationUrl } from "../../(den)/dashboard/_components/mcp-authorization-url";
import { denApiCredentials, denBrowserEndpoint } from "../../(den)/_lib/den-api-origin";
import { ORG_SCOPE_HEADER } from "../../(den)/_lib/org-scope";
import { getRuntimeConfig } from "../../(den)/_lib/runtime-config";
import { readConnectMcpLink, readConnectStartResult } from "./connect-mcp-link";

type ViewState =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "connected" }
  | { kind: "signed_out" }
  | { kind: "error"; message: string };

/**
 * One-click sign-in for a single connection. Agents that cannot render a
 * connection card (terminal hosts) hand this link to the person; the click
 * here is the user gesture that starts the provider sign-in in this tab.
 */
function ConnectMcpContent() {
  const searchParams = useSearchParams();
  const link = readConnectMcpLink(new URLSearchParams(searchParams.toString()));
  const [state, setState] = useState<ViewState>({ kind: "idle" });

  if (!link) {
    return (
      <DenStatusScreen
        title="This sign-in link is incomplete"
        description="Ask your agent for a new link to this connection."
      />
    );
  }

  const name = link.name;

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
      if (response.status === 401) {
        setState({ kind: "signed_out" });
        return;
      }
      const result = readConnectStartResult(payload, response.ok);
      if (result.kind === "connected") {
        setState({ kind: "connected" });
        return;
      }
      if (result.kind === "redirect") {
        window.location.assign(safeMcpAuthorizationUrl(result.authorizeUrl));
        return;
      }
      setState({ kind: "error", message: result.message });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : `Could not start sign-in to ${name}.` });
    }
  }

  if (state.kind === "connected") {
    return (
      <DenStatusScreen
        title={`${name} is connected`}
        description="Your agent can use it now. You can close this tab."
      />
    );
  }

  if (state.kind === "signed_out") {
    return (
      <DenStatusScreen
        title={`Sign in to OpenWork to connect ${name}`}
        description="Then open this link again."
      >
        <div className="mt-8">
          <DenButton href="/">Sign in to OpenWork</DenButton>
        </div>
      </DenStatusScreen>
    );
  }

  return (
    <DenStatusScreen
      title={`Connect ${name}`}
      description={`Sign in to ${name} so your agent can use it as you.`}
      error={state.kind === "error" ? state.message : null}
    >
      <div className="mt-8">
        <DenButton loading={state.kind === "starting"} onClick={() => void startSignIn()}>
          {`Sign in to ${name}`}
        </DenButton>
      </div>
    </DenStatusScreen>
  );
}

export default function ConnectMcpPage() {
  return (
    <Suspense fallback={<DenStatusScreen title="Connect" description="Loading this connection." />}>
      <ConnectMcpContent />
    </Suspense>
  );
}
