import type { JSX } from "solid-js";

type Props = {
  size?: number;
  class?: string;
};

export default function AikaOSLogo(props: Props): JSX.Element {
  const size = props.size ?? 24;
  return (
    <img
      src="/aikaos-logo.svg"
      alt="AikaOS"
      width={size}
      height={size}
      class={`inline-block ${props.class ?? ""}`}
    />
  );
}
