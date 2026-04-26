import NextLink from "./next-link";
import { MAIN_ROUTES } from "@/constants";

const Navigation = () => {
  return (
    <nav>
      <ul className="flex items-center gap-2xs">
        {MAIN_ROUTES.map((item) => (
          <li key={item.href}>
            <NextLink
              href={item.href}
              {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              className="hover:bg-foreground/[0.06] hover:text-foreground text-foreground/65 inline-flex items-center rounded-full px-base py-xs font-sans text-[1.4rem] font-medium transition-colors"
            >
              {item.label}
            </NextLink>
          </li>
        ))}
      </ul>
    </nav>
  );
};

export default Navigation;
