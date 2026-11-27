import { CloudCodingApprovalRoute } from "../../route-screens";

export default async function CloudCodingApprovalPage({ params }: { params: Promise<{ approvalId: string }> }) {
  const { approvalId } = await params;
  return <CloudCodingApprovalRoute approvalId={approvalId} />;
}
