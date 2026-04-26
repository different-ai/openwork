import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function getCurrentYear() {
  return new Date().getFullYear();
}

export function sleep(milliseconds: number) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

export const vhToPx = (value: number): number => {
  if (typeof window === "undefined") return 0;
  return (window.innerHeight * value) / 100;
};

export const vwToPx = (value: number): number => {
  if (typeof window === "undefined") return 0;
  return (window.innerWidth * value) / 100;
};

export function remToPx(rem: number | string): number {
  const remValue = typeof rem === "string" ? parseFloat(rem) : rem;

  if (typeof window === "undefined") {
    // Fallback for SSR (assumes 16px root font-size)
    return remValue * 10;
  }

  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);

  return remValue * rootFontSize;
}
