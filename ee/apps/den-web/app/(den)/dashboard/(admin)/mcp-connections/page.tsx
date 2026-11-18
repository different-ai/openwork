import { redirect } from "next/navigation";
import { getAddConnectorRoute } from "../../../_lib/den-org";
import { AdminConnectorsScreen } from "../../_components/admin-connectors-screen";

export default async function McpConnectionsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { quickAdd } = await searchParams;
  const catalogId = Array.isArray(quickAdd) ? quickAdd[0] : quickAdd;
  if (catalogId) redirect(getAddConnectorRoute(null, catalogId));
  return <AdminConnectorsScreen />;
}
