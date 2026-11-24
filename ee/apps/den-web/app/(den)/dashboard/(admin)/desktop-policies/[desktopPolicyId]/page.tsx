import { DesktopPolicyRoute } from "../../../_components/desktop-policy-route";

export default async function EditDesktopPolicyPage({
  params,
  searchParams,
}: {
  params: Promise<{ desktopPolicyId: string }>;
  searchParams: Promise<{ setup?: string }>;
}) {
  const { desktopPolicyId } = await params;
  const { setup } = await searchParams;
  return <DesktopPolicyRoute editor desktopPolicyId={desktopPolicyId} setupRestricted={setup === "restricted"} />;
}
