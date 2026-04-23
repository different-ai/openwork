import { MarketplaceDetailScreen } from "../../_components/marketplace-detail-screen";

export default async function MarketplaceDetailPage({
  params,
}: {
  params: Promise<{ marketplaceId: string }>;
}) {
  const { marketplaceId } = await params;
  return <MarketplaceDetailScreen marketplaceId={marketplaceId} />;
}
