import { HarnessFeedbackPage } from "../../../components/admin/harness-feedback/harness-feedback-page";

export default async function AdminHarnessFeedbackPage({ searchParams }: { searchParams: Promise<{ group?: string | string[] }> }) {
  const { group } = await searchParams;
  return <HarnessFeedbackPage selectedGroup={typeof group === "string" ? group : undefined} />;
}
