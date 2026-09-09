import type { ReactNode } from "react";
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
            openwork<span>/ review</span>
          </a>
          <span>Evidence, in context.</span>
        </header>
        {children}
      </body>
    </html>
  );
}
