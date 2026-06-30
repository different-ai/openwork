import { WorkspaceClaimScreen } from "../_components/workspace-claim-screen";

function firstParamValue(value: string | string[] | undefined): string {
  return typeof value === "string"
    ? value.trim()
    : Array.isArray(value)
      ? (value[0]?.trim() ?? "")
      : "";
}

function parseInviteEmails(value: string | string[] | undefined): string[] {
  const raw = firstParamValue(value);
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean)
    .slice(0, 10);
}

export default async function WorkspaceClaimPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const token = firstParamValue(params.token);
  const inviteEmails = parseInviteEmails(params.invite);

  return <WorkspaceClaimScreen token={token} inviteEmails={inviteEmails} />;
}
