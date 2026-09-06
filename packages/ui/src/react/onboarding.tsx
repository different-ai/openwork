import type { ReactNode } from "react";

export type OnboardingIntroProps = {
  title: string;
  description: ReactNode;
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
    <div className={`flex min-w-0 flex-col gap-2.5 ${className}`}>
      {eyebrow ? (
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {eyebrow}
        </p>
      ) : null}
      <Heading className={size === "compact"
        ? "text-lg font-semibold leading-7 tracking-tight text-foreground"
        : "text-[30px] font-semibold leading-[38px] tracking-[-0.03em] text-foreground sm:text-[38px] sm:leading-[46px]"}>
        {title}
      </Heading>
      <p className={size === "compact"
        ? "text-sm leading-relaxed text-muted-foreground"
        : "text-[15px] leading-[23px] text-muted-foreground"}>
        {description}
      </p>
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
    <div className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3 border-b border-border py-4 ${className}`}>
      <div className="flex min-w-0 flex-[1_1_12rem] items-start gap-3">
        {icon ? (
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-muted-foreground">
            {icon}
          </span>
        ) : null}
        <div className="min-w-0 break-words">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {description ? (
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
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
