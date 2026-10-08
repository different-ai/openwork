import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Workbot is its own app; Den is where people sign in to it. The dashboard's Workbot entry and old links land here. */
export default function WorkbotPage() {
  redirect(process.env.DEN_WORKBOT_URL?.trim() || "https://chat.openworklabs.com");
}
