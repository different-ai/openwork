import { redirect } from "next/navigation";
import { workbotDestination } from "../dashboard/_lib/workbot-entry";

export const dynamic = "force-dynamic";

/**
 * Workbot is its own app; Den is where people sign in to it. The dashboard's Workbot entry and old links land here.
 * The entry names the workspace on screen, so Workbot signs in again when it was last used for another workspace.
 */
export default async function WorkbotPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[] }> }) {
  const { organizationId } = await searchParams;
  redirect(workbotDestination(process.env.DEN_WORKBOT_URL?.trim() || "https://chat.openworklabs.com", organizationId));
}
