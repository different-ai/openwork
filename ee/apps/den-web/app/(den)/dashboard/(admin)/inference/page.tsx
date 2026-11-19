import { redirect } from "next/navigation";
import { getInferenceRoute } from "../../../_lib/den-org";

export default async function InferencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [pathname, query] = getInferenceRoute().split("?");
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(await searchParams)) {
    if (key === "tab" || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  redirect(`${pathname}?${params.toString()}`);
}
