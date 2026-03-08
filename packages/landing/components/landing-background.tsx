"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { ResponsiveGrain } from "./responsive-grain";

export function LandingBackground() {
  const { scrollY } = useScroll();
  const darkOpacity = useTransform(scrollY, [0, 500], [0.6, 0.015]);

  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-0 bg-[#f6f7f3]" />

      <motion.div
        style={{ opacity: darkOpacity, willChange: "opacity" }}
        className="pointer-events-none fixed inset-0 z-0 mix-blend-multiply"
      >
        <ResponsiveGrain
          colors={["#f6f7f3", "#f6f7f3", "#0f172a", "#334155"]}
          colorBack="#f6f7f3"
          softness={1}
          intensity={0.03}
          noise={0.14}
          shape="corners"
          speed={0.2}
        />
      </motion.div>
    </>
  );
}
