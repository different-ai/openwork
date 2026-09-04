// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ComputerUse",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "ComputerUse"),
        .testTarget(name: "ComputerUseTests", dependencies: ["ComputerUse"]),
    ]
)
