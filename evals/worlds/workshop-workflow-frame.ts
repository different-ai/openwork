/** Match the actual payload fact inside a rendered field, not necessarily the
 * whole field: valid results may retain a datasheet row such as | Payload | 300 kg |. */
export function workshopWorkflowFrame(value: unknown) {
  const actual = JSON.stringify(value);
  const atlas2 = actual?.match(/\b300\s*(?:kg|kilograms?)/i)?.[0];
  const lift = actual?.match(/\b1[,. ]?200\s*(?:kg|kilograms?)/i)?.[0];
  if (!atlas2 || !lift) throw new Error("Verified latest comparison lacked renderable actual product payload facts");
  const target = (fact: string) => ({ text: new RegExp(`\\b${fact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") });
  return { expect: ["Atlas 2", "Atlas Lift", atlas2, lift], atlas2: target(atlas2), lift: target(lift) };
}
