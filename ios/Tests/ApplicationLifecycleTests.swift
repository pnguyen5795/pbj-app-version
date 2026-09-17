import Foundation
import XCTest
import PBJCore
@testable import ApplicationHarness

private struct CapturedRequest {
  let path: String
  let method: String
  let body: [String: Any]
}

// Claims every request, including unexpected hosts. Nothing can fall through
// to a live Mac/provider. URLSession may deliver bodies as streams on macOS.
private final class OfflineProtocol: URLProtocol {
  static let lock = NSLock()
  static var responder: ((CapturedRequest) throws -> [String: Any])?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
          let read = stream.read(&buffer, maxLength: buffer.count)
          if read < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
          if read == 0 { break }
          data.append(contentsOf: buffer.prefix(read))
        }
      }
      let body = data.isEmpty ? [:] : try JSONSerialization.jsonObject(with: data) as! [String: Any]
      let captured = CapturedRequest(path: request.url!.path, method: request.httpMethod ?? "GET", body: body)
      Self.lock.lock(); let responder = Self.responder; Self.lock.unlock()
      guard let responder else { throw URLError(.notConnectedToInternet) }
      let result = try responder(captured)
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: result))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private final class OfflineServer {
  private let lock = NSLock()
  private var captured: [CapturedRequest] = []
  private var invalidIdentifiers: [String] = []
  var failMutation = true
  var currentProject: [String: Any]?
  var currentJob: [String: Any]?
  var olderJobs: [[String: Any]] = []
  var beforeProjectResponse: (() throws -> Void)?
  var beforeProjectDetailResponse: (() throws -> Void)?
  var beforeRevisionResponse: (() throws -> Void)?
  var memoryRecords: [[String: Any]] = []
  var teachingGroups: [[String: Any]] = []
  var beforeLearningResponse: ((String) throws -> Void)?
  func respond(_ request: CapturedRequest) throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    captured.append(request)
    if request.method == "POST" {
      var identifiers: [String: Any] = [:]
      identifiers["id"] = request.body["id"]
      identifiers["timeline.id"] = (request.body["timeline"] as? [String: Any])?["id"]
      // Match the backend's UUID version/variant contract, not Foundation's
      // permissive UUID parser that also accepts arbitrary hashes with dashes.
      let uuidPattern = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$"
      for (name, value) in identifiers {
        guard let id = value as? String, id.range(of: uuidPattern, options: .regularExpression) != nil else {
          invalidIdentifiers.append("\(request.path) \(name): \(value)")
          throw NSError(domain: "Invalid backend UUID contract", code: 400)
        }
      }
    }
    if request.method == "POST" && request.path == "/v2/projects" {
      if failMutation { throw URLError(.networkConnectionLost) }
      let beforeResponse = beforeProjectResponse
      beforeProjectResponse = nil
      try beforeResponse?()
      return ["id": request.body["id"]!, "title": request.body["title"]!, "brief": request.body["brief"]!, "status": "queued"]
    }
    if request.method == "POST" && request.path.hasSuffix("/revise") {
      if failMutation { throw URLError(.networkConnectionLost) }
      let beforeResponse = beforeRevisionResponse
      beforeRevisionResponse = nil
      try beforeResponse?()
      return ["id": request.body["id"]!, "kind": "plan", "status": "queued", "stage": "Waiting", "payload": [:]]
    }
    if request.method == "POST" && (request.path.hasSuffix("/approve") || request.path.hasSuffix("/restore")) && failMutation {
      throw URLError(.networkConnectionLost)
    }
    if request.method == "POST" && request.path.hasSuffix("/inputs") { return ["ok": true] }
    if request.method == "POST" && request.path.hasSuffix("/revisions") {
      if failMutation { throw URLError(.networkConnectionLost) }
      let timeline = request.body["timeline"] as! [String: Any]
      currentProject?["currentRevisionId"] = timeline["id"]
      return ["id": timeline["id"]!, "timeline": timeline, "origin": "manual", "summary": "Saved test edit", "accepted": true]
    }
    if request.method == "PATCH" && request.path.hasPrefix("/v2/memory/") { return ["ok": true] }
    if request.method == "POST" && request.path == "/v2/exclusions" { return ["ok": true] }
    if request.method == "GET" {
      switch request.path {
      case "/v2/projects": return ["projects": currentProject.map { [$0] } ?? [], "archivedProjectIDs": []]
      case "/v2/jobs": return ["jobs": olderJobs + (currentJob.map { [$0] } ?? [])]
      case "/v2/service-status": return ["aiProcessingEnabled": false]
      case "/v2/memory":
        try beforeLearningResponse?(request.path)
        return ["records": memoryRecords]
      case "/v2/teaching":
        try beforeLearningResponse?(request.path)
        return ["groups": teachingGroups]
      case "/v2/account": return ["ownerID": "local-spike", "sourceSeconds": 0]
      default:
        if request.path.hasPrefix("/v2/projects/"), let project = currentProject {
          try beforeProjectDetailResponse?()
          return ["project": project, "sources": [], "revisions": [], "jobs": olderJobs + (currentJob.map { [$0] } ?? [])]
        }
      }
    }
    throw NSError(domain: "Unexpected offline request: \(request.method) \(request.path)", code: 1)
  }
  func posts(ending suffix: String) -> [CapturedRequest] {
    requests(method: "POST", ending: suffix)
  }
  func requests(method: String, ending suffix: String) -> [CapturedRequest] {
    lock.lock(); defer { lock.unlock() }
    return captured.filter { $0.method == method && $0.path.hasSuffix(suffix) }
  }
  var uuidContractFailures: [String] {
    lock.lock(); defer { lock.unlock() }
    return invalidIdentifiers
  }
}

@MainActor
private final class Fixture {
  let documents: URL
  let server = OfflineServer()
  let session: URLSession
  let auth = AuthenticationModel()
  let editor: EditorModel
  var app: ApplicationModel
  let projectID = UUID().uuidString.lowercased()
  let revisionID = UUID().uuidString.lowercased()
  var stateFile: URL { documents.appendingPathComponent("PBJApplication/state.json") }
  init() throws {
    documents = FileManager.default.temporaryDirectory.appendingPathComponent("PBJ-lifecycle-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: documents, withIntermediateDirectories: true)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [OfflineProtocol.self]
    session = URLSession(configuration: configuration)
    let api = AppAPI(session: session); api.baseURL = URL(string: "https://pbj-offline.invalid")!
    app = ApplicationModel(api: api, documents: documents)
    editor = EditorModel(root: documents.appendingPathComponent(projectID),
      document: ProjectDocument(title: "Fixture", timeline: Timeline(id: revisionID, clips: [])))
    OfflineProtocol.lock.lock(); OfflineProtocol.responder = server.respond; OfflineProtocol.lock.unlock()
  }
  func activate() async { await app.activate(auth: auth, editor: editor) }
  func relaunch() async {
    let api = AppAPI(session: session); api.baseURL = URL(string: "https://pbj-offline.invalid")!
    app = ApplicationModel(api: api, documents: documents)
    await activate()
  }
  func cleanup() {
    XCTAssertEqual(server.uuidContractFailures, [], "A request would fail the real backend UUID schema")
    session.invalidateAndCancel()
    OfflineProtocol.lock.lock(); OfflineProtocol.responder = nil; OfflineProtocol.lock.unlock()
    try? FileManager.default.removeItem(at: documents)
  }
  func setRevisionContext() {
    let project = ServerProject(id: projectID, title: "Fixture", brief: "Flight", status: "review", currentRevisionId: revisionID)
    app.detail = ServerProjectDetail(project: project, sources: [], revisions: [], jobs: [])
    app.state.syncedLocalRevisions = [projectID: editor.timeline.id]
    app.state.syncedRevisions = [projectID: revisionID]
    app.route = .review
    XCTAssertTrue(app.save())
  }
}

final class ApplicationLifecycleTests: XCTestCase {
  @MainActor
  func testLearningChangesRefreshEffectiveStateDuringTheSameBusyOperation() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    let groupID = UUID().uuidString.lowercased()
    let personal: [String: Any] = [
      "id": "personal-rule", "kind": "personal_lesson", "context": "Golf follow-through",
      "statement": "Preserve the full follow-through.", "attribution": "Your kept edits", "enabled": true,
      "strength": "weak", "effectiveStrength": "moderate", "supportCount": 2, "status": "active",
      "project_scope": fixture.projectID,
      "learning": ["facet": "setup_payoff", "formats": ["short_form"], "subjects": ["golf"]]
    ]
    // Existing saved entries predate every optional effective-policy field.
    let legacy: [String: Any] = [
      "id": "legacy-reference", "kind": "reference", "context": "Pacing", "statement": "Brisk changes of view.",
      "attribution": "Your reference", "enabled": true
    ]
    let group: [String: Any] = ["id": groupID, "attribution": "Your reference", "notes": "Pacing only",
      "final_asset_id": UUID().uuidString.lowercased(), "raw_asset_ids": [], "enabled": true, "excluded": false]
    fixture.server.memoryRecords = [personal, legacy]
    fixture.server.teachingGroups = [group]
    await fixture.app.loadMemory()
    XCTAssertNil(fixture.app.error)
    let decoded = try XCTUnwrap(fixture.app.memory.first)
    XCTAssertEqual(decoded.effectiveStrength, "moderate")
    XCTAssertEqual(decoded.supportCount, 2)
    XCTAssertEqual(decoded.status, "active")
    XCTAssertEqual(decoded.projectScope, fixture.projectID)
    XCTAssertEqual(decoded.learning?.formats, ["short_form"])
    XCTAssertEqual(decoded.learning?.subjects, ["golf"])
    let old = try XCTUnwrap(fixture.app.memory.last)
    XCTAssertNil(old.strength)
    XCTAssertNil(old.effectiveStrength)
    XCTAssertNil(old.supportCount)
    XCTAssertNil(old.status)
    XCTAssertNil(old.learning)

    var disabled = personal
    disabled["enabled"] = false; disabled["status"] = "disabled"
    disabled["effectiveStrength"] = "weak"; disabled["supportCount"] = 0
    fixture.server.memoryRecords = [disabled, legacy]
    let toggleRead = expectation(description: "Toggle refresh reads teaching before finishing")
    let releaseToggle = DispatchSemaphore(value: 0)
    fixture.server.beforeLearningResponse = { path in
      guard path == "/v2/teaching" else { return }
      toggleRead.fulfill()
      guard releaseToggle.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
    }
    let toggling = Task { await fixture.app.toggleMemory(decoded) }
    await fulfillment(of: [toggleRead], timeout: 3)
    XCTAssertTrue(fixture.app.busy)
    XCTAssertEqual(fixture.app.stage, "Updating learning")
    releaseToggle.signal()
    await toggling.value
    XCTAssertNil(fixture.app.error)
    XCTAssertFalse(fixture.app.busy)
    XCTAssertEqual(fixture.app.memory.first?.enabled, false)
    XCTAssertEqual(fixture.app.memory.first?.status, "disabled")
    XCTAssertEqual(fixture.app.memory.first?.effectiveStrength, "weak")
    XCTAssertEqual(fixture.app.memory.first?.supportCount, 0)
    XCTAssertEqual(fixture.server.requests(method: "PATCH", ending: "/memory/personal-rule").last?.body["enabled"] as? Bool, false)

    var excluded = legacy
    excluded["effectiveStrength"] = "weak"; excluded["supportCount"] = 0; excluded["status"] = "excluded"
    var excludedGroup = group; excludedGroup["excluded"] = true
    fixture.server.memoryRecords = [disabled, excluded]
    fixture.server.teachingGroups = [excludedGroup]
    let excludingGroup = try XCTUnwrap(fixture.app.groups.first)
    let exclusionRead = expectation(description: "Exclusion refresh reads teaching before finishing")
    let releaseExclusion = DispatchSemaphore(value: 0)
    fixture.server.beforeLearningResponse = { path in
      guard path == "/v2/teaching" else { return }
      exclusionRead.fulfill()
      guard releaseExclusion.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
    }
    let excluding = Task { await fixture.app.excludeGroup(excludingGroup, excluded: true) }
    await fulfillment(of: [exclusionRead], timeout: 3)
    XCTAssertTrue(fixture.app.busy)
    XCTAssertEqual(fixture.app.stage, "Updating reference")
    releaseExclusion.signal()
    await excluding.value
    XCTAssertNil(fixture.app.error)
    XCTAssertFalse(fixture.app.busy)
    XCTAssertEqual(fixture.app.memory.last?.status, "excluded")
    XCTAssertEqual(fixture.app.groups.first?.excluded, true)
    let exclusion = try XCTUnwrap(fixture.server.posts(ending: "/exclusions").last)
    XCTAssertEqual(exclusion.body["evidenceID"] as? String, groupID)
    XCTAssertEqual(exclusion.body["excluded"] as? Bool, true)
    XCTAssertEqual(fixture.server.requests(method: "GET", ending: "/memory").count, 3)
    XCTAssertEqual(fixture.server.requests(method: "GET", ending: "/teaching").count, 3)
  }

  @MainActor
  func testRevisionRetryAndRelaunchKeepIdentityButNewIntentChangesIt() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate(); fixture.setRevisionContext()
    await fixture.app.revise("Shorter setup", editor: fixture.editor, scoped: false)
    XCTAssertNotNil(fixture.app.error)
    await fixture.app.revise("Shorter setup", editor: fixture.editor, scoped: false)
    await fixture.relaunch(); fixture.setRevisionContext()
    await fixture.app.revise("Shorter setup", editor: fixture.editor, scoped: false)
    let retried = fixture.server.posts(ending: "/revise")
    XCTAssertEqual(retried.count, 3)
    let originalID = retried[0].body["id"] as? String
    XCTAssertNotNil(originalID)
    XCTAssertTrue(retried.allSatisfy { $0.body["id"] as? String == originalID })
    await fixture.app.revise("Longer setup", editor: fixture.editor, scoped: false)
    XCTAssertEqual(fixture.server.posts(ending: "/revise").count, 3, "Changing text never implicitly discards the pending request")
    XCTAssertEqual(fixture.app.state.pendingRevision?.request?.id, originalID)
    XCTAssertTrue(fixture.app.discardPendingRevision())
    await fixture.app.revise("Longer setup", editor: fixture.editor, scoped: false)
    let instructionID = fixture.server.posts(ending: "/revise").last!.body["id"] as? String
    XCTAssertNotEqual(instructionID, originalID)
    XCTAssertTrue(fixture.app.discardPendingRevision())
    fixture.app.state.syncedRevisions[fixture.projectID] = UUID().uuidString.lowercased()
    await fixture.app.revise("Shorter setup", editor: fixture.editor, scoped: false)
    let baseID = fixture.server.posts(ending: "/revise").last!.body["id"] as? String
    XCTAssertNotEqual(baseID, originalID)
    XCTAssertTrue(fixture.app.discardPendingRevision())
    fixture.app.state.syncedRevisions[fixture.projectID] = fixture.revisionID
    fixture.editor.selectedID = UUID().uuidString.lowercased()
    await fixture.app.revise("Shorter setup", editor: fixture.editor, scoped: true)
    let scoped = fixture.server.posts(ending: "/revise").last!
    XCTAssertNotEqual(scoped.body["id"] as? String, originalID)
    XCTAssertEqual(scoped.body["scopeClipIDs"] as? [String], [fixture.editor.selectedID!])
  }

  @MainActor
  func testInterruptedGenerationPersistsExactSubmissionThenHandsOffDraft() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    let source = MediaSource(fileName: "fixture.mov", sha256: String(repeating: "a", count: 64), duration: 600000, hasAudio: false)
    let remoteID = UUID().uuidString.lowercased()
    fixture.app.state.footage = [.init(source: source, localPath: fixture.documents.appendingPathComponent("original.mov").path, remoteID: remoteID)]
    fixture.app.state.title = "Saved golf request"
    fixture.app.state.brief = "Three swings"
    fixture.app.state.duration = 24
    fixture.app.state.ingredients = ["Fast-paced"]
    fixture.app.route = .recipe
    await fixture.app.generate()
    XCTAssertNotNil(fixture.app.error)
    let first = try XCTUnwrap(fixture.server.posts(ending: "/projects").first)
    let pending = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: fixture.stateFile))
    XCTAssertEqual(pending.pendingSubmission?.id, first.body["id"] as? String)
    XCTAssertEqual(pending.pendingSubmission?.assetIDs, [remoteID])
    XCTAssertEqual(pending.pendingSubmission?.brief, "Three swings\nOptional treatment: Fast-paced")
    XCTAssertEqual(pending.pendingSubmission?.durationGoal.seconds, 24)
    XCTAssertEqual(pending.footage.count, 1)
    await fixture.relaunch()
    // A changed visible draft must not change an already-issued request.
    fixture.app.state.title = "Different visible title"
    fixture.app.state.brief = "Different visible instructions"
    fixture.app.state.duration = 60
    fixture.app.route = .recipe
    fixture.server.failMutation = false
    await fixture.app.generate()
    let second = try XCTUnwrap(fixture.server.posts(ending: "/projects").last)
    XCTAssertEqual(first.body as NSDictionary, second.body as NSDictionary)
    let completed = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: fixture.stateFile))
    XCTAssertNil(completed.pendingSubmission)
    XCTAssertNil(completed.pendingProjectID)
    XCTAssertEqual(completed.watchingProjectID, first.body["id"] as? String)
    XCTAssertTrue(completed.footage.isEmpty)
    XCTAssertEqual(completed.brief, "")
    XCTAssertEqual(fixture.app.route, .cooking)
  }

  @MainActor
  func testApprovalAndRestoreRetainRequestIdentityAfterLostResponses() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate(); fixture.setRevisionContext()
    let previous = ServerRevision(id: UUID().uuidString.lowercased(), timeline: fixture.editor.timeline,
      origin: "initial", summary: "Saved version", accepted: true)
    for _ in 0..<2 {
      await fixture.app.approve(editor: fixture.editor)
      XCTAssertNotNil(fixture.app.error)
      await fixture.app.restore(previous, editor: fixture.editor)
      XCTAssertNotNil(fixture.app.error)
    }
    await fixture.relaunch(); fixture.setRevisionContext()
    await fixture.app.approve(editor: fixture.editor)
    await fixture.app.restore(previous, editor: fixture.editor)
    for action in ["/approve", "/restore"] {
      let requests = fixture.server.posts(ending: action)
      XCTAssertEqual(requests.count, 3)
      let first = try XCTUnwrap(requests.first)
      XCTAssertTrue(requests.allSatisfy { $0.body as NSDictionary == first.body as NSDictionary })
      XCTAssertNotNil(UUID(uuidString: try XCTUnwrap(first.body["id"] as? String)))
    }
    XCTAssertNotEqual(fixture.server.posts(ending: "/approve").first?.body["id"] as? String,
      fixture.server.posts(ending: "/restore").first?.body["id"] as? String)
  }

  @MainActor
  func testFailedPlanDoesNotExposeOlderRevisionAsNewResult() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    fixture.server.currentProject = ["id": fixture.projectID, "title": "Fixture", "brief": "Flight", "status": "review", "currentRevisionId": fixture.revisionID]
    let jobID = UUID().uuidString.lowercased()
    fixture.server.currentJob = ["id": jobID, "kind": "plan", "status": "attention", "stage": "Choosing the cut", "payload": ["projectID": fixture.projectID]]
    fixture.app.state.watchingProjectID = fixture.projectID
    fixture.app.route = .cooking
    await fixture.app.refresh()
    XCTAssertEqual(fixture.app.route, .cooking)
    fixture.server.currentJob?["status"] = "complete"
    await fixture.app.refresh()
    XCTAssertEqual(fixture.app.route, .review)
  }

  @MainActor
  func testOlderFailedPlanDoesNotHideANewerCompletedCut() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    fixture.server.currentProject = ["id": fixture.projectID, "title": "Fixture", "brief": "Flight", "status": "review", "currentRevisionId": fixture.revisionID]
    fixture.server.olderJobs = [["id": UUID().uuidString.lowercased(), "kind": "plan", "status": "attention", "stage": "Choosing the cut", "payload": ["projectID": fixture.projectID]]]
    fixture.server.currentJob = ["id": UUID().uuidString.lowercased(), "kind": "plan", "status": "queued", "stage": "Waiting", "payload": ["projectID": fixture.projectID]]
    fixture.app.state.watchingProjectID = fixture.projectID
    fixture.app.route = .cooking
    await fixture.app.refresh()
    XCTAssertEqual(fixture.app.route, .cooking)
    fixture.server.currentJob?["status"] = "complete"
    await fixture.app.refresh()
    XCTAssertEqual(fixture.app.route, .review)
    XCTAssertEqual(fixture.app.detail?.jobs.first?.status, "attention")
    XCTAssertEqual(fixture.app.detail?.jobs.last?.status, "complete")
  }

  @MainActor
  func testSuccessfulProjectResponseWithFailedLocalSaveRetainsRetryReceipt() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    let source = MediaSource(fileName: "fixture.mov", sha256: String(repeating: "b", count: 64), duration: 600000, hasAudio: false)
    fixture.app.state.footage = [.init(source: source, localPath: fixture.documents.appendingPathComponent("original.mov").path, remoteID: UUID().uuidString.lowercased())]
    fixture.app.state.title = "Keep this draft"
    fixture.app.state.brief = "Keep the complete swing"
    fixture.app.route = .recipe
    let stateFile = fixture.stateFile
    let backup = fixture.documents.appendingPathComponent("pending-state-backup.json")
    fixture.server.failMutation = false
    fixture.server.beforeProjectResponse = {
      // The server accepted the POST. Block only the subsequent local save,
      // retaining the last durable receipt entirely within this test directory.
      try FileManager.default.moveItem(at: stateFile, to: backup)
      try FileManager.default.createDirectory(at: stateFile, withIntermediateDirectories: false)
    }
    await fixture.app.generate()
    XCTAssertNotNil(fixture.app.error)
    XCTAssertTrue(fixture.app.unsavedState)
    XCTAssertEqual(fixture.app.route, .recipe)
    let first = try XCTUnwrap(fixture.server.posts(ending: "/projects").first)
    let beforeFailure = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: backup))
    XCTAssertEqual(fixture.app.state.pendingSubmission?.id, first.body["id"] as? String)
    XCTAssertEqual(fixture.app.state.pendingProjectID, beforeFailure.pendingProjectID)
    XCTAssertEqual(fixture.app.state.watchingProjectID, beforeFailure.watchingProjectID)
    XCTAssertEqual(fixture.app.state.footage.map(\.id), beforeFailure.footage.map(\.id))
    XCTAssertEqual(fixture.app.state.brief, "Keep the complete swing")
    XCTAssertEqual(fixture.app.state.title, "Keep this draft")
    try FileManager.default.removeItem(at: stateFile)
    try FileManager.default.moveItem(at: backup, to: stateFile)
    await fixture.app.generate()
    let requests = fixture.server.posts(ending: "/projects")
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(first.body as NSDictionary, requests.last!.body as NSDictionary)
    XCTAssertFalse(fixture.app.unsavedState)
    XCTAssertNil(fixture.app.error)
    let completed = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: stateFile))
    XCTAssertNil(completed.pendingSubmission)
    XCTAssertNil(completed.pendingProjectID)
    XCTAssertTrue(completed.footage.isEmpty)
    XCTAssertEqual(completed.watchingProjectID, first.body["id"] as? String)
    XCTAssertEqual(fixture.app.route, .cooking)
  }

  @MainActor
  func testUnchangedRefreshDoesNotRewriteDurableState() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    XCTAssertTrue(fixture.app.save())
    let marker = Date(timeIntervalSince1970: 1000)
    try FileManager.default.setAttributes([.modificationDate: marker], ofItemAtPath: fixture.stateFile.path)
    let before = try Data(contentsOf: fixture.stateFile)
    for _ in 0..<2 {
      await fixture.app.refresh()
      await fixture.app.flushPending(editor: fixture.editor)
    }
    let afterDate = try FileManager.default.attributesOfItem(atPath: fixture.stateFile.path)[.modificationDate] as? Date
    XCTAssertEqual(afterDate, marker)
    XCTAssertEqual(try Data(contentsOf: fixture.stateFile), before)
  }

  @MainActor
  func testEmptyQueueFlushRecoversUnsavedStateAfterStorageReturns() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    let backup = fixture.documents.appendingPathComponent("state-before-storage-failure.json")
    try FileManager.default.moveItem(at: fixture.stateFile, to: backup)
    try FileManager.default.createDirectory(at: fixture.stateFile, withIntermediateDirectories: false)
    fixture.app.state.brief = "Preserve this unsaved recipe"
    XCTAssertFalse(fixture.app.save())
    XCTAssertTrue(fixture.app.unsavedState)
    XCTAssertFalse(fixture.app.canSignOut)
    try FileManager.default.removeItem(at: fixture.stateFile)
    try FileManager.default.moveItem(at: backup, to: fixture.stateFile)
    await fixture.app.flushPending(editor: fixture.editor)
    XCTAssertFalse(fixture.app.unsavedState)
    XCTAssertTrue(fixture.app.canSignOut)
    let saved = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: fixture.stateFile))
    XCTAssertEqual(saved.brief, "Preserve this unsaved recipe")
  }

  @MainActor
  func testManualSnapshotSyncUsesBackendValidStableIDAcrossRetry() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate(); fixture.setRevisionContext()
    fixture.server.currentProject = ["id": fixture.projectID, "title": "Fixture", "brief": "Flight", "status": "review", "currentRevisionId": fixture.revisionID]
    let source = MediaSource(fileName: "fixture.mov", sha256: String(repeating: "c", count: 64), duration: 600000, hasAudio: false)
    let remoteAssetID = UUID().uuidString.lowercased()
    let localRevisionID = UUID().uuidString.lowercased()
    let timeline = Timeline(id: localRevisionID, parentID: fixture.revisionID,
      clips: [.init(sourceID: source.id, sourceDuration: 180000)])
    fixture.editor.document = ProjectDocument(title: "Manual edit", sources: [source], timeline: timeline)
    fixture.editor.sourceURLs = [source.id: fixture.documents.appendingPathComponent("original.mov")]
    fixture.app.state.assetIDsByHash = [source.sha256: remoteAssetID]
    for _ in 0..<2 {
      await fixture.app.revise("Keep this opening", editor: fixture.editor, scoped: false)
      XCTAssertNotNil(fixture.app.error)
    }
    let failed = fixture.server.posts(ending: "/revisions")
    XCTAssertEqual(failed.count, 2)
    let first = try XCTUnwrap(failed.first)
    XCTAssertEqual(first.body as NSDictionary, failed.last!.body as NSDictionary)
    let savedTimeline = try XCTUnwrap(first.body["timeline"] as? [String: Any])
    let savedID = try XCTUnwrap(savedTimeline["id"] as? String)
    XCTAssertEqual((savedTimeline["clips"] as? [[String: Any]])?.first?["sourceID"] as? String, remoteAssetID)
    XCTAssertEqual(first.body["baseRevisionID"] as? String, fixture.revisionID)
    XCTAssertTrue(fixture.server.posts(ending: "/revise").isEmpty)
    fixture.server.failMutation = false
    await fixture.app.revise("Keep this opening", editor: fixture.editor, scoped: false)
    XCTAssertNil(fixture.app.error)
    let completed = fixture.server.posts(ending: "/revisions")
    XCTAssertEqual(completed.count, 3)
    XCTAssertEqual(first.body as NSDictionary, completed.last!.body as NSDictionary)
    XCTAssertEqual(fixture.app.state.syncedRevisions[fixture.projectID], savedID)
    XCTAssertEqual(fixture.app.state.syncedLocalRevisions?[fixture.projectID], localRevisionID)
    XCTAssertEqual(fixture.server.posts(ending: "/revise").last?.body["baseRevisionID"] as? String, savedID)
    XCTAssertEqual(fixture.app.route, .cooking)
  }
  @MainActor
  func testNotificationFromAnotherOwnerCannotChangeTheCurrentProjectOrConsumeItsDestination() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate(); fixture.setRevisionContext()
    let notices = CompletionNotifications.shared
    let foreign = CompletionNotice(id: "foreign-account-export", title: "Ready", body: "Open",
      destination: .init(ownerID: "another-owner", projectID: "another-project", exportID: "another-export"))
    notices.open(foreign)
    await fixture.app.openCompletion(foreign, editor: fixture.editor)
    XCTAssertEqual(fixture.app.projectID, fixture.projectID)
    XCTAssertEqual(fixture.app.route, .review)
    XCTAssertNil(fixture.app.openedExportID)
    XCTAssertNil(fixture.app.error)
    XCTAssertEqual(notices.pendingOpen, foreign)
    notices.opened()
  }

  @MainActor
  func testDraftImportCompletionOpensItsNewDraftInsteadOfAnOlderWatchedProject() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    let source = MediaSource(fileName: "new.mov", sha256: String(repeating: "d", count: 64), duration: 600000, hasAudio: false)
    fixture.app.state.footage = [.init(source: source, localPath: fixture.documents.appendingPathComponent("new.mov").path)]
    fixture.app.state.watchingProjectID = fixture.projectID
    fixture.app.route = .home
    let notice = CompletionNotice(id: "new-draft-import", title: "Media ready", body: "Continue",
      destination: .init(ownerID: "local-spike", screen: "draft"))
    await fixture.app.openCompletion(notice, editor: fixture.editor)
    XCTAssertEqual(fixture.app.route, .recipe)
    XCTAssertNil(fixture.app.error, "Opening a local draft must not try fetching an older remote project")
    XCTAssertNil(fixture.app.detail)
  }

  @MainActor
  func testTeachingImportCompletionReopensTheUnsubmittedTeachingDraft() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    fixture.app.state.teaching = TeachingDraft(finals: [fixture.documents.appendingPathComponent("reference.mov").path])
    XCTAssertFalse(fixture.app.hasPendingTeaching)
    fixture.app.route = .home
    let notice = CompletionNotice(id: "teaching-import", title: "Media ready", body: "Continue",
      destination: .init(ownerID: "local-spike", screen: "teaching"))
    await fixture.app.openCompletion(notice, editor: fixture.editor)
    XCTAssertEqual(fixture.app.route, .teachIt)
    XCTAssertNil(fixture.app.error)
  }

  @MainActor
  func testCancelledOlderNotificationCannotConsumeTheNewerPendingDestination() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate()
    fixture.server.currentProject = ["id": fixture.projectID, "title": "Fixture", "brief": "Flight", "status": "queued"]
    let started = expectation(description: "Older destination is loading")
    let release = DispatchSemaphore(value: 0)
    fixture.server.beforeProjectDetailResponse = {
      started.fulfill()
      guard release.wait(timeout: .now() + 5) == .success else { throw URLError(.timedOut) }
    }
    let notices = CompletionNotifications.shared
    defer { notices.opened() }
    let older = CompletionNotice(id: "older-notice", title: "Cut ready", body: "Open",
      destination: .init(ownerID: "local-spike", projectID: fixture.projectID))
    let newer = CompletionNotice(id: "newer-notice", title: "Media ready", body: "Open",
      destination: .init(ownerID: "local-spike", screen: "draft"))
    notices.open(older)
    let opening = Task { await fixture.app.openCompletion(older, editor: fixture.editor) }
    await fulfillment(of: [started], timeout: 1)
    notices.open(newer)
    opening.cancel() // SwiftUI cancels the previous .task when pendingOpen.id changes.
    release.signal()
    await opening.value
    XCTAssertEqual(notices.pendingOpen, newer)
  }

  @MainActor
  func testPendingRevisionRelaunchRetriesExactSubmittedRequestWithoutSyncingANewerEdit() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate(); fixture.setRevisionContext()
    fixture.editor.selectedID = UUID().uuidString.lowercased()
    await fixture.app.revise("Keep this complete swing", editor: fixture.editor, scoped: true)
    let first = try XCTUnwrap(fixture.server.posts(ending: "/revise").first)
    let saved = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: fixture.stateFile))
    XCTAssertEqual(saved.pendingRevision?.request?.id, first.body["id"] as? String)
    XCTAssertEqual(saved.pendingRevision?.localRevisionID, fixture.revisionID)
    await fixture.relaunch()
    fixture.editor.document = ProjectDocument(title: "Newer local edit", timeline: Timeline(id: UUID().uuidString.lowercased(), clips: []))
    fixture.editor.selectedID = UUID().uuidString.lowercased()
    fixture.app.state.syncedRevisions[fixture.projectID] = UUID().uuidString.lowercased()
    fixture.server.failMutation = false
    await fixture.app.resumePendingWork() // Final request needs neither a reopened editor nor new sync.
    XCTAssertNil(fixture.app.error)
    let retried = try XCTUnwrap(fixture.server.posts(ending: "/revise").last)
    XCTAssertEqual(first.body as NSDictionary, retried.body as NSDictionary)
    XCTAssertTrue(fixture.server.posts(ending: "/revisions").isEmpty)
    XCTAssertTrue(fixture.server.posts(ending: "/inputs").isEmpty)
    XCTAssertNil(fixture.app.state.pendingRevision)
    XCTAssertEqual(fixture.app.state.watchingProjectID, fixture.projectID)
  }

  @MainActor
  func testPreSyncRevisionRequiresItsOriginalProjectVersionAndBaseBeforeSending() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate(); fixture.setRevisionContext()
    let original = ProjectDocument(title: "Original local edit", timeline: Timeline(id: UUID().uuidString.lowercased(), clips: []))
    fixture.editor.document = original
    await fixture.app.revise("Preserve the landing", editor: fixture.editor, scoped: false)
    XCTAssertNotNil(fixture.app.error)
    XCTAssertNil(fixture.app.state.pendingRevision?.request)
    XCTAssertEqual(fixture.app.state.pendingRevision?.localRevisionID, original.current.id)
    XCTAssertTrue(fixture.server.posts(ending: "/revise").isEmpty)
    let attemptedSync = try XCTUnwrap(fixture.server.posts(ending: "/revisions").first)
    await fixture.relaunch()
    fixture.app.detail = ServerProjectDetail(project: ServerProject(id: fixture.projectID, title: "Fixture", brief: "Flight", status: "editing", currentRevisionId: fixture.revisionID), sources: [], revisions: [], jobs: [])
    fixture.editor.document = ProjectDocument(title: "Different version", timeline: Timeline(id: UUID().uuidString.lowercased(), clips: []))
    await fixture.app.resumePendingRevision(editor: fixture.editor)
    XCTAssertTrue(fixture.app.error?.contains("saved version") == true)
    XCTAssertEqual(fixture.server.posts(ending: "/revisions").count, 1)
    fixture.editor.document = original
    fixture.app.state.syncedRevisions[fixture.projectID] = UUID().uuidString.lowercased()
    await fixture.app.resumePendingRevision(editor: fixture.editor)
    XCTAssertTrue(fixture.app.error?.contains("base has changed") == true)
    XCTAssertTrue(fixture.server.posts(ending: "/revise").isEmpty)
    fixture.app.state.syncedRevisions[fixture.projectID] = fixture.revisionID
    fixture.server.currentProject = ["id": fixture.projectID, "title": "Fixture", "brief": "Flight", "status": "editing", "currentRevisionId": fixture.revisionID]
    fixture.server.failMutation = false
    await fixture.app.resumePendingRevision(editor: fixture.editor)
    XCTAssertNil(fixture.app.error)
    XCTAssertEqual(attemptedSync.body as NSDictionary, fixture.server.posts(ending: "/revisions").last!.body as NSDictionary)
    XCTAssertEqual(fixture.server.posts(ending: "/revise").last?.body["instruction"] as? String, "Preserve the landing")
    XCTAssertNil(fixture.app.state.pendingRevision)
  }

  @MainActor
  func testRevisionAcknowledgementWithFailedLocalSaveKeepsItsExactRetryReceipt() async throws {
    let fixture = try Fixture(); defer { fixture.cleanup() }
    await fixture.activate(); fixture.setRevisionContext()
    let backup = fixture.documents.appendingPathComponent("pending-revision-backup.json")
    let stateFile = fixture.stateFile
    fixture.server.failMutation = false
    fixture.server.beforeRevisionResponse = {
      try FileManager.default.moveItem(at: stateFile, to: backup)
      try FileManager.default.createDirectory(at: stateFile, withIntermediateDirectories: false)
    }
    await fixture.app.revise("Keep the last reaction", editor: fixture.editor, scoped: false)
    let first = try XCTUnwrap(fixture.server.posts(ending: "/revise").first)
    XCTAssertTrue(fixture.app.unsavedState)
    XCTAssertEqual(fixture.app.state.pendingRevision?.request?.id, first.body["id"] as? String)
    XCTAssertNil(fixture.app.state.watchingProjectID)
    try FileManager.default.removeItem(at: stateFile)
    try FileManager.default.moveItem(at: backup, to: stateFile)
    await fixture.app.resumePendingRevision()
    XCTAssertNil(fixture.app.error); XCTAssertFalse(fixture.app.unsavedState)
    XCTAssertEqual(first.body as NSDictionary, fixture.server.posts(ending: "/revise").last!.body as NSDictionary)
    XCTAssertNil(fixture.app.state.pendingRevision)
    XCTAssertEqual(fixture.app.state.watchingProjectID, fixture.projectID)
  }

}
