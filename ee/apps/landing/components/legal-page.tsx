import fs from "fs";
import path from "path";
import { renderMarkdown } from "../lib/render-markdown";

interface LegalPageProps {
  file: string;
}

export function LegalPage({ file }: LegalPageProps) {
  const raw = fs.readFileSync(path.join(process.cwd(), "app", file), "utf-8");

  return (
    <div className="legal-page relative min-h-screen pt-(--page-pt) text-foreground">
      <main className="mx-auto flex w-full max-w-6xl flex-col px-6 pb-24 md:px-8 md:pb-28">
        <article className="legal-prose max-w-4xl">{renderMarkdown(raw)}</article>
      </main>
    </div>
  );
}
