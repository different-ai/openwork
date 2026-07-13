"use client";

/**
 * Animated agent glyphs.
 *
 * The four animated SVG glyphs are adapted from Flue
 * (https://github.com/withastro/flue, apps/www/src/pages/index.astro),
 * licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0).
 *
 * MODIFIED by OpenWork from the original Flue source:
 *  - converted Astro markup to a React component
 *  - kept the four glyph SVGs and hover animations
 */

type Props = {
  className?: string;
};

export function LandingAgentGlyphs({ className }: Props) {
  return (
    <span
      className={`relative flex h-5 w-[94px] shrink-0 items-center justify-start text-gray-400 ${className ?? ""}`}
      aria-hidden="true"
    >
      <svg
        className="h-5 w-5 -rotate-6 transition-transform duration-300 ease-out group-hover:-translate-x-1 group-hover:-rotate-12"
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" />
      </svg>
      <svg
        className="ml-1 h-5 w-5 transition-transform duration-300 ease-out group-hover:-translate-x-px group-hover:-translate-y-px group-hover:rotate-6 group-hover:scale-110"
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" />
      </svg>
      <svg
        className="ml-1 h-5 w-5 transition-transform duration-300 ease-out group-hover:translate-x-px group-hover:translate-y-0.5 group-hover:-rotate-6 group-hover:scale-110"
        viewBox="82.65 82.65 634.71 634.71"
        fill="currentColor"
        fillRule="evenodd"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z" />
        <path d="M517.36 400H634.72V634.72H517.36Z" />
      </svg>
      <svg
        className="ml-0.5 h-5 w-5 rotate-6 transition-transform duration-300 ease-out group-hover:translate-x-1 group-hover:rotate-12"
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path d="M16 6H8v12h8V6zm4 16H4V2h16v20z" />
      </svg>
    </span>
  );
}
