import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-foreground/10 placeholder:text-foreground/60 text-foreground  aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive flex field-sizing-content w-full rounded-sm border bg-background p-base text-base shadow-md transition-[color,box-shadow] resize-none outline-none  disabled:cursor-not-allowed disabled:opacity-50 font-sans font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
