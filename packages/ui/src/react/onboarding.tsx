import type { ReactNode } from "react";

export type OnboardingIntroProps = {
  title: string;
  description?: ReactNode;
  eyebrow?: ReactNode;
  children?: ReactNode;
  className?: string;
  headingLevel?: 1 | 2;
  size?: "default" | "compact";
};

/** Shared hierarchy; each product surface owns its navigation and actions. */
export function OnboardingIntro({
  title,
  description,
  eyebrow,
  children,
  className = "",
  headingLevel = 1,
  size = "default",
}: OnboardingIntroProps) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`}>
      {eyebrow ? (
        <p className="text-xs font-medium text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <Heading className={size === "compact"
        ? "text-base font-semibold leading-6 tracking-tight text-foreground"
        : "text-[28px] font-semibold leading-9 tracking-tight text-foreground sm:text-[32px] sm:leading-10"}>
        {title}
      </Heading>
      {description ? <p className={size === "compact"
        ? "text-[13px] leading-5 text-muted-foreground"
        : "text-[15px] leading-[23px] text-muted-foreground"}>
        {description}
      </p> : null}
      {children}
    </div>
  );
}

export type OnboardingResourceRowProps = {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  status?: ReactNode;
  action?: ReactNode;
  className?: string;
};

/** Status comes from the caller's authorized data, never from appearance. */
export function OnboardingResourceRow({
  title,
  description,
  icon,
  status,
  action,
  className = "",
}: OnboardingResourceRowProps) {
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border py-3 last:border-b-0 ${className}`}>
      <div className="flex min-w-0 flex-[1_1_12rem] items-start gap-3">
        {icon ? (
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 break-words">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? (
            <p className="mt-0.5 text-[13px] leading-5 text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {status || action ? (
        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-3">
          {status ? <span className="text-xs text-muted-foreground">{status}</span> : null}
          {action}
        </div>
      ) : null}
    </div>
  );
}
