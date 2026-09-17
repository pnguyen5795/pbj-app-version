import Combine
import Foundation
#if os(iOS)
import UIKit
import UserNotifications
#endif

struct NotificationDestination: Codable, Equatable {
  let ownerID: String
  var projectID: String?
  var exportID: String?
  var screen: String? // draft, teaching, memory, home; otherwise open the identified project.
}
struct CompletionNotice: Codable, Identifiable, Equatable {
  let id: String
  let title: String
  let body: String
  let destination: NotificationDestination
  var isValid: Bool {
    func validID(_ value: String) -> Bool {
      !value.isEmpty && value.count <= 200 && value.unicodeScalars.allSatisfy {
        CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_"
      }
    }
    return validID(id) && validID(destination.ownerID) && !title.isEmpty
      && (destination.projectID.map(validID) ?? true)
      && (destination.exportID.map(validID) ?? true)
      && (destination.exportID == nil || destination.projectID != nil)
      && (destination.screen.map { ["draft", "teaching", "memory", "home"].contains($0) } ?? true)
      && (destination.projectID != nil || destination.screen != nil)
  }
}
struct ServerNotificationEvent: Codable, Identifiable {
  let id: String
  let ownerID: String
  let jobID: String
  let kind: String
  let status: String
  let projectID: String?
  let groupID: String?
  let revisionID: String?
  let title: String
  let body: String
  let createdAt: String
  var notice: CompletionNotice {
    .init(id: id, title: title, body: body, destination: .init(ownerID: ownerID,
      projectID: projectID, screen: kind == "teach" ? (status == "complete" ? "memory" : "home") : nil))
  }
}

/// The server is authoritative for remote completion. Nothing is scheduled
/// using an estimated finish time. Local completion is posted only by the code
/// that successfully saved the operation's result.
@MainActor final class CompletionNotifications: NSObject, ObservableObject {
  static let shared = CompletionNotifications()
  struct Watch: Codable, Equatable { let ownerID: String; let projectID: String?; let jobID: String? }
  private struct State: Codable {
    var deviceID = UUID().uuidString.lowercased()
    var seen: [String] = []
    var watches: [Watch] = []
    var pendingOpen: CompletionNotice?
  }
  @Published private(set) var authorized = false
  @Published private(set) var permissionDenied = false
  @Published var latest: CompletionNotice?
  @Published private(set) var pendingOpen: CompletionNotice?
  @Published private(set) var registrationError: String?
  @Published var serverPushEnabled = false
  private(set) var ownerID: String?
  private var api: AppAPI?
  private var state: State
  private let defaults: UserDefaults?
  private var token: String?
  private var registered = false
  private var requestingToken = false
  private var syncing = false
  private var resyncNeeded = false
  var isActive = true
  var pushConfigured: Bool { Bundle.main.object(forInfoDictionaryKey: "PBJPushEnabled") as? String == "YES" }
  var pushEnvironment: String { Bundle.main.object(forInfoDictionaryKey: "PBJPushEnvironment") as? String == "production" ? "production" : "sandbox" }
  var deliveryDescription: String {
    if permissionDenied { return "Notifications are off. Enable them in iPhone Settings to receive alerts." }
    if !authorized { return "Allow notifications to get completion and resume alerts." }
    if pushConfigured && serverPushEnabled {
      if token == nil { return registrationError ?? "Setting up alerts from your Mac. Local completion alerts are available." }
      return registrationError ?? "Completion alerts are enabled. Your Mac must be running for AI work."
    }
    return "Local completion alerts are on. Alerts sent by your Mac while PB&J is closed need the paid Apple push setup; for now, check progress when you return."
  }
  init(defaults: UserDefaults? = nil) {
    #if os(iOS)
    self.defaults = defaults ?? .standard
    #else
    self.defaults = defaults // Offline harness uses no real notification service or user preferences.
    #endif
    if let data = self.defaults?.data(forKey: "pbj.completion.notifications"), let saved = try? JSONDecoder().decode(State.self, from: data) { state = saved }
    else { state = State() }
    pendingOpen = state.pendingOpen
    super.init()
    persist()
  }
  private func persist() { if let data = try? JSONEncoder().encode(state) { defaults?.set(data, forKey: "pbj.completion.notifications") } }
  func install() {
    #if os(iOS)
    UNUserNotificationCenter.current().delegate = self
    #endif
  }
  func activate(ownerID: String, api: AppAPI) {
    if self.ownerID != ownerID { registered = false; latest = nil }
    self.ownerID = ownerID; self.api = api
    api.notificationDeviceID = nil
  }
  func deactivate() { api?.notificationDeviceID = nil; ownerID = nil; api = nil; registered = false; latest = nil }
  func requestPermission() async {
    #if os(iOS)
    let center = UNUserNotificationCenter.current()
    let settings = await center.notificationSettings()
    if settings.authorizationStatus == .notDetermined { _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge]) }
    let result = await center.notificationSettings()
    authorized = [.authorized, .provisional, .ephemeral].contains(result.authorizationStatus)
    permissionDenied = result.authorizationStatus == .denied
    if authorized && pushConfigured { requestingToken = true; UIApplication.shared.registerForRemoteNotifications() }
    registered = false
    #endif
  }
  func receivedToken(_ data: Data) {
    requestingToken = false
    token = data.map { String(format: "%02x", $0) }.joined()
    registered = false
    if syncing { resyncNeeded = true } else { Task { await sync() } }
  }
  func registrationFailed(_ error: Error) { registrationError = "Mac push registration is unavailable. Local alerts and saved progress still work." }
  func watch(projectID: String? = nil, jobID: String? = nil) async {
    guard let ownerID, projectID != nil || jobID != nil else { return }
    let watch = Watch(ownerID: ownerID, projectID: projectID, jobID: jobID)
    if !state.watches.contains(watch) { state.watches.append(watch); persist() }
    await sync()
  }
  /// Wait for any foreground refresh to unwind, then acquire the registration
  /// under the submission's execution allowance. The request can now save its
  /// notification subscription atomically with the server job.
  func prepareSubmission() async throws {
    #if os(iOS)
    while syncing { try await Task.sleep(for: .milliseconds(100)) }
    try Task.checkCancellation()
    await sync()
    try Task.checkCancellation()
    guard registered, api?.notificationDeviceID != nil else {
      throw NSError(domain: "PBJNotifications", code: 1, userInfo: [NSLocalizedDescriptionKey:
        "Your request is saved on this iPhone. Connect to your updated Mac service to register its completion alert and continue."])
    }
    #endif
  }
  func sync() async {
    #if os(iOS)
    guard let owner = ownerID, let api, !syncing else { return }
    syncing = true
    defer {
      syncing = false
      if resyncNeeded { resyncNeeded = false; Task { await sync() } }
    }
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    let allowed = [.authorized, .provisional, .ephemeral].contains(settings.authorizationStatus)
    if authorized != allowed { registered = false }
    authorized = allowed
    permissionDenied = settings.authorizationStatus == .denied
    if authorized && pushConfigured && token == nil && !requestingToken {
      requestingToken = true
      UIApplication.shared.registerForRemoteNotifications()
    }
    do {
      if !registered {
        struct Device: Encodable { let token: String?; let environment: String; let enabled: Bool }
        let registrationToken = pushConfigured ? token : nil
        let _: Acknowledgement = try await api.request("notification-devices/\(state.deviceID)", method: "PUT",
          body: Device(token: registrationToken, environment: pushEnvironment, enabled: authorized))
        guard ownerID == owner else { return }
        registered = registrationToken == (pushConfigured ? token : nil)
        registrationError = nil
        api.notificationDeviceID = state.deviceID
      }
      for watch in state.watches where watch.ownerID == owner {
        struct Body: Encodable { let projectID: String?; let jobID: String? }
        let _: Acknowledgement = try await api.request("notification-devices/\(state.deviceID)/watch", method: "POST",
          body: Body(projectID: watch.projectID, jobID: watch.jobID))
        guard ownerID == owner else { return }
        state.watches.removeAll { $0 == watch }; persist()
      }
      struct Feed: Decodable { let events: [ServerNotificationEvent] }
      let feed: Feed = try await api.get("notifications?deviceID=\(state.deviceID)")
      for event in feed.events where event.ownerID == owner {
        guard ownerID == owner else { return }
        if await receive(event.notice) {
          struct Ack: Encodable { let deviceID: String }
          let _: Acknowledgement = try await api.request("notifications/\(event.id)/ack", method: "POST", body: Ack(deviceID: state.deviceID))
        }
      }
    } catch { registrationError = "Notification sync is waiting for your Mac. Your work and alert requests are saved." }
    #endif
  }
  func unregister() async {
    if let api {
      let _: Acknowledgement? = try? await api.request("notification-devices/\(state.deviceID)", method: "DELETE", body: Optional<EmptyRequest>.none)
    }
    registered = false
    api?.notificationDeviceID = nil
  }
  @discardableResult func receive(_ notice: CompletionNotice) async -> Bool {
    guard notice.isValid, notice.destination.ownerID == ownerID else { return false }
    if state.seen.contains(notice.id) { return true }
    if isActive { latest = notice }
    else {
      #if os(iOS)
      let content = UNMutableNotificationContent()
      content.title = notice.title; content.body = notice.body; content.sound = .default
      content.threadIdentifier = notice.destination.projectID ?? "pbj-progress"
      content.userInfo = ["pbjLocal": String(data: (try? JSONEncoder().encode(notice)) ?? Data(), encoding: .utf8) ?? ""]
      do { try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil)) }
      catch { return false }
      #endif
    }
    state.seen.append(notice.id)
    state.seen = Array(state.seen.suffix(512))
    persist(); return true
  }
  func open(_ notice: CompletionNotice) {
    guard notice.isValid else { return }
    state.pendingOpen = notice; pendingOpen = notice; latest = nil; persist()
  }
  func opened(_ id: String? = nil) {
    guard id == nil || pendingOpen?.id == id else { return }
    state.pendingOpen = nil; pendingOpen = nil; persist()
  }
  static func decode(_ info: [AnyHashable: Any]) -> CompletionNotice? {
    if let json = info["pbjLocal"] as? String, let data = json.data(using: .utf8),
      let notice = try? JSONDecoder().decode(CompletionNotice.self, from: data), notice.isValid { return notice }
    if let value = info["pbj"], JSONSerialization.isValidJSONObject(value), let data = try? JSONSerialization.data(withJSONObject: value) {
      guard let event = try? JSONDecoder().decode(ServerNotificationEvent.self, from: data),
        ["plan", "teach"].contains(event.kind), ["complete", "attention"].contains(event.status), event.notice.isValid else { return nil }
      return event.notice
    }
    return nil
  }
}

#if os(iOS)
extension CompletionNotifications: UNUserNotificationCenterDelegate {
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    Task { @MainActor in
      if let notice = Self.decode(notification.request.content.userInfo) { _ = await self.receive(notice) }
      completionHandler([]) // The app shows its own actionable completion card.
    }
  }
  nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void) {
    Task { @MainActor in
      if let notice = Self.decode(response.notification.request.content.userInfo) { self.open(notice) }
      completionHandler()
    }
  }
}
#endif
