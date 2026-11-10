import { RoleNewScreen } from "../../../../_components/role-new-screen";

export default async function NewRolePage({ searchParams }: { searchParams: Promise<{ start?: string | string[] }> }) {
  const { start } = await searchParams;
  // ?start=billing opens the form on a ready-made role, from its Create role on Members › Roles.
  return <RoleNewScreen requestedStart={typeof start === "string" ? start : null} />;
}
