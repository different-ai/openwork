import type { ReactNode } from "react";
import { CircleAlert, LoaderCircle } from "lucide-react";

type DenStatusScreenProps = {
  title: string;
  description: string;
  status?: string;
  error?: string | null;
  children?: ReactNode;
};

/** Branded shell for the brief handoff screens between Den and identity providers. */
export function DenStatusScreen({ title, description, status, error, children }: DenStatusScreenProps) {
  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center bg-[var(--dls-surface)] px-6 py-16 text-[var(--dls-text-primary)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 opacity-10 [background-image:radial-gradient(circle,#011627_0.7px,transparent_0.8px)] [background-size:5px_5px] [mask-image:radial-gradient(ellipse_at_center,transparent_20%,black)]"
      />
      <div className="w-full max-w-[720px] rounded-3xl border border-[var(--dls-border)] bg-[var(--dls-surface)] px-8 pb-12 pt-10 sm:px-16 sm:pb-16 sm:pt-14">
        <div className="flex items-center gap-2.5">
          <img src="/openwork-mark.svg" alt="" width={26} height={26} aria-hidden="true" />
          <span className="text-[15px] font-semibold tracking-tight">OpenWork</span>
        </div>
        <div className="mt-10 sm:mt-14">
          <h1 className="text-[30px] font-semibold leading-[38px] tracking-[-0.03em] sm:text-[38px] sm:leading-[46px]">{title}</h1>
          <p className="mt-2.5 text-[15px] leading-[23px] text-[var(--dls-text-secondary)]">{description}</p>
        </div>
        {error ? (
          <div role="alert" className="mt-9 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 text-[14px] leading-5 text-red-700">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span className="min-w-0 break-words">{error}</span>
          </div>
        ) : status ? (
          <div role="status" className="mt-9 flex items-center gap-3 rounded-xl border border-[var(--dls-border)] px-4 py-3.5 text-[14px] leading-5 text-[var(--dls-text-secondary)]">
            <LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />
            <span>{status}</span>
          </div>
        ) : null}
        {children}
      </div>
    </main>
  );
}
