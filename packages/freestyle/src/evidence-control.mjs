// Runs only inside an owned evidence VM; no provider or production credentials.
const command = process.argv[2];
if (command !== "continue" && command !== "state" && command !== "refresh") throw new Error("Unknown evidence control");
// refresh [service...]: restart the named services (den-api, server), then reload the app.
const response = await fetch(`http://127.0.0.1:6081/__evidence/${command}`, {
  method: command === "state" ? "GET" : "POST", signal: AbortSignal.timeout(command === "refresh" ? 180_000 : 5_000),
  ...(command === "refresh" ? { body: JSON.stringify({ restart: process.argv.slice(3) }) } : {}),
});
const text = await response.text();
if (!response.ok) throw new Error(`Evidence control ${command} failed: ${text.slice(0, 500)}`);
console.log(text);
