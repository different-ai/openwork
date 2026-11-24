import { notFound, redirect } from "next/navigation";
import { workbotBaseUrl, workbotDestination } from "./destination";
import { configuredWorkbotEntryEnabled } from "./entry-feature";

export const dynamic = "force-dynamic";

export default async function WorkbotPage({ searchParams }: { searchParams: Promise<{ organizationId?: string | string[] }> }) {
  const { organizationId } = await searchParams;
  const base = workbotBaseUrl(process.env, await configuredWorkbotEntryEnabled());
  if (!base) notFound();
  redirect(workbotDestination(base, organizationId));
}
