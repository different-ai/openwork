import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "ghost" | "danger" }) {
  const styles = {
    default: "border border-white/65 bg-white/38 text-snow shadow-sm hover:bg-white/58 hover:border-white/80",
    primary: "border border-spark/30 bg-spark/12 text-spark shadow-[0_5px_16px_rgba(49,95,218,0.10),inset_0_1px_0_rgba(255,255,255,0.52)] hover:bg-spark/20",
    ghost: "border border-transparent text-mist hover:bg-white/32 hover:text-snow hover:border-white/55",
    danger: "border border-rose/35 bg-rose/10 text-rose hover:bg-rose/18",
  } as const;
  return (
    <button
      {...props}
      className={`rounded-xl px-3 py-1.5 text-sm font-medium transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
    />
  );
}

export function Section({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold tracking-wide text-snow">{title}</h2>
        <div className="flex items-center gap-2">{actions}</div>
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wider text-mist">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-xl border border-white/62 bg-white/42 px-3 py-2 text-sm text-snow shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] placeholder:text-mist/60 focus:border-spark/45 focus:bg-white/62 focus:outline-none";

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-mist">{children}</p>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-rose/30 bg-rose/10 px-3 py-2 text-sm text-rose">{children}</p>;
}

export function StatusDot({ tone }: { tone: "spark" | "mint" | "amber" | "rose" | "mist" }) {
  const colors = { spark: "bg-spark", mint: "bg-mint", amber: "bg-amber", rose: "bg-rose", mist: "bg-mist" } as const;
  return <span className={`inline-block size-2 rounded-full ${colors[tone]}`} />;
}
