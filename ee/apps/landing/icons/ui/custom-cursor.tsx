"use client";

import { useRef } from "react";
import { usePathname } from "next/navigation";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

const CustomCursor = () => {
  const cursorRef = useRef<HTMLDivElement>(null);
  const handRef = useRef<HTMLDivElement>(null);
  const path = usePathname();

  useGSAP(
    () => {
      const cursor = cursorRef.current!;
      const hand = handRef.current!;

      gsap.set(cursor, {
        xPercent: -50,
        yPercent: -50,
      });

      // smooth follow
      const xTo = gsap.quickTo([cursor, hand], "x", { duration: 0.3, ease: "power3" });
      const yTo = gsap.quickTo([cursor, hand], "y", { duration: 0.3, ease: "power3" });

      const followCursor = (e: MouseEvent) => {
        xTo(e.clientX);
        yTo(e.clientY);
      };

      window.addEventListener("mousemove", followCursor);

      const resetCursor = () => {
        gsap.to(cursor, {
          scale: 0.25,
          opacity: 1,
          backgroundColor: "var(--primary)",
          border: "none",
          mixBlendMode: "normal",
          duration: 0.25,
        });

        gsap.to(hand, { opacity: 0, scale: 0.5, duration: 0.2 });
      };

      const handleEnter = (e: Event) => {
        const target = e.currentTarget as HTMLElement;
        const type = target.dataset.cursor;

        switch (type) {
          case "large":
            gsap.to(cursor, {
              scale: 3,
              backgroundColor: "#fff",
              mixBlendMode: "difference",
              duration: 0.25,
            });
            break;

          case "accent":
            gsap.to(cursor, {
              scale: 1,
              border: "1px solid var(--primary)",
              backgroundColor: "rgba(0,73,255,0.25)",
              duration: 0.25,
            });
            break;

          case "outline":
            gsap.to(cursor, {
              scale: 2,
              backgroundColor: "transparent",
              border: "2px solid var(--primary)",
              duration: 0.25,
            });
            break;

          case "hide":
            gsap.to(cursor, { scale: 0, duration: 0.2 });
            break;

          case "hand":
            gsap.to(cursor, { opacity: 0, scale: 0.1, duration: 0.2 });
            gsap.to(hand, { opacity: 1, scale: 1, duration: 0.25 });
            break;

          default:
            gsap.to(cursor, { scale: 1.5, duration: 0.2 });
        }
      };

      const handleLeave = () => resetCursor();

      const items = document.querySelectorAll("[data-cursor]");
      items.forEach(el => {
        el.addEventListener("mouseenter", handleEnter);
        el.addEventListener("mouseleave", handleLeave);
      });

      return () => {
        window.removeEventListener("mousemove", followCursor);
        items.forEach(el => {
          el.removeEventListener("mouseenter", handleEnter);
          el.removeEventListener("mouseleave", handleLeave);
        });
      };
    },
    { dependencies: [path] },
  );

  return (
    <>
      {/* DOT CURSOR */}
      <div
        ref={cursorRef}
        className="bg-primary border-primary pointer-events-none fixed top-0 left-0 z-[999999] size-[4rem] scale-[0.25] rounded-full border will-change-transform pointer-coarse:hidden"
      />

      {/* HAND CURSOR */}
      <div
        ref={handRef}
        className="pointer-events-none fixed top-0 left-0 z-50 scale-50 opacity-0 will-change-transform pointer-coarse:hidden"
      >
        <svg className="text-primary w-[3.2rem]" viewBox="0 0 24 35" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path
            d="M11.9996 1.30564C11.0889 1.30564 10.3516 2.04339 10.3516 2.9537V15.4307H9.12567V5.99712C9.12567 5.08644 8.38716 4.3483 7.47723 4.3483C6.56654 4.3483 5.82879 5.08605 5.82879 5.99712V20.7238H4.60291V15.3931C4.60291 14.4828 3.86439 13.7451 2.95447 13.7451C2.04378 13.7451 1.30602 14.4828 1.30602 15.3931V19.5735H1.30449V22.1522C1.30449 22.1552 1.30602 22.1583 1.30602 22.1618V22.6591C1.30602 22.7776 1.31791 22.8918 1.3413 23.0027C1.77613 28.5113 6.3798 32.8469 11.9996 32.8469C17.9059 32.8469 22.694 28.0584 22.694 22.1522H22.6951V16.6984H22.694V10.457C22.694 9.5467 21.9558 8.80818 21.0452 8.80818C20.1348 8.80818 19.3967 9.5467 19.3967 10.457V16.6988H18.1712V4.72945C18.1712 3.81876 17.4331 3.081 16.5224 3.081C15.6121 3.081 14.8739 3.81914 14.8739 4.72945V15.4307H13.6484V2.9537C13.6484 2.04301 12.9103 1.30564 11.9996 1.30564ZM11.9996 0C13.3965 0 14.5699 0.973574 14.8759 2.27806C15.3467 1.96057 15.9139 1.77536 16.5224 1.77536C18.1517 1.77536 19.4768 3.10056 19.4768 4.72945V7.95463C19.9316 7.66819 20.4692 7.50292 21.0452 7.50292C22.6744 7.50292 23.9996 8.82774 23.9996 10.457L24 22.1525C23.9992 28.7682 18.616 34.1522 11.9996 34.1522C5.80693 34.1522 0.570571 29.338 0.0463981 23.1798C0.0164892 23.0076 1.15278e-07 22.8324 1.15278e-07 22.6595V15.3931C1.15278e-07 13.7646 1.32558 12.4394 2.95447 12.4394C3.53041 12.4394 4.068 12.6051 4.52277 12.8915V5.99712C4.52277 4.36824 5.84835 3.04343 7.47723 3.04343C8.05317 3.04343 8.59076 3.20908 9.0463 3.49551V2.9537C9.04592 1.3252 10.3707 0 11.9996 0Z"
            fill="currentColor"
          />
        </svg>
      </div>
    </>
  );
};

export default CustomCursor;
