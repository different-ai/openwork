import { redirect } from "next/navigation";
import { getAiGatewayProvidersRoute } from "../../../_lib/den-org";

export default function GatewayProvidersPage() {
  redirect(getAiGatewayProvidersRoute());
}
