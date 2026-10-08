"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { DownloadLink } from "./download-link";
import { LpDemoAiGateway, LpDemoCloud, LpDemoMcp } from "./lp-demo-panels";
import { LpDemoDesktop } from "./lp-demo-desktop";
import { LP_PRODUCTS, LP_PRODUCT_TAB_ORDER, type LpProduct, type LpProductKey } from "./lp-products";

type Stage = {
  content: ReactNode;
  /** Fixed-height app windows; data panels size to their content. */
  tall: boolean;
  note: string;
  action: ReactNode;
};

const STAGES: Record<LpProductKey, Stage> = {
  "desktop-app": {
    content: <LpDemoDesktop />,
    tall: true,
    note: "Chat, Library and Automations, on your own files. No account needed.",
    action: <DownloadLink className="lp-pill-primary lp-pill-sm">Download OpenWork</DownloadLink>
  },
  "mcp-gateway": {
    content: <LpDemoMcp />,
    tall: false,
    note: "Share a skill or connection once. Every teammate's agent gets it.",
    action: (
      <a href="/connect" className="lp-pill-secondary lp-pill-sm">
        Explore MCP Gateway
      </a>
    )
  },
  "ai-gateway": {
    content: <LpDemoAiGateway />,
    tall: false,
    note: "OpenAI, Anthropic, Vertex, Bedrock, Azure, Mistral, OpenRouter and more.",
    action: (
      <a href="/docs/ai-gateway/overview" className="lp-pill-secondary lp-pill-sm">
        Set up AI Gateway
      </a>
    )
  },
  "cloud-app": {
    content: <LpDemoCloud />,
    tall: true,
    note: "Nothing to install. Admins set models, skills and access for everyone.",
    action: (
      <a href="https://app.openworklabs.com" className="lp-pill-primary lp-pill-sm">
        Open OpenWork Web
      </a>
    )
  }
};

function isProductKey(value: string): value is LpProductKey {
  return LP_PRODUCT_TAB_ORDER.some((key) => key === value);
}

const TABS: LpProduct[] = LP_PRODUCT_TAB_ORDER.flatMap((key) => LP_PRODUCTS.filter((product) => product.key === key));

export function LpProductsShowcase() {
  const [active, setActive] = useState<LpProductKey>("desktop-app");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reduceMotion = useReducedMotion();

  // Deep links: /#mcp-gateway opens that tab.
  useEffect(() => {
    const fromHash = () => {
      const hash = window.location.hash.replace("#", "");
      if (isProductKey(hash)) setActive(hash);
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  const select = (key: LpProductKey) => {
    setActive(key);
    window.history.replaceState(null, "", `#${key}`);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    select(TABS[next].key);
    tabRefs.current[next]?.focus();
  };

  const stage = STAGES[active];

  return (
    <section id="products" aria-labelledby="products-heading" className="mt-20 scroll-mt-24 lg:mt-28">
      <div className="text-[13px] text-[var(--lp-muted)]">Products</div>
      <h2
        id="products-heading"
        className="mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.035em] text-[var(--lp-ink)] md:text-[40px] md:leading-[46px]"
      >
        <span className="block">Start with the open-source app.</span>
        <span className="block">Add the rest when you need it.</span>
      </h2>
      <p className="mt-4 text-[17px] text-[var(--lp-body)]">Free for teams of up to 5.</p>

      <div
        role="tablist"
        aria-label="OpenWork products"
        className="-mx-6 mt-8 flex gap-2 overflow-x-auto px-6 pb-1 md:mx-0 md:mt-10 md:gap-6 md:overflow-visible md:px-0 md:pb-0"
      >
        {TABS.map((product, index) => {
          const selected = product.key === active;
          const Icon = product.icon;
          return (
            <button
              key={product.key}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              role="tab"
              id={`product-tab-${product.key}`}
              aria-selected={selected}
              aria-controls={`product-panel-${product.key}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(product.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`group flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-left text-sm transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lp-ink)] md:flex-1 md:shrink md:flex-col md:items-start md:gap-2.5 md:rounded-none md:border-t-2 md:px-0 md:pb-[22px] md:pt-5 ${
                selected
                  ? "bg-[var(--lp-ink)] text-white md:border-[var(--lp-ink)] md:bg-transparent md:text-[var(--lp-ink)]"
                  : "bg-[var(--lp-tonal)] text-[var(--lp-body)] hover:text-[var(--lp-ink)] md:border-[var(--lp-border)] md:bg-transparent md:text-[var(--lp-muted)]"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
                <span className={`font-medium md:text-[17px] md:tracking-[-0.015em] ${selected ? "" : "md:text-[var(--lp-body)]"}`}>
                  {product.name}
                </span>
              </span>
              <span className={`hidden pr-5 text-sm leading-[21px] md:block ${selected ? "text-[var(--lp-body)]" : "text-[#6B7684]"}`}>
                {product.line}
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`product-panel-${active}`}
        aria-labelledby={`product-tab-${active}`}
        className="mt-6 md:mt-2"
      >
        <div
          className={`overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1px_rgba(1,22,39,0.08),0_2px_4px_rgba(1,22,39,0.04),0_32px_64px_-24px_rgba(1,22,39,0.22)] ${
            stage.tall ? "h-[620px] md:h-[704px]" : ""
          }`}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={active}
              className="flex h-full"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={reduceMotion ? undefined : { opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.15, ease: "easeOut" }}
            >
              {stage.content}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-[var(--lp-body)]">{stage.note}</p>
          {stage.action}
        </div>
      </div>
    </section>
  );
}
