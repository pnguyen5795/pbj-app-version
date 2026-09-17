import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// File-backed chunks can finish while iOS suspends the app. The server's
/// committed byte offset remains authoritative after relaunch or force-quit.
final class BackgroundTransfer: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private final class Cancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var task: URLSessionTask?
    private var cancelled = false
    func install(_ task: URLSessionTask) {
      let shouldCancel = lock.withLock { self.task = task; return cancelled }
      if shouldCancel { task.cancel() }
    }
    func cancel() {
      let task = lock.withLock { cancelled = true; return self.task }
      task?.cancel()
    }
  }
  static let shared = BackgroundTransfer()
  static let identifier = "com.pbj.original-uploads"
  private let lock = NSLock()
  private var continuations: [Int: CheckedContinuation<(Data, URLResponse), Error>] = [:]
  private var responses: [Int: Data] = [:]
  private var completion: (() -> Void)?
  private let suppliedConfiguration: URLSessionConfiguration?
  private lazy var session: URLSession = {
    let configuration = suppliedConfiguration ?? URLSessionConfiguration.background(withIdentifier: Self.identifier)
    configuration.sessionSendsLaunchEvents = true
    configuration.isDiscretionary = false
    configuration.waitsForConnectivity = true
    configuration.timeoutIntervalForResource = 24 * 60 * 60
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    return URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
  }()
  private let directory: URL
  init(directory: URL? = nil, configuration: URLSessionConfiguration? = nil) {
    self.directory = directory ?? FileManager.default.urls(
      for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("PBJTransfers")
    suppliedConfiguration = configuration
    super.init()
  }
  func reconnect(completion: (() -> Void)? = nil) {
    lock.withLock { self.completion = completion }
    _ = session
  }
  func upload(_ request: URLRequest, chunk: Data) async throws -> (Data, URLResponse) {
    try Task.checkCancellation()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let file = directory.appendingPathComponent(UUID().uuidString)
    try chunk.write(to: file, options: .atomic)
    let cancellation = Cancellation()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        let task = session.uploadTask(with: request, fromFile: file)
        task.taskDescription = file.lastPathComponent
        lock.withLock { continuations[task.taskIdentifier] = continuation }
        cancellation.install(task)
        task.resume()
      }
    } onCancel: { cancellation.cancel() }
  }
  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.withLock { responses[dataTask.taskIdentifier, default: Data()].append(data) }
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    MacConnection.shared.answer(challenge, completion: completionHandler)
  }
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(MacConnection.shared.redirect(response, request: request))
  }
  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let (continuation, data) = lock.withLock {
      (
        continuations.removeValue(forKey: task.taskIdentifier),
        responses.removeValue(forKey: task.taskIdentifier) ?? Data()
      )
    }
    if let name = task.taskDescription, UUID(uuidString: name) != nil {
      try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
    }
    if let error {
      continuation?.resume(throwing: error)
    } else if let response = task.response {
      continuation?.resume(returning: (data, response))
    } else {
      continuation?.resume(throwing: URLError(.badServerResponse))
    }
  }
  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    let callback = lock.withLock {
      let value = completion
      completion = nil
      return value
    }
    DispatchQueue.main.async { callback?() }
  }
}
#if canImport(UIKit)
@MainActor final class PBJAppDelegate: NSObject, UIApplicationDelegate {
  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    CompletionNotifications.shared.install()
    BackgroundTransfer.shared.reconnect()
    return true
  }
  func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    CompletionNotifications.shared.receivedToken(deviceToken)
  }
  func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    CompletionNotifications.shared.registrationFailed(error)
  }
  func application(
    _ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    guard identifier == BackgroundTransfer.identifier else {
      completionHandler()
      return
    }
    BackgroundTransfer.shared.reconnect(completion: completionHandler)
  }
}
#endif
