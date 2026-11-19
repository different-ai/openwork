import type { ReactNode } from "react";
import { OpenWorkMark } from "../components/icons";
import "./style.css";

export const metadata = {
  title: "OpenWork Review",
  robots: { index: false, follow: false },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <a href="/">
            <OpenWorkMark />
            openwork<span>/ review</span>
          </a>
        </header>
        {children}
      </body>
    </html>
  );
}
