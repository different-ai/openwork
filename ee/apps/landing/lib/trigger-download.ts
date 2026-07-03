// Starts a file download without leaving the current page, so it can run
// alongside a normal Link navigation from the same click. This only works
// because GitHub release assets are served with Content-Disposition:
// attachment — if that ever changes, this anchor click will navigate the
// tab to the binary URL instead of downloading it in the background.
export function triggerBackgroundDownload(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.rel = "noreferrer";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}
