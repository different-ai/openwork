"use client";

import { useEffect, useState } from "react";

function canCreateWebGlContext(): boolean {
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  return Boolean(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
}

export function useWebGlSupported(): boolean {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(canCreateWebGlContext());
  }, []);

  return supported;
}
