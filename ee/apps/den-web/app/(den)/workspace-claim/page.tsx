import { WorkspaceClaimScreen } from "../_components/workspace-claim-screen";

export default async function WorkspaceClaimPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tokenParam = params.token;
  const token = typeof tokenParam === "string"
    ? tokenParam.trim()
    : Array.isArray(tokenParam)
      ? (tokenParam[0]?.trim() ?? "")
      : "";

  return <WorkspaceClaimScreen token={token} />;
}
