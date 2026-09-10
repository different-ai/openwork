import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseBrowserTaskReply } from "@openwork/behaviors";
import type { BrowserTaskInput, BrowserTaskReply } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";

const exec = promisify(execFile);

/** JSON inside scripts also needs protection against HTML script delimiters. */
export function browserScriptValue(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("The browser fixture needs serializable data.");
  return json.replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Execute on the desktop host, keeping loopback endpoints and tokens there. */
export async function runBrowserHost(app: Surface, source: string): Promise<unknown> {
  const program = `try { const result = await (async () => { ${source} })(); console.log('BROWSER_RESULT='+JSON.stringify(result)); } catch { console.log('BROWSER_RESULT='+JSON.stringify({error:'browser_host_failure'})); process.exitCode=1; }`;
  const sandbox = app.handle.hostKind === "daytona" ? app.handle.sandboxId : undefined;
  if (app.handle.hostKind === "daytona" && !sandbox) throw new Error("Missing desktop sandbox.");
  const result = sandbox
    ? await exec("daytona", ["exec", sandbox, "--", `node --input-type=module -e '${program.replace(/'/g, "'\"'\"'")}'`], { timeout: 90_000, maxBuffer: 8_000_000 })
    : await exec(process.execPath, ["--input-type=module", "-e", program], { timeout: 90_000, maxBuffer: 8_000_000 });
  const line = result.stdout.split("\n").find((item) => item.startsWith("BROWSER_RESULT="));
  if (!line) throw new Error("The desktop host returned no browser result.");
  return JSON.parse(line.slice("BROWSER_RESULT=".length));
}

/** This is the Electron bridge, not the desktop server's five-second UI mailbox. */
export async function requestBrowserTask(app: Surface, input: BrowserTaskInput): Promise<BrowserTaskReply> {
  if (!app.handle.profileDir) throw new Error("The isolated desktop has no profile path.");
  return parseBrowserTaskReply(await runBrowserHost(app, `
    const {readFile}=await import('node:fs/promises');
    const bridge=JSON.parse(await readFile(${browserScriptValue(`${app.handle.profileDir}/electron-userdata/openwork-ui-control.json`)},'utf8'));
    const response=await fetch(bridge.baseUrl+'/browser/task',{
      method:'POST',headers:{Authorization:'Bearer '+bridge.token,'Content-Type':'application/json'},
      body:${browserScriptValue(JSON.stringify(input))},signal:AbortSignal.timeout(65000)
    });
    if(!response.ok)throw new Error('Browser task transport failed');
    return response.json();
  `));
}
