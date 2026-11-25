/** @jsxImportSource react */
import { useState, type ReactNode } from "react";

export function IconImage(props: { src: string | null | undefined; size: number; fallback: ReactNode }) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!props.src || failedSrc === props.src) return <>{props.fallback}</>;
  const src = props.src;
  return <img src={src} alt="" width={props.size} height={props.size} loading="lazy" onError={() => setFailedSrc(src)} />;
}
