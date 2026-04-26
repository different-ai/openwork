"use client";

import React, { AnchorHTMLAttributes } from "react";
import Link, { LinkProps } from "next/link";
import { useRouter } from "next/navigation";
import { ALL_ROUTES } from "@/constants";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

type NextLinkProps = LinkProps & AnchorHTMLAttributes<HTMLAnchorElement>;

const classMap: { [key: string]: string } = {
  "/": "home-page",
};

ALL_ROUTES.forEach(item => (classMap[item.href] = `${item.href.replace("/", item.href === "/" ? "home" : "")}-page`));

const NextLink = ({ children, ...props }: NextLinkProps) => {
  const router = useRouter();

  const handleLinkClick = async function(e: React.MouseEvent<HTMLAnchorElement>) {
    const href = props.href as string;

    // 👉 if opening in new tab/window, skip GSAP entirely
    if (props.target === "_blank") {
      return; // let the browser handle it normally
    }
    e.preventDefault();

    const wrap = document.querySelector("[data-load-wrap]");
    if (!wrap) return;

    const bg = wrap.querySelector("[data-load-bg]");
    const progressBar = wrap.querySelector("[data-load-progress]");

    const logo = wrap.querySelector("[data-load-logo]");
    const loaderContainer = wrap.querySelector(".loader__container");

    const tl = gsap.timeline({
      defaults: {
        ease: "primary",
        duration: 1.15,
      },
    });

    tl.set(wrap, { display: "block" })
      .fromTo(
        bg,
        {
          yPercent: 101,
        },
        {
          yPercent: 0,
          duration: 1,
          onComplete: () => {
            router.push(href);
          },
        },
      )
      .fromTo(progressBar, { scaleX: 0 }, { scaleX: 1.1 })
      .to(loaderContainer, { opacity: 1, duration: 0.5 }, "<")
      .fromTo(logo, { clipPath: "inset(0% 100% 0% 0%)" }, { clipPath: "inset(0% 0% 0% 0%)" }, "<");

    tl.to(loaderContainer, { opacity: 0, duration: 0.5 })
      .to(
        bg,
        {
          yPercent: -101,
          duration: 1,
        },
        "<",
      )
      .set(wrap, { display: "none" });
  };

  return (
    <Link onClick={handleLinkClick} {...props}>
      {children}
    </Link>
  );
};

export default NextLink;
