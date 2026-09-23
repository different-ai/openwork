import { ItemHeader, ItemPage, SectionTitle } from "./item-header";
import { ItemPanel, ItemRowsSkeleton } from "./item-list";

function Bar({ className }: { className: string }) {
  return <span aria-hidden className={`inline-block rounded bg-gray-100 align-middle motion-safe:animate-pulse ${className}`} />;
}

/** The plugin page's header and sections, in place, while the plugin loads. */
export function PluginPageSkeleton({ back, mode }: { back: { href: string; label: string }; mode: "member" | "admin" }) {
  return (
    <ItemPage>
      <ItemHeader
        back={back}
        logo={<span aria-hidden className="h-10 w-10 shrink-0 rounded-xl bg-gray-100 motion-safe:animate-pulse" />}
        title={<><span className="sr-only">Loading plugin</span><Bar className="h-6 w-56 max-w-full rounded-md" /></>}
        description={<Bar className="h-3 w-72 max-w-full" />}
      />
      {mode === "admin" ? (
        <section className="flex flex-col gap-2.5">
          <SectionTitle title="Who can use it" />
          <ItemPanel><ItemRowsSkeleton label="Loading who can use it" rows={1} /></ItemPanel>
        </section>
      ) : null}
      <section className="flex flex-col gap-2.5">
        <SectionTitle title="What's inside" />
        <ItemPanel><ItemRowsSkeleton label="Loading what's inside" rows={2} /></ItemPanel>
      </section>
    </ItemPage>
  );
}
