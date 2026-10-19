// Development builds only: Android may reach a Workbot on this computer over plain http (localhost through
// `adb reverse`; the app refuses plain http to any other host). Production builds never include this.
const { withAndroidManifest } = require("expo/config-plugins")

module.exports = function withLocalHttp(config) {
  return withAndroidManifest(config, (next) => {
    const application = next.modResults.manifest.application?.[0]
    if (application) application.$["android:usesCleartextTraffic"] = "true"
    return next
  })
}
