"use client";

import { motion, useScroll, useTransform } from "framer-motion";
import { ResponsiveGrain } from "./responsive-grain";

export function LandingBackground() {
  const { scrollY } = useScroll();
  const darkOpacity = useTransform(scrollY, [0, 500], [0.6, 0]);

  return (
    <>
      <div className="pointer-events-none fixed inset-0 z-0 bg-[#f6f9fc]" />

      <motion.div
        style={{ opacity: darkOpacity, willChange: "opacity" }}
        className="pointer-events-none fixed inset-0 z-0"
      >
           <ResponsiveGrain
          colors={["#f6f9fc", "#f6f9fc", "#1e293b", "#334155"]}
          colorBack="#f6f9fc"
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
