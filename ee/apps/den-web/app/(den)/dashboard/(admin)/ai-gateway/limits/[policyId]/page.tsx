import { GatewayLimitEditorScreen } from "../../../../_components/gateway-limit-editor-screen";

export default async function AiGatewayLimitPage({ params }: { params: Promise<{ policyId: string }> }) {
  const { policyId } = await params;
  return <GatewayLimitEditorScreen key={policyId} policyId={policyId} />;
}
