import { ModelPromotionLanding } from "../../../../components/model-promotion-landing";
export default async function OfferPage({ params }: { params: Promise<{ slug: string }> }) {
  return <ModelPromotionLanding slug={(await params).slug} />;
}
