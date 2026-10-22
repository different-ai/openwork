import { DesktopPolicyRoute } from "../../_components/desktop-policy-route";

export default async function DesktopPoliciesPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return <DesktopPolicyRoute assignmentRecovery={view === "assignments"} />;
}
