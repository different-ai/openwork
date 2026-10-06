import { AdminShell } from "../../../components/admin/admin-shell";
import { FeatureRolloutsPage } from "../../../components/admin/features/feature-rollouts-page";

export default function AdminFeaturesPage() {
  return (
    <AdminShell active="features">
      <FeatureRolloutsPage />
    </AdminShell>
  );
}
