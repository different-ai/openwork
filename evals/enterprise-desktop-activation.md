# Enterprise desktop activation

The enterprise desktop app is installed directly from the organization's Den
download page. Before activation it shows only the pixel-dither activation
gate, rejects runtime commands, and does not start the local runtime.

An authenticated Den user requests a one-time desktop handoff for the
`openwork-enterprise` scheme. Opening that deep link activates the enterprise
installation, signs the user into the issuing Den, permanently retains required
sign-in for that distribution, and consumes the handoff grant.

## Expected outcome

- The fresh enterprise app identifies itself as the enterprise distribution.
- Only the Den activation gate is visible before activation.
- A runtime command is rejected before activation.
- A real Den handoff deep link removes the gate and persists the issuing Den.
- The enterprise bootstrap records activation and keeps `requireSignin: true`.
- Den reports the one-time handoff grant as consumed.
