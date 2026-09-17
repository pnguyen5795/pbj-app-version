import Foundation
import XCTest
@testable import PBJCore

final class PreservedJSONStoreTests: XCTestCase {
    private struct SavedState: Codable, Equatable {
        var queuedFeedback: [String]
        var revision: String
    }
    func testMissingStateStartsNormallyAndQueuedWorkSurvivesReopening() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("state.json")
        let store = PreservedJSONStore<SavedState>(file: file)
        let initial = SavedState(queuedFeedback: [], revision: "initial")
        XCTAssertEqual(try store.load(or: initial), initial)
        let pending = SavedState(queuedFeedback: ["Keep the ending"], revision: "edited")
        try store.save(pending)
        XCTAssertEqual(try PreservedJSONStore<SavedState>(file: file).load(or: initial), pending)
    }
    func testDamagedAndIncompatibleStateCannotBeSilentlyReplaced() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("state.json")
        let store = PreservedJSONStore<SavedState>(file: file)
        for bytes in [Data("{truncated".utf8), Data("{\"futureState\":true}".utf8)] {
            try bytes.write(to: file)
            XCTAssertThrowsError(try store.load(or: SavedState(queuedFeedback: [], revision: "new")))
            XCTAssertThrowsError(try store.save(SavedState(queuedFeedback: [], revision: "new")))
            XCTAssertEqual(try Data(contentsOf: file), bytes)
        }
    }
}
