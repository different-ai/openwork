import type { ComponentProps } from "react";

export function DenSkeleton({ className = "", ...props }: ComponentProps<"span">) {
  return <span aria-hidden="true" {...props} className={`block rounded bg-gray-100 motion-safe:animate-pulse ${className}`} />;
}
