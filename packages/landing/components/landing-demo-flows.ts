export type ChatMessage =
  | {
      role: "user" | "agent";
      content: string;
    }
  | {
      role: "timeline";
      items: string[];
    };

export type DemoFlow = {
  id: string;
  categoryLabel: string;
  tabLabel: string;
  title: string;
  description: string;
  activeAgent: { name: string; color: string };
  agents: { name: string; desc: string; color: string }[];
  task: string;
  context: string;
  output: string;
  chatHistory: ChatMessage[];
};

export const landingDemoFlows: DemoFlow[] = [
  {
    id: "browser-automation",
    categoryLabel: "Browser Automation",
    tabLabel: "Like Twitter replies and export users",
    title: "Like Twitter replies and export users",
    description:
      "Turn plain-language requests into browser actions across the tools your team already uses.",
    activeAgent: {
      name: "Browser Operator",
      color: "bg-[#2463eb]"
    },
    agents: [
      {
        name: "Digital Twin",
        desc: "Extended digital you",
        color: "bg-[#4f6ee8]"
      },
      {
        name: "Sales Inbound",
        desc: "Qualifies leads",
        color: "bg-[#f97316]"
      },
      {
        name: "Personal",
        desc: "Daily tasks",
        color: "bg-[#0f9f7f]"
      }
    ],
    task:
      'Open this Twitter thread, like all the replies, and extract the user details into a CSV file.',
    context:
      'Ensure you scroll through the entire thread to load all replies before interacting and extracting data.',
    output: 'Save the extracted data as "tweet_replies.csv" on my desktop.',
    chatHistory: [
      {
        role: "user",
        content:
          "Here is a link to a tweet: https://x.com/user/status/12345. Like all the replies and save the user details to a CSV on your computer."
      },
      {
        role: "timeline",
        items: [
          "Execution timeline 1 step - Navigates to tweet URL in browser",
          'Execution timeline 4 steps - Scrolls to load and clicks "like" on all 42 replies',
          "Execution timeline 2 steps - Extracts usernames and bio data",
          'Execution timeline 1 step - Writes tweet_replies.csv to local filesystem'
        ]
      },
      {
        role: "agent",
        content:
          'I have successfully liked 42 replies on that thread and saved the user details to "tweet_replies.csv" on your computer. Is there anything else you need?'
      }
    ]
  },
  {
    id: "data-analysis",
    categoryLabel: "Data Analysis",
    tabLabel: "Summarize Q3 revenue outliers",
    title: "Summarize Q3 revenue outliers",
    description:
      "Work from Excel files or pasted spreadsheets without changing how your team already shares data.",
    activeAgent: {
      name: "Excel Analyst",
      color: "bg-[#0f9f7f]"
    },
    agents: [
      {
        name: "Digital Twin",
        desc: "Extended digital you",
        color: "bg-[#4f6ee8]"
      },
      {
        name: "Sales Inbound",
        desc: "Qualifies leads",
        color: "bg-[#f97316]"
      },
      {
        name: "Personal",
        desc: "Daily tasks",
        color: "bg-[#0f9f7f]"
      }
    ],
    task:
      "Analyze this Excel model even if the user uploads the file or pastes the spreadsheet directly into chat.",
    context:
      "Flag the biggest changes in revenue, explain the outliers, and compare each segment against plan.",
    output:
      "Return the findings as a clean table plus a short executive summary.",
    chatHistory: [
      {
        role: "user",
        content: "Here is the Q3_Financials.xlsx file. Find the biggest outliers."
      },
      {
        role: "timeline",
        items: [
          "Execution timeline 1 step - Reads Q3_Financials.xlsx",
          "Execution timeline 2 steps - Parses sheets and normalizes data",
          "Execution timeline 1 step - Runs statistical anomaly detection"
        ]
      },
      {
        role: "agent",
        content:
          "I analyzed the spreadsheet and found 3 major outliers. The most significant is a 42% spike in marketing spend during August, which correlates with the new campaign launch."
      }
    ]
  },
  {
    id: "outreach-creation",
    categoryLabel: "Outreach Creation",
    tabLabel: "Draft follow-up for Acme Corp",
    title: "Draft follow-up for Acme Corp",
    description:
      "Turn Notion MCP context into personalized outreach, then push the final result into your CRM.",
    activeAgent: {
      name: "Outreach Writer",
      color: "bg-[#d97706]"
    },
    agents: [
      {
        name: "Digital Twin",
        desc: "Extended digital you",
        color: "bg-[#4f6ee8]"
      },
      {
        name: "Sales Inbound",
        desc: "Qualifies leads",
        color: "bg-[#f97316]"
      },
      {
        name: "Personal",
        desc: "Daily tasks",
        color: "bg-[#0f9f7f]"
      }
    ],
    task:
      "Draft founder outreach from our Notion workspace, then save the final message and next step into HubSpot.",
    context:
      "Use the Notion MCP notes for tone, product context, and the last touchpoint before writing.",
    output: "Create the email, update the CRM record, and queue the follow-up.",
    chatHistory: [
      {
        role: "user",
        content:
          "Draft a follow-up to Acme Corp based on our last meeting notes in Notion."
      },
      {
        role: "timeline",
        items: [
          'Execution timeline 1 step - Queries Notion MCP for "Acme Corp meeting notes"',
          "Execution timeline 2 steps - Extracts action items and tone preferences",
          "Execution timeline 1 step - Generates personalized email draft"
        ]
      },
      {
        role: "agent",
        content:
          "I've drafted the follow-up email based on the action items from the Notion notes. It highlights the custom integration timeline we discussed. Would you like me to push this to HubSpot?"
      }
    ]
  }
];

export const landingDemoFlowTimes: Record<string, string> = {
  "browser-automation": "1s ago",
  "data-analysis": "15m ago",
  "outreach-creation": "22h ago"
};

export const defaultLandingDemoFlowId = landingDemoFlows[0]?.id ?? "";
