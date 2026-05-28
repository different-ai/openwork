import type { ComponentProps } from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

function Page({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative h-screen bg-background text-foreground", className)}
      {...props}
    />
  );
}

function PageBackground({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("pointer-events-none fixed inset-0 z-0 overflow-hidden", className)}
      {...props}
    >
      <div className="absolute -left-[20%] -top-[30%] h-[70%] w-[60%] rounded-full bg-[radial-gradient(ellipse,rgba(14,51,217,0.06),transparent_70%)] blur-3xl" />
      <div className="absolute -bottom-[20%] -right-[10%] h-[50%] w-[50%] rounded-full bg-[radial-gradient(ellipse,rgba(255,126,46,0.05),transparent_70%)] blur-3xl" />
      <div className="absolute left-[30%] top-[60%] h-[40%] w-[40%] rounded-full bg-[radial-gradient(ellipse,rgba(255,227,64,0.04),transparent_70%)] blur-3xl" />
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

function PageContainer({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("relative z-10 flex flex-col items-center space-y-8 px-6 mac:pt-16 pt-8 pb-8 h-full", className)}
      {...props}
    />
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
