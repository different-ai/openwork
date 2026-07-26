import type { SkillCard } from "@/app/types";
import { t } from "@/i18n";

export function skillOriginBadgeLabel(skill: Pick<SkillCard, "origin" | "marketplaceName">): string {
  if (skill.origin === "openwork-connect") {
    const marketplaceName = skill.marketplaceName?.trim();
    return marketplaceName ? marketplaceName : t("composer.source_organization");
  }

  return t("composer.source_local");
}
