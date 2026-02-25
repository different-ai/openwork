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
      <body className="antialiased min-h-screen overflow-x-hidden selection:bg-black selection:text-white text-slate-800 font-sans bg-[#ABCDE9] relative">
        {children}
        <Script
          src="https://code.iconify.design/iconify-icon/2.0.0/iconify-icon.min.js"
          strategy="afterInteractive"
        />
      </body>
    </html>
  );
}
