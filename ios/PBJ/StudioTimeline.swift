import AVFoundation
import PBJCore
import SwiftUI

private let purple = Color(red: 139 / 255, green: 92 / 255, blue: 246 / 255)

struct StudioTimeline: View {
  @EnvironmentObject private var editor: EditorModel
  @Environment(\.scenePhase) private var scenePhase
  let add: () -> Void
  @State private var timelineScale = 40.0
  @State private var zoomStart: Double?
  @State private var scrubStart: Double?
  @State private var trimDrag: ClipTrimDrag?
  @State private var reorderingID: String?
  @State private var reorderTranslation = 0.0
  @State private var reorderTarget: Int?
  @GestureState private var reorderGestureActive = false

  var body: some View {
    VStack(spacing: 0) {
      GeometryReader { geometry in track(width: geometry.size.width) }.frame(height: 112)
      HStack(spacing: 8) {
        Text(
          reorderingID == nil
            ? "Pinch to zoom · Hold a clip to move" : "Drag to move · Release to place"
        ).font(.system(size: 11)).foregroundStyle(.secondary)
        Spacer()
        Button {
          changeZoom(0.5)
        } label: {
          Image(systemName: "minus.magnifyingglass").frame(width: 44, height: 32)
        }
        .accessibilityLabel("Zoom out timeline")
        Button {
          changeZoom(2)
        } label: {
          Image(systemName: "plus.magnifyingglass").frame(width: 44, height: 32)
        }
        .accessibilityLabel("Zoom in timeline")
      }.padding(.horizontal, 20).disabled(editor.busy || trimDrag != nil)
    }
  }
  private func track(width: Double) -> some View {
    let scale = timelineScale
    let position = trimDrag?.position ?? editor.position
    return ZStack(alignment: .topLeading) {
      Color.clear.contentShape(Rectangle()).onTapGesture { editor.selectedID = nil }
      ruler(width: width, position: position, scale: scale)
      ForEach(editor.timeline.clips) { original in
        let clip = trimDrag?.original.id == original.id ? trimDrag!.draft : original
        let shift =
          trimDrag?.original.id == original.id && trimDrag?.edge == .start
          ? Double(clip.sourceIn - original.sourceIn) / clip.playbackRate / 60000 * scale : 0
        let clipWidth = max(1, Double(clip.outputDuration) / 60000 * scale)
        // Visual separation only: keep duration widths, hit targets and trim
        // coordinates unchanged so rounding never introduces playback gaps.
        let clipOutline = RoundedRectangle(cornerRadius: 8, style: .continuous)
          .inset(by: min(1.5, clipWidth / 4))
        let x = width / 2 + (Double(reorderOutputStart(original)) / 60000 - position) * scale + shift
        if reorderingID == original.id || (x + clipWidth >= -60 && x <= width + 60) {
          TimelineFilmstrip(
            clip: clip, source: source(clip), url: editor.sourceURL(clip.sourceID),
            scale: scale, viewportWidth: width, offset: x
          )
          .frame(width: clipWidth, height: 64).clipped()
          .overlay(alignment: .topLeading) {
            if editor.selectedID == clip.id {
              Text(String(format: "%.1fs", Double(clip.outputDuration) / 60000))
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(.white)
                .padding(4).background(.black.opacity(0.5), in: RoundedRectangle(cornerRadius: 4))
                .padding(3).offset(x: max(0, -x))
            }
          }
          .clipShape(clipOutline)
          .overlay(
            clipOutline.strokeBorder(
              editor.selectedID == clip.id ? purple : .white,
              lineWidth: editor.selectedID == clip.id ? 2 : 1)
          )
          .contentShape(Rectangle())
          .onTapGesture {
            reorderingID = nil
            select(original)
          }
          // A hold must coexist with the quick tap used for selection.
          // The viewport pan already ignores movement while a clip is lifted.
          .simultaneousGesture(reorderGesture(original, scale: scale))
          .accessibilityElement(children: .ignore)
          .accessibilityLabel(source(clip)?.fileName ?? "Video clip")
          .accessibilityAddTraits(.isButton)
          .accessibilityAction { select(original) }
          .accessibilityAction(named: "Move earlier") { moveAccessibly(original, by: -1) }
          .accessibilityAction(named: "Move later") { moveAccessibly(original, by: 1) }
          .scaleEffect(reorderingID == clip.id ? 1.04 : 1)

          .shadow(color: .black.opacity(reorderingID == clip.id ? 0.3 : 0), radius: 8, y: 4)
          .offset(
            x: x + (reorderingID == clip.id ? reorderTranslation : 0),
            y: reorderingID == clip.id ? 20 : 28
          )
          .zIndex(reorderingID == clip.id ? 5 : 0)
        }
      }
      if let id = reorderingID, let lifted = editor.timeline.clips.first(where: { $0.id == id }),
        let target = reorderTarget {
        let remaining = editor.timeline.clips.filter { $0.id != id }
        let start = remaining.prefix(target).reduce(Int64(0)) { $0 + $1.outputDuration }
        let x = width / 2 + (Double(start) / 60000 - position) * scale
        RoundedRectangle(cornerRadius: 8, style: .continuous).fill(purple.opacity(0.12))
          .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(purple, style: StrokeStyle(lineWidth: 2, dash: [4])))
          .frame(width: max(2, Double(lifted.outputDuration) / 60000 * scale), height: 64)
          .offset(x: x, y: 28).allowsHitTesting(false)
      }
      // Handles sit above all clip bodies, including neighboring clips.
      if let original = editor.selected, reorderingID == nil {
        let clip = trimDrag?.draft ?? original
        let shift =
          trimDrag?.edge == .start
          ? Double(clip.sourceIn - original.sourceIn) / clip.playbackRate / 60000 * scale : 0
        let x = width / 2 + (Double(original.outputStart) / 60000 - position) * scale + shift
        let clipWidth = Double(clip.outputDuration) / 60000 * scale
        trimHandle(original, edge: .start, scale: scale).offset(x: x - 44, y: 28)
        trimHandle(original, edge: .end, scale: scale).offset(x: x + clipWidth, y: 28)
        Text(String(format: "%.2fs · drag either end", Double(clip.outputDuration) / 60000))
          .font(.system(size: 11, weight: .medium)).foregroundStyle(purple)
          .frame(width: width).offset(y: 94).allowsHitTesting(false)
      }
      let endX = width / 2 + (editor.seconds - position) * scale
      if endX >= -40 && endX <= width {
        Button(action: add) {
          Image(systemName: "plus").font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.black).frame(width: 32, height: 32).background(
              .white, in: RoundedRectangle(cornerRadius: 8))
        }
        .frame(width: 44, height: 64).offset(x: endX + 48, y: 28)
        .disabled(editor.busy || trimDrag != nil).accessibilityLabel("Add clips at end")
      }
      Rectangle().fill(.black).frame(width: 1, height: 108).offset(x: width / 2).allowsHitTesting(
        false)
    }.frame(width: width, alignment: .topLeading).clipped()
      .onDisappear { resetInteractions() }
      .onChange(of: scenePhase) { _, phase in
        // Interrupted gestures do not reliably deliver onEnded. Never leave
        // a draft trim/zoom locking out taps when the app becomes active again.
        if phase != .active { resetInteractions() }
      }
      .onChange(of: reorderGestureActive) { _, active in
        if !active { resetReorder() }
      }
      .coordinateSpace(name: "timeline")
      // The pan recognizer lives on this stationary viewport. Moving or
      // culling a thumbnail clip must not reset the finger's translation.
      .gesture(scrubGesture(scale: scale, width: width))
      .simultaneousGesture(
        MagnifyGesture()
          .onChanged { value in
            guard trimDrag == nil, reorderingID == nil, !editor.busy else { return }
            if zoomStart == nil {
              zoomStart = timelineScale
              scrubStart = nil
              editor.endScrub()
              editor.player.pause()
            }
            timelineScale = clampedScale((zoomStart ?? timelineScale) * value.magnification)
          }.onEnded { _ in
            zoomStart = nil
            scrubStart = nil
          }
      )
      .accessibilityElement(children: .contain).accessibilityLabel(
        "Timeline. Drag to scrub. Hold a clip to pick it up, then drag and release to reorder. Select a clip and drag its ends to trim.")
  }

  private func select(_ clip: TimelineClip) {
    guard !editor.busy, trimDrag == nil else { return }
    editor.player.pause()
    editor.selectedID = clip.id
  }
  private func clampedScale(_ scale: Double) -> Double { min(320, max(0.5, scale)) }
  private func changeZoom(_ factor: Double) {
    guard trimDrag == nil, reorderingID == nil, !editor.busy else { return }
    editor.player.pause()
    timelineScale = clampedScale(timelineScale * factor)
  }
  private func source(_ clip: TimelineClip) -> MediaSource? {
    editor.document.sources.first { $0.id == clip.sourceID }
  }
  private func ruler(width: Double, position: Double, scale: Double) -> some View {
    let intervals: [Double] = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800]
    let interval = intervals.first { $0 * scale >= 52 } ?? 1800
    let first = max(0, Int(floor((position - width / 2 / scale) / interval)))
    let last = max(first, Int(ceil(min(editor.seconds, position + width / 2 / scale) / interval)))
    return ZStack(alignment: .topLeading) {
      ForEach(first...last, id: \.self) { index in
        let seconds = Double(index) * interval
        VStack(spacing: 3) {
          Text(
            interval < 1
              ? String(format: "%.1f", seconds)
              : String(format: "%02d:%02d", Int(seconds) / 60, Int(seconds) % 60)
          )
          .font(.system(size: 10)).monospacedDigit().foregroundStyle(.secondary)
          Rectangle().fill(.secondary.opacity(0.4)).frame(width: 1, height: 4)
        }.frame(width: 48).offset(x: width / 2 + (seconds - position) * scale - 24, y: 5)
      }
    }.allowsHitTesting(false).accessibilityHidden(true)
  }
  private func scrubGesture(scale: Double, width: Double) -> some Gesture {
    DragGesture(minimumDistance: 8, coordinateSpace: .named("timeline"))
      .onChanged { value in
        guard trimDrag == nil, zoomStart == nil, !editor.busy else { return }
        guard reorderingID == nil else { return }
        if scrubStart == nil {
          scrubStart = editor.position
          editor.beginScrub()
        }
        editor.scrub(to: (scrubStart ?? 0) - value.translation.width / scale)
      }.onEnded { value in
        guard reorderingID == nil else { return }
        if let start = scrubStart, zoomStart == nil {
          editor.scrub(to: start - value.translation.width / scale)
          editor.endScrub()
        }
        scrubStart = nil
      }
  }
  private func reorderGesture(_ clip: TimelineClip, scale: Double) -> some Gesture {
    LongPressGesture(minimumDuration: 0.4, maximumDistance: 8)
      .sequenced(before: DragGesture(minimumDistance: 0, coordinateSpace: .named("timeline")))
      .updating($reorderGestureActive) { value, active, _ in
        switch value {
        case .first(true), .second(true, _): active = true
        default: break
        }
      }
      .onChanged { value in
        guard !editor.busy, trimDrag == nil, zoomStart == nil, scrubStart == nil else { return }
        switch value {
        case .second(true, let drag):
          beginReorder(clip)
          guard let drag else { return }
          reorderTranslation = drag.translation.width
          let center = Double(clip.outputStart) + Double(clip.outputDuration) / 2
            + drag.translation.width / scale * 60000
          let target = editor.timeline.clips.filter { $0.id != clip.id }.filter {
            center > Double($0.outputStart) + Double($0.outputDuration) / 2
          }.count
          if target != reorderTarget {
            withAnimation(.easeInOut(duration: 0.15)) { reorderTarget = target }
            UISelectionFeedbackGenerator().selectionChanged()
          }
        default: break
        }
      }
      .onEnded { value in
        if case .second(true, _) = value, reorderingID == clip.id, let target = reorderTarget,
          editor.timeline.clips.firstIndex(where: { $0.id == clip.id }) != target {
          editor.moveClip(clip.id, to: target)
          UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
        resetReorder()
      }
  }
  private func beginReorder(_ clip: TimelineClip) {
    guard reorderingID == nil else { return }
    editor.player.pause()
    editor.endScrub()
    editor.selectedID = clip.id
    reorderTranslation = 0
    withAnimation(.easeOut(duration: 0.12)) {
      reorderingID = clip.id
      reorderTarget = editor.timeline.clips.firstIndex(where: { $0.id == clip.id })
    }
    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
  }
  private func resetReorder() {
    reorderingID = nil
    reorderTranslation = 0
    reorderTarget = nil
  }
  private func resetInteractions() {
    editor.endScrub()
    scrubStart = nil
    zoomStart = nil
    trimDrag = nil
    resetReorder()
  }
  private func reorderOutputStart(_ clip: TimelineClip) -> Int64 {
    guard let id = reorderingID, id != clip.id, let target = reorderTarget,
      let lifted = editor.timeline.clips.first(where: { $0.id == id }) else { return clip.outputStart }
    var preview = editor.timeline.clips.filter { $0.id != id }
    preview.insert(lifted, at: min(target, preview.count))
    return preview.prefix(while: { $0.id != clip.id }).reduce(Int64(0)) { $0 + $1.outputDuration }
  }
  private func moveAccessibly(_ clip: TimelineClip, by delta: Int) {
    guard !editor.busy, let index = editor.timeline.clips.firstIndex(where: { $0.id == clip.id }),
      editor.timeline.clips.indices.contains(index + delta) else { return }
    editor.selectedID = clip.id
    editor.moveClip(clip.id, to: index + delta)
  }
  private func trimHandle(_ clip: TimelineClip, edge: TimelineClip.TrimEdge, scale: Double)
    -> some View
  {
    ZStack(alignment: edge == .start ? .trailing : .leading) {
      Color.clear
      RoundedRectangle(cornerRadius: 5).fill(purple).frame(width: 16, height: 64)
        .overlay { Capsule().fill(.white).frame(width: 3, height: 24) }
    }.frame(width: 44, height: 64).contentShape(Rectangle())
      .accessibilityElement().accessibilityLabel(edge == .start ? "Trim start" : "Trim end")
      .accessibilityValue(
        String(
          format: "%.2f seconds",
          Double(edge == .start ? clip.sourceIn : clip.sourceIn + clip.sourceDuration) / 60000)
      )
      .accessibilityAdjustableAction { direction in
        let delta: Int64 = direction == .increment ? 6000 : -6000
        guard let source = editor.document.sources.first(where: { $0.id == clip.sourceID }),
          let draft = try? clip.trimmed(
            edge: edge, by: delta, sourceLength: source.duration,
            minimumDuration: Int64(
              (60000 / Double(editor.timeline.fps) * clip.playbackRate).rounded())), draft != clip
        else { return }
        commitTrim(draft)
      }
      .highPriorityGesture(
        DragGesture(minimumDistance: 0, coordinateSpace: .named("timeline"))
          .onChanged { value in
            guard !editor.busy, zoomStart == nil else { return }
            if trimDrag == nil {
              editor.player.pause()
              trimDrag = ClipTrimDrag(
                original: clip, draft: clip, edge: edge, position: editor.position)
            }
            guard var drag = trimDrag,
              let source = editor.document.sources.first(where: { $0.id == clip.sourceID })
            else { return }
            let seconds = value.translation.width / scale * clip.playbackRate
            let boundedSeconds = min(
              max(seconds, -Double(source.duration) / 60000), Double(source.duration) / 60000)
            let delta = Int64((boundedSeconds * 60000).rounded())
            if let draft = try? drag.original.trimmed(
              edge: edge, by: delta, sourceLength: source.duration,
              minimumDuration: Int64(
                (60000 / Double(editor.timeline.fps) * clip.playbackRate).rounded()))
            {
              drag.draft = draft
              trimDrag = drag
            }
          }.onEnded { _ in
            guard let drag = trimDrag else { return }
            trimDrag = nil
            if drag.draft != drag.original { commitTrim(drag.draft) }
          })
  }
  private func commitTrim(_ clip: TimelineClip) {
    editor.trim(clip)
  }
}

private struct ClipTrimDrag {
  let original: TimelineClip
  var draft: TimelineClip
  let edge: TimelineClip.TrimEdge
  let position: Double
}
