import Foundation
import XCTest
@testable import ApplicationHarness

@MainActor
private final class TestLease: BackgroundWorkLease {
  let mode: BackgroundWorkMode
  let expire: @MainActor () -> Void
  var finishes: [Bool] = []
  var updates: [(Double, String)] = []
  init(_ mode: BackgroundWorkMode, expire: @escaping @MainActor () -> Void) {
    self.mode = mode; self.expire = expire
  }
  func update(_ fraction: Double, _ detail: String) { updates.append((fraction, detail)) }
  func finish(_ success: Bool) { finishes.append(success) }
}

final class BackgroundWorkTests: XCTestCase {
  @MainActor
  func testExpirationCancelsTheRunningChildAndFinishesItsLeaseOnceAsFailed() async throws {
    var lease: TestLease?
    let controller = BackgroundWorkController { _, _, _, expire in
      let result = TestLease(.brief, expire: expire); lease = result; return result
    }
    let started = expectation(description: "Child running")
    let operation = Task {
      do {
        try await controller.run(title: "Uploading", projectID: "project") { _ in
          started.fulfill()
          try await Task.sleep(for: .seconds(5))
        }
        XCTFail("Expired child succeeded")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
    await fulfillment(of: [started], timeout: 1)
    try XCTUnwrap(lease).expire()
    await operation.value
    XCTAssertEqual(lease?.finishes, [false]); XCTAssertNil(controller.message)
    lease?.expire()
    XCTAssertEqual(lease?.finishes, [false])
  }

  @MainActor
  func testExpiredNoncooperativeWorkCannotReportSuccessfulCompletion() async throws {
    var lease: TestLease?
    let controller = BackgroundWorkController { _, _, _, expire in
      let result = TestLease(.brief, expire: expire); lease = result; return result
    }
    var release: CheckedContinuation<Void, Never>?
    let started = expectation(description: "Noncooperative operation started")
    let operation = Task {
      do {
        try await controller.run(title: "Preparing footage", projectID: nil) { _ in
          // A callback or a detached importer can return after its parent was cancelled.
          await withCheckedContinuation { release = $0; started.fulfill() }
        }
        XCTFail("Expired operation was reported as successful")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
    await fulfillment(of: [started], timeout: 1)
    try XCTUnwrap(lease).expire()
    try XCTUnwrap(release).resume()
    await operation.value
    XCTAssertEqual(lease?.finishes, [false])
  }

  @MainActor
  func testExpirationDuringLeaseCreationPreventsWorkFromStarting() async throws {
    var lease: TestLease?
    let controller = BackgroundWorkController { _, _, _, expire in
      let result = TestLease(.brief, expire: expire); lease = result
      expire() // Models expiration before the child handle has been installed.
      return result
    }
    do {
      try await controller.run(title: "Uploading", projectID: nil) { _ in XCTFail("Expired operation started") }
      XCTFail("Synchronous expiration was ignored")
    } catch { XCTAssertTrue(error is CancellationError) }
    XCTAssertEqual(lease?.finishes, [false])
  }

  @MainActor
  func testForegroundGPURenderCancelsWhenTheAppLeavesForeground() async throws {
    for mode in [BackgroundWorkMode.foreground, .brief] {
      var lease: TestLease?
      let controller = BackgroundWorkController { _, _, gpu, expire in
        XCTAssertTrue(gpu)
        let result = TestLease(mode, expire: expire); lease = result; return result
      }
      let started = expectation(description: "Render started")
      let rendering = Task {
        do {
          try await controller.run(title: "Exporting", projectID: "project", requiresGPU: true) { _ in
            started.fulfill(); try await Task.sleep(for: .seconds(5))
          }
          XCTFail("Foreground GPU work continued after backgrounding")
        } catch { XCTAssertTrue(error is CancellationError) }
      }
      await fulfillment(of: [started], timeout: 1)
      controller.setBackground(true)
      await rendering.value
      XCTAssertEqual(lease?.finishes, [false]); XCTAssertNil(controller.message)
    }
  }

  @MainActor
  func testGrantedContinuedWorkStaysRunningInBackgroundUntilActualCompletion() async throws {
    var lease: TestLease?
    let controller = BackgroundWorkController { _, _, _, expire in
      let result = TestLease(.continued, expire: expire); lease = result; return result
    }
    var release: CheckedContinuation<Void, Never>?
    let started = expectation(description: "Continued work started")
    let rendering = Task {
      try await controller.run(title: "Exporting", projectID: "project", requiresGPU: true) { update in
        await update(0.4, "Rendering frames")
        await withCheckedContinuation { release = $0; started.fulfill() }
        try Task.checkCancellation()
        return "verified-export"
      }
    }
    await fulfillment(of: [started], timeout: 1)
    controller.setBackground(true)
    XCTAssertTrue(controller.hasContinuedExecution)
    XCTAssertTrue(lease?.finishes.isEmpty == true)
    XCTAssertEqual(lease?.updates.last?.0, 0.4)
    XCTAssertEqual(lease?.updates.last?.1, "Rendering frames")
    try XCTUnwrap(release).resume()
    let result = try await rendering.value
    XCTAssertEqual(result, "verified-export")
    XCTAssertEqual(lease?.finishes, [true]); XCTAssertFalse(controller.hasContinuedExecution)
    XCTAssertNil(controller.message)
  }

  @MainActor
  func testNestedWorkSharesOneLeaseAndOnlyTheOutermostFinishesIt() async throws {
    var leases: [TestLease] = []
    let controller = BackgroundWorkController { _, _, _, expire in
      let lease = TestLease(.continued, expire: expire); leases.append(lease); return lease
    }
    let result = try await controller.run(title: "Import and upload", projectID: "project") { _ in
      XCTAssertTrue(controller.isNestedOperation)
      let result = try await controller.run(title: "Uploading", projectID: "project") { update in
        await update(0.5, "Half uploaded")
        return 17
      }
      XCTAssertTrue(leases[0].finishes.isEmpty)
      return result
    }
    XCTAssertEqual(result, 17); XCTAssertEqual(leases.count, 1)
    XCTAssertEqual(leases[0].finishes, [true]); XCTAssertEqual(leases[0].updates.last?.1, "Half uploaded")
    XCTAssertFalse(controller.isNestedOperation)
  }

  @MainActor
  func testCancellingParentCancelsChildAndReleasesLeaseExactlyOnce() async throws {
    var lease: TestLease?
    let controller = BackgroundWorkController { _, _, _, expire in
      let result = TestLease(.continued, expire: expire); lease = result; return result
    }
    let started = expectation(description: "Child started")
    let parent = Task {
      do {
        try await controller.run(title: "Uploading", projectID: nil) { _ in
          started.fulfill(); try await Task.sleep(for: .seconds(5))
        }
        XCTFail("Cancelled parent returned a successful result")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
    await fulfillment(of: [started], timeout: 1)
    parent.cancel(); parent.cancel()
    await parent.value
    XCTAssertEqual(lease?.finishes, [false]); XCTAssertFalse(controller.hasContinuedExecution)
  }
}

private final class InMemoryDefaults: UserDefaults, @unchecked Sendable {
  private let lock = NSLock()
  private var values: [String: Data] = [:]
  override func data(forKey defaultName: String) -> Data? { lock.withLock { values[defaultName] } }
  override func set(_ value: Any?, forKey defaultName: String) {
    lock.withLock { values[defaultName] = value as? Data }
  }
}

final class CompletionNotificationTests: XCTestCase {
  @MainActor
  func testPendingDestinationAndSeenReceiptsSurviveManagerReconstruction() async {
    let defaults = InMemoryDefaults()
    let initial = CompletionNotifications(defaults: defaults)
    initial.activate(ownerID: "owner-a", api: AppAPI())
    let notice = CompletionNotice(id: "persisted-notice", title: "Ready", body: "Open",
      destination: .init(ownerID: "owner-a", projectID: "project-a", exportID: "export-a"))
    let received = await initial.receive(notice)
    XCTAssertTrue(received)
    initial.open(notice)
    let restored = CompletionNotifications(defaults: defaults)
    XCTAssertEqual(restored.pendingOpen, notice)
    restored.activate(ownerID: "owner-a", api: AppAPI())
    let repeated = await restored.receive(notice)
    XCTAssertTrue(repeated); XCTAssertNil(restored.latest, "Previously delivered events remain deduplicated after a process restart")
    restored.opened(notice.id)
    XCTAssertNil(CompletionNotifications(defaults: defaults).pendingOpen)
  }

  @MainActor
  func testLocalExportAndRemoteProjectPayloadsPreserveTheirDestinations() throws {
    let local = CompletionNotice(id: "local-export", title: "Your export is ready", body: "Tap to open",
      destination: .init(ownerID: "owner-a", projectID: "project-a", exportID: "export-a"))
    let data = try JSONEncoder().encode(local)
    XCTAssertEqual(CompletionNotifications.decode(["pbjLocal": String(data: data, encoding: .utf8)!]), local)
    let remote: [String: Any] = ["id": "remote-plan", "ownerID": "owner-a", "jobID": "job-a", "kind": "plan",
      "status": "complete", "projectID": "project-a", "revisionID": "revision-a", "title": "Your cut is ready",
      "body": "Tap to review", "createdAt": "2026-09-11T12:00:00.000Z"]
    let decoded = try XCTUnwrap(CompletionNotifications.decode(["pbj": remote]))
    XCTAssertEqual(decoded.id, "remote-plan")
    XCTAssertEqual(decoded.destination, .init(ownerID: "owner-a", projectID: "project-a"))
    var teaching = remote
    teaching["kind"] = "teach"; teaching["projectID"] = nil; teaching["revisionID"] = nil; teaching["groupID"] = "group-a"
    XCTAssertEqual(CompletionNotifications.decode(["pbj": teaching])?.destination, .init(ownerID: "owner-a", screen: "memory"))
    teaching["status"] = "attention"
    XCTAssertEqual(CompletionNotifications.decode(["pbj": teaching])?.destination, .init(ownerID: "owner-a", screen: "home"))
  }

  @MainActor
  func testNotificationsAreOwnerIsolatedAndRepeatedDeliveryDoesNotShowAgain() async {
    let notices = CompletionNotifications(defaults: nil)
    let api = AppAPI()
    notices.activate(ownerID: "owner-a", api: api)
    let other = CompletionNotice(id: "other-owner", title: "Ready", body: "Open", destination: .init(ownerID: "owner-b", projectID: "project-b"))
    let rejected = await notices.receive(other)
    XCTAssertFalse(rejected); XCTAssertNil(notices.latest)
    let own = CompletionNotice(id: "own-notice", title: "Ready", body: "Open", destination: .init(ownerID: "owner-a", projectID: "project-a"))
    let accepted = await notices.receive(own)
    XCTAssertTrue(accepted); XCTAssertEqual(notices.latest, own)
    notices.latest = nil
    let duplicate = await notices.receive(own)
    XCTAssertTrue(duplicate); XCTAssertNil(notices.latest)
    notices.activate(ownerID: "owner-b", api: api)
    let oldOwner = await notices.receive(own)
    XCTAssertFalse(oldOwner); XCTAssertNil(notices.latest)
    let nowAccepted = await notices.receive(other)
    XCTAssertTrue(nowAccepted); XCTAssertEqual(notices.latest, other)
  }

  @MainActor
  func testOpeningNotificationPreservesExactPendingDestinationUntilConsumed() {
    let notices = CompletionNotifications(defaults: nil)
    let destination = NotificationDestination(ownerID: "owner-a", projectID: "project-a", exportID: "export-a")
    let notice = CompletionNotice(id: "export-notice", title: "Ready", body: "Open", destination: destination)
    notices.open(notice) // Tapping may launch before account restoration finishes.
    XCTAssertEqual(notices.pendingOpen?.destination, destination)
    notices.activate(ownerID: "owner-b", api: AppAPI())
    XCTAssertEqual(notices.pendingOpen, notice, "An unrelated sign-in must not consume the intended owner's destination")
    notices.deactivate()
    XCTAssertEqual(notices.pendingOpen, notice)
    notices.activate(ownerID: "owner-a", api: AppAPI())
    notices.opened("an-older-notice")
    XCTAssertEqual(notices.pendingOpen, notice, "Only the notice actually opened may consume this destination")
    notices.opened(notice.id)
    XCTAssertNil(notices.pendingOpen)
  }

  @MainActor
  func testMalformedNotificationPayloadsAreRejected() throws {
    let malformed: [[AnyHashable: Any]] = [
      [:], ["pbjLocal": "not JSON"], ["pbjLocal": "{}"], ["pbj": "not an object"],
      ["pbj": ["id": "missing-required-fields"]],
      ["pbjLocal": "{\\\"id\\\":\\\"notice\\\",\\\"title\\\":\\\"Ready\\\",\\\"body\\\":\\\"Open\\\",\\\"destination\\\":{\\\"projectID\\\":\\\"project\\\"}}"],
      ["pbj": ["id": 42, "ownerID": "owner", "jobID": "job", "kind": "plan", "status": "complete", "title": "Ready", "body": "Open", "createdAt": "today"]]
    ]
    for payload in malformed { XCTAssertNil(CompletionNotifications.decode(payload)) }
    let missingOwner: [String: Any] = ["id": "notice", "title": "Ready", "body": "Open", "destination": ["projectID": "project"]]
    let data = try JSONSerialization.data(withJSONObject: missingOwner)
    XCTAssertNil(CompletionNotifications.decode(["pbjLocal": String(data: data, encoding: .utf8)!]))
    let destinations = [
      NotificationDestination(ownerID: "", projectID: "project"),
      NotificationDestination(ownerID: "owner", projectID: "../project"),
      NotificationDestination(ownerID: "owner", projectID: "project", exportID: "../export"),
      NotificationDestination(ownerID: "owner", exportID: "export"),
      NotificationDestination(ownerID: "owner", screen: "unrecognized-screen"),
      NotificationDestination(ownerID: "owner")
    ]
    let notices = CompletionNotifications(defaults: nil)
    for destination in destinations {
      let invalid = CompletionNotice(id: "notice", title: "Ready", body: "Open", destination: destination)
      let data = try JSONEncoder().encode(invalid)
      XCTAssertNil(CompletionNotifications.decode(["pbjLocal": String(data: data, encoding: .utf8)!]))
      notices.open(invalid)
      XCTAssertNil(notices.pendingOpen)
    }
    let remote: [String: Any] = ["id": "notice", "ownerID": "owner", "jobID": "job", "kind": "plan", "status": "complete",
      "projectID": "project", "title": "Ready", "body": "Open", "createdAt": "2026-09-11T12:00:00Z"]
    var notComplete = remote; notComplete["status"] = "running"
    XCTAssertNil(CompletionNotifications.decode(["pbj": notComplete]))
    var unknownKind = remote; unknownKind["kind"] = "unrecognized"
    XCTAssertNil(CompletionNotifications.decode(["pbj": unknownKind]))
  }
}
