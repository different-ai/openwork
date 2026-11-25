import { redirect } from "next/navigation";
import { workbotDestination } from "../dashboard/_lib/workbot-entry";

export const dynamic = "force-dynamic";

export default async function WorkbotPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[] }> }) {
  const { organizationId } = await searchParams;
  redirect(workbotDestination(process.env.DEN_WORKBOT_URL?.trim() || "https://chat.openworklabs.com", organizationId));
}
