import type { ReactNode } from "react";

import { LP_PRODUCTS, type LpProductKey } from "./lp-products";
import { SiteFooter } from "./site-footer";
import { SiteNav, type ActivePage } from "./site-nav";

/**
 * Building blocks shared by the product pages (/connect, /ai-gateway,
 * /desktop, /cloud) so the four read as one family: the same hero scale,
 * section headings, numbered steps, facts and plan rows.
 */

export const CLOUD_SIGNUP_URL = "https://app.openworklabs.com";

/** The sales call link, the same one the header uses. */
export function salesCallHref() {
  return process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";
}

type LpProductShellProps = {
  /** GitHub star count for the header, from getGithubData(). */
  stars: string;
  /** Where "Book a call" goes. */
  callHref: string;
  active: ActivePage;
  current: LpProductKey;
  /** The main action in the phone menu. */
  mobilePrimary: { href: string; label: string };
  children: ReactNode;
};

/** Page frame for a product page: header, content column, the other products, footer. */
export function LpProductShell({ stars, callHref, active, current, mobilePrimary, children }: LpProductShellProps) {
  return (
    <div className="relative min-h-screen overflow-x-hidden bg-[var(--lp-page)] text-[var(--lp-ink)]">
      <div className="relative z-10">
        <SiteNav
          stars={stars}
          callUrl={callHref}
          mobilePrimaryHref={mobilePrimary.href}
          mobilePrimaryLabel={mobilePrimary.label}
          active={active}
        />
        <main className="mx-auto w-full max-w-[1176px] px-6 pb-8">
          {children}
          <LpOtherProducts current={current} />
          <div className="mt-16">
            <SiteFooter />
          </div>
        </main>
      </div>
    </div>
  );
}

type LpProductHeroProps = {
  /** id of the h1, for aria-labelledby on the section. */
  id: string;
  /** Product name shown above the headline. */
  label: string;
  /** One short fact in a green pill, such as "Free for solo use". */
  badge?: string;
  lines: string[];
  sub: string;
  /** Buttons and the note under them. */
  actions?: ReactNode;
  /** The product preview under the copy. */
  children?: ReactNode;
};

export function LpProductHero({ id, label, badge, lines, sub, actions, children }: LpProductHeroProps) {
  return (
    <section aria-labelledby={id} className="pt-12 md:pt-[72px]">
      <div className="flex items-center gap-2.5">
        <span className="text-[13px] text-[var(--lp-muted)]">{label}</span>
        {badge ? (
          <span className="inline-flex h-[22px] items-center rounded-full bg-[#ECFDF5] px-2.5 text-xs font-medium text-[#047857]">
            {badge}
          </span>
        ) : null}
      </div>
      <h1
        id={id}
        className="mt-5 max-w-[880px] text-[40px] font-medium leading-[44px] tracking-[-0.045em] md:text-[60px] md:leading-[64px]"
      >
        {lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </h1>
      <p className="mt-5 max-w-[620px] text-[17px] leading-[27px] text-[var(--lp-body)] md:text-lg md:leading-7">{sub}</p>
      {actions ? <div className="mt-8">{actions}</div> : null}
      {children ? <div className="mt-10">{children}</div> : null}
    </section>
  );
}

type LpProductHeadingProps = {
  id: string;
  label: string;
  lines: string[];
  /** Short paragraph on the right of the heading on wide screens. */
  aside?: ReactNode;
  size?: "major" | "small";
};

export function LpProductHeading({ id, label, lines, aside, size = "major" }: LpProductHeadingProps) {
  const heading = (
    <div>
      <div className="text-[13px] text-[var(--lp-muted)]">{label}</div>
      <h2
        id={id}
        className={
          size === "major"
            ? "mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]"
            : "mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.03em]"
        }
      >
        {lines.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </h2>
    </div>
  );
  if (!aside) return heading;
  return (
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
      {heading}
      <p className="max-w-[380px] text-sm leading-[22px] text-[var(--lp-body)] md:text-right">{aside}</p>
    </div>
  );
}

export function LpStep({ number, title, children }: { number: string; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-baseline gap-2.5">
        <span className="mono text-[13px] text-[var(--lp-muted)]">{number}</span>
        <h2 className="text-[17px] font-medium tracking-[-0.015em]">{title}</h2>
      </div>
      {children}
    </div>
  );
}

/** The white card under a step. `mono` sets terminal-style lines. */
export function LpStepCard({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <div
      className={`flex h-[132px] flex-col justify-center rounded-[14px] bg-white px-[18px] shadow-[0_0_0_1px_rgba(1,22,39,0.08)] ${
        mono ? "mono gap-2 text-xs leading-[18px]" : "gap-2.5"
      }`}
    >
      {children}
    </div>
  );
}

export function LpFact({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-t border-[var(--lp-border)] pt-5">
      <h3 className="text-base font-medium tracking-[-0.01em]">{title}</h3>
      <p className="text-sm leading-[22px] text-[var(--lp-body)]">{children}</p>
    </div>
  );
}

type LpTierProps = { name: string; price: string; note: string };

/** Plans as one ruled row: name, price, one line. */
export function LpTiers({ id, tiers, footnote }: { id: string; tiers: LpTierProps[]; footnote?: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mt-24 md:mt-28">
      <h2 id={id} className="text-[13px] font-normal text-[var(--lp-muted)]">
        Pricing
      </h2>
      <div className="mt-4 grid border-y border-[var(--lp-border)] md:grid-cols-3">
        {tiers.map((tier, index) => (
          <div
            key={tier.name}
            className={`flex flex-col gap-1.5 py-6 ${
              index === 0 ? "md:pr-6" : "border-t border-[var(--lp-border)] md:border-l md:border-t-0 md:px-6"
            }`}
          >
            <span className="text-sm text-[var(--lp-body)]">{tier.name}</span>
            <span className="text-[28px] font-medium tracking-[-0.03em]">{tier.price}</span>
            <span className="text-[13px] text-[var(--lp-muted)]">{tier.note}</span>
          </div>
        ))}
      </div>
      {footnote ? <p className="mt-4 text-[13px] leading-5 text-[var(--lp-muted)]">{footnote}</p> : null}
    </section>
  );
}

/** A ruled grid of named marks: providers, connections, platforms. */
export function LpMarkGrid({ items, label }: { items: { name: string; mark: ReactNode }[]; label: string }) {
  return (
    <ul aria-label={label} className="mt-8 grid grid-cols-2 border-b border-[var(--lp-border)] md:grid-cols-4">
      {items.map((item, index) => (
        <li
          key={item.name}
          className={`flex h-16 items-center gap-3 border-t border-[var(--lp-border)] px-4 md:px-5 ${index % 2 === 1 ? "border-l" : ""} ${index % 4 !== 0 ? "md:border-l" : "md:border-l-0"}`}
        >
          {item.mark}
          <span className="text-sm text-[#111827]">{item.name}</span>
        </li>
      ))}
    </ul>
  );
}

/** Closing panel: one line and the page's main action. */
export function LpProductCta({ heading, note, children }: { heading: string; note: string; children: ReactNode }) {
  return (
    <section className="mt-24 md:mt-28">
      <div className="flex flex-col items-start gap-6 rounded-[24px] bg-[var(--lp-tonal)] px-6 py-10 md:px-14 md:py-14">
        <h2 className="text-[32px] font-medium leading-[38px] tracking-[-0.035em] md:text-[40px] md:leading-[46px]">{heading}</h2>
        {children}
        <span className="text-[13px] text-[var(--lp-muted)]">{note}</span>
      </div>
    </section>
  );
}

/** The other three products, so every product page leads to the rest. */
export function LpOtherProducts({ current }: { current: LpProductKey }) {
  const others = LP_PRODUCTS.filter((product) => product.key !== current);
  return (
    <nav aria-label="Other OpenWork products" className="mt-16">
      <div className="text-[13px] text-[var(--lp-muted)]">More from OpenWork</div>
      <ul className="mt-4 grid border-y border-[var(--lp-border)] md:grid-cols-3">
        {others.map((product, index) => (
          <li key={product.key} className={index === 0 ? "" : "border-t border-[var(--lp-border)] md:border-l md:border-t-0"}>
            <a
              href={product.href}
              className={`group flex h-full flex-col gap-2 py-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--lp-ink)] ${
                index === 0 ? "md:pr-6" : "md:px-6"
              }`}
            >
              <span className="flex items-center gap-2.5 text-[17px] font-medium tracking-[-0.015em]">
                <product.icon size={18} strokeWidth={1.5} aria-hidden="true" />
                {product.name}
                <span aria-hidden="true" className="transition-transform duration-150 ease-out group-hover:translate-x-1 motion-reduce:transition-none">
                  →
                </span>
              </span>
              <span className="text-sm leading-[21px] text-[var(--lp-body)]">{product.line}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A small "Rolling out" style label next to a fact title. */
export function LpStatusBadge({ children }: { children: ReactNode }) {
  return (
    <span className="ml-2 inline-flex h-5 items-center rounded-full bg-[var(--lp-tonal)] px-2 align-middle text-[11px] font-medium text-[var(--lp-body)]">
      {children}
    </span>
  );
}

/** White preview window with the hairline and soft drop used by the homepage showcase. */
export function LpPreviewFrame({ children, tall = false, label }: { children: ReactNode; tall?: boolean; label: string }) {
  return (
    <div
      role="group"
      aria-label={label}
      className={`flex overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_2px_4px_rgba(1,22,39,0.04),0_32px_64px_-24px_rgba(1,22,39,0.22)] ${
        tall ? "h-[620px] md:h-[704px]" : ""
      }`}
    >
      {children}
    </div>
  );
}
