export type StationGoalVoiceDecision = "approve" | "dismiss" | null;

export function stationGoalVoiceDecision(transcript: string): StationGoalVoiceDecision {
  const clean = transcript.trim().toLowerCase().replace(/[^\p{Letter}\p{Number}\s']/gu, " ");
  if (!clean || clean.length > 90) return null;
  if (/^(yes|yeah|yep|do it|go ahead|look into it|research it|please do|continue|start it)\b/.test(clean)) {
    return "approve";
  }
  if (/^(no|nope|not now|don't|do not|stop|skip it|leave it|cancel)\b/.test(clean)) {
    return "dismiss";
  }
  return null;
}
