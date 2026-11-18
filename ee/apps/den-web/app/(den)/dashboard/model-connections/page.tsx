import { redirect } from "next/navigation";

// Models moved into My Library. Installed desktop builds still open this address.
export default function ModelConnectionsPage() {
  redirect("/dashboard/library?show=models");
}
