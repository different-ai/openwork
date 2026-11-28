type SetupInput = {
  apiBaseUrl: string
  setupCode: string
  root: string
  workFolder: string
}

function shellQuote(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`
}

export function buildCloudCodingSetup(input: SetupInput): { setupCommand: string; instructions: string } {
  const api = input.apiBaseUrl.replace(/\/+$/, "")
  const root = shellQuote(input.root)
  const helper = shellQuote(`${input.root}/openwork-code.mjs`)
  const body = shellQuote(`${input.root}/pull-request.md`)
  return {
    setupCommand: `mkdir -p ${root} && curl -fsSL ${shellQuote(`${api}/v1/cloud-coding/gateway/helper.mjs`)} -o ${helper} && node ${helper} setup --api ${shellQuote(api)} --code ${shellQuote(input.setupCode)} --root ${root}`,
    instructions: [
      "Run the returned setupCommand once in this chat's shell. The setup code is single use and expires after 10 minutes. Never share the setup code or task token.",
      `Work in ${shellQuote(input.workFolder)}. Confirm install and test commands from the repository itself (README, package.json, Makefile, or CI config). Make the smallest change that completes the task and run the tests that cover it.`,
      "Never push with git or look for other credentials. Never change files under .github/workflows. Report tests honestly: if keys are missing, say what could not run and report not_run or failed, as appropriate.",
      `When ready, write the pull request description to ${body} and run this command with the placeholders replaced:`,
      `node ${helper} request-push --root ${root} --branch "openwork/<short-kebab-name>" --title "<title>" --body-file ${body} --tests <passed|failed|not_run> --test-command "<cmd>" --test-summary "<one line>"`,
      "The helper asks the person to approve the push and waits up to four minutes. Exit 3 means still waiting: tell the person that a push is waiting for their approval and stop.",
      `When they have approved, call cloud-coding:start again with taskId and the same repository, run the new setupCommand once, then run node ${helper} wait --root ${root}.`,
      "Exit 0 prints the pull request link to share. Exit 4 means denied: say nothing was pushed. The helper removes the work folder and its credential when the pull request opens or the push is denied. The credential ends with this turn or after 60 minutes.",
    ].join("\n"),
  }
}
