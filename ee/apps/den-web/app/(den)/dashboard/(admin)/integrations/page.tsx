import { redirect } from "next/navigation";

export default function IntegrationsPage() {
  redirect("/dashboard/plugins?view=sources");
}
