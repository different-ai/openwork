import { readStoredConnection, resolveConnectionState } from "../../lib/openwork-lab-server";
import { LabProvider } from "./_providers/lab-provider";

export default async function LabLayout({ children }: { children: React.ReactNode }) {
  const initialState = await resolveConnectionState(await readStoredConnection());
  return <LabProvider initialState={initialState}>{children}</LabProvider>;
}
