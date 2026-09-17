import XCTest
@testable import PBJCore

final class LatestSeekQueueTests: XCTestCase {
    func testRapidDragKeepsOnlyLatestPendingDestination() throws {
        var queue = LatestSeekQueue()
        let first = try XCTUnwrap(queue.enqueue(ticks:0,precise:false))
        for tick in 1...10_000 {
            XCTAssertNil(queue.enqueue(ticks:Int64(tick),precise:false))
        }
        let next = try XCTUnwrap(queue.complete(id:first.id))
        XCTAssertEqual(next.ticks,10_000)
        XCTAssertFalse(next.precise)
        XCTAssertNil(queue.complete(id:next.id))
        XCTAssertFalse(queue.hasWork)
    }
    func testFingerReleaseFinishesWithExactSeekEvenAtSamePosition() throws {
        var queue = LatestSeekQueue()
        let moving = try XCTUnwrap(queue.enqueue(ticks:90_000,precise:false))
        XCTAssertNil(queue.enqueue(ticks:90_000,precise:true))
        let released = try XCTUnwrap(queue.complete(id:moving.id))
        XCTAssertTrue(released.precise)
        XCTAssertEqual(released.ticks,90_000)
        XCTAssertNotEqual(moving.id,released.id)
    }
    func testReversingDragDropsObsoletePendingPosition() throws {
        var queue = LatestSeekQueue()
        let first = try XCTUnwrap(queue.enqueue(ticks:60_000,precise:false))
        _ = queue.enqueue(ticks:180_000,precise:false)
        _ = queue.enqueue(ticks:60_000,precise:false)
        XCTAssertNil(queue.complete(id:first.id))
        XCTAssertFalse(queue.hasWork)
    }
    func testLateCallbackCannotCompleteReplacementPlayerWork() throws {
        var queue = LatestSeekQueue()
        let old = try XCTUnwrap(queue.enqueue(ticks:60_000,precise:false))
        _ = queue.enqueue(ticks:120_000,precise:false)
        queue.cancel()
        let current = try XCTUnwrap(queue.enqueue(ticks:0,precise:true))
        XCTAssertNil(queue.complete(id:old.id))
        XCTAssertTrue(queue.hasWork)
        XCTAssertNil(queue.complete(id:current.id))
        XCTAssertFalse(queue.hasWork)
    }
}
