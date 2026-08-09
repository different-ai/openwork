import * as React from "react";

const MOBILE_BREAKPOINT = 768
const MOBILE_MEDIA_QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

export function getInitialIsMobile(matchMedia?: (query: string) => { matches: boolean }) {
  return matchMedia?.(MOBILE_MEDIA_QUERY).matches ?? false
}

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState(() =>
    getInitialIsMobile(typeof window === "undefined" ? undefined : (query) => window.matchMedia(query)),
  )

  React.useEffect(() => {
    const mql = window.matchMedia(MOBILE_MEDIA_QUERY)
    const onChange = () => {
      setIsMobile(mql.matches)
    }
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
