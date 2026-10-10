import { PermissionKeyScreen } from "../../../../_components/permission-keys-screen";

export default async function PermissionKeyPage({
  params,
}: {
  params: Promise<{ permissionKey: string }>;
}) {
  const { permissionKey } = await params;
  return <PermissionKeyScreen permissionKey={permissionKey} />;
}
