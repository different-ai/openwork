"use client";
import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { ALL_ROUTES } from "@/constants";
import LogoTextIcon from "@/icons/logos/logo-text";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

const classMap: { [key: string]: string } = {
  "/": "home-page",
};

ALL_ROUTES.forEach(item => {
  classMap[item.href] = `${item.href.replace("/", item.href === "/" ? "home" : "")}-page`;
});

const Preloader = () => {
  const pathname = usePathname();

  // Lock scroll on mount
  useEffect(() => {
    // Save current scroll position
    // const scrollY = window.scrollY;

    // Lock scroll
    // document.body.style.overflow = "hidden";
    // document.body.style.position = "fixed";
    // document.body.style.top = `-${scrollY}px`;
    // document.body.style.width = "100%";

    return () => {
      // Cleanup if component unmounts before animation completes
      // document.body.style.overflow = "";
      // document.body.style.position = "";
      // document.body.style.top = "";
      // document.body.style.width = "";
      // window.scrollTo(0, scrollY);
    };
  }, []);

  useGSAP(async () => {
    const href = `/${pathname.split("/")[1] || ""}`;
    await new Promise(resolve => {
      const pageClass = classMap[href];
      if (!pageClass) {
        resolve(true);
        return;
      }
      const checkPageLoad = () => {
        const mainContent = document.querySelector(`.${pageClass}`);
        if (mainContent) {
          resolve(true);
        } else {
          setTimeout(checkPageLoad, 100);
        }
      };
      checkPageLoad();
    });

    const wrap = document.querySelector("[data-load-wrap]");
    if (!wrap) return;

    const bg = wrap.querySelector("[data-load-bg]");
    const progressBar = wrap.querySelector("[data-load-progress]");
    const logo = wrap.querySelector("[data-load-logo]");
    const loaderContainer = wrap.querySelector(".loader__container");
    const resetTargets = Array.from(wrap.querySelectorAll<HTMLElement>("[data-load-reset]:not([data-load-text])"));

    const tl = gsap.timeline({
      defaults: {
        ease: "primary",
        duration: 1.15,
      },
    });

    tl.set(wrap, { display: "block" })
      .to(progressBar, { scaleX: 1 })
      .to(logo, { clipPath: "inset(0% 0% 0% 0%)" }, "<")
      .to(loaderContainer, { opacity: 0, duration: 0.5 })
      .to(
        bg,
        {
          yPercent: -101,
          duration: 1,
        },
        "<",
      )
      .set(wrap, { display: "none" });

    if (resetTargets.length) {
      tl.set(resetTargets, { autoAlpha: 1 }, 0);
    }

    return () => {
      tl.kill();
    };
  });

  return (
    <div data-load-wrap className="loader pointer-events-none fixed inset-0 z-[10000] h-dvh w-full">
      <div className="absolute inset-0 z-20 h-full w-full bg-[url(/noise.png)] opacity-35"></div>
      <div data-load-bg className="loader__bg bg-foreground absolute inset-0">
        <div
          data-load-progress
          className="loader__bg-bar bg-background absolute bottom-0 h-[0.4rem] w-full origin-left scale-x-0"
        />
      </div>
      <div className="loader__container relative z-50 flex h-full w-full flex-col items-center justify-center">
        <div className="loader__logo-wrapper relative z-0 flex items-center justify-center">
          <div className="loader__logo-item is--base absolute inset-0 flex items-center justify-center opacity-20">
            <LogoTextIcon className="text-background text-[6.4rem] sm:text-[8rem]" />
          </div>
          <div
            data-load-logo
            className="loader__logo-item is--top relative z-10 flex items-center justify-center"
            style={{ clipPath: "inset(0% 100% 0% 0%)" }}
          >
            <LogoTextIcon className="text-background text-[6.4rem] sm:text-[8rem]" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default Preloader;
