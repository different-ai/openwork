import { redirect } from "next/navigation";

export default function McpConnectionsPage() {
  redirect("/dashboard/marketplaces?tab=servers");
}
