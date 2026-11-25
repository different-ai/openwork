import { redirect } from "next/navigation";
import { ADMIN_LIMIT_KINDS } from "@openwork/types/den/admin-limits";

export default function AdminLimitsPage() {
  redirect(`/admin/limits/${ADMIN_LIMIT_KINDS[0].key}`);
}
