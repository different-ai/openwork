import { WorkspaceClaimCodeScreen } from "../_components/workspace-claim-code-screen";

function firstParamValue(value: string | string[] | undefined): string {
  return typeof value === "string"
    ? value.trim()
    : Array.isArray(value)
      ? (value[0]?.trim() ?? "")
      : "";
}

export default async function WorkspaceClaimCodePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <WorkspaceClaimCodeScreen initialUserCode={firstParamValue(params.user_code)} />;
}
