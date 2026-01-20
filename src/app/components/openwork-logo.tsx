import type { JSX } from "solid-js";

type Props = {
  size?: number;
  class?: string;
};

export default function OpenWorkLogo(props: Props): JSX.Element {
  const size = props.size ?? 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      class={props.class}
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M21 12C21 16.9706 16.9706 21 12 21C7.02944 21 3 16.9706 3 12C3 7.02944 7.02944 3 12 3" />
      <path d="M21 3L12 12" />
      <path d="M16.5 3H21V7.5" />
    </svg>
  );
}
