"use client";
import { useRef } from "react";
import DotsPattern from "../dots-pattern";
import NotionIconBorder from "@/icons/brands/notion-icon-border";
import LogoSymbolIcon from "@/icons/logos/logo-symbol";
import LockIcon from "@/icons/ui/lock-icon";
import { cn } from "@/lib/utils";
import { useGSAP } from "@gsap/react";
import gsap from "gsap";

// Constants
const STAR_POSITIONS = [0.05, 0.25, 0.45, 0.65, 0.85];
const CIRCLE_SMALL_COUNT = 5;
const CIRCLE_BIG_COUNT = 2;
const SPECIAL_CIRCLE_INDEX = 4;

// Animation configuration
const ANIMATION_CONFIG = {
  logoOpacity: { duration: 1, ease: "power1.inOut" },
  circleRotation: { duration: 1, ease: "back.inOut" },
  pulseScale: { duration: 0.8 },
  default: { ease: "primary", duration: 0.5 },
};

const FeatureDirectExecution = () => {
  const containerRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const elements = getAnimationElements();
      if (!elements) return;

      setupCirclePositions(elements);
      setupLoopAnimations(elements);
      const timeline = createHoverTimeline(elements);
      attachHoverListeners(timeline);
    },
    { scope: containerRef },
  );

  return (
    <div ref={containerRef} className="bg-background-muted p-lg relative z-0 h-full w-full overflow-hidden rounded-sm">
      <DotsPattern />
      <Header />
      <CircleAnimation />
    </div>
  );

  // Helper functions
  function getAnimationElements() {
    if (!containerRef.current) return null;

    return {
      circleBig: gsap.utils.toArray<HTMLDivElement>(".circle-big"),
      circleSmall: gsap.utils.toArray<HTMLDivElement>(".circle-small"),
      notionIcon: containerRef.current.querySelector<HTMLDivElement>(".notion-icon"),
      notionLock: containerRef.current.querySelector<HTMLDivElement>(".notion-lock"),
      logoIcon: containerRef.current.querySelector<HTMLDivElement>(".logo-icon"),
      centerNotion: containerRef.current.querySelector<HTMLDivElement>(".center-notion"),
      pulse: containerRef.current.querySelector<HTMLDivElement>(".pulse"),
    };
  }

  function setupCirclePositions(elements: NonNullable<ReturnType<typeof getAnimationElements>>) {
    elements.circleSmall.forEach((circle, index) => {
      gsap.set(circle, {
        motionPath: {
          path: "#circle-small-path",
          align: "#circle-small-path",
          alignOrigin: [0.5, 0.5],
          start: STAR_POSITIONS[index],
          end: STAR_POSITIONS[index],
          autoRotate: true,
        },
      });
    });

    const bigPathProgress = [0.3, 0.7];
    elements.circleBig.forEach((circle, index) => {
      gsap.set(circle, {
        motionPath: {
          path: "#circle-big-path",
          align: "#circle-big-path",
          alignOrigin: [0.5, 0.5],
          start: bigPathProgress[index],
          end: bigPathProgress[index],
          autoRotate: true,
        },
      });
    });
  }

  function setupLoopAnimations(elements: NonNullable<ReturnType<typeof getAnimationElements>>) {
    if (elements.logoIcon) {
      gsap.to(elements.logoIcon, {
        opacity: 0.8,
        ...ANIMATION_CONFIG.logoOpacity,
        repeat: -1,
        yoyo: true,
      });
    }
  }

  function createHoverTimeline(elements: NonNullable<ReturnType<typeof getAnimationElements>>) {
    const tl = gsap.timeline({
      paused: true,
      defaults: ANIMATION_CONFIG.default,
    });

    tl.to(".circle-small-wrapper", {
      rotation: "73deg",
      duration: ANIMATION_CONFIG.circleRotation.duration,
      ease: ANIMATION_CONFIG.circleRotation.ease,
      force3D: true,
    });

    const { notionIcon, notionLock, logoIcon, centerNotion, pulse } = elements;
    if (notionIcon && notionLock && logoIcon && centerNotion && pulse) {
      tl.to(pulse, { scale: 1, duration: ANIMATION_CONFIG.pulseScale.duration })
        .to(".notion-icon-pulse", { scale: 1.2 }, "<+=0.05")
        .to(notionIcon, { scale: 0 })
        .to(notionLock, { scale: 1 }, "<")
        .to(logoIcon, { scale: 0 }, "<")
        .to(centerNotion, { scale: 1 }, "<");
    }

    return tl;
  }

  function attachHoverListeners(timeline: gsap.core.Timeline) {
    const container = containerRef.current;
    if (container) {
      container.addEventListener("mouseenter", () => timeline.timeScale(1).play());
      container.addEventListener("mouseleave", () => timeline.timeScale(1.5).reverse());
    }
  }
};

// Subcomponents
const Header = () => (
  <div className="gap-sm flex flex-col items-center text-center">
    <h3 className="h3-serif bg-background-muted w-fit">Direct execution</h3>
    <p className="body-base-sm text-primary">
      OpenWork plans, asks, and acts — every step is visible. The plan timeline renders OpenCode todos as they
      happen, every tool call surfaces a permission prompt, every result is auditable.
    </p>
  </div>
);

const CircleAnimation = () => (
  <div className="absolute left-1/2 aspect-square w-[44.8rem] -translate-x-1/2 translate-y-[3.2rem] scale-100">
    <CenterContent />
    <CirclePaths />
  </div>
);

const CenterContent = () => (
  <div className="absolute top-1/2 left-1/2 z-40 aspect-square w-[29.8rem] -translate-x-1/2 -translate-y-1/2">
    <PulseEffect />
    <CentralIcon />
    <SmallCircleWrapper />
  </div>
);

const PulseEffect = () => (
  <div className="bg-primary/5 border-primary pulse absolute top-1/2 left-1/2 z-10 aspect-square w-[300%] -translate-x-1/2 -translate-y-1/2 scale-0 rounded-full border will-change-transform" />
);

const CentralIcon = () => (
  <div className="gap-sm absolute top-1/2 left-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
    <div className="border-primary h-[7.4rem] w-[12rem] rounded-sm border p-[3px]">
      <div className="bg-primary-dark relative z-0 grid h-full w-full place-content-center rounded-[7px]">
        <div className="center-notion absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 scale-0">
          <NotionIconBorder />
        </div>
        <LogoSymbolIcon className="logo-icon w-[6rem] text-white" />
      </div>
    </div>
    <div className="bg-primary h-[1px] w-[16rem]" />
  </div>
);

const SmallCircleWrapper = () => (
  <div className="circle-small-wrapper absolute top-0 h-full w-full will-change-transform">
    <svg className="w-full" viewBox="0 0 299 299" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M100.653 8.64521C178.191 -18.0787 262.712 23.1144 289.436 100.653C316.16 178.191 274.967 262.712 197.429 289.436C119.89 316.16 35.3692 274.967 8.64523 197.429C-18.0787 119.89 23.1144 35.3691 100.653 8.64521Z"
        id="circle-small-path"
        className="stroke-primary"
      />
    </svg>
    {Array.from({ length: CIRCLE_SMALL_COUNT }, (_, index) => (
      <SmallCircle key={index} index={index} />
    ))}
  </div>
);

const SmallCircle = ({ index }: { index: number }) => (
  <div
    className={cn(
      "border-primary bg-background-muted circle-small absolute grid size-[8rem] place-content-center rounded-full border border-dashed",
      `circle-small-${index}`,
    )}
  >
    {index === SPECIAL_CIRCLE_INDEX ? <SpecialCircleContent /> : <LockIcon />}
  </div>
);

const SpecialCircleContent = () => (
  <>
    <div className="notion-lock scale-0">
      <LockIcon />
    </div>
    <div className="bg-primary/50 notion-icon-pulse absolute top-0 left-0 h-full w-full scale-0 animate-pulse rounded-full will-change-transform" />
    <div className="bg-primary-dark notion-icon absolute top-1/2 left-1/2 grid size-[7.2rem] -translate-x-1/2 -translate-y-1/2 place-content-center rounded-full will-change-transform">
      <NotionIconBorder />
    </div>
  </>
);

const CirclePaths = () => (
  <>
    <svg className="w-full" viewBox="0 0 488 488" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M244 0.5C378.481 0.500006 487.5 109.519 487.5 244C487.5 378.481 378.481 487.5 244 487.5C109.519 487.5 0.500002 378.481 0.5 244C0.500006 109.519 109.519 0.500002 244 0.5Z"
        className="stroke-primary"
        id="circle-big-path"
      />
    </svg>
    {Array.from({ length: CIRCLE_BIG_COUNT }, (_, index) => (
      <BigCircle key={index} index={index} />
    ))}
  </>
);

const BigCircle = ({ index }: { index: number }) => (
  <div
    className={cn(
      "border-primary bg-background-muted circle-big absolute grid size-[8rem] place-content-center rounded-full border border-dashed",
      `circle-big-${index}`,
    )}
  >
    <LockIcon />
  </div>
);

export default FeatureDirectExecution;
