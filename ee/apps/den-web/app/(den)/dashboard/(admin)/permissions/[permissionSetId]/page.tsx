import { PermissionSetScreen } from "../../../_components/permission-set-screen";

export default async function PermissionSetPage({
  params,
}: {
  params: Promise<{ permissionSetId: string }>;
}) {
  const { permissionSetId } = await params;
  return <PermissionSetScreen permissionSetId={permissionSetId} />;
}
