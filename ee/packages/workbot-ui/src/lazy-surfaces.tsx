"use client";

import { lazy, Suspense, type ComponentProps, type ComponentType } from "react";
import type { WorkbotCalendar as Calendar } from "./calendar";

const LazyCalendar = lazy<ComponentType<ComponentProps<typeof Calendar>>>(() => import("./calendar").then((module) => ({ default: module.WorkbotCalendar }), () => ({ default: () => null })));

/** The Calendar tab stays empty for the moment its code takes; the tab already has its place in the layout. */
export function WorkbotCalendar(props: ComponentProps<typeof Calendar>) {
  return <Suspense fallback={null}><LazyCalendar {...props} /></Suspense>;
}
