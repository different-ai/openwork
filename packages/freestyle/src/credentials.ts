/** The server has a Freestyle credential. Kept apart from the SDK so pages can check it cheaply. */
export function freestyleConfigured(): boolean {
  return Boolean(process.env.FREESTYLE_API_KEY?.trim());
}
