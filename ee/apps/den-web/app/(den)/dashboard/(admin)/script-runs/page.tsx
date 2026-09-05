import { redirect } from "next/navigation";

export default function LegacyScriptRunsPage() {
  redirect("/dashboard/workflow-runs");
}
