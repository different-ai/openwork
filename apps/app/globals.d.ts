export {};

declare module "react" {
  interface CSSProperties extends React.CSSProperties {
    [key: `--${string}`]: string | number | undefined;
  }
}
