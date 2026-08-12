import { JoinOrgScreen } from "../_components/join-org-screen";
import { getPublicInstallers } from "../_lib/public-installers";

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

  const { installers, releaseTag } = await getPublicInstallers();

  return <JoinOrgScreen invitationId={invitationId} installers={installers} releaseTag={releaseTag} />;
}
