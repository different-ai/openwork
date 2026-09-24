type Props = {
  className?: string;
};

export function SocTypeIIBadge(props: Props) {
  return (
    <img
      src="/soc-2-type-ii.svg"
      width={128}
      height={128}
      className={props.className}
      alt=""
      aria-hidden="true"
      loading="lazy"
    />
  );
}
