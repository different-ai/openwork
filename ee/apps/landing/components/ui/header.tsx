"use client";

import { useEffect, useState } from "react";
import BubbleButton from "./bubble-button";
import DirectionalButton from "./directional-button";
import Navigation from "./navigation";
import NextLink from "./next-link";
import ThemeSelector from "./theme-selector";
import { DOWNLOAD_URL, GITHUB_URL } from "@/constants";
import LogoTextIcon from "@/icons/logos/logo-text";

const Header = () => {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => {
      setScrolled(window.scrollY > window.innerHeight * 0.05);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <header
      className={
        "pointer-events-none fixed inset-x-0 top-0 z-[200] hidden transition-all duration-500 md:block " +
        (scrolled ? "-translate-y-full opacity-0" : "translate-y-0 opacity-100")
      }
    >
      <div className="pointer-events-auto relative mx-auto flex h-[6.4rem] w-full items-center justify-between border-b border-transparent bg-transparent px-(--container-px)">
        <NextLink href="/" className="text-foreground shrink-0">
          <LogoTextIcon className="text-[1.7rem]" />
        </NextLink>
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <Navigation />
        </div>
        <div className="flex items-center gap-sm shrink-0">
          <DirectionalButton asChild>
            <NextLink href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </NextLink>
          </DirectionalButton>
          <BubbleButton isLink href={DOWNLOAD_URL} target="_blank">
            Download
          </BubbleButton>
          <ThemeSelector />
        </div>
      </div>
    </header>
  );
};

export default Header;
