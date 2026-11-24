// swift-tools-version: 6.2
import PackageDescription

/// Everything the app knows that is not a screen: sign-in, the session, the
/// Workbot API, live answers, and the models the screens read. It builds for
/// macOS too so `swift test` runs without a simulator.
let package = Package(
    name: "OpenWorkKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [.library(name: "OpenWorkKit", targets: ["OpenWorkKit"])],
    targets: [
        .target(name: "OpenWorkKit"),
        .testTarget(name: "OpenWorkKitTests", dependencies: ["OpenWorkKit"]),
    ],
    swiftLanguageModes: [.v6]
)
