// Runs only inside an owned evidence VM; no provider or production credentials.
const command = process.argv[2];
if (command !== "continue" && command !== "state") throw new Error("Unknown evidence control");
const response = await fetch(`http://127.0.0.1:6081/__evidence/${command}`, {
  method: command === "continue" ? "POST" : "GET", signal: AbortSignal.timeout(5_000),
});
if (!response.ok) throw new Error("Evidence control unavailable");
console.log(await response.text());
