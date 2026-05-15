import assert from "node:assert/strict";

const { clearDevLogs, formatDevLogLine, formatDevLogText, readDevLogs, recordDevLog } = await import(
  "../src/app/lib/dev-log.ts"
);

const results = {
  ok: true,
  steps: [] as Array<Record<string, unknown>>,
};

function step(name: string, fn: () => void) {
  results.steps.push({ name, status: "running" });
  const index = results.steps.length - 1;

  try {
    fn();
    results.steps[index] = { name, status: "ok" };
  } catch (error) {
    results.ok = false;
    results.steps[index] = {
      name,
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

try {
  clearDevLogs();

  step("disabled logging does not retain entries", () => {
    recordDevLog(false, { level: "debug", source: "workspace", label: "connect:start" });
    assert.equal(readDevLogs(0).length, 0);
  });

  step("enabled logging retains ordered entries", () => {
    recordDevLog(true, { level: "debug", source: "workspace", label: "connect:start", payload: { root: "/tmp/demo" } });
    recordDevLog(true, { level: "warn", source: "session", label: "stream:error", payload: { code: 500 } });
    const logs = readDevLogs(0);
    assert.equal(logs.length, 2);
    assert.equal(logs[0]?.source, "workspace");
    assert.equal(logs[1]?.level, "warn");
  });

  step("formatted output stays readable and exportable", () => {
    const line = formatDevLogLine(readDevLogs(1)[0]!);
    assert.match(line, /WARN session:stream:error/);
    const text = formatDevLogText(0);
    assert.match(text, /DEBUG workspace:connect:start/);
    assert.match(text, /WARN session:stream:error/);
  });

  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  results.ok = false;
  console.error(
    JSON.stringify(
      {
        ...results,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
