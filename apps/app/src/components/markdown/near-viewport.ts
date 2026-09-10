/** Keep readable markup in the document; only defer its optional enhancements. */
export function enhanceNearViewport(elements: HTMLElement[], enhance: (element: HTMLElement) => void) {
  const pending = new Set(elements);
  if (!pending.size) return () => {};
  if (typeof IntersectionObserver === "undefined") {
    elements.forEach(enhance);
    return () => {};
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || !(entry.target instanceof HTMLElement) || !pending.delete(entry.target)) continue;
      observer.unobserve(entry.target);
      enhance(entry.target);
    }
    if (!pending.size) observer.disconnect();
  }, { rootMargin: "320px 0px" });
  for (const element of pending) observer.observe(element);
  return () => {
    pending.clear();
    observer.disconnect();
  };
}
