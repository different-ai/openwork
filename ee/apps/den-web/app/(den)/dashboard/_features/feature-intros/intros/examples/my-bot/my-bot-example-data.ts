import type { ExampleService } from "../example-parts";

/** Sample data only: no API calls (DESIGN.md I7). Lines follow the real My bot page. */

export const myBotExample = {
  focal: "Last check 9:30 AM",
  summary: "2 things need you: Dana asked about the Q3 deck, and standup moved to 10:30.",
  today: [
    { time: "9:30 AM", text: "2 things need you", sent: "Sent in Slack" },
    { time: "11:30 AM", text: "Nothing new", sent: "" },
    { time: "1:30 PM", text: "Contract back from legal", sent: "Sent in Slack" },
  ],
  reads: [{ name: "Gmail" }, { name: "Google Calendar" }, { name: "Slack" }] as readonly ExampleService[],
} as const;
