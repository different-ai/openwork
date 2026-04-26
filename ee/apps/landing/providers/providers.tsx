"use client";

import AnimationsProvider from "./animations-provider";
import { ThemeProvider } from "./theme-provider";
import CustomCursor from "@/icons/ui/custom-cursor";
import ReactLenis from "lenis/react";

const Providers = ({ children }: { children?: React.ReactNode }) => {
  return (
    <>
      <ReactLenis root />
      <ThemeProvider>{children}</ThemeProvider>
      <AnimationsProvider />
      <CustomCursor />
    </>
  );
};

export default Providers;
