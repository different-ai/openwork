import { defaultDaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import { execInSandbox } from "../../evals/packages/hosts/src/provision.ts";
import { workshopRemoteScript } from "./workshop-browser.ts";

/** Only for the explicitly owned, disposable workshop desktop, never a developer host. */
export function workshopUnlockScript(): string {
  return `set -eu
export DISPLAY=:99
# X11 activity resumes an idle blanked screen, without guessing any password.
xset s reset || true
xset s off || true
xset s noblank || true
xset -dpms || true
xdg-screensaver reset || true
for process in light-locker xscreensaver xfce4-screensaver; do
  pkill -u "$(id -u)" -x "$process" || true
done
mkdir -p "$HOME/.config/autostart"
for name in light-locker xscreensaver xfce4-screensaver; do
  printf '[Desktop Entry]\\nType=Application\\nName=Workshop idle lock disabled\\nHidden=true\\n' > "$HOME/.config/autostart/$name.desktop"
done
if command -v xfconf-query >/dev/null; then
  timeout 5 xfconf-query -c xfce4-session -p /general/LockCommand -n -t string -s true || true
  timeout 5 xfconf-query -c xfce4-power-manager -p /xfce4-power-manager/lock-screen-suspend-hibernate -n -t bool -s false || true
  timeout 5 xfconf-query -c xfce4-screensaver -p /lock/enabled -n -t bool -s false || true
  timeout 5 xfconf-query -c xfce4-screensaver -p /saver/enabled -n -t bool -s false || true
fi
xset q
`;
}
export async function unlockWorkshopDesktop(id: string) {
  return execInSandbox(defaultDaytonaExec, id, workshopRemoteScript(workshopUnlockScript()), { timeoutMs: 60_000, context: "unlock owned ephemeral workshop desktop and prevent idle lock" });
}
