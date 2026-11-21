import { RoleNewScreen } from "../../../../_components/role-new-screen";

export default async function NewRolePage({ searchParams }: { searchParams: Promise<{ start?: string | string[] }> }) {
  const { start } = await searchParams;
  return <RoleNewScreen requestedStart={typeof start === "string" ? start : null} />;
}
