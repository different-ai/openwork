import { listRoutines } from "./routines.js";
import type { ServerConfig } from "./types.js";
import { createWorkspaceOpencodeClient } from "./server.js"; // We need to export this or pass a callback
import { CronExpressionParser } from "cron-parser";

export class CronScheduler {
  private config: ServerConfig;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private createClient: (workspace: ServerConfig["workspaces"][number]) => any;
  private isTicking = false;
  private lastTickMinute: number | null = null;

  constructor(config: ServerConfig, createClient: (workspace: ServerConfig["workspaces"][number]) => any) {
    this.config = config;
    this.createClient = createClient;
  }

  public start() {
    if (this.intervalId) return;
    // Check every minute
    this.intervalId = setInterval(() => this.tick(), 60000);
    // Initial check on start
    setTimeout(() => this.tick(), 5000);
  }

  public stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async tick() {
    if (this.isTicking) return;
    this.isTicking = true;
    try {
      const nowMinute = new Date();
      nowMinute.setSeconds(0, 0);
      const targetMinute = nowMinute.getTime();

      let startMinute = this.lastTickMinute !== null ? this.lastTickMinute + 60000 : targetMinute;
      
      // Cap catch-up to the last 5 minutes to prevent spam after system sleep
      if (targetMinute - startMinute > 5 * 60000) {
        startMinute = targetMinute - 5 * 60000;
      }

      if (startMinute > targetMinute) return;
      this.lastTickMinute = targetMinute;

      for (let time = startMinute; time <= targetMinute; time += 60000) {
        const checkTime = new Date(time);
        for (const workspace of this.config.workspaces) {
          try {
            const routines = await listRoutines(workspace.path, "workspace");
            for (const routine of routines) {
              if (!routine.enabled) continue;

              try {
                const interval = CronExpressionParser.parse(routine.schedule, { currentDate: new Date(checkTime.getTime() - 60000) });
                const nextDate = interval.next().toDate();
                
                // If the next scheduled time matches our check minute exactly
                if (nextDate.getTime() === checkTime.getTime()) {
                  this.triggerRoutine(workspace, routine).catch((err) => {
                    console.error(`Failed to execute routine ${routine.name}:`, err);
                  });
                }
              } catch (err) {
                console.error(`Error parsing schedule for routine ${routine.name}:`, err);
              }
            }
          } catch (err) {
            console.error(`Error listing routines for workspace ${workspace.id}:`, err);
          }
        }
      }
    } finally {
      this.isTicking = false;
    }
  }

  private async triggerRoutine(workspace: ServerConfig["workspaces"][number], routine: any) {
    try {
      const opencode = this.createClient(workspace);
      
      // 1. Create a background session
      const result = await opencode.session.create({ title: `Routine: ${routine.name}` });
      // Depending on sdk version, result might be wrapped
      let sessionId = "";
      if (result && typeof result === "object" && "id" in result) {
        sessionId = String(result.id);
      } else if (result && typeof result === "object" && "data" in result && result.data && "id" in result.data) {
        sessionId = String(result.data.id);
      }

      if (!sessionId) {
        console.error(`Failed to create session for routine ${routine.name}`);
        return;
      }

      // 2. Prompt the agent
      await opencode.session.prompt({
        sessionID: sessionId,
        text: routine.command,
        mode: "prompt",
      });

    } catch (err) {
      console.error(`Failed to execute routine ${routine.name}:`, err);
    }
  }
}
