"use client";

import { usePathname } from "next/navigation";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import MotionPathPlugin from "gsap/MotionPathPlugin";
import { CustomEase, ScrollTrigger, SplitText } from "gsap/all";

type SplitType = "lines" | "words" | "chars";

type SplitConfig = Record<
  SplitType,
  {
    duration: number;
    stagger: number;
  }
>;

interface ItemSlot {
  type: "item";
  el: HTMLElement;
}

interface NestedSlot {
  type: "nested";
  parentEl: HTMLElement;
  nestedEl: HTMLElement;
  includeParent: boolean;
}

type AnimationSlot = ItemSlot | NestedSlot;

const splitConfig: SplitConfig = {
  lines: { duration: 0.8, stagger: 0.08 },
  words: { duration: 0.6, stagger: 0.06 },
  chars: { duration: 0.4, stagger: 0.01 },
};

const AnimationsProvider = (): null => {
  const path = usePathname();

  useGSAP(
    () => {
      gsap.config({
        force3D: true,
      });

      gsap.registerPlugin(ScrollTrigger, MotionPathPlugin, CustomEase, SplitText);
      const primaryEase = CustomEase.create("primary", "0.625, 0.05, 0, 1");
      gsap.registerEase("primary", primaryEase);

      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      document.querySelectorAll<HTMLElement>("[data-reveal-group]").forEach(groupEl => {
        const groupStaggerSec = parseFloat(groupEl.getAttribute("data-stagger") || "0.1") || 0.1;
        const groupDelaySec = parseFloat(groupEl.getAttribute("data-reveal-delay") || "0") || 0;
        const groupDistance = groupEl.getAttribute("data-distance") || "3.2rem";
        const triggerStart = groupEl.getAttribute("data-start") || "top 85%";
        const animateWhole = groupEl.getAttribute("data-animate-whole") || false;

        const animDuration = 1.25;
        const animEase = "expo.out";

        if (prefersReduced) {
          gsap.set(groupEl, { clearProps: "all", y: 0, autoAlpha: 1 });
          return;
        }

        const children = Array.from(groupEl.children).filter(el => el.nodeType === 1) as HTMLElement[];

        // ─────────────────────────────────────────────
        // Single element reveal
        // ─────────────────────────────────────────────
        if (!children.length || animateWhole) {
          gsap.set(groupEl, { y: groupDistance, autoAlpha: 0 });

          ScrollTrigger.create({
            trigger: groupEl,
            start: triggerStart,
            once: true,
            onEnter: () =>
              gsap.to(groupEl, {
                y: 0,
                autoAlpha: 1,
                duration: animDuration,
                ease: animEase,
                delay: groupDelaySec,
                onComplete: () => {
                  gsap.set(groupEl, { clearProps: "all" });
                },
              }),
          });

          return;
        }

        const slots: AnimationSlot[] = [];

        children.forEach(child => {
          const nested = child.matches("[data-reveal-group-nested]")
            ? child
            : (child.querySelector(":scope [data-reveal-group-nested]") as HTMLElement | null);

          if (nested) {
            const includeParent =
              child.getAttribute("data-ignore") === "false" || nested.getAttribute("data-ignore") === "false";

            slots.push({
              type: "nested",
              parentEl: child,
              nestedEl: nested,
              includeParent,
            });
          } else {
            slots.push({ type: "item", el: child });
          }
        });

        // ─────────────────────────────────────────────
        // Initial state
        // ─────────────────────────────────────────────
        slots.forEach(slot => {
          if (slot.type === "item") {
            const d = slot.el.matches("[data-reveal-group-nested]")
              ? groupDistance
              : slot.el.getAttribute("data-distance") || groupDistance;

            gsap.set(slot.el, { y: d, autoAlpha: 0 });
          } else {
            if (slot.includeParent) {
              gsap.set(slot.parentEl, { y: groupDistance, autoAlpha: 0 });
            }

            const nestedD = slot.nestedEl.getAttribute("data-distance") || groupDistance;

            Array.from(slot.nestedEl.children).forEach(el => gsap.set(el as HTMLElement, { y: nestedD, autoAlpha: 0 }));
          }
        });

        // ─────────────────────────────────────────────
        // Scroll trigger - with group delay applied
        // ─────────────────────────────────────────────
        ScrollTrigger.create({
          trigger: groupEl,
          start: triggerStart,
          once: true,
          onEnter: () => {
            const tl = gsap.timeline({ delay: groupDelaySec });

            slots.forEach((slot, i) => {
              const time = i * groupStaggerSec;

              if (slot.type === "item") {
                tl.to(
                  slot.el,
                  {
                    y: 0,
                    autoAlpha: 1,
                    duration: animDuration,
                    ease: animEase,
                    onComplete: () => {
                      gsap.set(slot.el, { clearProps: "all" });
                    },
                  },
                  time,
                );
              } else {
                if (slot.includeParent) {
                  tl.to(
                    slot.parentEl,
                    {
                      y: 0,
                      autoAlpha: 1,
                      duration: animDuration,
                      ease: animEase,
                      onComplete: () => {
                        gsap.set(slot.parentEl, { clearProps: "all" });
                      },
                    },
                    time,
                  );
                }

                const nestedMs = parseFloat(slot.nestedEl.getAttribute("data-stagger") || "");
                const nestedStagger = isNaN(nestedMs) ? groupStaggerSec : nestedMs / 1000;

                Array.from(slot.nestedEl.children).forEach((el, j) => {
                  tl.to(
                    el as HTMLElement,
                    {
                      y: 0,
                      autoAlpha: 1,
                      duration: animDuration,
                      ease: animEase,
                      onComplete: () => {
                        gsap.set(el as HTMLElement, { clearProps: "all" });
                      },
                    },
                    time + j * nestedStagger,
                  );
                });
              }
            });
          },
        });
      });

      document.querySelectorAll<HTMLElement>('[data-split="heading"]').forEach(heading => {
        gsap.set(heading, { autoAlpha: 1 });

        const splitType = (heading.dataset.splitReveal as SplitType | undefined) ?? "lines";

        const typesToSplit =
          splitType === "lines" ? ["lines"] : splitType === "words" ? ["lines", "words"] : ["lines", "words", "chars"];

        const splitDelay = heading.dataset.splitDelay ?? 0;
        const splitPaddingBottom = heading.dataset.splitPaddingBottom ?? 0;

        SplitText.create(heading, {
          type: typesToSplit.join(", "),
          mask: "lines",
          autoSplit: true,
          linesClass: "line",
          wordsClass: "word",
          charsClass: "letter",

          onSplit(instance) {
            const targets = instance[splitType] as HTMLElement[];
            const { duration, stagger } = splitConfig[splitType];

            const splitDuration = heading.dataset.splitDuration ?? duration;

            gsap.set(targets, {
              paddingBottom: splitPaddingBottom,
            });

            return gsap.from(targets, {
              yPercent: 110,
              duration: splitDuration,
              stagger,
              ease: "primary",
              delay: splitDelay,
              scrollTrigger: {
                trigger: heading,
                start: "top 90%",
                once: true,
              },
            });
          },
        });
      });
    },
    { dependencies: [path] },
  );

  return null;
};

export default AnimationsProvider;
