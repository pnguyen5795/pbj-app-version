import Combine
import Foundation
#if os(iOS)
import BackgroundTasks
import UIKit
#endif

enum BackgroundWorkMode: Equatable { case foreground, brief, continued }
private enum BackgroundWorkContext { @TaskLocal static var id: String? }
@MainActor protocol BackgroundWorkLease: AnyObject {
  var mode: BackgroundWorkMode { get }
  func update(_ fraction: Double, _ detail: String)
  func finish(_ success: Bool)
}

/// An execution allowance, not a timer that pretends work has finished.
/// Durable upload/export intent belongs to the existing project stores.
@MainActor final class BackgroundWorkController: ObservableObject {
  static let shared = BackgroundWorkController()
  typealias Factory = (String, String, Bool, @escaping @MainActor () -> Void) -> BackgroundWorkLease
  @Published private(set) var isBackground = false
  @Published private(set) var message: String?
  private var active: [String: (lease: BackgroundWorkLease, gpu: Bool, cancel: () -> Void)] = [:]
  private let factory: Factory
  var hasContinuedExecution: Bool { active.values.contains { $0.lease.mode == .continued } }
  var isNestedOperation: Bool { BackgroundWorkContext.id.map { active[$0] != nil } ?? false }
  init(factory: Factory? = nil) {
    self.factory = factory ?? { id, title, gpu, cancel in
      #if os(iOS)
      return AppleWorkLease(id: id, title: title, gpu: gpu, cancel: cancel)
      #else
      return ForegroundWorkLease()
      #endif
    }
  }
  func setBackground(_ value: Bool) {
    isBackground = value
    if value {
      for work in active.values where work.lease.mode == .foreground || (work.gpu && work.lease.mode != .continued) {
        work.cancel()
      }
    }
    updateMessage()
  }
  func update(_ fraction: Double, _ detail: String) {
    for work in active.values { work.lease.update(fraction, detail) }
    updateMessage()
  }
  private func updateMessage() {
    if active.isEmpty { message = nil }
    else if active.values.allSatisfy({ $0.lease.mode == .continued }) {
      message = "You can switch apps. Completion alerts follow your notification settings. iOS can pause work if resources run low."
    } else if active.values.contains(where: { $0.gpu }) {
      message = "This device needs PB&J in the foreground to render right now. Leaving pauses the export; you can restart it from this project."
    } else {
      message = "Progress is saved. Background time is limited on this device; reopen PB&J if iOS pauses the transfer."
    }
  }
  func run<T>(title: String, projectID: String?, requiresGPU: Bool = false,
    operation: @escaping @MainActor (_ update: @escaping @Sendable (Double, String) async -> Void) async throws -> T
  ) async throws -> T {
    try Task.checkCancellation()
    if let parent = BackgroundWorkContext.id, let existing = active[parent], !requiresGPU || existing.gpu {
      return try await operation { fraction, detail in
        await MainActor.run { existing.lease.update(fraction, detail) }
      }
    }
    let id = UUID().uuidString
    var child: Task<T, Error>?
    var expired = false
    let cancel: @MainActor () -> Void = { expired = true; child?.cancel() }
    let lease = factory(id, title, requiresGPU, cancel)
    active[id] = (lease, requiresGPU, cancel)
    updateMessage()
    let task = Task { @MainActor in
      try Task.checkCancellation()
      let result = try await BackgroundWorkContext.$id.withValue(id) {
        try await operation { [self, lease] fraction, detail in
          await MainActor.run { lease.update(fraction, detail); self.updateMessage() }
        }
      }
      try Task.checkCancellation()
      return result
    }
    child = task
    if expired || (isBackground && (lease.mode == .foreground || (requiresGPU && lease.mode != .continued))) { task.cancel() }
    var success = false
    defer { lease.finish(success); active.removeValue(forKey: id); updateMessage() }
    let result = try await withTaskCancellationHandler {
      try await task.value
    } onCancel: { task.cancel() }
    try Task.checkCancellation()
    success = true
    return result
  }
}

@MainActor private final class ForegroundWorkLease: BackgroundWorkLease {
  let mode = BackgroundWorkMode.foreground
  func update(_ fraction: Double, _ detail: String) {}
  func finish(_ success: Bool) {}
}

#if os(iOS)
@MainActor private final class AppleWorkLease: BackgroundWorkLease {
  private var task: BGTask?
  private var brief: UIBackgroundTaskIdentifier = .invalid
  private var identifier: String?
  private var completed: Bool?
  private var fraction = 0.0
  private var detail = "Starting"
  private let title: String
  private let gpu: Bool
  var mode: BackgroundWorkMode {
    if task != nil { return .continued }
    return brief != .invalid ? .brief : .foreground
  }
  init(id: String, title: String, gpu: Bool, cancel: @escaping @MainActor () -> Void) {
    self.title = title; self.gpu = gpu
    guard UIApplication.shared.applicationState != .background else { return }
    if !gpu {
      brief = UIApplication.shared.beginBackgroundTask(withName: title) { Task { @MainActor in cancel() } }
    }
    if #available(iOS 26.0, *) {
      if gpu {
        guard Bundle.main.object(forInfoDictionaryKey: "PBJBackgroundGPUEnabled") as? String == "YES",
          BGTaskScheduler.supportedResources.contains(.gpu) else { return }
      }
      let identifier = (Bundle.main.bundleIdentifier ?? "com.pbj.native.mediatest") + ".work." + id
      self.identifier = identifier
      guard BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: .main, launchHandler: { [weak self] task in
        Task { @MainActor in
          guard let self else { task.setTaskCompleted(success: false); return }
          if let completed = self.completed { task.setTaskCompleted(success: completed); return }
          self.task = task
          task.expirationHandler = { Task { @MainActor in cancel() } }
          if self.brief != .invalid { UIApplication.shared.endBackgroundTask(self.brief); self.brief = .invalid }
          self.update(self.fraction, self.detail)
        }
      }) else { self.identifier = nil; return }
      let request = BGContinuedProcessingTaskRequest(identifier: identifier, title: title, subtitle: "Starting")
      request.strategy = .fail
      if gpu { request.requiredResources = .gpu }
      do { try BGTaskScheduler.shared.submit(request) }
      catch { self.identifier = nil } // Foreground/brief mode remains explicit to the user.
    }
  }
  func update(_ fraction: Double, _ detail: String) {
    if fraction.isFinite { self.fraction = max(self.fraction, min(1, max(0, fraction))) }
    self.detail = detail
    if #available(iOS 26.0, *), let task = task as? BGContinuedProcessingTask {
      task.progress.totalUnitCount = 1000
      task.progress.completedUnitCount = Int64(self.fraction * 1000)
      task.updateTitle(title, subtitle: detail)
    }
  }
  func finish(_ success: Bool) {
    guard completed == nil else { return }
    completed = success
    if success { update(1, "Finished") }
    task?.setTaskCompleted(success: success)
    if let identifier, task == nil { BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: identifier) }
    if brief != .invalid { UIApplication.shared.endBackgroundTask(brief); brief = .invalid }
  }
}
#endif
