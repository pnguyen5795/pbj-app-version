import Foundation
import PBJCore

struct ServerProject: Codable, Identifiable {
  let id: String
  var title: String
  var brief: String
  var status: String
  var currentRevisionId: String?
  var updatedAt: String?
  var coverAssetId: String?
  var coverTicks: Double?
  var durationSeconds: Double?
}
struct ServerRevision: Codable, Identifiable {
  let id: String
  let timeline: Timeline
  let origin: String
  let summary: String
  let accepted: Bool
  var feedback: String?
}
struct ServerJob: Codable, Identifiable {
  let id: String
  let kind: String
  let status: String
  let stage: String
  let lastError: String?
  let payload: Payload
  struct Payload: Codable {
    var projectID: String?
    var groupID: String?
  }
  var active: Bool { status == "queued" || status == "running" }
}
struct ServerProjectDetail: Codable {
  let project: ServerProject
  let sources: [MediaSource]
  let revisions: [ServerRevision]
  let jobs: [ServerJob]
}
struct UploadReceipt: Codable {
  let id: String
  let assetID: String?
  let receivedBytes: Int64
  let status: String
}
struct MemoryEntry: Codable, Identifiable {
  let id: String
  let kind: String
  let context: String
  let statement: String
  let attribution: String
  var enabled: Bool
  var strength: String?
  var effectiveStrength: String?
  var supportCount: Int?
  var status: String?
  var projectScope: String?
  var learning: Applicability?

  struct Applicability: Codable {
    var formats: [String]?
    var subjects: [String]?
  }
}
struct TeachingGroup: Codable, Identifiable {
  let id: String
  let attribution: String
  let notes: String
  let finalAssetId: String
  let rawAssetIds: [String]
  let enabled: Bool
  var excluded: Bool?
}
struct AccountUsage: Codable {
  let ownerID: String
  let sourceSeconds: Double
  var providerRequests: Int?
  var analyzedFiles: Int?
  var speechSeconds: Double?
  var inputTokens: Int?
  var outputTokens: Int?
}
struct ProjectList: Decodable {
  let projects: [ServerProject]
  var archivedProjectIDs: [String]?
}
struct ServiceStatus: Decodable { let aiProcessingEnabled: Bool; var pushNotificationsEnabled: Bool? }
struct JobList: Decodable { let jobs: [ServerJob] }
struct MemoryList: Decodable { let records: [MemoryEntry] }
struct TeachingList: Decodable { let groups: [TeachingGroup] }
struct Acknowledgement: Decodable { let ok: Bool? }
struct EmptyRequest: Encodable {}

@MainActor
final class AppAPI {
  private struct ServiceFailure: LocalizedError {
    let status: Int
    let message: String
    var errorDescription: String? { message }
  }
  var baseURL: URL?
  var notificationDeviceID: String?
  var pairedMacName: String? { MacConnection.shared.pairing?.serverURL.host }
  private let suppliedSession: URLSession?
  private var session: URLSession {
    suppliedSession ?? (MacConnection.shared.pairing == nil ? .shared : MacConnection.shared.session)
  }
  var token: () async throws -> String? = { nil }
  // Supplied by the foreground-started work controller. Recheck each chunk;
  // ordinary uploads avoid discretionary scheduling while execution is granted.
  var usesContinuedExecution: () -> Bool = { false }
  private let decoder: JSONDecoder = {
    let d = JSONDecoder()
    d.keyDecodingStrategy = .convertFromSnakeCase
    return d
  }()
  init(session: URLSession? = nil) {
    suppliedSession = session
    let configured = Bundle.main.object(forInfoDictionaryKey: "PBJAPIURL") as? String
    if let configured, !configured.isEmpty { baseURL = URL(string: configured) }
    #if DEBUG
      if let pairing = MacConnection.shared.pairing { baseURL = pairing.serverURL }
    #endif
    #if DEBUG && targetEnvironment(simulator)
      if baseURL == nil { baseURL = URL(string: "http://127.0.0.1:8787") }
    #endif
  }
  func request<T: Decodable, B: Encodable>(_ path: String, method: String = "GET", body: B? = nil)
    async throws -> T
  {
    var request = try await makeRequest(path, method: method)
    if let body {
      let encoded = try JSONEncoder().encode(body)
      if method == "POST", let notificationDeviceID,
        path == "projects" || path == "teaching" || (path.hasPrefix("projects/") && path.hasSuffix("/revise")),
        var object = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] {
        object["notificationDeviceID"] = notificationDeviceID
        request.httpBody = try JSONSerialization.data(withJSONObject: object)
      } else { request.httpBody = encoded }
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    }
    let (data, response) = try await session.data(for: request)
    try check(data, response)
    return try decoder.decode(T.self, from: data)
  }
  func get<T: Decodable>(_ path: String) async throws -> T {
    try await request(path, body: Optional<EmptyRequest>.none)
  }
  private func makeRequest(_ path: String, method: String) async throws -> URLRequest {
    guard let baseURL,
      let url = URL(string: "v2/" + path, relativeTo: baseURL.appendingPathComponent("/"))
    else {
      throw TimelineError.invalid(
        "The editing service is not configured yet. Your work is saved on this device.")
    }
    var request = URLRequest(url: url)
    request.httpMethod = method
    request.timeoutInterval = 120
    if let token = try await token() {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return request
  }
  private func check(_ data: Data, _ response: URLResponse) throws {
    guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
      let error = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw ServiceFailure(status: (response as? HTTPURLResponse)?.statusCode ?? 0,
        message: error?["error"] as? String
          ?? "The service could not finish this step. Your work is saved; try again.")
    }
  }
  private func canResumeUpload(after error: Error) -> Bool {
    if let failure = error as? ServiceFailure {
      return failure.status == 409 || failure.status >= 500
        || (failure.status == 400 && (failure.message.hasPrefix("Upload offset changed")
          || failure.message.hasPrefix("Upload offset reset")))
    }
    guard let error = error as? URLError else { return false }
    return [.networkConnectionLost, .timedOut, .notConnectedToInternet, .cannotConnectToHost,
      .cannotFindHost, .dnsLookupFailed].contains(error.code)
  }
  private func validateUpload(_ receipt: UploadReceipt, count: Int64) throws {
    guard !receipt.id.isEmpty, (0...count).contains(receipt.receivedBytes),
      receipt.status == "receiving" || receipt.status == "complete",
      receipt.status != "complete" || (receipt.assetID?.isEmpty == false && receipt.receivedBytes == count),
      receipt.assetID == nil || receipt.status == "complete"
    else { throw TimelineError.invalid("The service returned invalid upload progress. Your original is saved; reconnect and retry.") }
  }
  func upload(_ source: MediaSource, url: URL, progress: (Int64, Int64) -> Void) async throws
    -> String
  {
    struct Reserve: Encodable {
      let sha256: String
      let fileName: String
      let byteCount: Int64
    }
    let count =
      (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.int64Value
      ?? 0
    guard count > 0 else { throw TimelineError.invalid("The saved original is empty.") }
    // The source record may predate a same-path file replacement. Verify once
    // before the server's existing-asset shortcut can reuse its cached hash.
    let verification = Task.detached(priority: .utility) { try MediaImport.hash(url) }
    let checksum = try await withTaskCancellationHandler {
      try await verification.value
    } onCancel: { verification.cancel() }
    try Task.checkCancellation()
    guard checksum == source.sha256 else {
      throw TimelineError.invalid("This saved original has changed since it was imported. Add the video again before uploading it.")
    }
    let reservation = Reserve(sha256: source.sha256, fileName: source.fileName, byteCount: count)
    func reserve() async throws -> UploadReceipt {
      let receipt: UploadReceipt = try await request("uploads", method: "POST", body: reservation)
      try validateUpload(receipt, count: count)
      progress(receipt.receivedBytes, count)
      return receipt
    }
    var receipt = try await reserve()
    if let asset = receipt.assetID { return asset }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var recoveryAttempts = 0
    while receipt.receivedBytes < count {
      try Task.checkCancellation()
      try handle.seek(toOffset: UInt64(receipt.receivedBytes))
      guard let chunk = try handle.read(upToCount: 4 * 1024 * 1024), !chunk.isEmpty else {
        throw TimelineError.invalid("The saved original is incomplete.")
      }
      var request = try await makeRequest(
        "uploads/\(receipt.id)/chunk?offset=\(receipt.receivedBytes)", method: "PUT")
      request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
      do {
        let result: (Data, URLResponse)
        if usesContinuedExecution() || suppliedSession != nil {
          result = try await session.upload(for: request, from: chunk)
        } else {
          #if targetEnvironment(simulator) || !os(iOS)
            result = try await session.upload(for: request, from: chunk)
          #else
            result = try await BackgroundTransfer.shared.upload(request, chunk: chunk)
          #endif
        }
        let (data, response) = result
        try check(data, response)
        let committed = try decoder.decode(UploadReceipt.self, from: data)
        try validateUpload(committed, count: count)
        guard committed.id == receipt.id,
          committed.receivedBytes >= receipt.receivedBytes + Int64(chunk.count)
        else { throw TimelineError.invalid("The service did not confirm this upload chunk. Your original is saved; reconnect and retry.") }
        receipt = committed
        progress(receipt.receivedBytes, count)
      } catch {
        try Task.checkCancellation()
        guard canResumeUpload(after: error), recoveryAttempts < 2 else { throw error }
        recoveryAttempts += 1
        let previousOffset = receipt.receivedBytes
        // The chunk may already be committed despite its missing response.
        // Relaunched/background transfers use this same authoritative offset.
        receipt = try await reserve()
        if let asset = receipt.assetID { return asset }
        // A recovered Mac staging file can legitimately restart at zero. Bound
        // all recovery attempts so repeated resets cannot run indefinitely.
        if receipt.receivedBytes <= previousOffset { try await Task.sleep(for: .milliseconds(250)) }
      }
    }
    for attempt in 0...2 {
      try Task.checkCancellation()
      do {
        let complete: UploadReceipt = try await request(
          "uploads/\(receipt.id)/complete", method: "POST", body: EmptyRequest())
        try validateUpload(complete, count: count)
        guard let id = complete.assetID else { throw TimelineError.invalid("The service has not verified the upload yet.") }
        return id
      } catch {
        try Task.checkCancellation()
        guard canResumeUpload(after: error), attempt < 2 else { throw error }
        receipt = try await reserve()
        if let asset = receipt.assetID { return asset }
        guard receipt.receivedBytes == count else { throw TimelineError.invalid("The service has not retained the complete original. Reconnect and retry.") }
      }
    }
    throw TimelineError.invalid("The upload could not be verified. Your original is saved.")
  }
  func projectCover(_ project: ServerProject) async throws -> Data {
    guard let id = project.coverAssetId else { throw TimelineError.invalid("No project cover yet") }
    let request = try await makeRequest(
      "assets/\(id)/thumbnail?ticks=\(Int64(project.coverTicks ?? 0))", method: "GET")
    let (data, response) = try await session.data(for: request)
    try check(data, response)
    return data
  }
  func download(_ source: MediaSource, into directory: URL) async throws -> URL {
    let target = directory.appendingPathComponent(source.id).appendingPathExtension(
      (source.fileName as NSString).pathExtension)
    if FileManager.default.fileExists(atPath: target.path),
      try await Task.detached(priority: .utility, operation: { try MediaImport.hash(target) }).value == source.sha256
    {
      return target
    }
    let request = try await makeRequest("assets/\(source.id)/content", method: "GET")
    let (temporary, response) = try await session.download(for: request)
    guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
      throw TimelineError.invalid(
        "Could not download an original. Your saved project is preserved.")
    }
    guard try await Task.detached(priority: .utility, operation: { try MediaImport.hash(temporary) }).value == source.sha256 else {
      throw TimelineError.invalid("Downloaded footage did not match its original checksum.")
    }
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    if FileManager.default.fileExists(atPath: target.path) {
      _ = try FileManager.default.replaceItemAt(target, withItemAt: temporary)
    } else {
      try FileManager.default.moveItem(at: temporary, to: target)
    }
    return target
  }
}
