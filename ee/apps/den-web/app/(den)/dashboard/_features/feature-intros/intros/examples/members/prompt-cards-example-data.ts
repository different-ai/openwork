/** Sample data only: no API calls (DESIGN.md I7). A card's title is its description; the prompt goes into the message box. */

export const promptCardsExampleCards: ReadonlyArray<{ title: string; prompt: string }> = [
  { title: "Summarize this week's tickets", prompt: "Read this week's support tickets and list the top five issues." },
  { title: "Draft a renewal email", prompt: "Draft a friendly renewal reminder for the account I name." },
  { title: "Prepare a call brief", prompt: "Brief me on the customer before my next call." },
];
