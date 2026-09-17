import AVFoundation
import Foundation
import XCTest
import PBJCore
@testable import ApplicationHarness

private struct UploadRequest {
  let url: URL
  let method: String
  let data: Data
  var body: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
}
private struct UploadHTTPError: Error { let status: Int; let message: String }

private final class UploadProtocol: URLProtocol {
  static let lock = NSLock()
  static var responder: ((UploadRequest) throws -> [String: Any])?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    do {
      var data = request.httpBody ?? Data()
      if let stream = request.httpBodyStream {
        stream.open(); defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 65536)
        while stream.hasBytesAvailable {
          let count = stream.read(&buffer, maxLength: buffer.count)
          if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
          if count == 0 { break }
          data.append(contentsOf: buffer.prefix(count))
        }
      }
      Self.lock.lock(); let responder = Self.responder; Self.lock.unlock()
      guard let responder else { throw URLError(.notConnectedToInternet) }
      let result = try responder(.init(url: request.url!, method: request.httpMethod ?? "GET", data: data))
      let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try JSONSerialization.data(withJSONObject: result))
      client?.urlProtocolDidFinishLoading(self)
    } catch let error as UploadHTTPError {
      let response = HTTPURLResponse(url: request.url!, statusCode: error.status, httpVersion: nil, headerFields: nil)!
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["error": error.message]))
      client?.urlProtocolDidFinishLoading(self)
    } catch { client?.urlProtocol(self, didFailWithError: error) }
  }
  override func stopLoading() {}
}

private final class PausedUploadProtocol: URLProtocol {
  static let lock = NSLock()
  static var current: PausedUploadProtocol?
  static var started: (() -> Void)?
  override class func canInit(with request: URLRequest) -> Bool { true }
  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
  override func startLoading() {
    Self.lock.lock(); Self.current = self; let started = Self.started; Self.lock.unlock()
    started?()
  }
  override func stopLoading() { Self.lock.withLock { if Self.current === self { Self.current = nil } } }
  static func release() {
    lock.lock(); let pending = current; current = nil; started = nil; lock.unlock()
    if let pending { pending.client?.urlProtocol(pending, didFailWithError: URLError(.cancelled)) }
  }
}

@MainActor
private final class IngestionFixture {
  let directory: URL
  let session: URLSession
  let api: AppAPI
  let auth = AuthenticationModel()
  init() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("PBJ-ingestion-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [UploadProtocol.self]
    session = URLSession(configuration: configuration)
    api = AppAPI(session: session); api.baseURL = URL(string: "https://pbj-ingestion.invalid")!
  }
  func respond(_ block: @escaping (UploadRequest) throws -> [String: Any]) {
    UploadProtocol.lock.lock(); UploadProtocol.responder = block; UploadProtocol.lock.unlock()
  }
  func cleanup() {
    session.invalidateAndCancel()
    UploadProtocol.lock.lock(); UploadProtocol.responder = nil; UploadProtocol.lock.unlock()
    try? FileManager.default.removeItem(at: directory)
  }
  func original(bytes: Int) throws -> (MediaSource, URL) {
    let url = directory.appendingPathComponent("original.mov")
    try Data(repeating: 73, count: bytes).write(to: url)
    return (MediaSource(fileName: "original.mov", sha256: try MediaImport.hash(url), duration: 60000, hasAudio: false), url)
  }
  func video() async throws -> URL {
    let url = directory.appendingPathComponent("reference.mov")
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64])
    let frames = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64])
    writer.add(input)
    guard writer.startWriting() else { throw writer.error ?? URLError(.cannotCreateFile) }
    writer.startSession(atSourceTime: .zero)
    var value: CVPixelBuffer?
    guard CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(frames.pixelBufferPool), &value) == kCVReturnSuccess else { throw URLError(.cannotCreateFile) }
    let pixel = try XCTUnwrap(value)
    CVPixelBufferLockBaseAddress(pixel, []); memset(CVPixelBufferGetBaseAddress(pixel), 0, CVPixelBufferGetDataSize(pixel)); CVPixelBufferUnlockBaseAddress(pixel, [])
    let deadline = Date().addingTimeInterval(5)
    for frame in 0..<3 {
      while !input.isReadyForMoreMediaData {
        guard writer.status == .writing, Date() < deadline else { writer.cancelWriting(); throw URLError(.timedOut) }
        try await Task.sleep(for: .milliseconds(5))
      }
      XCTAssertTrue(frames.append(pixel, withPresentationTime: CMTime(value: Int64(frame), timescale: 3)))
    }
    writer.endSession(atSourceTime: CMTime(value: 1, timescale: 1)); input.markAsFinished()
    await writer.finishWriting()
    guard writer.status == .completed else { throw writer.error ?? URLError(.cannotCreateFile) }
    return url
  }
}

final class ApplicationIngestionTests: XCTestCase {
  func testLegacyTeachingDraftWithoutMetadataSurvivesDocumentContainerMigration() throws {
    let oldPath = "/var/mobile/Containers/Data/Application/5E3B2A24-42A7-4502-BDE6-8EC83819A4FD/Documents/PBJApplication/teaching-draft/group/reference.mov"
    let legacy = try JSONSerialization.data(withJSONObject: ["finals": [oldPath], "raw": [], "attribution": "My work", "notes": "Pacing", "groupIDs": [oldPath: "saved-group"]])
    var state = ApplicationState(); state.teaching = try JSONDecoder().decode(TeachingDraft.self, from: legacy)
    XCTAssertNil(state.teaching?.sourcesByPath)
    let documents = URL(fileURLWithPath: "/var/mobile/Containers/Data/Application/00000000-0000-4000-8000-000000000001/Documents")
    let migrated = try state.mappingMediaPaths { try DocumentMediaPath.resolved($0, documents: documents) }
    let expected = documents.appendingPathComponent("PBJApplication/teaching-draft/group/reference.mov").path
    XCTAssertEqual(migrated.teaching?.finals, [expected])
    XCTAssertEqual(migrated.teaching?.groupIDs[expected], "saved-group")
    XCTAssertNil(migrated.teaching?.sourcesByPath)
  }

  @MainActor
  func testChangedOriginalCannotReuseAnOlderServerAssetUnderTheSamePath() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let (source, url) = try f.original(bytes: 1024)
    try Data(repeating: 92, count: 1024).write(to: url, options: .atomic)
    var requests = 0
    f.respond { _ in requests += 1; return ["id": "old-asset", "assetID": "old-asset", "receivedBytes": 1024, "status": "complete"] }
    do { _ = try await f.api.upload(source, url: url) { _, _ in }; XCTFail("Changed local bytes reused the stale original hash") }
    catch { XCTAssertTrue(error.localizedDescription.contains("changed since it was imported")) }
    XCTAssertEqual(requests, 0, "Identity is checked before sending the stale hash to the service")
  }

  @MainActor
  func testAlreadyCancelledTransferDoesNotCreateAChunkOrReadAnOriginal() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let directory = f.directory.appendingPathComponent("chunks")
    let transfer = BackgroundTransfer(directory: directory, configuration: .ephemeral)
    let request = URLRequest(url: URL(string: "https://pbj-cancelled.invalid/chunk")!)
    let task = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      do { _ = try MediaImport.hash(f.directory.appendingPathComponent("not-present.mov")); XCTFail("Cancelled hash proceeded") }
      catch { XCTAssertTrue(error is CancellationError) }
      do { _ = try await transfer.upload(request, chunk: Data([1])); XCTFail("Cancelled transfer proceeded") }
      catch { XCTAssertTrue(error is CancellationError) }
    }
    await task.value
    XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
  }

  @MainActor
  func testCancellingBackgroundUploadReleasesItsWaitAndTemporaryChunk() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let directory = f.directory.appendingPathComponent("chunks")
    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [PausedUploadProtocol.self]
    let transfer = BackgroundTransfer(directory: directory, configuration: configuration)
    let started = expectation(description: "Background chunk started")
    let cancelled = expectation(description: "Cancelled caller released")
    PausedUploadProtocol.lock.withLock { PausedUploadProtocol.started = { started.fulfill() } }
    var request = URLRequest(url: URL(string: "https://pbj-paused.invalid/chunk")!); request.httpMethod = "PUT"
    let task = Task {
      do { _ = try await transfer.upload(request, chunk: Data(repeating: 1, count: 1024)); XCTFail("Cancelled upload succeeded") }
      catch { XCTAssertEqual((error as? URLError)?.code, .cancelled) }
      cancelled.fulfill()
    }
    await fulfillment(of: [started], timeout: 3)
    task.cancel()
    await fulfillment(of: [cancelled], timeout: 1)
    PausedUploadProtocol.release() // Also guarantees cleanup when testing the broken implementation.
    await task.value
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [])
  }

  @MainActor
  func testLostCommittedChunkResponseResumesAtAuthoritativeOffsetWithoutReuploadingBytes() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let count = 9 * 1024 * 1024, (source, url) = try f.original(bytes: count)
    var received = 0, offsets: [Int] = [], reservations = 0
    f.respond { request in
      if request.url.path == "/v2/uploads" { reservations += 1; return ["id": "upload", "receivedBytes": received, "status": "receiving"] }
      if request.url.path.hasSuffix("/chunk") {
        let offset = Int(URLComponents(url: request.url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
        XCTAssertEqual(offset, received); offsets.append(offset); received += request.data.count
        if offsets.count == 1 { throw URLError(.networkConnectionLost) }
        return ["id": "upload", "receivedBytes": received, "status": "receiving"]
      }
      XCTAssertEqual(request.url.path, "/v2/uploads/upload/complete")
      XCTAssertEqual(received, count)
      return ["id": "upload", "assetID": "asset", "receivedBytes": received, "status": "complete"]
    }
    var progress: [Int64] = []
    let asset = try await f.api.upload(source, url: url) { sent, total in XCTAssertEqual(total, Int64(count)); progress.append(sent) }
    XCTAssertEqual(asset, "asset"); XCTAssertEqual(reservations, 2)
    XCTAssertEqual(offsets, [0, 4 * 1024 * 1024, 8 * 1024 * 1024])
    XCTAssertEqual(progress.first, 0); XCTAssertEqual(progress.last, Int64(count))
  }

  @MainActor
  func testRelaunchedUploadReportsAlreadyCommittedProgressBeforeSendingItsNextChunk() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let count = 5 * 1024 * 1024, resumed = 4 * 1024 * 1024, (source, url) = try f.original(bytes: count)
    var progress: [Int64] = []
    f.respond { request in
      if request.url.path == "/v2/uploads" { return ["id": "upload", "receivedBytes": resumed, "status": "receiving"] }
      if request.url.path.hasSuffix("/chunk") { return ["id": "upload", "receivedBytes": count, "status": "receiving"] }
      return ["id": "upload", "assetID": "asset", "receivedBytes": count, "status": "complete"]
    }
    _ = try await f.api.upload(source, url: url) { sent, _ in progress.append(sent) }
    XCTAssertEqual(progress.first, Int64(resumed))
  }

  @MainActor
  func testInvalidServerOffsetCannotSkipVerificationAndAppearUploaded() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let (source, url) = try f.original(bytes: 1024)
    var completionRequests = 0
    f.respond { request in
      if request.url.path.hasSuffix("/complete") { completionRequests += 1 }
      return request.url.path == "/v2/uploads"
        ? ["id": "upload", "receivedBytes": 2048, "status": "receiving"]
        : ["id": "upload", "assetID": "asset", "receivedBytes": 1024, "status": "complete"]
    }
    do { _ = try await f.api.upload(source, url: url) { _, _ in }; XCTFail("Out-of-bounds upload receipt was accepted") }
    catch { XCTAssertEqual(completionRequests, 0) }
  }

  @MainActor
  func testRecoveredMacStagingOffsetCanRestartAtZeroAndPersistentFailureIsBounded() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let count = 5 * 1024 * 1024, (source, url) = try f.original(bytes: count)
    var received = 4 * 1024 * 1024, offsets: [Int] = []
    f.respond { request in
      if request.url.path == "/v2/uploads" { return ["id": "upload", "receivedBytes": received, "status": "receiving"] }
      if request.url.path.hasSuffix("/chunk") {
        let offset = Int(URLComponents(url: request.url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
        offsets.append(offset)
        if offsets.count == 1 { received = 0; throw UploadHTTPError(status: 400, message: "Upload offset reset after missing staging bytes") }
        XCTAssertEqual(offset, received); received += request.data.count
        return ["id": "upload", "receivedBytes": received, "status": "receiving"]
      }
      return ["id": "upload", "assetID": "asset", "receivedBytes": count, "status": "complete"]
    }
    _ = try await f.api.upload(source, url: url) { _, _ in }
    XCTAssertEqual(offsets, [4 * 1024 * 1024, 0, 4 * 1024 * 1024])
    var puts = 0
    f.respond { request in
      if request.url.path == "/v2/uploads" { return ["id": "upload", "receivedBytes": 0, "status": "receiving"] }
      puts += 1; throw UploadHTTPError(status: 500, message: "Unavailable")
    }
    do { _ = try await f.api.upload(source, url: url) { _, _ in }; XCTFail("Persistent failure was accepted") }
    catch { XCTAssertEqual(puts, 3, "Stop after the original attempt and two recoveries") }
  }

  @MainActor
  func testLostCompletionReceiptReturnsTheAlreadyVerifiedAssetWithoutAnotherCompletion() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let (source, url) = try f.original(bytes: 1024)
    var completed = false, completionRequests = 0
    f.respond { request in
      if request.url.path.hasSuffix("/complete") { completionRequests += 1; completed = true; throw URLError(.networkConnectionLost) }
      return completed ? ["id": "asset", "assetID": "asset", "receivedBytes": 1024, "status": "complete"]
        : ["id": "upload", "receivedBytes": 1024, "status": "receiving"]
    }
    let asset = try await f.api.upload(source, url: url) { _, _ in }
    XCTAssertEqual(asset, "asset"); XCTAssertEqual(completionRequests, 1)
  }

  @MainActor
  func testTeachingUploadRetriesReuseTheAlreadySavedOriginal() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let app = ApplicationModel(api: f.api, documents: f.directory)
    f.respond { request in
      switch request.url.path {
      case "/v2/projects": return ["projects": []]
      case "/v2/jobs": return ["jobs": []]
      case "/v2/service-status": return ["aiProcessingEnabled": false]
      default: throw URLError(.notConnectedToInternet)
      }
    }
    await app.activate(auth: f.auth, editor: EditorModel(root: f.directory.appendingPathComponent("editor")))
    await app.importTeaching([try await f.video()], final: true)
    XCTAssertNil(app.error)
    let original = try XCTUnwrap(app.state.teaching?.finals.first)
    let originalBytes = try Data(contentsOf: URL(fileURLWithPath: original))
    for _ in 0..<2 {
      await app.teach(finals: [URL(fileURLWithPath: original)], raw: [], attribution: "My work", notes: "Pacing")
      XCTAssertNotNil(app.error)
    }
    let appDirectory = f.directory.appendingPathComponent("PBJApplication")
    let files = FileManager.default.enumerator(at: appDirectory, includingPropertiesForKeys: [.isRegularFileKey])!
      .compactMap { $0 as? URL }.filter { $0.pathExtension == "mov" }
    XCTAssertEqual(files.count, 1, "Retries must not create additional full originals")
    XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: original)), originalBytes)
    XCTAssertEqual(app.state.teaching?.finals, [original])
    let cached = try XCTUnwrap(app.state.teaching?.sourcesByPath?[original])
    let movedDocuments = f.directory.appendingPathComponent("new-container")
    try FileManager.default.createDirectory(at: movedDocuments, withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: appDirectory, to: movedDocuments.appendingPathComponent("PBJApplication"))
    let relaunched = ApplicationModel(api: f.api, documents: movedDocuments)
    await relaunched.activate(auth: f.auth, editor: EditorModel(root: movedDocuments.appendingPathComponent("editor")))
    let movedOriginal = try XCTUnwrap(relaunched.state.teaching?.finals.first)
    XCTAssertTrue(movedOriginal.hasPrefix(movedDocuments.path + "/"))
    XCTAssertEqual(relaunched.state.teaching?.sourcesByPath?[movedOriginal], cached)
  }

  @MainActor
  func testTeachingCleanupWaitsForEveryGroupAndDurableDraftClearing() async throws {
    for failure in ["none", "second-group", "local-save", "shared-copy"] {
      let f = try IngestionFixture(); defer { f.cleanup() }
      let app = ApplicationModel(api: f.api, documents: f.directory)
      let home: (UploadRequest) throws -> [String: Any] = { request in
        switch request.url.path {
        case "/v2/projects": return ["projects": []]
        case "/v2/jobs": return ["jobs": []]
        case "/v2/service-status": return ["aiProcessingEnabled": false]
        default: throw URLError(.notConnectedToInternet)
        }
      }
      f.respond(home)
      await app.activate(auth: f.auth, editor: EditorModel(root: f.directory.appendingPathComponent("editor")))
      let video = try await f.video()
      await app.importTeaching([video, video], final: true)
      XCTAssertNil(app.error)
      let originals = try XCTUnwrap(app.state.teaching?.finals)
      XCTAssertEqual(originals.count, 2)
      if failure == "shared-copy" {
        app.state.originalPathsByHash = ["retained-source": originals[0]]
        XCTAssertTrue(app.save())
      }
      let urls = originals.map { URL(fileURLWithPath: $0) }
      let appDirectory = f.directory.appendingPathComponent("PBJApplication")
      let stateFile = appDirectory.appendingPathComponent("state.json")
      let backup = f.directory.appendingPathComponent("saved-draft.json")
      let legacy = appDirectory.appendingPathComponent("teaching-originals/keep.mov")
      let unrelated = appDirectory.appendingPathComponent("teaching-draft/unrelated/keep.mov")
      for file in [legacy, unrelated] {
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([17]).write(to: file)
      }
      var groupIDs: [String] = [], fail = failure == "second-group" || failure == "local-save"
      f.respond { request in
        if request.url.path == "/v2/uploads" {
          return ["id": "verified-asset", "assetID": "verified-asset", "receivedBytes": request.body["byteCount"]!, "status": "complete"]
        }
        if request.url.path == "/v2/teaching" {
          groupIDs.append(request.body["id"] as! String)
          if groupIDs.count == 2 && fail {
            if failure == "second-group" { throw UploadHTTPError(status: 400, message: "Group not saved") }
            try FileManager.default.moveItem(at: stateFile, to: backup)
            try FileManager.default.createDirectory(at: stateFile, withIntermediateDirectories: false)
          }
          return ["id": UUID().uuidString, "kind": "teach", "status": "queued", "stage": "Saved", "payload": ["groupID": request.body["id"]!]]
        }
        return try home(request)
      }
      await app.teach(finals: urls, raw: [], attribution: "My work", notes: "Pacing")
      if failure == "second-group" || failure == "local-save" {
        XCTAssertNotNil(app.error)
        XCTAssertEqual(app.state.teaching?.finals, originals, "A partial submit or failed local handoff retains its retry draft")
        XCTAssertTrue(originals.allSatisfy { FileManager.default.fileExists(atPath: $0) })
        if failure == "local-save" {
          try FileManager.default.removeItem(at: stateFile)
          try FileManager.default.moveItem(at: backup, to: stateFile)
        }
        fail = false
        await app.teach(finals: urls, raw: [], attribution: "My work", notes: "Pacing")
        XCTAssertEqual(Array(groupIDs.prefix(2)), Array(groupIDs.suffix(2)), "Retry preserves each previously submitted group identity")
      }
      XCTAssertNil(app.error); XCTAssertNil(app.state.teaching)
      let saved = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: stateFile))
      XCTAssertNil(saved.teaching)
      for (index, original) in originals.enumerated() {
        XCTAssertEqual(FileManager.default.fileExists(atPath: original), failure == "shared-copy" && index == 0,
          "Only the submitted, now unreferenced draft originals are removed")
      }
      XCTAssertTrue(FileManager.default.fileExists(atPath: video.path), "The selected original remains untouched")
      XCTAssertEqual(try Data(contentsOf: legacy), Data([17]))
      XCTAssertEqual(try Data(contentsOf: unrelated), Data([17]))
    }
  }
  @MainActor
  func testCancelledUploadStopsBeforeNextChunkAndRetryUsesCommittedOffset() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let count = 5 * 1024 * 1024, (source, url) = try f.original(bytes: count)
    var received = 0, offsets: [Int] = [], completions = 0, modeChecks = 0
    f.api.usesContinuedExecution = { modeChecks += 1; return true }
    f.respond { request in
      if request.url.path == "/v2/uploads" { return ["id": "upload", "receivedBytes": received, "status": "receiving"] }
      if request.url.path.hasSuffix("/chunk") {
        let offset = Int(URLComponents(url: request.url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
        XCTAssertEqual(offset, received); offsets.append(offset); received += request.data.count
        return ["id": "upload", "receivedBytes": received, "status": "receiving"]
      }
      completions += 1
      return ["id": "upload", "assetID": "asset", "receivedBytes": count, "status": "complete"]
    }
    let interrupted = Task {
      do {
        _ = try await f.api.upload(source, url: url) { sent, _ in
          if sent == 4 * 1024 * 1024 { withUnsafeCurrentTask { $0?.cancel() } }
        }
        XCTFail("Cancelled upload continued")
      } catch { XCTAssertTrue(error is CancellationError) }
    }
    await interrupted.value
    XCTAssertEqual(offsets, [0]); XCTAssertEqual(completions, 0)
    let asset = try await f.api.upload(source, url: url) { _, _ in }
    XCTAssertEqual(asset, "asset")
    XCTAssertEqual(offsets, [0, 4 * 1024 * 1024]); XCTAssertEqual(completions, 1)
    XCTAssertEqual(modeChecks, 2, "Transport mode is checked anew for each chunk")
  }

  @MainActor
  func testStartedGenerationSurvivesUploadInterruptionAndContainerMoveWithFrozenIntent() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let home: (UploadRequest) throws -> [String: Any] = { request in
      switch request.url.path {
      case "/v2/projects": return ["projects": []]
      case "/v2/jobs": return ["jobs": []]
      case "/v2/service-status": return ["aiProcessingEnabled": false]
      default: throw URLError(.notConnectedToInternet)
      }
    }
    f.respond(home)
    let app = ApplicationModel(api: f.api, documents: f.directory)
    await app.activate(auth: f.auth, editor: EditorModel(root: f.directory.appendingPathComponent("editor")))
    let (source, original) = try f.original(bytes: 1024)
    let owned = f.directory.appendingPathComponent("PBJApplication/originals/original.mov")
    try FileManager.default.createDirectory(at: owned.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: original, to: owned)
    app.state.footage = [.init(source: source, localPath: owned.path)]
    app.state.title = "My original request"; app.state.brief = "Keep the whole swing"
    app.state.duration = 24; app.state.ingredients = ["Fast-paced"]
    XCTAssertTrue(app.save())
    var reservations = 0
    f.respond { request in
      if request.url.path == "/v2/uploads" { reservations += 1; throw URLError(.cancelled) }
      return try home(request)
    }
    await app.generate()
    let started = try XCTUnwrap(app.state.pendingGeneration)
    XCTAssertEqual(app.state.pendingProjectID, started.id)
    XCTAssertNil(app.state.pendingSubmission, "No project POST is ready before its originals upload")
    let saved = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: f.directory.appendingPathComponent("PBJApplication/state.json")))
    XCTAssertEqual(saved.pendingGeneration?.id, started.id)
    XCTAssertEqual(reservations, 1)

    let moved = f.directory.appendingPathComponent("new-container")
    try FileManager.default.createDirectory(at: moved, withIntermediateDirectories: true)
    try FileManager.default.copyItem(at: f.directory.appendingPathComponent("PBJApplication"), to: moved.appendingPathComponent("PBJApplication"))
    let restored = ApplicationModel(api: f.api, documents: moved)
    await restored.activate(auth: f.auth, editor: EditorModel(root: moved.appendingPathComponent("editor")))
    XCTAssertEqual(reservations, 1, "Loading saved state itself never starts external work")
    XCTAssertEqual(restored.state.pendingGeneration?.footage.first?.localPath, moved.appendingPathComponent("PBJApplication/originals/original.mov").path)
    restored.state.title = "Changed visible title"; restored.state.brief = "Changed visible recipe"; restored.state.duration = 60
    await restored.importFootage([original])
    XCTAssertTrue(restored.error?.contains("saved request") == true)
    var submission: [String: Any]?
    f.respond { request in
      if request.url.path == "/v2/uploads" {
        reservations += 1
        return ["id": "verified-asset", "assetID": "verified-asset", "receivedBytes": request.body["byteCount"]!, "status": "complete"]
      }
      if request.url.path == "/v2/projects", request.method == "POST" {
        submission = request.body
        return ["id": request.body["id"]!, "title": request.body["title"]!, "brief": request.body["brief"]!, "status": "queued"]
      }
      return try home(request)
    }
    await restored.resumePendingWork()
    XCTAssertNil(restored.error)
    XCTAssertEqual(submission?["id"] as? String, started.id)
    XCTAssertEqual(submission?["title"] as? String, "My original request")
    XCTAssertEqual(submission?["brief"] as? String, "Keep the whole swing\nOptional treatment: Fast-paced")
    XCTAssertEqual((submission?["durationGoal"] as? [String: Any])?["seconds"] as? Int, 24)
    XCTAssertEqual(restored.state.watchingProjectID, started.id)
    XCTAssertFalse(restored.hasPendingWork)
    let completed = try JSONDecoder().decode(ApplicationState.self, from: Data(contentsOf: moved.appendingPathComponent("PBJApplication/state.json")))
    XCTAssertNil(completed.pendingGeneration); XCTAssertNil(completed.pendingSubmission)
  }

  @MainActor
  func testPendingTeachingRestoresTheOriginalNotesAndGroupAfterInterruptedSubmission() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    let home: (UploadRequest) throws -> [String: Any] = { request in
      switch request.url.path {
      case "/v2/projects": return ["projects": []]
      case "/v2/jobs": return ["jobs": []]
      case "/v2/service-status": return ["aiProcessingEnabled": false]
      default: throw URLError(.notConnectedToInternet)
      }
    }
    f.respond(home)
    let app = ApplicationModel(api: f.api, documents: f.directory)
    await app.activate(auth: f.auth, editor: EditorModel(root: f.directory.appendingPathComponent("editor")))
    await app.importTeaching([try await f.video()], final: true)
    let final = URL(fileURLWithPath: try XCTUnwrap(app.state.teaching?.finals.first))
    var failed = true, requests: [[String: Any]] = []
    f.respond { request in
      if request.url.path == "/v2/uploads" {
        return ["id": "verified-asset", "assetID": "verified-asset", "receivedBytes": request.body["byteCount"]!, "status": "complete"]
      }
      if request.url.path == "/v2/teaching" {
        requests.append(request.body)
        if failed { throw URLError(.cancelled) }
        return ["id": UUID().uuidString, "kind": "teach", "status": "queued", "stage": "Saved", "payload": ["groupID": request.body["id"]!]]
      }
      return try home(request)
    }
    await app.teach(finals: [final], raw: [], attribution: "Someone else's work", notes: "Only borrow pacing")
    XCTAssertNotNil(app.state.pendingTeaching)
    let restored = ApplicationModel(api: f.api, documents: f.directory)
    await restored.activate(auth: f.auth, editor: EditorModel(root: f.directory.appendingPathComponent("editor")))
    XCTAssertEqual(requests.count, 1)
    restored.state.teaching?.notes = "A changed note"
    restored.state.teaching?.attribution = "My work"
    await restored.importTeaching([final], final: true)
    XCTAssertTrue(restored.error?.contains("saved reference") == true)
    failed = false
    await restored.resumePendingWork()
    XCTAssertEqual(requests.count, 2)
    XCTAssertEqual(requests.first! as NSDictionary, requests.last! as NSDictionary)
    XCTAssertEqual(requests.last?["notes"] as? String, "Only borrow pacing")
    XCTAssertEqual(requests.last?["attribution"] as? String, "Someone else's work")
    XCTAssertNil(restored.error); XCTAssertFalse(restored.hasPendingWork)
    XCTAssertNil(restored.state.teaching)
  }

  @MainActor
  func testUntouchedDraftsDoNotAuthorizeUploadWhenResuming() async throws {
    let f = try IngestionFixture(); defer { f.cleanup() }
    f.respond { request in
      switch request.url.path {
      case "/v2/projects": return ["projects": []]
      case "/v2/jobs": return ["jobs": []]
      case "/v2/service-status": return ["aiProcessingEnabled": false]
      default: XCTFail("Unrequested external work: \(request.url)"); throw URLError(.cancelled)
      }
    }
    let app = ApplicationModel(api: f.api, documents: f.directory)
    await app.activate(auth: f.auth, editor: EditorModel(root: f.directory.appendingPathComponent("editor")))
    let (source, url) = try f.original(bytes: 1024)
    app.state.footage = [.init(source: source, localPath: url.path)]
    app.state.teaching = TeachingDraft(finals: [url.path])
    XCTAssertTrue(app.save())
    XCTAssertFalse(app.hasPendingWork)
    await app.resumePendingWork()
    XCTAssertNil(app.error)
    XCTAssertNil(app.state.pendingGeneration); XCTAssertNil(app.state.pendingTeaching)
  }

}
