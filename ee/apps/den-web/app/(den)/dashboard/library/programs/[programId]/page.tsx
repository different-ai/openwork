import { redirect } from "next/navigation";

export default async function LegacyProgramPage({ params }: { params: Promise<{ programId: string }> }) {
  const { programId } = await params;
  redirect(`/dashboard/library/workflows/${encodeURIComponent(programId)}`);
}
