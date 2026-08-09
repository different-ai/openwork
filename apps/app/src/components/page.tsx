import type { ComponentProps } from "react";
import { Loader2 } from "lucide-react";
import { Dithering } from "@paper-design/shaders-react";

import { cn } from "@/lib/utils";

function Page({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative h-dvh bg-background text-foreground", className)}
      {...props}
    />
  );
}

/**
 * Paper first-load spec: subtle pixel-dither mosaic over the page ground.
 * `dark:invert` flips the black pixels to white so the texture survives
 * dark mode.
 */
function PageBackground({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("pointer-events-none fixed inset-0 z-0 overflow-hidden opacity-[0.1] dark:invert", className)}
      {...props}
    >
      <Dithering
        className="size-full"
        speed={0.01}
        shape="warp"
        type="2x2"
        size={20.3}
        scale={1.19}
        frame={264559.21}
        colorBack="#00000000"
        colorFront="#000000"
      />
    </div>
  );
}

function PageTitlebarRegion({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("fixed inset-x-0 top-0 z-20 h-10 mac:titlebar-drag", className)}
      {...props}
    />
  );
}

/**
 * Centers page content inside a bounded card (same treatment as the
 * sign-in/welcome card) so onboarding stages stay readable over the
 * dithered background. The outer region scrolls when content is tall.
 */
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
