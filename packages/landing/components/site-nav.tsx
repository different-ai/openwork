import Link from "next/link";

type Props = {
  active?: "home" | "download" | "enterprise" | "den";
};

export function SiteNav(props: Props) {
  const navLink = (isActive: boolean) =>
    isActive ? "transition text-black" : "transition hover:text-black";
  return (
    <nav className="sticky top-0 z-50 py-4 bg-white/80 backdrop-blur-sm">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-tight">
            <span className="mono text-aika-teal">{">_"}</span>
            <span>AikaOS</span>
          </Link>
          <div className="hidden items-center gap-6 text-[15px] text-gray-700 md:flex">
            <Link href="/#funciones" className="transition hover:text-black">
              Funciones
            </Link>
            <Link href="/#comparativa" className="transition hover:text-black">
              Comparativa
            </Link>
            <Link href="/#sectores" className="transition hover:text-black">
              Sectores
            </Link>
            <Link href="/#faq" className="transition hover:text-black">
              FAQ
            </Link>
            <Link href="/enterprise" className={navLink(props.active === "enterprise")}>
              Precios
            </Link>
          </div>
        </div>
        <div className="flex items-center gap-4 text-[14px]">
          <a
            href="/enterprise#contacto"
            className="hidden rounded-md bg-aika-teal px-3 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-aika-teal-hover sm:inline-flex"
          >
            Contactar ventas
          </a>
        </div>
      </div>
    </nav>
  );
}
