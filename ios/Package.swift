// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "PageBetweenCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "PageBetweenCore", targets: ["PageBetweenCore"])],
    targets: [
        .target(name: "PageBetweenCore", path: "PageBetween/Core"),
        .testTarget(name: "PageBetweenCoreTests", dependencies: ["PageBetweenCore"], path: "Tests/Core")
    ]
)
