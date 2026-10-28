import { redirect } from "next/navigation";

/** My agent moved out of the Library and became My bot; keep old links working. */
export default function MyAgentMovedPage() {
  redirect("/dashboard/my-bot");
}
