"use client";

import { lazy, Suspense, type ComponentProps, type ComponentType } from "react";
import type { WorkbotCalendar as Calendar } from "./calendar";

/**
 * Surfaces the chat does not need to draw: their code arrives when they are first shown, not with the page. Each is a
 * drop-in for the component it loads, so screen.tsx only changes where it imports them from.
 *
 * Code that cannot be fetched (a tab left open across a deploy asks for a file the server no longer has) leaves the
 * surface as it looks while loading, so the chat goes on; the host app loads the page again for the new build.
 */
const LazyCalendar = lazy<ComponentType<ComponentProps<typeof Calendar>>>(() => import("./calendar").then((module) => ({ default: module.WorkbotCalendar }), () => ({ default: () => null })));

/** The Calendar tab stays empty for the moment its code takes; the tab already has its place in the layout. */
export function WorkbotCalendar(props: ComponentProps<typeof Calendar>) {
  return <Suspense fallback={null}><LazyCalendar {...props} /></Suspense>;
}
