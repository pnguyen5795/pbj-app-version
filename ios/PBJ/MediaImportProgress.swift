import PhotosUI
import SwiftUI
import PBJCore

/// Owned by the app so feedback survives a picker button being replaced by imported thumbnails.
@MainActor
final class MediaImportProgress: ObservableObject {
  @Published private(set) var message: String?
  var destination: (() -> NotificationDestination?)?
  var onStart: (() -> Void)?
  var didSaveSuccessfully: (() -> Bool)?
  var active: Bool { message != nil }

  func run(
    _ message: String,
    onError: @escaping @MainActor (Error) -> Void,
    operation: @escaping @MainActor () async throws -> Void
  ) {
    guard !active else { return }
    onStart?()
    self.message = message
    Task { @MainActor in
      defer { self.message = nil }
      let target = destination?(), id = UUID().uuidString
      await CompletionNotifications.shared.requestPermission()
      do {
        try await BackgroundWorkController.shared.run(title: "Adding your media", projectID: target?.projectID) { update in
          try await operation()
          try Task.checkCancellation()
          guard self.didSaveSuccessfully?() != false else { throw TimelineError.invalid("The selected media could not be saved. Open PB&J to review the error and continue.") }
          await update(1, "Media saved")
          if self.didSaveSuccessfully?() != false, let target, !CompletionNotifications.shared.isActive {
            _ = await CompletionNotifications.shared.receive(.init(id: id, title: "Your media is ready",
              body: "Your selected media has been saved. Tap to continue.", destination: target))
          }
        }
      } catch {
        onError(error)
        if let target, !CompletionNotifications.shared.isActive {
          _ = await CompletionNotifications.shared.receive(.init(id: id, title: "Adding media needs your attention",
            body: "Open PB&J to continue. If the photo picker was interrupted, choose the remaining media again.", destination: target))
        }
      }
    }
  }

  func videos(
    _ items: [PhotosPickerItem],
    onPick: @escaping @MainActor ([URL]) async -> Void,
    onError: @escaping @MainActor (Error) -> Void
  ) {
    guard !items.isEmpty else { return }
    run("Preparing video 1 of \(items.count)…", onError: onError) {
      var urls: [URL] = []
      defer { for url in urls { try? FileManager.default.removeItem(at: url) } }
      for (index, item) in items.enumerated() {
        self.message = "Preparing video \(index + 1) of \(items.count)…"
        guard let movie = try await item.loadTransferable(type: PickedMovie.self) else {
          throw URLError(.cannotDecodeContentData)
        }
        urls.append(movie.url)
        BackgroundWorkController.shared.update(Double(index + 1) / Double(items.count) * 0.7, self.message ?? "Preparing media")
      }
      self.message = "Saving your videos…"
      await onPick(urls)
    }
  }

  func image(
    _ item: PhotosPickerItem,
    onPick: @escaping @MainActor (URL) async -> Void,
    onError: @escaping @MainActor (Error) -> Void
  ) {
    run("Preparing your image…", onError: onError) {
      guard let picked = try await item.loadTransferable(type: PickedImage.self) else {
        throw URLError(.cannotDecodeContentData)
      }
      defer { try? FileManager.default.removeItem(at: picked.url) }
      self.message = "Saving your image…"
      await onPick(picked.url)
    }
  }
}

private struct MediaImportFeedback: ViewModifier {
  @EnvironmentObject private var progress: MediaImportProgress
  @ObservedObject private var background = BackgroundWorkController.shared
  func body(content: Content) -> some View {
    content
      .disabled(progress.active)
      .overlay {
        if let message = progress.message {
          ZStack {
            Color.black.opacity(0.20).ignoresSafeArea()
            VStack(spacing: 16) {
              ProgressView().controlSize(.large).tint(PBJDesign.purple)
              Text("Adding your media").font(.headline)
              Text(message).font(.subheadline).accessibilityIdentifier("media-import-status")
              Text("Large files or media in iCloud can take a little longer.")
                .font(.footnote).foregroundStyle(.secondary)
              if let detail = background.message { Text(detail).font(.footnote).foregroundStyle(.secondary) }
            }
            .multilineTextAlignment(.center)
            .padding(28).frame(maxWidth: 310)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24))
            .padding(24)
          }
          .accessibilityElement(children: .combine)
          .accessibilityAddTraits(.updatesFrequently)
        }
      }
      .interactiveDismissDisabled(progress.active)
  }
}

extension View {
  func mediaImportFeedback() -> some View { modifier(MediaImportFeedback()) }
}
