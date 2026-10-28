import { DesktopPolicyRoute } from "../../../_components/desktop-policy-route";

export default async function NewDesktopPolicyPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return <DesktopPolicyRoute editor assignmentRecovery={view === "assignments"} />;
}
