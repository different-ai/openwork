# Presentation components

Ordinary React/Remotion components shared by scenario videos.

- `BrowserFrame`: the browser chrome from the onboarding film.
- `RecordedBrowser`: display the last captured frame at a source timestamp.
- `DownloadToast`: presentation of observed download progress.
- `recordingFromCapture`: validate and convert a CDP capture manifest into props.

See `scenarios/onboarding/video.tsx` for composition and
`scenarios/onboarding/render.mjs` for rendering. There is no presentation registry
or timeline DSL. Keep scenario-specific illustrations in the scenario folder.

Run helper checks with `node --test packages/presentation/test/*.test.ts`.
