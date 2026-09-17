import PBJCore
import SwiftUI
import UniformTypeIdentifiers

struct FinishingPanel: View {
  @EnvironmentObject var editor: EditorModel
  @EnvironmentObject var app: ApplicationModel
  @EnvironmentObject private var mediaImport: MediaImportProgress
  @Environment(\.dismiss) var dismiss
  @State private var soundFiles = false

  @State private var editingOverlay: TimelineOverlay?
  @State private var editingSound: TimelineSound?
  var body: some View {
    NavigationStack {
      List {
        Section("Sound") {
          Button("Import Audio", systemImage: "music.note") { soundFiles = true }
          Button("Extract Selected Clip’s Sound", systemImage: "waveform") {
            editor.extractSelectedSound()
          }.disabled(editor.selected == nil)
          ForEach(editor.timeline.sounds ?? []) { sound in
            Button {
              editingSound = sound
            } label: {
              HStack {
                Image(systemName: "waveform")
                Text(editor.document.sources.first { $0.id == sound.sourceID }?.fileName ?? "Sound")
                Spacer()
                Text(String(format: "%.1fs", Double(sound.outputStart) / 60000)).foregroundStyle(
                  .secondary)
              }
            }
          }.onDelete { indices in
            let sounds = editor.timeline.sounds ?? []
            for i in indices { editor.deleteSound(sounds[i].id) }
          }
        }
        Section("Overlays") {
          Button("Add Text", systemImage: "textformat") {
            editor.addText()
            editingOverlay = editor.timeline.overlays?.last
          }
          ImageSelectionButton { await editor.importFinishing($0, kind: "image") }
          VideoSelectionButton(
            multiple: false,
            onPick: { urls in
              if let url = urls.first { await editor.importFinishing(url, kind: "video") }
            }
          ) { Label("Add Video", systemImage: "video") }
          ForEach(editor.timeline.overlays ?? []) { overlay in
            Button {
              editingOverlay = overlay
            } label: {
              VStack(alignment: .leading, spacing: 4) {
                Text(overlay.text ?? overlay.kind.capitalized).lineLimit(2)
                Text(
                  String(
                    format: "%.1f – %.1fs", Double(overlay.start) / 60000,
                    Double(overlay.end) / 60000)
                ).font(.caption).foregroundStyle(.secondary)
              }
            }
          }.onDelete { indices in
            let overlays = editor.timeline.overlays ?? []
            for i in indices { editor.deleteOverlay(overlays[i].id) }
          }
        }
      }
      .disabled(editor.busy || app.busy)
      .navigationTitle("Finish Your Video")
      .toolbar { Button("Done") { dismiss() } }
      .fileImporter(
        isPresented: $soundFiles, allowedContentTypes: [.audio], allowsMultipleSelection: false
      ) { result in
        if case .success(let urls) = result, let url = urls.first {
          mediaImport.run("Saving your audio…", onError: { editor.error = $0.localizedDescription }) {
            await editor.importFinishing(url, kind: "sound")
          }
        } else if case .failure(let error) = result {
          editor.error = error.localizedDescription
        }
      }
      .sheet(item: $editingOverlay) { overlay in
        OverlayEditor(overlay: overlay).environmentObject(editor)
      }
      .sheet(item: $editingSound) { sound in SoundEditor(sound: sound).environmentObject(editor) }
    }
    .mediaImportFeedback()
  }
}
private struct OverlayEditor: View {
  @EnvironmentObject var editor: EditorModel
  @Environment(\.dismiss) var dismiss
  @State var overlay: TimelineOverlay
  var overlaySource: MediaSource? { editor.document.sources.first { $0.id == overlay.sourceID } }
  var endLimit: Double {
    let sourceLimit =
      overlay.kind == "video"
      ? Double(overlay.start + (overlaySource?.duration ?? 0) - (overlay.sourceIn ?? 0)) / 60000
      : editor.seconds
    return max(Double(overlay.start + 1) / 60000, min(editor.seconds, sourceLimit))
  }
  var textColor: Binding<Color> {
    Binding(
      get: {
        let hex = UInt32(overlay.color.dropFirst(), radix: 16) ?? 0xffffff
        return Color(
          red: Double((hex >> 16) & 255) / 255, green: Double((hex >> 8) & 255) / 255,
          blue: Double(hex & 255) / 255)
      },
      set: { color in
        var r: CGFloat = 0
        var g: CGFloat = 0
        var b: CGFloat = 0
        var a: CGFloat = 0
        UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
        overlay.color = String(format: "#%02X%02X%02X", Int(r * 255), Int(g * 255), Int(b * 255))
      })
  }
  var body: some View {
    NavigationStack {
      Form {
        if ["text", "caption"].contains(overlay.kind) {
          TextEditor(text: Binding(get: { overlay.text ?? "" }, set: { overlay.text = $0 })).frame(
            minHeight: 100)
          Picker("Style", selection: $overlay.style) {
            ForEach(["Classic", "Bold", "Minimal"], id: \.self) { Text($0) }
          }
          Slider(value: $overlay.fontSize, in: 16...120, step: 2) { Text("Font size") }
          ColorPicker("Text color", selection: textColor, supportsOpacity: false)
        }
        Section("Timing") {
          LabeledContent("Start", value: String(format: "%.2fs", Double(overlay.start) / 60000))
          Slider(
            value: Binding(
              get: { Double(overlay.start) / 60000 },
              set: {
                let newStart = Int64(($0 * 60000).rounded())
                overlay.start = newStart
                if overlay.kind == "video" {
                  overlay.end = min(
                    overlay.end, newStart + (overlaySource?.duration ?? 0) - (overlay.sourceIn ?? 0)
                  )
                }
              }),
            in: 0...max(0.01, Double(overlay.end - 1) / 60000))
          LabeledContent("End", value: String(format: "%.2fs", Double(overlay.end) / 60000))
          Slider(
            value: Binding(
              get: { Double(overlay.end) / 60000 },
              set: { overlay.end = Int64(($0 * 60000).rounded()) }),
            in: Double(overlay.start + 1)
              / 60000...endLimit)
        }
        Section("Position & Appearance") {
          LabeledContent("Horizontal") { Slider(value: $overlay.x, in: 0...1) }
          LabeledContent("Vertical") { Slider(value: $overlay.y, in: 0...1) }
          LabeledContent("Width") { Slider(value: $overlay.width, in: 0.1...1.2) }
          LabeledContent("Rotation") { Slider(value: $overlay.rotation, in: -180...180, step: 5) }
          LabeledContent("Opacity") { Slider(value: $overlay.opacity, in: 0...1) }
          if overlay.kind == "video" {
            Toggle(
              "Original overlay audio",
              isOn: Binding(
                get: { (overlay.volume ?? 0) > 0 }, set: { overlay.volume = $0 ? 1 : 0 }))
          }
        }
        Button("Delete Overlay", role: .destructive) {
          editor.deleteOverlay(overlay.id)
          dismiss()
        }
      }.navigationTitle(overlay.kind.capitalized)
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") {
              editor.updateOverlay(overlay)
              if editor.error == nil { dismiss() }
            }
          }
        }
    }
  }
}
private struct SoundEditor: View {
  @EnvironmentObject var editor: EditorModel
  @Environment(\.dismiss) var dismiss
  @State var sound: TimelineSound
  var source: MediaSource? { editor.document.sources.first { $0.id == sound.sourceID } }
  var durationBinding: Binding<Double> {
    Binding(
      get: { Double(sound.sourceDuration) / 60000.0 },
      set: { sound.sourceDuration = Int64(($0 * 60000.0).rounded()) })
  }
  var durationRange: ClosedRange<Double> {
    (1.0 / 60000.0)...max(
      1.0 / 60000.0, Double((source?.duration ?? sound.sourceDuration) - sound.sourceIn) / 60000.0)
  }
  var body: some View {
    NavigationStack {
      Form {
        LabeledContent("Volume", value: String(format: "%d%%", Int(sound.volume * 100)))
        Slider(value: $sound.volume, in: 0...2)
        LabeledContent(
          "Timeline start", value: String(format: "%.1fs", Double(sound.outputStart) / 60000))
        Slider(
          value: Binding(
            get: { Double(sound.outputStart) / 60000 },
            set: { sound.outputStart = Int64(($0 * 60000).rounded()) }),
          in: 0...max(0.01, editor.seconds))
        if source != nil {
          LabeledContent(
            "Source start", value: String(format: "%.1fs", Double(sound.sourceIn) / 60000))
          Slider(
            value: Binding(
              get: { Double(sound.sourceIn) / 60000 },
              set: {
                let end = sound.sourceIn + sound.sourceDuration
                sound.sourceIn = Int64(($0 * 60000).rounded())
                sound.sourceDuration = end - sound.sourceIn
              }), in: 0...max(0.01, Double(sound.sourceIn + sound.sourceDuration - 1) / 60000))
          LabeledContent(
            "Length", value: String(format: "%.1fs", Double(sound.sourceDuration) / 60000))
          Slider(value: durationBinding, in: durationRange)
        }
        Button("Delete Sound", role: .destructive) {
          editor.deleteSound(sound.id)
          dismiss()
        }
      }.navigationTitle("Sound")
        .toolbar {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
          ToolbarItem(placement: .confirmationAction) {
            Button("Save") {
              editor.updateSound(sound)
              if editor.error == nil { dismiss() }
            }
          }
        }
    }
  }
}
