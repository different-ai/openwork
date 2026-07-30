# pretty-screenshot — Marketing-grade frames from any eval flow

A new option on the screenshot primitive: `pretty` composites the raw capture
onto the paper mesh-gradient brand background with rounded corners and a soft
drop shadow, entirely inside the app's own Chromium via CDP — so it behaves
identically on Linux, macOS, and Windows. One paragraph per frame; the flow
loads its narration from this file, so this script is the spec the code is
held to.

1. Any screenshot an eval takes can now ship presentation-ready. It is one flag on the existing screenshot primitive — the flow, the assertions, and the evidence pipeline stay exactly the same.

2. Here is the same app state twice: first the plain capture, then the pretty capture — the app framed on the paper mesh-gradient background in OpenWork's brand palette.

3. The pretty frame is not a filter: the capture sits centered with rounded corners, and every corner of the canvas is proven by pixel checks to show the gradient background — including inside the corner radius, where the app image is clipped away.

4. The drop shadow is real and smooth: sampled just below the card, the background is measurably darker than the very same pixels rendered without the card.

5. And it runs everywhere the runner runs: the compositing happens inside the app's own Chromium over CDP — no ImageMagick, no OS screenshot tools, and not a single platform branch in the implementation — so Linux, macOS, and Windows produce the same pixels.
