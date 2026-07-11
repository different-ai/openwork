const OPENWORK_CLOUD_DOMAIN = "openworklabs.com";

export function isOpenWorkCloudUrl(rawUrl) {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase();
    return hostname === OPENWORK_CLOUD_DOMAIN || hostname.endsWith(`.${OPENWORK_CLOUD_DOMAIN}`);
  } catch {
    return false;
  }
}

/**
 * Fresh enterprise installs are network-neutral: no request may reach the
 * vendor cloud until a managed JSON file, manual server, or confirmed signed
 * link has supplied an organization configuration.
 */
export function createEnterpriseConnectionGuard({ enterprise, configured = false }) {
  let configurationPresent = configured;

  return {
    isLocked() {
      return enterprise && !configurationPresent;
    },
    setConfigured(value) {
      configurationPresent = value === true;
    },
    shouldBlock(rawUrl) {
      return enterprise && !configurationPresent && isOpenWorkCloudUrl(rawUrl);
    },
    install(electronSession) {
      electronSession.webRequest.onBeforeRequest(
        { urls: ["https://openworklabs.com/*", "https://*.openworklabs.com/*"] },
        (details, callback) => callback({ cancel: this.shouldBlock(details.url) }),
      );
    },
  };
}
