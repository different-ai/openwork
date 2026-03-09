import { ImageResponse } from "next/og";
import { getOgImageDataUrl } from "../components/og-image-svg";

export const alt = "OpenWork";
export const size = {
  width: 1200,
  height: 630
};

export const contentType = "image/png";

export default function TwitterImage() {
  return new ImageResponse(<img src={getOgImageDataUrl()} alt={alt} width={size.width} height={size.height} />, size);
}
