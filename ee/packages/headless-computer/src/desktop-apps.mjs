import { access, mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

// The image, desktop menu and model discovery use the same application catalog.
export const DESKTOP_APPS = [
  { id: "blender", name: "Blender", command: "blender", package: "blender", args: [], purpose: "3D modeling, animation and CPU rendering", formats: ["blend", "obj", "stl", "png"], note: "Software OpenGL; use Cycles CPU for renders. No GPU is promised." },
  { id: "writer", name: "LibreOffice Writer", command: "libreoffice", package: "libreoffice-writer", args: ["--writer", "--norestore", "--nologo"], purpose: "Write and edit documents", formats: ["odt", "docx", "pdf"] },
  { id: "calc", name: "LibreOffice Calc", command: "libreoffice", package: "libreoffice-calc", args: ["--calc", "--norestore", "--nologo"], purpose: "Spreadsheets, formulas and charts", formats: ["ods", "xlsx", "csv", "pdf"] },
  { id: "impress", name: "LibreOffice Impress", command: "libreoffice", package: "libreoffice-impress", args: ["--impress", "--norestore", "--nologo"], purpose: "Create and edit presentations", formats: ["odp", "pptx", "pdf"] },
  { id: "draw", name: "LibreOffice Draw", command: "libreoffice", package: "libreoffice-draw", args: ["--draw", "--norestore", "--nologo"], purpose: "Diagrams and PDF edits", formats: ["odg", "pdf", "svg"] },
  { id: "gimp", name: "GIMP", command: "gimp", package: "gimp", args: [], purpose: "Photo editing and raster graphics", formats: ["xcf", "png", "jpg", "webp"] },
  { id: "inkscape", name: "Inkscape", command: "inkscape", package: "inkscape", args: [], purpose: "Vector illustrations and diagrams", formats: ["svg", "pdf", "png"] },
  { id: "pdf", name: "PDF Viewer", command: "evince", package: "evince", args: [], purpose: "Read and inspect PDF documents", formats: ["pdf"] },
  { id: "media", name: "VLC", command: "vlc", package: "vlc", args: ["--no-qt-privacy-ask", "--no-metadata-network-access"], purpose: "Play and inspect audio and video", formats: ["mp4", "webm", "mp3", "wav"] },
  { id: "files", name: "Files", command: "thunar", package: "thunar", args: [], defaultPath: "/workspace", purpose: "Browse uploads, outputs and project files", formats: [] },
  { id: "editor", name: "Text Editor", command: "mousepad", package: "mousepad", args: [], purpose: "Edit plain text, code and notes", formats: ["txt", "md", "py", "js", "json"] },
  { id: "terminal", name: "Terminal", command: "xterm", package: "xterm", args: ["-fa", "DejaVu Sans Mono", "-fs", "11"], purpose: "Run Linux commands in the visible desktop", formats: [] },
];

const execute = promisify(execFile);
const home = "/home/openwork-browser";
const path = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const failure = (code, message) => Object.assign(new Error(message), { code });

export function createDesktopApplications({ display = ":99", authority = process.env.XAUTHORITY, directory }) {
  const available = async app => access(`/usr/bin/${app.command}`, constants.X_OK).then(() => true, () => false);
  const installed = async () => {
    const versions = await execute("dpkg-query", ["-W", "-f=${binary:Package}\t${db:Status-Status}\t${Version}\n", ...new Set(DESKTOP_APPS.map(app => app.package))], { timeout: 3000 }).then(result => result.stdout, error => String(error.stdout ?? ""));
    return new Map(versions.trim().split("\n").map(line => line.split("\t")).filter(([, status]) => status === "installed").map(([pkg, , version]) => [pkg, version]));
  };
  return {
    async list() {
      const packages = await installed();
      return {
        environment: {
          os: "Linux", display, desktop: "Openbox", rendering: "CPU / Mesa software OpenGL",
          uploads: "/workspace/files", outputs: "/workspace/out", home,
          guidance: "Browser and applications share this display. Use computer_launch, then open/observe the desktop before acting. Save deliverables in /workspace/out and return them with the existing file tools. App profiles and files persist across VM pause/resume. Right-click the desktop or press Super+Space for applications. The bash tool also provides Python, FFmpeg, ImageMagick, OCR and document conversion.",
        },
        apps: await Promise.all(DESKTOP_APPS.map(async ({ id, name, command, package: pkg, purpose, formats, note }) => ({ id, name, command, purpose, formats, ...(note ? { note } : {}), available: packages.has(pkg) && await available({ command }), version: packages.get(pkg) ?? null }))),
      };
    },
    async launch(args, signal) {
      if (!args || Object.keys(args).some(key => !["app", "path"].includes(key))) throw failure("invalid_app", "Use an app id from computer_apps and an optional absolute file path.");
      const app = DESKTOP_APPS.find(app => app.id === args.app);
      if (!app) throw failure("invalid_app", "Choose an app id returned by computer_apps.");
      if (args.path !== undefined && (typeof args.path !== "string" || args.path.length > 4096 || args.path.includes("\0") || !isAbsolute(args.path))) throw failure("invalid_path", "Use an absolute file path on this computer.");
      if (!(await installed()).has(app.package) || !await available(app)) throw failure("app_unavailable", `${app.name} is not installed in this computer's snapshot. Rebuild the desktop image to add it.`);
      signal?.throwIfAborted();
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const log = await open(`${directory}/${app.id}.log`, "a", 0o600);
      try {
        signal?.throwIfAborted();
        const command = `/usr/bin/${app.command}`;
        const argv = [...app.args, ...(args.path || app.defaultPath ? [args.path ?? app.defaultPath] : [])];
        // Never inherit model, provider or connected-app credentials into GUI processes.
        const env = { PATH: path, HOME: home, USER: "openwork-browser", LOGNAME: "openwork-browser", LANG: "C.UTF-8", DISPLAY: display, XAUTHORITY: authority ?? "", LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe" };
        // Detached applications survive a completed tool call and VM pause/resume.
        const child = spawn(process.getuid?.() === 0 ? "/usr/sbin/runuser" : command, process.getuid?.() === 0 ? ["-u", "openwork-browser", "--", command, ...argv] : argv, { env, cwd: "/workspace", detached: true, stdio: ["ignore", log.fd, log.fd] });
        await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
        child.unref();
        return { app: app.id, name: app.name, launched: true, guidance: "Launch requested. Observe the desktop to verify readiness; an existing app may reuse its window. Do not assume a file was opened or saved." };
      } finally { await log.close(); }
    },
  };
}

if (process.argv[2] === "--launch-app" && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  await createDesktopApplications({ directory: `${home}/.local/state/openwork-apps` }).launch({ app: process.argv[3], ...(process.argv[4] ? { path: process.argv[4] } : {}) });
}
