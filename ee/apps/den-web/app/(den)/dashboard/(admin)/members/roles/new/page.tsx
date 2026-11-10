import { RoleNewScreen } from "../../../../_components/role-new-screen";

export default async function NewRolePage({ searchParams }: { searchParams: Promise<{ start?: string | string[] }> }) {
  const { start } = await searchParams;
  // ?start=billing-manager opens the form on that starting point (a copy of a built-in role's permissions).
  return <RoleNewScreen requestedStart={typeof start === "string" ? start : null} />;
}
