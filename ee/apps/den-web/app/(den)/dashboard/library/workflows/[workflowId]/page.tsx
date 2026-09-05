import { WorkflowDetailScreen } from "../../../_components/workflow-detail-screen";

export default async function WorkflowPage({ params }: { params: Promise<{ workflowId: string }> }) {
  const { workflowId } = await params;
  return <WorkflowDetailScreen workflowId={workflowId} />;
}
