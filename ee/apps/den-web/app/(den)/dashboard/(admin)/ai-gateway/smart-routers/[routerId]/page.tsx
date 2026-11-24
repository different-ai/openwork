import { AutoRouterScreen } from "../../../../_components/auto-router-screen";

export default async function AiGatewaySmartRouterPage({
  params,
  searchParams,
}: {
  params: Promise<{ routerId: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const [{ routerId }, { step }] = await Promise.all([params, searchParams]);
  return <AutoRouterScreen key={routerId} routerId={routerId} step={step === "access" ? "access" : undefined} />;
}
