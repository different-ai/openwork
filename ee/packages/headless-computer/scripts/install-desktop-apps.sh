#!/bin/bash
# Image build only. GUI packages replace LibreOffice's headless variants here.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
packages=$(node --input-type=module -e 'import { DESKTOP_APPS } from "/usr/local/share/openwork-desktop/apps.mjs"; console.log([...new Set(DESKTOP_APPS.map(app => app.package))].join(" "))')
apt-get update -qq
# Word splitting is intentional: the package names come from our static catalog.
apt-get install -y -qq --no-install-recommends $packages \
  libreoffice-gtk3 libgl1-mesa-dri libglx-mesa0 mesa-utils tint2 adwaita-icon-theme fonts-noto-cjk fonts-noto-color-emoji acl

bash /usr/local/share/openwork-desktop/configure-files.sh
ln -sfn /workspace/files /home/openwork-browser/Uploads
ln -sfn /workspace/out /home/openwork-browser/Outputs
ln -sfn /workspace/out /home/openwork-browser/Downloads
# Prepare a normal persistent Blender profile without its first-run splash.
env -i PATH=/usr/sbin:/usr/bin:/bin HOME=/home/openwork-browser LIBGL_ALWAYS_SOFTWARE=1 \
  runuser -u openwork-browser -- blender --background --factory-startup --python-expr \
  'import bpy; bpy.context.preferences.view.show_splash = False; bpy.ops.wm.save_userpref(); s = bpy.context.scene; s.render.engine = "CYCLES"; s.cycles.device = "CPU"; s.cycles.use_denoising = False; bpy.ops.wm.save_homefile()'
cat > /usr/local/bin/openwork-desktop-app <<'HELPER'
#!/bin/sh
umask 077
exec node /usr/local/share/openwork-desktop/apps.mjs --launch-app "$@"
HELPER
chmod 0755 /usr/local/bin/openwork-desktop-app

node --input-type=module <<'CONFIG'
import { DESKTOP_APPS } from "/usr/local/share/openwork-desktop/apps.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const icons = { blender: "blender", writer: "libreoffice-writer", calc: "libreoffice-calc", impress: "libreoffice-impress", draw: "libreoffice-draw", gimp: "gimp", inkscape: "inkscape", pdf: "org.gnome.Evince", media: "vlc", files: "system-file-manager", editor: "accessories-text-editor", terminal: "utilities-terminal" };
writeFileSync("/etc/xdg/openbox/menu.xml", `<?xml version="1.0"?><openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="Applications">${DESKTOP_APPS.map(app => `<item label="${escape(app.name)}"><action name="Execute"><command>/usr/local/bin/openwork-desktop-app ${app.id}</command></action></item>`).join("")}</menu></openbox_menu>`);
for (const app of DESKTOP_APPS) writeFileSync(`/usr/share/applications/openwork-${app.id}.desktop`, `[Desktop Entry]\nType=Application\nName=${app.name}\nComment=${app.purpose}\nExec=/usr/local/bin/openwork-desktop-app ${app.id}\nIcon=${icons[app.id]}\nTerminal=false\nCategories=Utility;\n`);
writeFileSync("/usr/share/applications/openwork-applications.desktop", "[Desktop Entry]\nType=Application\nName=Applications\nExec=xdotool key --clearmodifiers super+space\nIcon=applications-other\nTerminal=false\nCategories=Utility;\n");
mkdirSync("/etc/xdg/tint2", { recursive: true });
writeFileSync("/etc/xdg/tint2/tint2rc", `panel_items = LTC\npanel_position = bottom center horizontal\npanel_size = 100% 36\npanel_padding = 6 2 6\npanel_background_id = 0\nwm_menu = 1\nlauncher_icon_size = 26\nlauncher_padding = 4 2 4\nlauncher_item_app = /usr/share/applications/openwork-applications.desktop\nlauncher_item_app = /usr/share/applications/openwork-files.desktop\nlauncher_item_app = /usr/share/applications/openwork-writer.desktop\nlauncher_item_app = /usr/share/applications/openwork-blender.desktop\ntaskbar_mode = single_desktop\ntask_icon = 1\ntask_text = 1\ntask_font = Sans 10\ntask_maximum_size = 180 30\ntask_padding = 4 2 4\ntime1_format = %H:%M\ntime1_font = Sans 10\nclock_padding = 8 2\nmouse_left = toggle_iconify\nmouse_middle = close\nmouse_right = none\nscroll_up = toggle\nscroll_down = iconify\n`);
CONFIG
python3 <<'CONFIG'
import xml.etree.ElementTree as ET
path = '/etc/xdg/openbox/rc.xml'
ns = '{http://openbox.org/3.4/rc}'
ET.register_namespace('', ns[1:-1])
tree = ET.parse(path)
root = tree.getroot()
keyboard = root.find(f'{ns}keyboard')
key = ET.SubElement(keyboard, f'{ns}keybind', {'key': 'W-space'})
action = ET.SubElement(key, f'{ns}action', {'name': 'ShowMenu'})
ET.SubElement(action, f'{ns}menu').text = 'root-menu'
menu = root.find(f'{ns}menu')
for file in menu.findall(f'{ns}file'): menu.remove(file)
ET.SubElement(menu, f'{ns}file').text = '/etc/xdg/openbox/menu.xml'
tree.write(path, encoding='UTF-8', xml_declaration=True)
CONFIG
apt-get clean
rm -rf /var/lib/apt/lists/*
