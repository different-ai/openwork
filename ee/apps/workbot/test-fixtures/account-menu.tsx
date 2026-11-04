import { createRoot } from "react-dom/client";
import { AccountAvatar } from "../../../packages/workbot-ui/src/account-menu";
import { setWorkbotHost } from "../../../packages/workbot-ui/src/host";
import { createHost, meSchema } from "../src/client/host";
import "../src/client/styles.css";

// The production host and avatar for one signed-in person. `?menu=off` is the person
// before `workbotAccountMenu`; Workbot's real /auth routes answer behind the page.
const accountMenu = new URLSearchParams(window.location.search).get("menu") !== "off";
const me = meSchema.parse({
  userId: "user_fixture", organizationId: "org_fixture", name: "Sam Rivera", email: "sam@example.test",
  organizationName: "Example Team", enabled: true, accountMenu, denUrl: "https://den.example.test",
});
setWorkbotHost(createHost(me));

const root = document.getElementById("root");
if (root) createRoot(root).render(
  <main className="workbot" style={{ minHeight: "100vh", background: "var(--wb-bg)" }}>
    <header className="flex h-13 items-center justify-between px-5">
      <h1 className="text-[15px] font-semibold text-[var(--wb-text)]">Workbot</h1>
      <AccountAvatar userName={me.name} />
    </header>
  </main>,
);
