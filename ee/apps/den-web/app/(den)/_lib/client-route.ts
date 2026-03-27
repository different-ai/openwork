export function getComparablePathname(target: string | null | undefined): string | null {
  const trimmed = target?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      return new URL(trimmed).pathname;
    } catch {
      return trimmed;
    }
  }

  return trimmed.split(/[?#]/)[0] ?? trimmed;
}

export function isSamePathname(currentPathname: string, target: string | null | undefined) {
  const comparable = getComparablePathname(target);
  if (!comparable) {
    return false;
  }

  return comparable === currentPathname;
}
