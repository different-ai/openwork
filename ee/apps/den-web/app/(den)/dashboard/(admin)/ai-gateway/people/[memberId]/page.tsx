import { GatewayPersonScreen } from "../../../../_components/gateway-person-screen";

export default async function AiGatewayPersonPage({ params }: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await params;
  return <GatewayPersonScreen key={memberId} memberId={memberId} />;
}
