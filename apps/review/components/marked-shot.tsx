import type { CSSProperties } from "react";
import type { EvidenceBox, ReviewEvidence } from "@openwork/review";

type ImageEvidence = Extract<ReviewEvidence, { kind: "image" }>;

function place(box: EvidenceBox): CSSProperties {
  return { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.width * 100}%`, height: `${box.height * 100}%` };
}

/**
 * The screenshot with two kinds of marks: a dashed outline where it changed
 * since the previous screenshot, and a solid one around each element the test
 * checked just before taking it. Images without a recorded size render plain,
 * since the marks could not be placed on a cropped thumbnail.
 */
export function MarkedShot({ image, src, alt, labels = false, actualSize = false, loading, maxChanges = 8 }: {
  image: ImageEvidence;
  src: string;
  alt: string;
  labels?: boolean;
  actualSize?: boolean;
  loading?: "lazy";
  /** Thumbnails mark only the largest changes; the viewer marks all of them. */
  maxChanges?: number;
}) {
  if (!image.size) return <img src={src} alt={alt} loading={loading} />;
  // A first screenshot or a whole-screen change has nothing narrower to point at.
  const changed = image.change && image.change.since !== null && image.change.ratio < 0.5 ? image.change.boxes.slice(0, maxChanges) : [];
  const style: CSSProperties = { aspectRatio: `${image.size.width} / ${image.size.height}`, ...(actualSize ? { width: image.size.width } : {}) };
  return (
    <span className="marked-shot" style={style}>
      <img src={src} alt={alt} loading={loading} />
      {changed.map((box, index) => <span key={`changed-${index}`} className="mark changed" style={place(box)} aria-hidden="true" />)}
      {(image.focus ?? []).map((item, index) => (
        <span key={`checked-${index}`} className="mark checked" style={place(item.box)} aria-hidden="true">
          {labels && <span className="mark-label">{item.label}</span>}
        </span>
      ))}
    </span>
  );
}
