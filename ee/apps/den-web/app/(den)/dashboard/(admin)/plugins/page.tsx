import { Suspense } from "react";
import { AdminPluginsScreen } from "../../_components/admin-plugins-screen";
import { PluginsScreen } from "../../_components/plugins-screen";

/** Plugin Directory tabs; any of them in `?view=` opens the directory on that tab. */
const DIRECTORY_VIEWS = new Set(["plugins", "agents", "commands", "hooks", "mcps", "sources"]);

export default async function PluginsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { view } = await searchParams;
  if (typeof view === "string" && DIRECTORY_VIEWS.has(view)) {
    return (
      <Suspense fallback={null}>
        <PluginsScreen />
      </Suspense>
    );
  }
  return <Suspense fallback={null}><AdminPluginsScreen /></Suspense>;
}
