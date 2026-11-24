import { DenBrandMark } from "../../../../../../_components/ui/brand-mark";
import { getProviderIconSlug } from "../../../../../_components/llm-provider-data";

export { ExampleAvatar, ExampleCaption, ExampleGroupLabel, ExampleRow, ExampleRows } from "../example-parts";

export type ExampleProvider = { providerId: string; name: string };

export function ExampleProviderMark({ provider, size = "md" }: { provider: ExampleProvider; size?: "sm" | "md" }) {
  return (
    <DenBrandMark
      name={provider.name}
      simpleIconSlug={provider.providerId === "openwork" ? "openwork" : getProviderIconSlug(provider.providerId)}
      className={size === "sm" ? "size-6 rounded-[7px]" : "size-7 rounded-[8px]"}
      imageClassName={size === "sm" ? "size-3.5" : "size-4"}
    />
  );
}

export function ExampleProviderMarks({ providers }: { providers: readonly ExampleProvider[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {providers.map((provider) => <ExampleProviderMark key={provider.providerId} provider={provider} size="sm" />)}
    </span>
  );
}
