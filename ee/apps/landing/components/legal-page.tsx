import { ReactNode } from "react";

interface LegalPageProps {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}

/**
 * Reusable layout for legal pages (privacy policy, terms of service, etc.).
 * Wrap parsed content in this component for consistent styling.
 */
export function LegalPage({ title, lastUpdated, children }: LegalPageProps) {
  return (
    <section className="max-w-4xl pt-6 md:pt-10">
      <header className="mb-12 md:mb-16">
        <h1 className="mb-4 text-4xl font-medium leading-[1.05] tracking-tight md:text-5xl lg:text-6xl">
          {title}
        </h1>
        <p className="text-base text-gray-500">Last updated {lastUpdated}</p>
      </header>

      <div className="legal-content">{children}</div>
    </section>
  );
}

interface LegalSectionProps {
  heading?: string;
  children: ReactNode;
}

export function LegalSection({ heading, children }: LegalSectionProps) {
  return (
    <section className="mb-10">
      {heading && (
        <h2 className="mb-4 text-xl font-semibold tracking-tight text-[#011627]">
          {heading}
        </h2>
      )}
      {children}
    </section>
  );
}
