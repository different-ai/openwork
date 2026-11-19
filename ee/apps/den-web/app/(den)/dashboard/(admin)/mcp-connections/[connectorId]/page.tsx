import { AdminConnectorRoute } from "../../../_components/admin-connector-route";

export default async function McpConnectionDetailPage({ params, searchParams }: {
  params: Promise<{ connectorId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId } = await params;
  const { remove } = await searchParams;
  // An agent's removal link: open the Remove confirmation. Nothing is removed until the person confirms.
  const confirmRemove = (Array.isArray(remove) ? remove[0] : remove) === "1";
  return <AdminConnectorRoute connectorId={connectorId} confirmRemove={confirmRemove} />;
}
