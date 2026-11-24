import { expect, test } from "vitest";
import { fillOnlyProgramIn } from "../src/agent-permission-engine.js";
import { refuseFillOnlyPrograms, terminalBlockReply } from "../src/opencode-plugins/private-values-terminal.js";

const PROGRAMS = ["bw", "vault-cli", "my-secrets"];

test("a program used for a private value is found wherever the command line runs it, whatever its name", () => {
  for (const line of [
    "bw get password example.com",
    "/opt/homebrew/bin/bw get password example.com",
    "vault-cli read prod/db",
    "export TOKEN=$(my-secrets token) && curl https://example.com",
    "sh -c 'bw get password example.com'",
    "env BW_SESSION=abc bw list items",
    "cd /tmp; vault-cli read prod/db",
  ]) expect(fillOnlyProgramIn(line, PROGRAMS), line).not.toBeNull();
  for (const line of ["npm test", "git status", "echo bw", "cat vault-cli.md", "op read op://v/i/p"]) {
    expect(fillOnlyProgramIn(line, PROGRAMS), line).toBeNull();
  }
  expect(fillOnlyProgramIn("bw get password example.com", [])).toBeNull();
});

test("the refusal names the program, who set the block and what to do instead", async () => {
  const ask = async () => ({ blocked: true, source: "Finance", programs: PROGRAMS });
  const refused = refuseFillOnlyPrograms("bash", { command: "vault-cli read prod/db" }, ask);
  await expect(refused).rejects.toThrow('"vault-cli" was used to get a private value');
  await expect(refuseFillOnlyPrograms("bash", { command: "vault-cli read prod/db" }, ask)).rejects.toThrow("set for Finance");
  await expect(refuseFillOnlyPrograms("shell", { command: "echo $(bw get password x)" }, ask)).rejects.toThrow("fill_from");
});

test("only a shell command is checked, and only a confirmed block refuses", async () => {
  let asked = 0;
  const count = async () => { asked++; return { blocked: true, source: "Everyone", programs: PROGRAMS }; };
  await refuseFillOnlyPrograms("read", { command: "bw get password example.com" }, count);
  await refuseFillOnlyPrograms("bash", { command: 7 }, count);
  expect(asked).toBe(0);
  await refuseFillOnlyPrograms("bash", { command: "npm test" }, count);
  expect(asked).toBe(1);
  await refuseFillOnlyPrograms("bash", { command: "bw get password example.com" }, async () => ({ blocked: false, source: "Everyone", programs: PROGRAMS }));
  await refuseFillOnlyPrograms("bash", { command: "bw get password example.com" }, async () => null);
  await refuseFillOnlyPrograms("bash", { command: "bw get password example.com" }, async () => { throw new Error("offline"); });
});

test("only a plain yes from the desktop is a block, with the programs it names", () => {
  expect(terminalBlockReply({ ok: true, blocked: true, source: "Finance", programs: ["bw", 3, ""] })).toEqual({ blocked: true, source: "Finance", programs: ["bw"] });
  expect(terminalBlockReply({ ok: true, blocked: true })).toEqual({ blocked: true, source: "Everyone", programs: [] });
  expect(terminalBlockReply({ ok: true, blocked: false })).toEqual({ blocked: false, source: "Everyone", programs: [] });
  for (const reply of [null, { ok: false, code: "browser_unavailable" }, { ok: true }, { ok: true, blocked: "true" }, "yes"]) expect(terminalBlockReply(reply)).toBeNull();
});
