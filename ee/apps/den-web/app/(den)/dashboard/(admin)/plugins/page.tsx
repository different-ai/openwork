import { Suspense } from "react";
import { AdminPluginsScreen } from "../../_components/admin-plugins-screen";
import { PluginsScreen } from "../../_components/plugins-screen";

export default async function PluginsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { view } = await searchParams;
  if (view === "sources") {
    return (
      <Suspense fallback={null}>
        <PluginsScreen />
      </Suspense>
    );
  }
  return <Suspense fallback={null}><AdminPluginsScreen /></Suspense>;
}
