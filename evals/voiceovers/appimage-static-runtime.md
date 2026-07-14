# appimage-static-runtime - AppImage runs without FUSE2 and remains updateable

1. This modern Linux host has FUSE3 but no legacy FUSE2 library, matching systems where the old OpenWork AppImage could not start.

2. The packaged OpenWork AppImage uses the static type-two runtime, starts normally, and reaches a working session screen with its embedded server online.

3. Finally, the updater manifest matches the finished AppImage byte-for-byte, so the runtime change preserves automatic updates.
