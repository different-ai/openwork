import { JoinOrgScreen } from "../_components/join-org-screen";

export default async function JoinOrgPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const inviteParam = params.invite;
  const invitationId = typeof inviteParam === "string"
    ? inviteParam.trim()
    : Array.isArray(inviteParam)
      ? (inviteParam[0]?.trim() ?? "")
      : "";
  const slugParam = params.slug;
  const organizationSlug = typeof slugParam === "string"
    ? slugParam.trim()
    : Array.isArray(slugParam)
      ? (slugParam[0]?.trim() ?? "")
      : "";

  return <JoinOrgScreen invitationId={invitationId} organizationSlug={organizationSlug} />;
}
