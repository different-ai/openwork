import { useEffect, useRef, type AnchorHTMLAttributes, type ReactNode } from "react";

export function Container({ children, className = "", wide = false }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={`mx-auto w-full ${wide ? "max-w-[1280px]" : "max-w-[1040px]"} px-6 md:px-8 ${className}`}>{children}</div>;
}

/** A section is a heading, one paragraph, and one thing to look at. */
export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className = "",
}: {
  id?: string;
  eyebrow?: string;
  title: string;
  lead?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-24 py-16 md:py-24 ${className}`}>
      <Container>
        <Reveal>
          <div className="max-w-2xl">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h2 className="mt-3 text-[28px] font-semibold leading-[1.12] tracking-[-0.03em] text-snow md:text-[36px]">{title}</h2>
            {lead ? <p className="mt-4 text-[15.5px] leading-relaxed text-mist md:text-[17px]">{lead}</p> : null}
          </div>
        </Reveal>
        {children}
      </Container>
    </section>
  );
}

/** Reveals once when scrolled into view; a no-op under reduced motion (see styles.css). */
export function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!("IntersectionObserver" in window)) {
      node.classList.add("is-visible");
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add("is-visible");
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className={`reveal ${className}`} style={delay ? { transitionDelay: `${delay}ms` } : undefined}>
      {children}
    </div>
  );
}

export function ButtonLink({
  variant = "primary",
  className = "",
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: "primary" | "ghost"; children: ReactNode }) {
  const styles = {
    primary: "bg-snow text-ink hover:bg-white",
    ghost: "border border-white/12 bg-white/[0.04] text-snow hover:bg-white/[0.08]",
  } as const;
  return (
    <a
      {...props}
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-sm font-semibold transition-colors ${styles[variant]} ${className}`}
    >
      {children}
    </a>
  );
}

export function Pill({ tone = "mist", children }: { tone?: "mist" | "spark" | "mint" | "amber" | "rose"; children: ReactNode }) {
  const tones = {
    mist: "bg-white/[0.06] text-mist",
    spark: "bg-spark/12 text-spark",
    mint: "bg-mint/12 text-mint",
    amber: "bg-amber/12 text-amber",
    rose: "bg-rose/12 text-rose",
  } as const;
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

export function StatusDot({ tone }: { tone: "spark" | "mint" | "amber" | "rose" | "mist" }) {
  const colors = { spark: "bg-spark", mint: "bg-mint", amber: "bg-amber", rose: "bg-rose", mist: "bg-mist" } as const;
  return <span className={`status-dot ${colors[tone]} ${tone === "spark" ? "pulse" : ""}`} aria-hidden="true" />;
}

/** A faux macOS window with hidden-inset traffic lights, for product vignettes. */
export function ProductFrame({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <div className={`product-frame ${className}`} role="img" aria-label={title ? `${title} — product illustration` : "Product illustration"}>
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2">
        <span className="traffic-light bg-[#ff5f57]" />
        <span className="traffic-light bg-[#febc2e]" />
        <span className="traffic-light bg-[#28c840]" />
        {title ? <span className="ml-3 text-[11px] font-medium text-mist">{title}</span> : null}
      </div>
      {children}
    </div>
  );
}
