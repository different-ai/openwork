/** A bounded, overscanned window, including when filtering shrinks a deep list. */
export function pluginDirectoryRange(scrollTop: number, viewportHeight: number, rowHeight: number, count: number) {
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewportHeight)) / rowHeight) + 4);
  return {
    start: Math.min(end, Math.max(0, Math.floor(Math.max(0, scrollTop) / rowHeight) - 4)),
    end,
  };
}

/** Hidden/clip containers clip content but are not the user's scroll viewport. */
export function isDirectoryScrollOverflow(overflow: string) {
  return overflow === "auto" || overflow === "scroll";
}

export function shouldAutoLoadPluginPage({ listBottom, viewportTop, viewportHeight, hasNextPage, isFetchingNextPage, isFetchNextPageError }: {
  listBottom: number;
  viewportTop: number;
  viewportHeight: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
}) {
  return viewportHeight > 0 && listBottom > viewportTop && listBottom - (viewportTop + viewportHeight) < 300
    && hasNextPage && !isFetchingNextPage && !isFetchNextPageError;
}
