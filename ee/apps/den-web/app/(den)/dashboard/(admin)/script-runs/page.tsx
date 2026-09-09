import { redirect } from "next/navigation";
import { getWorkflowRunsRoute } from "../../../_lib/den-org";

export default function LegacyWorkflowRunsPage() {
  redirect(getWorkflowRunsRoute());
}
