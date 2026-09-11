export const SLACK_RELEASE_PENDING_MARKER = "<!-- openwork-slack-release:pending -->";
export const SLACK_RELEASE_SENT_MARKER = "<!-- openwork-slack-release:sent -->";

export function getSlackReleaseMarkers(body) {
  return [SLACK_RELEASE_PENDING_MARKER, SLACK_RELEASE_SENT_MARKER].filter((marker) => body.includes(marker));
}
