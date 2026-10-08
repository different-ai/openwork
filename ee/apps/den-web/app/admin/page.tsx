import { AdminShell } from "../../components/admin/admin-shell";
import { DenAdminPanel } from "../../components/den-admin-panel";

export default function AdminPage() {
  return (
    <AdminShell active="overview">
      <DenAdminPanel />
    </AdminShell>
  );
}
