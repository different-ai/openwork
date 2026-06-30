import { WorkspaceClaimScreen } from "../_components/workspace-claim-screen";

function firstParamValue(value: string | string[] | undefined): string {
  return typeof value === "string"
    ? value.trim()
    : Array.isArray(value)
      ? (value[0]?.trim() ?? "")
      : "";
}

export default async function WorkspaceClaimPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = firstParamValue(params.token);
  // Optional prefill only - never a security boundary. The claim token is
  // the only thing that authorizes accepting this claim.
  const prefilledEmail = firstParamValue(params.email);

  return <WorkspaceClaimScreen token={token} prefilledEmail={prefilledEmail} />;
}
