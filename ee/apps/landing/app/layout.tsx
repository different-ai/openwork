import "./globals.css";
import localFont from "next/font/local";
import Script from "next/script";
import { BotIdClient } from "botid/client";
import type { Metadata } from "next";
import { WebMcpProvider } from "@/components/webmcp-provider";
import { StructuredData } from "@/components/structured-data";
import CookieConsent from "@/components/ui/cookie-consent";
import Footer from "@/components/ui/footer";
import Header from "@/components/ui/header";
import HeaderCompact from "@/components/ui/header-compact";
import Noise from "@/components/ui/noise";
import Preloader from "@/components/ui/preloader";
import JsonLd from "@/components/seo/json-ld";
import Providers from "@/providers/providers";
import { APP_URL } from "@/constants";

const ivyprestoHeadline = localFont({
  src: "./fonts/IvyprestoHeadline-LightItalic.woff2",
  style: "italic",
  weight: "300",
  variable: "--font-ivypresto-headline"
});

const helveticaNowProText = localFont({
  src: [
    { path: "./fonts/HelveticaNowProTextRegular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/HelveticaNowProTextMedium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/HelveticaNowProTextBold.woff2", weight: "700", style: "normal" }
  ],
  variable: "--font-helvetica-now-pro-text"
});

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "OpenWork",
  legalName: "Different AI",
  url: "https://openworklabs.com",
  logo: "https://openworklabs.com/openwork-mark.svg",
  sameAs: ["https://github.com/different-ai/openwork"]
};

const siteTitle = "OpenWork — Open-source alternative to Claude Cowork";
const siteDescription =
  "OpenWork helps you create, share, and consume agentic workflows. Local-first desktop app, cloud-ready, powered by OpenCode. Bring your own LLM providers, skills, and MCP servers — and ship them to your whole team.";

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL || "https://openworklabs.com"),
  title: {
    default: siteTitle,
    template: "%s | OpenWork"
  },
  description: siteDescription,
  applicationName: "OpenWork",
  keywords: [
    "OpenWork",
    "OpenCode",
    "open source AI agents",
    "agentic workflows",
    "Claude Cowork alternative",
    "Codex alternative",
    "local-first AI",
    "AI desktop app",
    "MCP servers",
    "skills",
    "self-hosted AI"
  ],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    siteName: "OpenWork",
    locale: "en_US",
    url: "https://openworklabs.com",
    title: siteTitle,
    description: siteDescription,
    images: ["/og-image-clean.png"]
  },
  twitter: {
    card: "summary_large_image",
    title: siteTitle,
    description: siteDescription,
    images: ["/og-image-clean.png"]
  }
};

const protectedRoutes = [
  { path: "/api/enterprise-contact", method: "POST" as const },
  { path: "/api/app-feedback", method: "POST" as const }
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${ivyprestoHeadline.variable} ${helveticaNowProText.variable}`}>
      <head>
        {/* Read saved theme synchronously before paint so dark mode users
            don't see a light flash (FOUC). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('theme');if(t==='dark'||t==='light'){document.documentElement.classList.add(t);}}catch(e){}})();`
          }}
        />
        <StructuredData data={organizationSchema} />
        <JsonLd />
        <BotIdClient protect={protectedRoutes} />
        <Script
          id="posthog"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture identify".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    posthog.init('phc_4YnPTlDVYPjgwKvLuNxhbHjV5kadgvd7XLzVHWnCXAI', {
        api_host: 'https://us.i.posthog.com',
        defaults: '2025-11-30',
        person_profiles: 'identified_only',
    })`
          }}
        />
      </head>
      <body className="antialiased">
        <Providers>
          <WebMcpProvider />
          <Header />
          <HeaderCompact />
          <Noise />
          {children}
          <Preloader />
          <Footer />
          <CookieConsent />
        </Providers>
      </body>
    </html>
  );
}
