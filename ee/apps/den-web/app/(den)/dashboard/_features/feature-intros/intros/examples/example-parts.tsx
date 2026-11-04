import type { ReactNode } from "react";
import { DenBrandMark } from "../../../../../_components/ui/brand-mark";
import { brandHintFor } from "../../../../_components/item-logo";

/*
 * Small shared pieces for every section's live example (DESIGN.md I7). They
 * sit inside FeatureIntroExample's frame, so nothing here draws its own
 * bordered card (S1): groups are whitespace plus one hairline.
 */

/** "Your gateway, once running": what the example shows, above it. */
export function ExampleCaption({ children }: { children: ReactNode }) {
  return <p className="mb-3 text-[13px] font-medium text-gray-900">{children}</p>;
}

/** A quiet label above a group of rows, with an optional count on the right. */
export function ExampleGroupLabel({ children, meta }: { children: ReactNode; meta?: ReactNode }) {
  return (
    <p className="mb-1 flex items-baseline justify-between gap-3 text-[12px] text-gray-500">
      <span>{children}</span>
      {meta ? <span className="shrink-0 tabular-nums">{meta}</span> : null}
    </p>
  );
}

/** Hairline-divided rows, 40–48px (S2). */
export function ExampleRows({ children }: { children: ReactNode }) {
  return <ul className="m-0 list-none divide-y divide-gray-100 p-0">{children}</ul>;
}

/** One row; `active` is the gentle highlight the example steps through. */
export function ExampleRow({ children, active = false }: { children: ReactNode; active?: boolean }) {
  return (
    <li
      className={`-mx-2 flex min-h-11 items-center gap-3 rounded-lg px-2 py-2 transition-colors duration-200 ease-out ${active ? "bg-gray-50" : ""}`}
    >
      {children}
    </li>
  );
}

export function ExampleAvatar({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-700">
      {children}
    </span>
  );
}

/** A service by name ("Linear", "Google Workspace"), with its logo as on the connector rows. */
export type ExampleService = { name: string; url?: string };

/** Same brand tile and logo lookup as ConnectorLogo, sized to sit with the other example rows. */
export function ExampleServiceMark({ service, size = "md" }: { service: ExampleService; size?: "sm" | "md" }) {
  const hint = brandHintFor(service.name, service.url);
  return (
    <DenBrandMark
      name={service.name}
      simpleIconSlug={hint.simpleIconSlug}
      serviceUrl={hint.serviceUrl}
      className={size === "sm" ? "size-6 rounded-[7px]" : "size-7 rounded-[8px]"}
      imageClassName={size === "sm" ? "size-3.5" : "size-4"}
    />
  );
}
