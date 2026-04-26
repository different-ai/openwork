"use client";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import BubbleButton from "./bubble-button";
import NextLink from "./next-link";
import ThemeSelector from "./theme-selector";
import { MAIN_ROUTES } from "@/constants";
import LogoSymbolIcon from "@/icons/logos/logo-symbol";
import { cn, vhToPx } from "@/lib/utils";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/all";

gsap.registerPlugin(ScrollTrigger);

const HeaderCompact = () => {
  const navRef = useRef<HTMLElement | null>(null);
  const scrollYRef = useRef(0);
  const path = usePathname();

  useEffect(() => {
    const navEl = navRef.current;
    if (!navEl) return;

    const items = navEl.querySelectorAll<HTMLElement>("[data-navigation-item]");
    const toggleBtns = navEl.querySelectorAll('[data-navigation-toggle="toggle"]');
    const closeBtns = navEl.querySelectorAll('[data-navigation-toggle="close"]');

    const openNav = () => {
      ScrollTrigger.getAll().forEach(st => st.disable());

      scrollYRef.current = window.scrollY;
      navRef.current?.setAttribute("data-navigation-status", "active");
    };

    const closeNav = () => {
      navRef.current?.setAttribute("data-navigation-status", "not-active");

      document.body.style.position = "";
      document.body.style.top = "";
      document.body.style.width = "";

      window.scrollTo(0, scrollYRef.current);

      ScrollTrigger.getAll().forEach(st => st.enable());
      ScrollTrigger.refresh();
    };

    const toggleNav = () =>
      navRef.current?.getAttribute("data-navigation-status") === "active" ? closeNav() : openNav();

    items.forEach((item, index) => {
      item.style.transitionDelay = `${index * 0.05}s`;
    });

    /* ---------------------------------------------
     * Event bindings
     * --------------------------------------------- */
    toggleBtns.forEach(btn => {
      btn.addEventListener("click", toggleNav);
    });

    closeBtns.forEach(btn => {
      btn.addEventListener("click", closeNav);
    });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeNav();
      }
    };

    document.addEventListener("keydown", onKeyDown);

    /* ---------------------------------------------
     * Cleanup
     * --------------------------------------------- */
    return () => {
      toggleBtns.forEach(btn => {
        btn.removeEventListener("click", toggleNav);
      });
      closeBtns.forEach(btn => {
        btn.removeEventListener("click", closeNav);
      });
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [path]);

  useGSAP(
    () => {
      gsap
        .timeline({
          scrollTrigger: {
            trigger: "body",
            start: `${vhToPx(10)} ${vhToPx(5)}`,
            toggleActions: "play none none reverse",
          },
        })
        .to(".nav-header", {
          opacity: 1,
          y: "0",
          ease: "primary",
          duration: 0.735,
        });
    },
    { dependencies: [path] },
  );

  return (
    <nav
      ref={navRef}
      data-navigation-status="not-active"
      className="group/nav pointer-events-none fixed inset-0 z-[500]"
    >
      {/* Dark overlay */}
      <div
        data-navigation-toggle="close"
        className="ease-primary pointer-events-auto invisible absolute inset-0 bg-black opacity-0 transition-all duration-[700ms] group-data-[navigation-status=active]/nav:visible group-data-[navigation-status=active]/nav:opacity-[0.15]"
      />

      {/* Nav container */}
      <div className="bg-foreground nav-header absolute inset-x-(--container-px) top-[calc(var(--container-px)/2)] flex h-auto w-[calc(100%-var(--container-px)*2)] flex-col items-stretch rounded-sm sm:left-1/2 sm:w-[68rem] sm:-translate-x-1/2 md:-translate-y-[6.4rem] md:opacity-0">
        {/* Header */}
        <div className="px-base bg-foreground relative z-[1] flex h-(--header-compact-height) items-center justify-between overflow-hidden rounded-sm">
          <div data-navigation-toggle="close" className="absolute top-1/2 left-1/2 -translate-1/2">
            <NextLink
              href="/"
              className="text-foreground pointer-events-auto hidden w-[7rem] items-center justify-center sm:flex"
            >
              <LogoSymbolIcon className="text-background h-full w-full" />
            </NextLink>
          </div>

          {/* Toggle */}
          <button
            data-navigation-toggle="toggle"
            data-hover
            className="text-background group/btn gap-sm pointer-events-auto relative flex cursor-pointer items-center justify-center"
          >
            <div className="relative h-full w-[3rem]">
              <span className="bg-background ease-primary absolute right-0 left-0 h-[0.2rem] translate-y-[-0.4rem] transition-transform duration-[735ms] group-hover/btn:translate-y-[0.4rem] group-data-[navigation-status=active]/nav:translate-y-0 group-data-[navigation-status=active]/nav:rotate-45" />
              <span className="bg-background ease-primary absolute right-0 left-0 h-[0.2rem] translate-y-[0.3rem] transition-transform duration-[735ms] group-hover/btn:-translate-y-[0.3rem] group-data-[navigation-status=active]/nav:translate-y-0 group-data-[navigation-status=active]/nav:-rotate-45" />
            </div>
            <span className="mt-[2px] inline-block font-sans text-base font-medium">Menu</span>
          </button>
          <div className="gap-xs pointer-events-auto flex items-center">
            <BubbleButton variant="secondary">Download</BubbleButton>
            <ThemeSelector className="bg-foreground text-background border-background/60" />
          </div>
        </div>

        {/* Collapsible content */}
        <div className="rounded-b-base ease-primary grid grid-rows-[0fr] overflow-hidden transition-[grid-template-rows] duration-[735ms] group-data-[navigation-status=active]/nav:grid-rows-[1fr]">
          <div
            data-navigation-toggle="close"
            className="gap-base pointer-events-auto flex w-full flex-col items-center overflow-hidden"
          >
            <NextLink
              href="/"
              className="text-foreground pointer-events-auto mt-[1.6rem] flex w-[7rem] items-center justify-center sm:hidden"
            >
              <LogoSymbolIcon className="text-background h-full w-full" />
            </NextLink>
            <ul className="flex w-full flex-col">
              {MAIN_ROUTES.map((item, index) => (
                <li
                  data-navigation-toggle="close"
                  key={item.href}
                  data-navigation-item
                  className="group overflow-hidden"
                >
                  <NextLink
                    href={item.href}
                    {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                    className={cn(
                      "py-base group/item text-background after:ease-primary after:bg-background before:ease-primary before:bg-primary relative block text-center font-sans text-lg font-medium before:absolute before:right-0 before:bottom-0 before:left-0 before:z-10 before:h-px before:origin-left before:scale-x-0 before:transition-all before:duration-700 group-last:before:hidden after:absolute after:right-0 after:bottom-0 after:left-0 after:h-px after:scale-x-0 after:opacity-20 after:transition-all after:duration-700 group-last:after:hidden group-data-[navigation-status=active]/nav:after:scale-x-100 hover:before:scale-x-100",
                      index === MAIN_ROUTES.length - 1 && "pb-lg",
                    )}
                  >
                    <p className="ease-primary translate-y-[150%] transition-colors transition-transform duration-[735ms] group-data-[navigation-status=active]/nav:translate-y-0">
                      <span className="group-hover/item:text-primary transition-all duration-300">{item.label}</span>
                    </p>
                  </NextLink>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </nav>
  );
};

export default HeaderCompact;
