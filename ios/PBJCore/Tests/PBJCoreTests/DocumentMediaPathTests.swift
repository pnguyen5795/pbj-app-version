import Foundation
import XCTest
@testable import PBJCore

final class DocumentMediaPathTests: XCTestCase {
    private let oldID = "5E3B2A24-42A7-4502-BDE6-8EC83819A4FD"
    private let newDocuments = URL(fileURLWithPath: "/var/mobile/Containers/Data/Application/00000000-0000-4000-8000-000000000001/Documents")

    func testOldPhoneAndSimulatorPathsSurviveContainerChanges() throws {
        let relative = "PBJApplication/originals/clip.mov"
        for prefix in ["/var/mobile", "/private/var/mobile", "/Users/test/Library/Developer/CoreSimulator/Devices/device/data"] {
            let old = prefix + "/Containers/Data/Application/" + oldID + "/Documents/" + relative
            XCTAssertEqual(try DocumentMediaPath.stored(old, documents: newDocuments), relative)
            XCTAssertEqual(try DocumentMediaPath.resolved(old, documents: newDocuments), newDocuments.appendingPathComponent(relative).path)
        }
        XCTAssertEqual(try DocumentMediaPath.resolved(relative, documents: newDocuments), newDocuments.appendingPathComponent(relative).path)
    }

    func testRoundTripPreservesAccountAndTeachingSubdirectories() throws {
        for relative in ["Accounts/alice/Application/teaching-draft/group/raw.mov", "PBJProjects/project/media/source.mp4"] {
            let absolute = newDocuments.appendingPathComponent(relative).path
            XCTAssertEqual(try DocumentMediaPath.stored(absolute, documents: newDocuments), relative)
            XCTAssertEqual(try DocumentMediaPath.resolved(relative, documents: newDocuments), absolute)
        }
        let external = "/Users/test/Desktop/raw.mov"
        XCTAssertEqual(try DocumentMediaPath.resolved(external, documents: newDocuments), external)
    }

    func testTraversalAndMalformedRelativePathsAreRejected() {
        for path in ["../other/clip.mov", "PBJApplication/../other.mov", "PBJApplication//clip.mov", "", "clip\0.mov",
            "/var/mobile/Containers/Data/Application/" + oldID + "/Documents/../other.mov"] {
            XCTAssertThrowsError(try DocumentMediaPath.resolved(path, documents: newDocuments))
        }
    }
}
