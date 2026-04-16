import * as React from "react";

import { cn } from "../lib/cn";

function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ow-soft-card", className)} {...props} />;
}

function CardQuiet({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ow-soft-card-quiet", className)} {...props} />;
}

function CardShell({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("ow-soft-shell", className)} {...props} />;
}

export { Card, CardQuiet, CardShell };
