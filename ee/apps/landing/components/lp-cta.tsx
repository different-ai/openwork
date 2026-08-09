type CtaLink = {
  label: string;
  href: string;
};

type LpCtaProps = {
  heading: string;
  sub: string;
  primary: CtaLink;
  secondary: CtaLink;
  trust: string;
};

export function LpCta({
  heading,
  sub,
  primary,
  secondary,
  trust
}: LpCtaProps) {
  return (
    <section className="flex flex-col justify-between gap-10 rounded-[24px] bg-[var(--lp-tonal)] px-7 py-12 md:flex-row md:items-center md:px-14 md:py-[72px]">
      <div className="max-w-[640px]">
        <h2 className="[text-wrap:balance] text-[34px] font-light leading-[41px] tracking-[-0.015em] text-[var(--lp-ink)] md:text-[40px] md:leading-[48px]">
          {heading}
        </h2>
        <p className="mt-4 text-[15px] leading-[23px] text-[var(--lp-body)]">
          {sub}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-start gap-3 md:items-end">
        <div className="flex flex-col gap-3 sm:flex-row">
          <a href={primary.href} className="lp-pill-primary">
            {primary.label}
          </a>
          <a href={secondary.href} className="lp-pill-secondary">
            {secondary.label}
          </a>
        </div>
        <div className="text-[12.5px] text-[var(--lp-muted)]">{trust}</div>
      </div>
    </section>
  );
}
