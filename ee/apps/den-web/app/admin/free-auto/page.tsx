import { AdminShell } from "../../../components/admin/admin-shell";
import { FreeAutoUsagePage } from "../../../components/admin/free-auto-usage/free-auto-usage-page";

export default function AdminFreeAutoPage() {
  return (
    <AdminShell active="free-auto">
      <FreeAutoUsagePage />
    </AdminShell>
  );
}
