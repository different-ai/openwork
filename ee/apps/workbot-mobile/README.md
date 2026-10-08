# Workbot for iPhone and Android

The Workbot chat on a phone: the same conversation, background tasks, files, side chats and Calendar as
[chat.openworklabs.com](../workbot), built with Expo (React Native). It talks only to Workbot's `/v1/workbot/...` API,
through the shared client in [`@openwork-ee/workbot-client`](../../packages/workbot-client).

- **Sign-in** goes through Workbot and Den ([how](../workbot/README.md#the-phone-app)): the system's sign-in browser,
  then a sealed Workbot session kept in the phone's keychain. The phone never holds Den tokens. Signing out revokes
  the session and removes the files cached on the phone.
- **Replies stream** over `/v1/workbot/events` while the app is open; it catches up when it comes back.
- **Organizations turn it on** with the `workbotMobile` feature, next to Workbot.

## Run it locally

You need Xcode with an iOS Simulator (or Android Studio with an emulator) and the usual local Den setup (Docker with
MySQL and Redis, Node 24).

1. Start a local OpenWork with Workbot, a scripted model and a demo account:

   ```sh
   pnpm world up ./ee/apps/workbot-mobile/e2e/world.ts --place local -- --calendar
   ```

   It prints `workbotUrl` and the account to sign in with. The password is `outputs.alexPassword` in
   `evals/results/.worlds/scripts/workbot-phone.json`.
2. Build and open the development app (once; after that, code changes reload by themselves):

   ```sh
   pnpm --filter @openwork-ee/workbot-mobile ios   # or android
   ```

3. On the sign-in screen, tap **Change**, enter the `workbotUrl`, tap **Use**, then **Sign in with OpenWork**.

`--calendar` fills the Calendar with Automations and Google Calendar and Outlook meetings. In the scripted chat,
"Draft the launch brief" starts a background task that saves a file; "thanks" and "good news" get reactions.

## Builds

`APP_VARIANT=production` builds `com.openworklabs.workbot` for `https://chat.openworklabs.com`. Any other build is the
development app `com.openworklabs.workbot.dev` ("Workbot Dev"), which can sign in to any Workbot.
