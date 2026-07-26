/** @jsxImportSource react */
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { t } from "../../../i18n";

export function DesktopPolicyBlockedPage(props: {
  notice: string;
  compact?: boolean;
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const openCloudAccount = () => navigate("/settings/cloud-account", { replace: true });
  const openRecovery = () => navigate("/settings/recovery", { replace: true });
  const backToApp = () => {
    if (props.onClose) {
      props.onClose();
      return;
    }

    navigate("/session", { replace: true });
  };

  return (
    <main className={props.compact ? "flex h-full min-h-0 items-center justify-center bg-background p-6" : "flex min-h-screen items-center justify-center bg-background p-6"}>
      <section className="w-full max-w-lg rounded-2xl border border-amber-6 bg-amber-2 p-5 text-amber-12 shadow-sm">
        <p className="text-sm font-medium">{props.notice}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="outline" onClick={openCloudAccount}>
            {t("settings.tab_cloud_account")}
          </Button>
          <Button variant="outline" onClick={openRecovery}>
            {t("settings.tab_recovery")}
          </Button>
          <Button onClick={backToApp}>{t("dashboard.back_to_app")}</Button>
        </div>
      </section>
    </main>
  );
}
