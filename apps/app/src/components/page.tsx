import type { ComponentProps } from "react";
import { Loader2 } from "lucide-react";

import { DitherBackdrop } from "@/components/dither-backdrop";
import { cn } from "@/lib/utils";

function Page({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative h-dvh bg-background text-foreground", className)}
      {...props}
    />
  );
}

function PageBackground({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("pointer-events-none fixed inset-0 z-0 overflow-hidden opacity-[0.1] dark:invert", className)}
      {...props}
    >
      <DitherBackdrop />
    </div>
  );
}

function PageTitlebarRegion({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("window-titlebar fixed inset-x-0 top-0 z-20 electron:titlebar-drag", className)}
      {...props}
    />
  );
}

function PageContainer({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative z-10 h-full overflow-y-auto px-6 pb-8 pt-8 mac:pt-16", className)}
      {...props}
    >
      <div className="mx-auto flex min-h-full w-full max-w-[760px] items-center justify-center">
        <div className="flex w-full flex-col items-center space-y-8 rounded-3xl border border-border bg-background px-6 py-10 sm:px-14 sm:py-12">
          {children}
        </div>
      </div>
    </div>
  );
}

function PageHeader({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("space-y-3 text-center w-full max-w-lg", className)}
      {...props}
    />
  );
}

function PageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 overflow-y-auto w-full max-w-lg grow", className)}
      {...props}
    />
  );
}

function PageLoading({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2 items-center justify-center py-8 flex-1", className)}
      {...props}
    />
  );
}

function PageLoadingSpinner({ className, ...props }: ComponentProps<typeof Loader2>) {
  return (
    <Loader2
      className={cn("size-6 animate-spin text-muted-foreground", className)}
      {...props}
    />
  );
}

function PageLoadingDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

function PageFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col items-center gap-4 w-full max-w-lg", className)}
      {...props}
    />
  );
}

function PageTitle({ className, ...props }: ComponentProps<"h1">) {
  return (
    <h1
      className={cn("text-2xl font-semibold tracking-tight text-foreground", className)}
      {...props}
    />
  );
}

function PageDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("text-base text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Page,
  PageBackground,
  PageContainer,
  PageContent,
  PageDescription,
  PageFooter,
  PageHeader,
  PageLoading,
  PageLoadingDescription,
  PageLoadingSpinner,
  PageTitle,
  PageTitlebarRegion,
};
