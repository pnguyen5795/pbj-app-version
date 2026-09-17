import XCTest
@testable import PBJCore
final class JobProgressMessageTests: XCTestCase {
    func testPausedWaitingDoesNotPretendToProcess() {
        let p = JobProgressMessage.describe(kind: "plan", status: "queued", stage: "Waiting", processingEnabled: false, connected: true)
        XCTAssertEqual(p.title, "AI processing is paused")
        XCTAssertFalse(p.showsActivity)
        XCTAssertTrue(p.detail.contains("worker is off"))
        XCTAssertTrue(p.next.contains("paid"))
    }
    func testOfflineIsNotReportedAsActiveOrPaused() {
        let p = JobProgressMessage.describe(kind: "plan", status: "queued", stage: "Choosing the cut", processingEnabled: false, connected: false)
        XCTAssertEqual(p.title, "Can't reach the editing service")
        XCTAssertFalse(p.showsActivity)
    }
    func testCompletedAndFailedJobsDoNotSpin() {
        let complete = JobProgressMessage.describe(kind: "plan", status: "complete", stage: "Ready", processingEnabled: false, connected: true)
        XCTAssertEqual(complete.title, "Your cut is ready")
        XCTAssertFalse(complete.showsActivity)
        let failed = JobProgressMessage.describe(kind: "plan", status: "attention", stage: "Choosing the cut", processingEnabled: true, connected: true)
        XCTAssertEqual(failed.title, "This step needs attention")
        XCTAssertFalse(failed.showsActivity)
    }
    func testProviderWaitShowsRealCountAndNextStep() {
        let p = JobProgressMessage.describe(kind: "plan", status: "queued", stage: "Analyzed 7 of 8 files", processingEnabled: true, connected: true)
        XCTAssertEqual(p.title, "Analyzed 7 of 8 files")
        XCTAssertTrue(p.detail.contains("TwelveLabs"))
        XCTAssertTrue(p.showsActivity)
        XCTAssertTrue(p.next.contains("don't need to upload again"))
    }
}
