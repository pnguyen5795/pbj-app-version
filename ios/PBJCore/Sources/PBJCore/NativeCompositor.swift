import AVFoundation
import CoreGraphics
import Foundation

public struct PreparedTimeline {
  public let composition: AVMutableComposition
  public let videoComposition: AVMutableVideoComposition
  public let audioMix: AVMutableAudioMix
  public let revisionID: String
  public let expectedDuration: Double
  public let expectsAudio: Bool
  public func playerItem() -> AVPlayerItem {
    let item = AVPlayerItem(asset: composition.copy() as! AVComposition)
    item.videoComposition = videoComposition.copy() as? AVVideoComposition
    item.audioMix = audioMix.copy() as? AVAudioMix
    return item
  }
}

/// Review, Studio and export consume this same composition. No cloud renderer.
public enum NativeCompositor {
  private static func time(_ ticks: Int64) -> CMTime {
    CMTime(value: ticks, timescale: timelineTimescale)
  }

  public static func prepare(_ timeline: Timeline, sources: [MediaSource], urls: [String: URL])
    async throws -> PreparedTimeline
  {
    try timeline.validate(sources: sources, eligibleIDs: Set(sources.map(\.id)))
    guard !timeline.clips.isEmpty else {
      throw TimelineError.invalid("Add footage before playing or exporting")
    }
    let sourceMap = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
    let composition = AVMutableComposition()
    composition.naturalSize = CGSize(width: timeline.width, height: timeline.height)
    guard
      let videoTrack = composition.addMutableTrack(
        withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
    else {
      throw TimelineError.invalid("Could not create video composition")
    }
    var instructions: [AVMutableVideoCompositionInstruction] = []
    var baseTransforms: [String: (CGAffineTransform, CGFloat)] = [:]
    var audioParameters: [AVMutableAudioMixInputParameters] = []
    var audioWasInserted = false
    var baseAudioTracks: [Int: (track: AVMutableCompositionTrack, parameters: AVMutableAudioMixInputParameters)] = [:]
    // A source can appear in many shots. Reuse its AVFoundation metadata within
    // this preparation, without retaining assets from older project revisions.
    var assets: [String: AVURLAsset] = [:]
    func asset(for id: String, url: URL) -> AVURLAsset {
      if let existing = assets[id] { return existing }
      let loaded = AVURLAsset(url: url)
      assets[id] = loaded
      return loaded
    }
    for (clipIndex, clip) in timeline.clips.enumerated() {
      try Task.checkCancellation()
      guard let url = urls[clip.sourceID], let source = sourceMap[clip.sourceID],
        FileManager.default.fileExists(atPath: url.path)
      else {
        throw TimelineError.invalid(
          "An original source is unavailable. Restore or download it, then retry.")
      }
      let asset = asset(for: clip.sourceID, url: url)
      guard let track = try await asset.loadTracks(withMediaType: .video).first else {
        throw TimelineError.invalid("An original video track is unreadable")
      }
      let sourceRange = CMTimeRange(
        start: time(source.mediaStart + clip.sourceIn), duration: time(clip.sourceDuration))
      let placement = time(clip.outputStart)
      try videoTrack.insertTimeRange(sourceRange, of: track, at: placement)
      videoTrack.scaleTimeRange(
        CMTimeRange(start: placement, duration: sourceRange.duration),
        toDuration: time(clip.outputDuration))
      let transform = try await track.load(.preferredTransform).concatenating(
        CGAffineTransform(rotationAngle: CGFloat(clip.rotation ?? 0) * .pi / 180))
      let naturalSize = try await track.load(.naturalSize)
      let bounds = CGRect(origin: .zero, size: naturalSize).applying(transform)
      let canvas = CGSize(width: timeline.width, height: timeline.height)
      let x = canvas.width / bounds.width
      let y = canvas.height / bounds.height
      let scale = clip.fit == "fit" ? min(x, y) : max(x, y)
      let normalized = transform.concatenating(
        CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY)
      )
      .concatenating(CGAffineTransform(scaleX: scale, y: scale))
      .concatenating(
        CGAffineTransform(
          translationX: (canvas.width - bounds.width * scale) / 2,
          y: (canvas.height - bounds.height * scale) / 2))
      baseTransforms[clip.id] = (normalized, naturalSize.height)
      let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
      layer.setTransform(normalized, at: placement)
      let instruction = AVMutableVideoCompositionInstruction()
      instruction.timeRange = CMTimeRange(start: placement, duration: time(clip.outputDuration))
      instruction.layerInstructions = [layer]
      instruction.backgroundColor = CGColor(red: 0, green: 0, blue: 0, alpha: 1)
      instructions.append(instruction)

      if let audio = try await asset.loadTracks(withMediaType: .audio).first {
        let availableAudio = try await audio.load(.timeRange)
        let overlap = CMTimeRangeGetIntersection(sourceRange, otherRange: availableAudio)
        if overlap.duration.seconds > 0 {
          // Alternate two tracks so adjacent clips never share an automation
          // boundary. The AAC renderer can interpolate across a discontinuous
          // volume/mute change on one track even with constant volume ranges.
          // Two tracks keep decoder/mixer work bounded as shot count grows.
          let lane = clipIndex % 2
          if baseAudioTracks[lane] == nil {
            guard let track = composition.addMutableTrack(
              withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            else { throw TimelineError.invalid("Could not add original sound") }
            let parameters = AVMutableAudioMixInputParameters(track: track)
            baseAudioTracks[lane] = (track, parameters)
            audioParameters.append(parameters)
          }
          guard let (destination, parameters) = baseAudioTracks[lane] else {
            throw TimelineError.invalid("Could not add original sound")
          }
          let offset = CMTimeMultiplyByFloat64(
            CMTimeSubtract(overlap.start, sourceRange.start), multiplier: 1 / clip.playbackRate)
          let audioStart = CMTimeAdd(placement, offset)
          try destination.insertTimeRange(overlap, of: audio, at: audioStart)
          destination.scaleTimeRange(
            CMTimeRange(start: audioStart, duration: overlap.duration),
            toDuration: CMTimeMultiplyByFloat64(overlap.duration, multiplier: 1 / clip.playbackRate)
          )
          let volume = clip.muted ? 0 : clip.volume
          // Explicit constant ranges prevent AVFoundation from interpolating
          // between adjacent clips' volume settings (including muted clips).
          parameters.setVolumeRamp(fromStartVolume: volume, toEndVolume: volume,
            timeRange: CMTimeRange(start: placement, duration: time(clip.outputDuration)))
          audioWasInserted = true
        }
      }
    }
    for sound in timeline.sounds ?? [] {
      try Task.checkCancellation()
      if sound.outputStart >= timeline.duration { continue }
      guard let source = sourceMap[sound.sourceID], let url = urls[sound.sourceID] else {
        throw TimelineError.invalid("Sound original unavailable")
      }
      let asset = asset(for: sound.sourceID, url: url)
      guard let audio = try await asset.loadTracks(withMediaType: .audio).first else {
        throw TimelineError.invalid("Imported sound is unreadable")
      }
      let length = min(
        sound.sourceDuration,
        Int64((Double(timeline.duration - sound.outputStart) * sound.playbackRate).rounded()))
      let requested = CMTimeRange(
        start: time(source.mediaStart + sound.sourceIn), duration: time(length))
      let range = CMTimeRangeGetIntersection(
        requested, otherRange: try await audio.load(.timeRange))
      if range.duration.seconds <= 0 { continue }
      let soundStart = CMTimeAdd(
        time(sound.outputStart),
        CMTimeMultiplyByFloat64(
          CMTimeSubtract(range.start, requested.start), multiplier: 1 / sound.playbackRate))
      guard
        let track = composition.addMutableTrack(
          withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
      else { throw TimelineError.invalid("Could not add sound") }
      try track.insertTimeRange(range, of: audio, at: soundStart)
      track.scaleTimeRange(
        CMTimeRange(start: soundStart, duration: range.duration),
        toDuration: CMTimeMultiplyByFloat64(range.duration, multiplier: 1 / sound.playbackRate))
      let parameters = AVMutableAudioMixInputParameters(track: track)
      parameters.setVolume(sound.volume, at: time(sound.outputStart))
      audioParameters.append(parameters)
      audioWasInserted = true
    }
    var overlayLayers: [OverlayRenderLayer] = []
    let canvas = CGSize(width: timeline.width, height: timeline.height)
    for overlay in timeline.overlays ?? [] where overlay.start < timeline.duration {
      try Task.checkCancellation()
      if ["text", "caption"].contains(overlay.kind) {
        overlayLayers.append(
          OverlayRenderLayer(
            overlay: overlay, image: try OverlayArtwork.text(overlay, canvas: canvas), trackID: nil,
            sourceTransform: .identity, sourceHeight: 0))
      } else {
        guard let id = overlay.sourceID, let url = urls[id], let source = sourceMap[id] else {
          throw TimelineError.invalid("Overlay original is unavailable")
        }
        if overlay.kind == "image" {
          overlayLayers.append(
            OverlayRenderLayer(
              overlay: overlay, image: try OverlayArtwork.image(url), trackID: nil,
              sourceTransform: .identity, sourceHeight: 0))
        } else {
          let asset = asset(for: id, url: url)
          guard let original = try await asset.loadTracks(withMediaType: .video).first,
            let track = composition.addMutableTrack(
              withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid)
          else { throw TimelineError.invalid("Overlay video is unreadable") }
          let range = CMTimeRange(
            start: time(source.mediaStart + (overlay.sourceIn ?? 0)),
            duration: time(min(overlay.end, timeline.duration) - overlay.start))
          try track.insertTimeRange(range, of: original, at: time(overlay.start))
          let transform = try await original.load(.preferredTransform)
          let size = try await original.load(.naturalSize)
          overlayLayers.append(
            OverlayRenderLayer(
              overlay: overlay, image: nil, trackID: track.trackID, sourceTransform: transform,
              sourceHeight: size.height))
          if (overlay.volume ?? 0) > 0,
            let audio = try await asset.loadTracks(withMediaType: .audio).first,
            let target = composition.addMutableTrack(
              withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
          {
            let overlap = CMTimeRangeGetIntersection(
              range, otherRange: try await audio.load(.timeRange))
            if overlap.duration.seconds > 0 {
              let start = CMTimeAdd(time(overlay.start), CMTimeSubtract(overlap.start, range.start))
              try target.insertTimeRange(overlap, of: audio, at: start)
              let parameters = AVMutableAudioMixInputParameters(track: target)
              parameters.setVolume(overlay.volume ?? 0, at: start)
              audioParameters.append(parameters)
              audioWasInserted = true
            }
          }
        }
      }
    }
    let video = AVMutableVideoComposition()
    video.renderSize = CGSize(width: timeline.width, height: timeline.height)
    video.renderScale = 1
    video.sourceTrackIDForFrameTiming = kCMPersistentTrackID_Invalid
    video.frameDuration = CMTime(value: 1, timescale: Int32(timeline.fps))
    video.instructions = instructions
    if !overlayLayers.isEmpty {
      video.customVideoCompositorClass = PBJVideoCompositor.self
      var boundaries = Set<Int64>([0, timeline.duration])
      for clip in timeline.clips {
        boundaries.insert(clip.outputStart)
        boundaries.insert(clip.outputStart + clip.outputDuration)
      }
      for layer in overlayLayers {
        boundaries.insert(min(layer.overlay.start, timeline.duration))
        boundaries.insert(min(layer.overlay.end, timeline.duration))
      }
      let times = boundaries.sorted()
      var custom: [PBJVideoInstruction] = []
      for index in 0..<(times.count - 1) {
        let start = times[index]
        let end = times[index + 1]
        guard end > start,
          let clip = timeline.clips.first(where: {
            $0.outputStart <= start && $0.outputStart + $0.outputDuration > start
          }), let transform = baseTransforms[clip.id]
        else { continue }
        let active = overlayLayers.filter { $0.overlay.start <= start && $0.overlay.end > start }
        custom.append(
          PBJVideoInstruction(
            timeRange: CMTimeRange(start: time(start), duration: time(end - start)),
            baseTrackID: videoTrack.trackID, baseTransform: transform.0, baseHeight: transform.1,
            canvas: canvas, overlays: active))
      }
      video.instructions = custom
    }
    video.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
    video.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
    video.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
    let audio = AVMutableAudioMix()
    audio.inputParameters = audioParameters
    return PreparedTimeline(
      composition: composition, videoComposition: video, audioMix: audio,
      revisionID: timeline.id,
      expectedDuration: Double(timeline.duration) / Double(timelineTimescale),
      expectsAudio: audioWasInserted)
  }

  public static func export(_ prepared: PreparedTimeline, to url: URL,
    progress: @escaping @Sendable (Double, String) async -> Void = { _, _ in }) async throws
    -> ExportVerification
  {
    try Task.checkCancellation()
    guard !FileManager.default.fileExists(atPath: url.path) else {
      throw TimelineError.invalid("Export destination already exists")
    }
    guard
      let session = AVAssetExportSession(
        asset: prepared.composition, presetName: AVAssetExportPresetHighestQuality)
    else {
      throw TimelineError.invalid("Export is unavailable for these sources")
    }
    session.videoComposition = prepared.videoComposition
    session.audioMix = prepared.audioMix
    session.shouldOptimizeForNetworkUse = true
    do {
      try Task.checkCancellation()
      await progress(0, "Preparing export")
      let monitor = Task {
        for await state in session.states(updateInterval: 0.5) {
          guard !Task.isCancelled else { return }
          if case .exporting(let value) = state {
            await progress(min(0.95, max(0, value.fractionCompleted * 0.95)), "Rendering video")
          }
        }
      }
      do {
        defer { monitor.cancel() }
        // The async AVFoundation API installs its own cancellation handler;
        // cancelling this task cancels the export session as well.
        try Task.checkCancellation()
        try await session.export(to: url, as: .mp4)
        try Task.checkCancellation()
      }
      try Task.checkCancellation()
      await progress(0.96, "Checking video and audio")
      let report = try await verify(
        url, revisionID: prepared.revisionID,
        expectedDuration: prepared.expectedDuration, expectsAudio: prepared.expectsAudio)
      try Task.checkCancellation()
      await progress(1, "Export verified")
      return report
    } catch {
      try? FileManager.default.removeItem(at: url)
      if Task.isCancelled { throw CancellationError() }
      throw error
    }
  }

  public static func verify(
    _ url: URL, revisionID: String, expectedDuration: Double, expectsAudio: Bool
  ) async throws -> ExportVerification {
    try Task.checkCancellation()
    let asset = AVURLAsset(url: url)
    let duration = try await asset.load(.duration).seconds
    let videos = try await asset.loadTracks(withMediaType: .video)
    let audios = try await asset.loadTracks(withMediaType: .audio)
    guard duration.isFinite, abs(duration - expectedDuration) <= max(0.1, 2.0 / 30),
      !videos.isEmpty,
      !expectsAudio || !audios.isEmpty
    else { throw TimelineError.invalid("Export streams or duration did not verify") }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 320, height: 320)
    for fraction in [0.1, 0.5, 0.9] {
      try Task.checkCancellation()
      _ = try await generator.image(
        at: CMTime(seconds: duration * fraction, preferredTimescale: timelineTimescale))
    }
    if expectsAudio, let audio = audios.first {
      try Task.checkCancellation()
      let reader = try AVAssetReader(asset: asset)
      let output = AVAssetReaderTrackOutput(
        track: audio, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
      guard reader.canAdd(output) else {
        throw TimelineError.invalid("Cannot decode exported audio")
      }
      reader.add(output)
      guard reader.startReading(), output.copyNextSampleBuffer() != nil else {
        throw TimelineError.invalid("Exported audio did not decode")
      }
      reader.cancelReading()
    }
    try Task.checkCancellation()
    return ExportVerification(
      revisionID: revisionID, durationSeconds: duration, hasAudio: !audios.isEmpty,
      decodedVideoSamples: 3, sha256: try MediaImport.hash(url))
  }
}

public struct ExportVerification: Codable, Sendable {
  public let revisionID: String
  public let durationSeconds: Double
  public let hasAudio: Bool
  public let decodedVideoSamples: Int
  public let sha256: String
}
