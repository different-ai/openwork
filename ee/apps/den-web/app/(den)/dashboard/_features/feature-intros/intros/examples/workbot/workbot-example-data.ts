import type { ExampleService } from "../example-parts";

export const GOOGLE_CALENDAR: ExampleService = { name: "Google Calendar" };
export const GOOGLE_WORKSPACE: ExampleService = { name: "Google Workspace" };
export const LINEAR: ExampleService = { name: "Linear" };
export const SLACK: ExampleService = { name: "Slack" };
export const OPENAI: ExampleService = { name: "OpenAI", url: "https://openai.com" };

export const workbotExampleQuestion = "What's on my plate today?";

export const workbotExampleSteps: ReadonlyArray<{ service: ExampleService; sentence: string; result: string }> = [
  { service: GOOGLE_CALENDAR, sentence: "Read your calendar for today", result: "4 events" },
  { service: LINEAR, sentence: "Searched Linear for your open issues", result: "3 issues" },
  { service: SLACK, sentence: "Read #launch", result: "12 messages" },
];

export const workbotExampleReply =
  "Four meetings, the first at 10:00. Two of your Linear issues are due today, and #launch is waiting on your sign-off.";

export const workbotExampleModel = { service: OPENAI, label: "Default model", value: "GPT-6 Luna" };
export const workbotExampleApps = { services: [GOOGLE_WORKSPACE, LINEAR, SLACK], label: "Apps", value: "For everyone" };
