import { notFound } from "next/navigation";
import { ADMIN_LIMIT_KINDS, type AdminLimitKind } from "@openwork/types/den/admin-limits";
import { LimitsPage } from "../../../../components/admin/limits/limits-page";

export default async function AdminLimitKindPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const match = ADMIN_LIMIT_KINDS.find(entry => entry.key === kind);
  if (!match) notFound();
  return <LimitsPage kind={match.key satisfies AdminLimitKind} />;
}
