import { cn } from "@/lib/utils";

export default function DotsPattern({
  colorVariable = "--primary",
  className,
}: {
  colorVariable?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 -z-10 flex h-full w-full items-center justify-center overflow-hidden opacity-40",
        className,
      )}
    >
      {/* Dots Pattern Overlay */}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(circle, var(${colorVariable}) 1px, transparent 1px)`,
          backgroundSize: "30px 30px",
        }}
      />

      {/* Animated Dots Layer */}
      <div
        className="absolute inset-0 animate-pulse"
        style={{
          backgroundImage: `radial-gradient(circle, rgba(255, 255, 255, 0.15) 2px, transparent 2px)`,
          backgroundSize: "60px 60px",
          backgroundPosition: "15px 15px",
        }}
      />
    </div>
  );
}
