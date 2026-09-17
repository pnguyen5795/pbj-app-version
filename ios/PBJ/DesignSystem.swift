import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum PBJDesign {
  static let purple = Color(red: 139 / 255, green: 92 / 255, blue: 246 / 255)
  static let cream = Color(red: 254 / 255, green: 246 / 255, blue: 238 / 255)
  static let secondary = Color(red: 142 / 255, green: 142 / 255, blue: 147 / 255)
  static let background = LinearGradient(
    colors: [.white, cream.opacity(0.65)], startPoint: .top, endPoint: .bottom)
}
struct PBJButton: View {
  var title: String
  var secondary = false
  var accent = false
  var disabled = false
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Text(title).font(.system(size: 17, weight: .semibold)).frame(maxWidth: .infinity).frame(
        minHeight: 56
      )
      .foregroundStyle(disabled ? PBJDesign.secondary : secondary ? Color.primary : .white)
      .background(
        disabled
          ? Color(red: 0.9, green: 0.9, blue: 0.92)
          : secondary ? .white : accent ? PBJDesign.purple : .black, in: Capsule()
      )
      .overlay(Capsule().stroke(.black.opacity(secondary ? 0.10 : 0), lineWidth: 1))
      .shadow(color: .black.opacity(secondary ? 0.08 : 0.02), radius: 3, y: 2)
    }.buttonStyle(PressButtonStyle()).disabled(disabled)
  }
}
private struct PressButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.scaleEffect(configuration.isPressed ? 0.97 : 1).animation(
      .easeOut(duration: 0.15), value: configuration.isPressed)
  }
}
struct PBJHeading: View {
  let title: String
  var subtitle: String?
  var body: some View {
    VStack(spacing: 8) {
      Text(title).font(.system(size: 34, weight: .bold)).tracking(-1).multilineTextAlignment(
        .center)
      if let subtitle {
        Text(subtitle).font(.system(size: 17)).foregroundStyle(PBJDesign.secondary)
          .multilineTextAlignment(.center)
      }
    }.frame(maxWidth: .infinity)
  }
}
struct PBJBack: View {
  var action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: "chevron.left").foregroundStyle(.primary).frame(width: 44, height: 44)
        .background(.black.opacity(0.03), in: Circle())
    }.accessibilityLabel("Back")
  }
}
struct PBJCard<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    content.padding(16).frame(maxWidth: .infinity, alignment: .leading).background(
      .white.opacity(0.8), in: RoundedRectangle(cornerRadius: 22)
    ).overlay(RoundedRectangle(cornerRadius: 22).stroke(.black.opacity(0.06)))
  }
}
struct SourceThumbnail: View {
  let url: URL
  @State private var image: UIImage?
  var body: some View {
    ZStack {
      Color.black.opacity(0.04)
      if let image {
        Image(uiImage: image).resizable().scaledToFill()
      } else {
        Image(systemName: "film").foregroundStyle(.secondary)
      }
    }.clipped()
      .task(id: url) {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 320, height: 320)
        if let frame = try? await generator.image(at: .zero) {
          image = UIImage(cgImage: frame.image)
        }
      }
  }
}
struct VideoSelectionButton<Label: View>: View {
  @EnvironmentObject private var mediaImport: MediaImportProgress
  var multiple = true
  var onPick: ([URL]) async -> Void
  @ViewBuilder var label: Label
  @State private var choose = false
  @State private var files = false
  @State private var showPhotos = false
  @State private var items: [PhotosPickerItem] = []
  @State private var error: String?
  var body: some View {
    Button {
      choose = true
    } label: {
      label
    }
    .confirmationDialog("Choose footage", isPresented: $choose, titleVisibility: .visible) {
      Button("Photos") { showPhotos = true }
      Button("Files") { files = true }
    }
    .photosPicker(
      isPresented: $showPhotos, selection: $items, maxSelectionCount: multiple ? nil : 1,
      matching: .videos
    )
    .fileImporter(
      isPresented: $files, allowedContentTypes: [.movie, .video], allowsMultipleSelection: multiple
    ) { result in
      switch result {
      case .success(let urls):
        guard !urls.isEmpty else { return }
        mediaImport.run("Saving your videos…", onError: { error = $0.localizedDescription }) {
          await onPick(urls)
        }
      case .failure(let failure): error = failure.localizedDescription
      }
    }
    .onChange(of: items) { _, newItems in
      guard !newItems.isEmpty else { return }
      items = []
      mediaImport.videos(newItems, onPick: onPick, onError: { error = $0.localizedDescription })
    }
    .alert(
      "Could not import footage",
      isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })
    ) {
      Button("OK") { error = nil }
    } message: {
      Text(error ?? "")
    }
  }
}
struct SandwichArtwork: View {
  var body: some View {
    ZStack {
      ForEach(["bottom-bread", "peanut-butter", "jelly", "top-bread"], id: \.self) {
        Image($0).resizable().scaledToFit()
      }
    }.accessibilityHidden(true)
  }
}

struct ImageSelectionButton: View {
  @EnvironmentObject private var mediaImport: MediaImportProgress
  var onPick: (URL) async -> Void
  @State private var choose = false
  @State private var photos = false
  @State private var files = false
  @State private var item: PhotosPickerItem?
  @State private var error: String?
  var body: some View {
    Button("Add Image", systemImage: "photo") { choose = true }
      .confirmationDialog("Choose image", isPresented: $choose) {
        Button("Photos") { photos = true }
        Button("Files") { files = true }
      }
      .photosPicker(isPresented: $photos, selection: $item, matching: .images)
      .fileImporter(isPresented: $files, allowedContentTypes: [.image]) { result in
        switch result {
        case .success(let url):
          mediaImport.run("Saving your image…", onError: { error = $0.localizedDescription }) {
            await onPick(url)
          }
        case .failure(let failure): error = failure.localizedDescription
        }
      }
      .onChange(of: item) { _, item in
        guard let item else { return }
        self.item = nil
        mediaImport.image(item, onPick: onPick, onError: { error = $0.localizedDescription })
      }
      .alert(
        "Could not import image",
        isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })
      ) {
        Button("OK") { error = nil }
      } message: {
        Text(error ?? "")
      }
  }
}
struct PickedImage: Transferable {
  let url: URL
  static var transferRepresentation: some TransferRepresentation {
    FileRepresentation(contentType: .image) {
      SentTransferredFile($0.url)
    } importing: { received in
      let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        .appendingPathExtension(received.file.pathExtension)
      try FileManager.default.copyItem(at: received.file, to: url)
      return PickedImage(url: url)
    }
  }
}
