export const LIVE_STEP_BOTTOM_GAP_PX = 16

export type LiveStepScrollBox = {
  scrollHeight: number
  scrollTop: number
  clientHeight: number
}

export function isLiveStepAtBottom(box: LiveStepScrollBox, gapPx = LIVE_STEP_BOTTOM_GAP_PX) {
  return box.scrollHeight - (box.scrollTop + box.clientHeight) <= gapPx
}

export function shouldFollowLiveStepGrowth(input: { isLive: boolean; pinned: boolean }) {
  return input.isLive && input.pinned
}

export function pinnedAfterUserScroll(atBottom: boolean) {
  return atBottom
}

export function pinnedAfterWheel(input: {
  deltaY: number
  pinned: boolean
  atBottom: boolean
}) {
  if (input.deltaY < 0) return false
  return input.pinned && input.atBottom
}
