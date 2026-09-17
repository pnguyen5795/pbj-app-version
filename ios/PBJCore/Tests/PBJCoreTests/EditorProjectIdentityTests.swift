import Foundation
import XCTest
@testable import PBJCore

final class EditorProjectIdentityTests: XCTestCase {
    func testOldStudioCannotSyncIntoNewCookingProject() {
        let newProject = "3bbee95d-9142-42bd-98e4-7da7d83b3238"
        XCTAssertFalse(EditorProjectIdentity.matches(editorRoot: URL(fileURLWithPath: "/Documents/PBJ"), remoteProjectID: newProject))
        XCTAssertFalse(EditorProjectIdentity.matches(editorRoot: URL(fileURLWithPath: "/Documents/PBJProjects/2ac12040-9b05-4ce4-b405-6b2628d8eb99"), remoteProjectID: newProject))
        XCTAssertFalse(EditorProjectIdentity.matches(editorRoot: URL(fileURLWithPath: "/Documents/PBJ"), remoteProjectID: nil))
    }
    func testLoadedMatchingProjectCanSyncWithEitherUUIDCase() {
        let id = "3bbee95d-9142-42bd-98e4-7da7d83b3238"
        let root = URL(fileURLWithPath: "/Documents/PBJProjects/" + id.uppercased())
        XCTAssertTrue(EditorProjectIdentity.matches(editorRoot: root, remoteProjectID: id))
    }
}
