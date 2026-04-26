"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import ReactLenis, { type LenisRef } from "lenis/react";

const SmoothScroll = () => {
  const lenisRef = useRef<LenisRef | null>(null);

  useEffect(() => {
    const update = (time: number) => {
      lenisRef.current?.lenis?.raf(time * 1000);
    };

    gsap.ticker.add(update);
    return () => {
      gsap.ticker.remove(update);
    };
  }, []);

  return (
    <ReactLenis
      root
      ref={lenisRef}
      options={{
        autoRaf: false,
      }}
    />
  );
};

export default SmoothScroll;
