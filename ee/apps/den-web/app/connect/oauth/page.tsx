"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useMemo } from "react";
import { parseMcpAuthorizationTabState } from "../../(den)/dashboard/_components/mcp-authorization-url";
import { ConnectFailure, ConnectPending } from "./connect-handoff-screen";

function OAuthPageContent() {
  const searchParams = useSearchParams();
  const state = useMemo(
    () => parseMcpAuthorizationTabState(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );
  return state.outcome === "failed" && state.failure
    ? <ConnectFailure connectionName={state.connectionName} message={state.failure.message} details={state.failure.details} />
    : <ConnectPending connectionName={state.connectionName} />;
}

export default function OAuthPage() {
  return (
    <Suspense fallback={<ConnectPending connectionName="your provider" />}>
      <OAuthPageContent />
    </Suspense>
  );
}
