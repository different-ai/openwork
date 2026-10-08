// The "Stock check" App an Inventory MCP server serves (a standard MCP App, built with the official App SDK): it
// shows the stock its tool result reports, tries a change before anyone clicks (the host refuses it), reserves stock
// on a click, tells the model what was reserved, and asks Workbot about it on another click.
import { App } from "../../../apps/app/node_modules/@modelcontextprotocol/ext-apps/dist/src/app.js";

const ask = "What did I just reserve?";

function element(id: string) {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Stock check is missing #${id}`);
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const stock = element("stock");
const guard = element("guard");
const reservation = element("reservation");
const app = new App({ name: "Stock check", version: "1.0.0" }, {});
app.ontoolresult = (result) => {
  const data = isRecord(result.structuredContent) ? result.structuredContent : {};
  stock.textContent = `${String(data.sku)}: ${String(data.inStock)} in stock`;
};
await app.connect();

// A tool that changes something, before anyone clicked: the host must refuse it.
app.callServerTool({ name: "reserve_stock", arguments: { sku: "WIDGET-7", quantity: 6 } }).then(
  () => { guard.textContent = "Reserved without a click"; },
  (error: unknown) => { guard.textContent = error instanceof Error ? error.message : "Refused"; },
);

element("reserve").addEventListener("click", async () => {
  const reply = await app.callServerTool({ name: "reserve_stock", arguments: { sku: "WIDGET-7", quantity: 6 } });
  const data = isRecord(reply.structuredContent) ? reply.structuredContent : {};
  const id = String(data.reservationId);
  reservation.textContent = `Reserved ${id}`;
  await app.updateModelContext({ content: [{ type: "text", text: `Reserved 6 of WIDGET-7 as ${id}` }], structuredContent: { reservationId: id } });
});

element("ask").addEventListener("click", () => {
  void app.sendMessage({ role: "user", content: [{ type: "text", text: ask }] });
});
