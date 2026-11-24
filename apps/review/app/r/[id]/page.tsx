import { notFound } from "next/navigation";
import { readReview } from "@openwork/review/storage";
import { Report } from "../../../components/report";
import { connectedCheckpointProviders, previewProviderOptions } from "../../../lib/provider-status";

export const dynamic = "force-dynamic";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await readReview(id);
  if (!report) notFound();
  const providers = await previewProviderOptions();
  const preview = providers.find((option) => option.connected) ?? providers[0];
  return <Report id={id} report={report} connected={Boolean(preview?.connected)} providerLabel={preview?.label ?? "Sandbox provider"}
    previewProviders={providers} checkpointProviders={connectedCheckpointProviders()} />;
}
