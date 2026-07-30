# Eval runner assets

`mesh-gradient-bg.png` is the checked-in 1920x1200 paper mesh-gradient brand
background used by `pretty` screenshots.

To regenerate it, render `@paper-design/shaders@0.0.72` with `ShaderMount` and
`meshGradientFragmentShader`, using the default OpenWork brand colors from
`packages/ui/src/common/paper.ts`:
`["#e0eaff", "#241d9a", "#f75092", "#9f50d3"]`. Set `distortion: 0.8`,
`swirl: 0.1`, `grainMixer: 0`, `grainOverlay: 0`, `speed: 0`, `frame: 140000`,
and `preserveDrawingBuffer: true`. Mount on a 2560x1600 canvas host, export with
`canvas.toDataURL("image/png")`, then downscale the PNG to 1920x1200.
