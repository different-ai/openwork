export function resolveExtensionIconSrc(iconSrc: string): string {
  if (!iconSrc.startsWith("/")) {
    return iconSrc;
  }

  const base = import.meta.env.BASE_URL || "/";
  return `${base.replace(/\/?$/, "/")}${iconSrc.replace(/^\/+/, "")}`;
}

export function resolveExtensionIconUrl(input: {
  iconSrc?: string;
  iconSlug?: string;
  serviceUrl?: string;
}): string | undefined {
  if (input.iconSrc) {
    return resolveExtensionIconSrc(input.iconSrc);
  }

  if (input.iconSlug) {
    return `https://cdn.simpleicons.org/${input.iconSlug}`;
  }

  const serviceUrl = input.serviceUrl?.trim();
  if (!serviceUrl?.match(/^https?:\/\//i)) {
    return undefined;
  }

  try {
    const labels = new URL(serviceUrl).hostname.split(".").filter(Boolean);
    const apex = labels.length < 2 ? labels.join(".") : labels.slice(-2).join(".");
    return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(apex)}`;
  } catch {
    return undefined;
  }
}
