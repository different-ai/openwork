import { DeploymentsRoute } from "../../../_components/deployments-route";

export default async function DeploymentPage({ params }: { params: Promise<{ deploymentId: string }> }) {
  const { deploymentId } = await params;
  return <DeploymentsRoute deploymentId={deploymentId} />;
}
