import { redirect } from "next/navigation";

export default function ManageMembersRedirectPage() {
  redirect("/dashboard/members");
}
