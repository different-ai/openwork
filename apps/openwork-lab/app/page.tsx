import { redirect } from "next/navigation";
import { readStoredConnection } from "../lib/openwork-lab-server";

export default async function HomePage() {
  const connection = await readStoredConnection();
  redirect(connection ? "/lab" : "/connect");
}
