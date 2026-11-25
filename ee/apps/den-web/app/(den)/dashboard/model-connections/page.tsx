import { redirect } from "next/navigation";

export default function ModelConnectionsPage() {
  redirect("/dashboard/library?show=models");
}
