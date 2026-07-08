import { redirect } from "next/navigation";
import { getConnectionsRoute } from "../../../_lib/den-org";

export default function McpConnectionsPage() {
  redirect(getConnectionsRoute());
}
