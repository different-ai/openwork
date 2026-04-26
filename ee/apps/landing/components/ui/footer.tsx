import NextLink from "./next-link";
import GithubIcon from "@/icons/brands/github-icon";
import LinkedinIcon from "@/icons/brands/linkedin-icon";
import XIcon from "@/icons/brands/x-icon";
import LogoTextIcon from "@/icons/logos/logo-text";
import { CLOUD_URL, GITHUB_URL } from "@/constants";
import { getCurrentYear } from "@/lib/utils";

const FOOTER_LINKS = {
  product: [
    { label: "Download", href: "/download" },
    { label: "Cloud", href: CLOUD_URL },
    { label: "Enterprise", href: "/enterprise" },
    { label: "Pricing", href: "/pricing" },
    { label: "Trust & Security", href: "/trust" },
  ],
  resources: [
    { label: "Docs", href: "/docs" },
    { label: "GitHub", href: GITHUB_URL },
    { label: "Releases", href: "https://github.com/different-ai/openwork/releases" },
    { label: "Feedback", href: "/feedback" },
  ],
  legal: [
    { label: "Privacy", href: "/privacy" },
    { label: "Terms of Use", href: "/terms" },
  ],
};

const SOCIAL_ICONS = [
  { Icon: GithubIcon, label: "GitHub", href: GITHUB_URL },
  { Icon: XIcon, label: "X", href: "https://x.com/openworklabs" },
  { Icon: LinkedinIcon, label: "LinkedIn", href: "https://www.linkedin.com/company/openworklabs/" },
];

const FooterSection = ({ title, links }: { title: string; links: Array<{ label: string; href: string }> }) => (
  <div className="gap-base sm:gap-xl flex flex-col">
    <h3 className="text-base-lg font-sans font-medium">{title}</h3>
    <ul className="gap-sm text-base-sm text-foreground/60 flex flex-col font-sans font-medium">
      {links.map(link => (
        <li key={link.label}>
          <NextLink data-underline-link className="hover:text-primary transition-all" href={link.href}>
            {link.label}
          </NextLink>
        </li>
      ))}
    </ul>
  </div>
);

const Footer = () => {
  return (
    <footer className="grid-12 gap-y-xl mt-[3.2rem] px-(--container-px) py-(--container-px) md:gap-y-[6.4rem]">
      <div className="gap-base md:gap-lg col-span-12 flex flex-col items-start sm:col-span-8 md:col-span-4">
        <LogoTextIcon className="text-[2.4rem]" />
        <p className="text-base-sm text-foreground/60 font-sans font-medium">
          OpenWork is the open-source alternative to Claude Cowork. Create, share, and consume agentic workflows on your
          desktop, in Slack, Telegram, or via the orchestrator CLI — built on OpenCode, local-first by default.
        </p>
      </div>

      <div className="gap-xl col-span-12 flex flex-col justify-between sm:flex-row md:col-span-7 md:col-start-6">
        <FooterSection title="Product" links={FOOTER_LINKS.product} />
        <FooterSection title="Resources" links={FOOTER_LINKS.resources} />
        <FooterSection title="Legal" links={FOOTER_LINKS.legal} />
      </div>

      <div className="gap-base col-span-12 flex flex-col items-start justify-between sm:flex-row sm:items-center">
        <div className="gap-sm flex">
          {SOCIAL_ICONS.map(({ Icon, label, href }) => (
            <a
              key={label}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Follow OpenWork on ${label}`}
              className="bg-background-muted rounded-2xs p-base size-[4.8rem] transition-opacity hover:opacity-70"
            >
              <Icon className="text-foreground w-full" />
            </a>
          ))}
        </div>
        <p className="font-sans text-base font-medium sm:text-right">
          © {getCurrentYear()} Different AI. Open-source under AGPL.
        </p>
      </div>
    </footer>
  );
};

export default Footer;
