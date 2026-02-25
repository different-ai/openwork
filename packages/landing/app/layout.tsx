import "./globals.css";
import { Nunito, Inter } from "next/font/google";
import Script from "next/script";

const nunito = Nunito({
  subsets: ["latin"],
  variable: "--font-nunito",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata = {
  title: "AikaOS por AikaLabs — Agentes IA para empresas en Latinoamérica",
  description:
    "AikaOS es la plataforma de automatización con agentes IA preconfigurados para legal, contabilidad, retail, marketing y más. Diseñada para LATAM.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es" className={`${nunito.variable} ${inter.variable}`}>
      <head>
        {/* Preload hero background to avoid blank flash */}
        <link
          rel="preload"
          href="https://hoirqrkdgbmvpwutwuwj.supabase.co/storage/v1/object/public/assets/assets/bfd2f4cf-65ed-4b1a-86d1-a1710619267b_1600w.png"
          as="image"
        />
        {/* Preconnect to Iconify CDN for faster icon loading */}
        <link rel="preconnect" href="https://api.iconify.design" />
      </head>
      <body className="antialiased min-h-screen overflow-x-hidden selection:bg-black selection:text-white text-slate-800 font-sans bg-[#ABCDE9] relative">
        {children}
        <Script
          src="https://code.iconify.design/iconify-icon/2.0.0/iconify-icon.min.js"
          strategy="beforeInteractive"
        />
      </body>
    </html>
  );
}
