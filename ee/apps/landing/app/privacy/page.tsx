import fs from "fs";
import path from "path";
import { LandingBackground } from "../../components/landing-background";
import { LegalPage } from "../../components/legal-page";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";
import { getGithubData } from "../../lib/github";

export const metadata = {
  title: "OpenWork — Privacy Policy",
  description:
    "Privacy policy for Different AI, doing business as OpenWorkLabs."
};

/** Parse the plain-text privacy policy into renderable blocks. */
function parsePolicy(raw: string) {
  const lines = raw.split("\n");
  const title = lines[0]?.trim() ?? "";

  // Extract "Updated at YYYY-MM-DD"
  const dateLine = lines.find((l) => l.startsWith("Updated at"));
  const lastUpdated = dateLine?.replace("Updated at ", "").trim() ?? "";

  // Everything after the date line is body content.
  const dateIdx = lines.indexOf(dateLine ?? "");
  const bodyLines = lines.slice(dateIdx + 1);

  // Split into blocks separated by blank lines.
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of bodyLines) {
    if (line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);

  // Classify each block as a heading, subheading, list, or paragraph.
  type Block =
    | { type: "heading"; text: string }
    | { type: "subheading"; text: string }
    | { type: "paragraph"; text: string }
    | { type: "list"; items: string[] };

  const classified: Block[] = [];

  for (const block of blocks) {
    const joined = block.join(" ").trim();
    const allList = block.every((l) => l.trimStart().startsWith("-"));

    if (allList) {
      const items = block.map((l) => l.replace(/^\s*-/, "").trim());
      // Single-item short lists are subheadings (e.g. "Cookies", "Local Storage")
      if (items.length === 1 && items[0].length < 50) {
        classified.push({ type: "subheading", text: items[0] });
      } else {
        classified.push({ type: "list", items });
      }
    } else if (
      block.length === 1 &&
      joined.length < 120 &&
      !joined.startsWith("-") &&
      !joined.endsWith(".")
    ) {
      // Short single-line blocks that don't end with a period are headings.
      classified.push({ type: "heading", text: joined });
    } else {
      classified.push({ type: "paragraph", text: joined });
    }
  }

  return { title, lastUpdated, blocks: classified };
}

/** Turn email addresses into clickable links. */
function formatText(text: string) {
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const parts = text.split(emailRegex);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    emailRegex.test(part) ? (
      <a
        key={i}
        href={`mailto:${part}`}
        className="text-[#011627] underline hover:opacity-70"
      >
        {part}
      </a>
    ) : (
      part
    )
  );
}

export default async function PrivacyPage() {
  const github = await getGithubData();
  const callUrl = process.env.NEXT_PUBLIC_CAL_URL || "/enterprise#book";

  const raw = fs.readFileSync(
    path.join(process.cwd(), "app/privacy/privacy-policy.txt"),
    "utf-8"
  );
  const policy = parsePolicy(raw);

  return (
    <div className="relative min-h-screen overflow-hidden text-[#011627]">
      <LandingBackground />

      <div className="relative z-10 flex min-h-screen flex-col items-center pb-3 pt-1 md:pb-4 md:pt-2">
        <div className="w-full">
          <SiteNav
            stars={github.stars}
            callUrl={callUrl}
            downloadHref={github.downloads.macos}
          />
        </div>

        <main className="mx-auto flex w-full max-w-6xl flex-col gap-16 px-6 pb-24 md:gap-20 md:px-8 md:pb-28">
          <LegalPage title={policy.title} lastUpdated={policy.lastUpdated}>
            {policy.blocks.map((block, i) => {
              switch (block.type) {
                case "heading":
                  return (
                    <h2
                      key={i}
                      className="mb-3 mt-10 text-xl font-semibold tracking-tight text-[#011627] first:mt-0"
                    >
                      {block.text}
                    </h2>
                  );
                case "subheading":
                  return (
                    <h3
                      key={i}
                      className="mb-2 mt-6 text-base font-semibold text-[#011627]"
                    >
                      {block.text}
                    </h3>
                  );
                case "list":
                  return (
                    <ul
                      key={i}
                      className="mb-4 list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-gray-700"
                    >
                      {block.items.map((item, j) => {
                        const colonIdx = item.indexOf(":");
                        if (colonIdx > 0 && colonIdx < 40) {
                          return (
                            <li key={j}>
                              <strong className="font-semibold text-[#011627]">
                                {item.slice(0, colonIdx)}
                              </strong>
                              :{formatText(item.slice(colonIdx + 1))}
                            </li>
                          );
                        }
                        return <li key={j}>{formatText(item)}</li>;
                      })}
                    </ul>
                  );
                case "paragraph":
                  return (
                    <p
                      key={i}
                      className="mb-4 text-[15px] leading-relaxed text-gray-700"
                    >
                      {formatText(block.text)}
                    </p>
                  );
              }
            })}
          </LegalPage>

          <SiteFooter />
        </main>
      </div>
    </div>
  );
}
