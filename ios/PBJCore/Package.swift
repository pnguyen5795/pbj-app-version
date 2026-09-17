// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "PBJCore",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "PBJCore", targets: ["PBJCore"])],
    targets: [
        .target(name: "PBJCore"),
        .testTarget(name: "PBJCoreTests", dependencies: ["PBJCore"])
    ],
    swiftLanguageModes: [.v5]
)
