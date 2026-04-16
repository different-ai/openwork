/** @jsxImportSource react */

export function AppRoot() {
  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-16">
      <div className="max-w-xl rounded-3xl border border-dls-border bg-dls-surface px-8 py-10 text-center shadow-[var(--dls-card-shadow)]">
        <h1 className="text-2xl font-semibold text-dls-text">
          OpenWork React runtime
        </h1>
        <p className="mt-3 text-sm leading-7 text-dls-secondary">
          The React entry is coming online. The Solid runtime is still the shipped
          default while the migration proceeds domain by domain.
        </p>
      </div>
    </div>
  );
}
