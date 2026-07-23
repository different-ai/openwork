import { readdir } from "node:fs/promises";

const bundlesUrl = new URL("../dist/opencode-plugin-bundles/", import.meta.url);
const files = (await readdir(bundlesUrl)).sort();
const expectedFiles = ["openwork-context.js", "openwork-prompt-log.js"];
if (JSON.stringify(files) !== JSON.stringify(expectedFiles)) {
  throw new Error(`Expected only active observability bundles; found ${files.join(", ")}`);
}

const previousPromptLog = process.env.OPENWORK_PROMPT_LOG;
const previousServerUrl = process.env.OPENWORK_SERVER_URL;
const previousServerToken = process.env.OPENWORK_SERVER_TOKEN;
process.env.OPENWORK_PROMPT_LOG = "1";
delete process.env.OPENWORK_SERVER_URL;
delete process.env.OPENWORK_SERVER_TOKEN;

const records = [];
const originalError = console.error;
console.error = (...values) => records.push(values.map(String).join(" "));

try {
  // These are deliberately independent bundle imports. The smoke fails if a
  // bundler change gives each entrypoint a private trace/provenance singleton.
  const [{ OpenWorkContext }, { OpenWorkPromptLog }] = await Promise.all([
    import(new URL("openwork-context.js", bundlesUrl)),
    import(new URL("openwork-prompt-log.js", bundlesUrl)),
  ]);
  const context = await OpenWorkContext();
  const observer = await OpenWorkPromptLog();
  const input = { sessionID: "built-observability-smoke" };
  const output = { system: ["engine-system-header"] };

  await context["experimental.chat.system.transform"](input, output);
  await observer["experimental.chat.system.transform"](input, output);
  output.system.splice(1, output.system.length - 1, output.system.slice(1).join("\n"));
  await observer["chat.params"](input);

  const contributor = records.find((record) => (
    record.includes("[openwork][context] trace=")
    && record.includes(" chars=")
  ));
  const observed = records.find((record) => record.includes("observed system array changed"));
  const contributorTrace = contributor?.match(/trace=(pt_[a-z0-9]+)/)?.[1];
  const observedTrace = observed?.match(/trace=(pt_[a-z0-9]+)/)?.[1];
  if (!contributorTrace || contributorTrace !== observedTrace) {
    throw new Error("Independent observability bundles did not share one trace ID");
  }
  if (!records.some((record) => (
    record.includes(`[openwork][agent-prompt] provenance trace=${contributorTrace}`)
    && record.includes(" match=text-correspondence causalOrigin=unproven ")
    && record.includes(" finalBlock=2 ")
  ))) {
    throw new Error("Independent observability bundles did not share contributor text correspondence");
  }
} finally {
  console.error = originalError;
  if (previousPromptLog === undefined) delete process.env.OPENWORK_PROMPT_LOG;
  else process.env.OPENWORK_PROMPT_LOG = previousPromptLog;
  if (previousServerUrl === undefined) delete process.env.OPENWORK_SERVER_URL;
  else process.env.OPENWORK_SERVER_URL = previousServerUrl;
  if (previousServerToken === undefined) delete process.env.OPENWORK_SERVER_TOKEN;
  else process.env.OPENWORK_SERVER_TOKEN = previousServerToken;
}
