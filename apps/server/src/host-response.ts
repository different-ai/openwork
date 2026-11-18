/** Decode an internal host response without changing its HTTP failure semantics. */
export async function readHostResponse(response: Response): Promise<unknown> {
  // Native V2 writes such as /model succeed with 204 No Content.
  const text = await response.text();
  const payload: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string" ? `: ${payload.message}` : "";
    throw new Error(`OpenWork request failed (${response.status})${message}`);
  }
  return payload;
}
