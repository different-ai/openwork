import { redirect } from "next/navigation";
import { readStoredConnection } from "../../lib/openwork-lab-server";
import { LabShell } from "./_components/lab-shell";

export default async function LabPage() {
  const connection = await readStoredConnection();
  if (!connection) {
    redirect("/connect");
  }

  return <LabShell />;
}
