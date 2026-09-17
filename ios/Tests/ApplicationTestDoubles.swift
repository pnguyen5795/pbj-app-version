// Test-only dependencies for compiling the actual app lifecycle on macOS.
// These never load Keychain, sign in, open media, or touch user documents.
import Foundation
import PBJCore

@MainActor
final class AuthenticationModel {
  struct User { let id: String }
  struct Clerk { let user: User? }
  var localWorkspace = true
  var signedIn = true
  var clerk: Clerk?
  func token() async throws -> String? { "offline-test-token" }
}

final class MacConnection {
  struct Pairing { let serverURL: URL }
  static let shared = MacConnection()
  let pairing: Pairing? = nil
  var session: URLSession { fatalError("Tests must inject their intercepted session") }
  func answer(_ challenge: URLAuthenticationChallenge, completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    completion(.performDefaultHandling, nil)
  }
  func redirect(_ response: HTTPURLResponse, request: URLRequest) -> URLRequest? { request }
}

@MainActor
final class EditorModel {
  struct LocalProject { let root: URL; let title: String }
  final class Player { func pause() {} }
  let player = Player()
  var root: URL
  var busy = false
  var projects: [LocalProject] = []
  var selectedID: String?
  var verification: ExportVerification?
  var document: ProjectDocument
  var sourceURLs: [String: URL] = [:]
  var timeline: Timeline { document.current }
  init(root: URL, document: ProjectDocument = ProjectDocument(title: "Test")) {
    self.root = root
    self.document = document
  }
  func useAccountDirectory(_ directory: URL?) {}
  func openProject(_ project: LocalProject) { fatalError("Unexpected media opening in lifecycle test") }
  func openSavedExport(_ id: String) async throws {
    throw TimelineError.invalid("Unexpected export opening in lifecycle test")
  }
  func sourceURL(_ id: String) -> URL? { sourceURLs[id] }
  func installSnapshot(projectID: String, title: String, timeline: Timeline,
    sources: [MediaSource], sourceURLs: [String: URL]) async throws {
    throw TimelineError.invalid("Unexpected media installation in lifecycle test")
  }
  func addCaptions(_ words: [String: [TimedWord]], style: String) {
    fatalError("Unexpected captions in lifecycle test")
  }
}
