import { EveryoneScreen, type EveryoneTab } from "../../../../_components/everyone-screen";

const TABS: readonly EveryoneTab[] = ["role", "agents", "browser", "models", "prompts", "desktop"];

export default async function EveryonePage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab } = await searchParams;
  return <EveryoneScreen initialTab={TABS.find((entry) => entry === tab) ?? null} />;
}
