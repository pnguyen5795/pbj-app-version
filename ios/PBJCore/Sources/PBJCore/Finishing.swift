import Foundation

public struct TimelineSound: Codable, Equatable, Identifiable, Sendable {
  public var id = UUID().uuidString
  public var sourceID: String
  public var sourceIn: Int64
  public var sourceDuration: Int64
  public var outputStart: Int64
  public var volume: Float
  public var speed: Double?
  public var playbackRate: Double { speed ?? 1 }
  public init(
    sourceID: String, sourceIn: Int64 = 0, sourceDuration: Int64, outputStart: Int64 = 0,
    volume: Float = 0.5
  ) {
    self.sourceID = sourceID
    self.sourceIn = sourceIn
    self.sourceDuration = sourceDuration
    self.outputStart = outputStart
    self.volume = volume
  }
}
public struct TimelineOverlay: Codable, Equatable, Identifiable, Sendable {
  public var id = UUID().uuidString
  public var kind: String
  public var start: Int64
  public var end: Int64
  public var text: String?
  public var sourceID: String?
  public var sourceIn: Int64?
  public var x = 0.5
  public var y = 0.8
  public var width = 0.8
  public var rotation = 0.0
  public var opacity = 1.0
  public var fontSize = 56.0
  public var style = "Classic"
  public var color = "#FFFFFF"
  public var volume: Float?
  public init(
    kind: String = "text", start: Int64, end: Int64, text: String? = nil, sourceID: String? = nil
  ) {
    self.kind = kind
    self.start = start
    self.end = end
    self.text = text
    self.sourceID = sourceID
  }
}
public struct TimedWord: Codable, Equatable, Sendable {
  public var word: String
  public var start: Double
  public var end: Double
  public init(word: String, start: Double, end: Double) {
    self.word = word
    self.start = start
    self.end = end
  }
}
public enum CaptionBuilder {
  /// Map original word times through trims, clip order and speed; never use
  /// transcript timestamps directly as output placements.
  public static func overlays(
    timeline: Timeline, wordsBySource: [String: [TimedWord]], style: String = "Classic"
  ) -> [TimelineOverlay] {
    var result: [TimelineOverlay] = []
    var audible = timeline.clips
    for sound in timeline.sounds ?? []
    where sound.volume > 0 && sound.outputStart < timeline.duration {
      let remaining = Int64(
        (Double(timeline.duration - sound.outputStart) * sound.playbackRate).rounded())
      var clip = TimelineClip(
        id: sound.id, sourceID: sound.sourceID, sourceIn: sound.sourceIn,
        sourceDuration: min(sound.sourceDuration, remaining), outputStart: sound.outputStart,
        volume: sound.volume)
      clip.speed = sound.speed
      audible.append(clip)
    }
    for overlay in timeline.overlays ?? []
    where overlay.kind == "video" && (overlay.volume ?? 0) > 0 && overlay.start < timeline.duration
    {
      audible.append(
        TimelineClip(
          id: overlay.id, sourceID: overlay.sourceID ?? "", sourceIn: overlay.sourceIn ?? 0,
          sourceDuration: min(overlay.end, timeline.duration) - overlay.start,
          outputStart: overlay.start, volume: overlay.volume ?? 0))
    }
    for clip in audible where !clip.muted && clip.volume > 0 {
      let begin = Double(clip.sourceIn) / 60000
      let end = Double(clip.sourceIn + clip.sourceDuration) / 60000
      let words = (wordsBySource[clip.sourceID] ?? []).filter {
        $0.start >= begin - 0.02 && $0.end <= end + 0.02 && $0.end >= $0.start
      }
      var group: [TimedWord] = []
      func appendGroup() {
        guard let first = group.first, let last = group.last else { return }
        let start =
          clip.outputStart
          + Int64(((max(begin, first.start) - begin) / clip.playbackRate * 60000).rounded())
        let finish = min(
          clip.outputStart + clip.outputDuration,
          clip.outputStart
            + Int64(
              ((min(end, max(last.end, last.start + 0.1)) - begin) / clip.playbackRate * 60000)
                .rounded()))
        if finish > start {
          var overlay = TimelineOverlay(
            kind: "caption", start: start, end: finish,
            text: group.map(\.word).joined(separator: " "))
          overlay.style = style
          result.append(overlay)
        }
        group = []
      }
      for word in words {
        if let last = group.last, let first = group.first,
          group.count >= 6 || word.start - last.end > 0.65 || word.end - first.start > 2.5
        {
          appendGroup()
        }
        group.append(word)
        if word.word.hasSuffix(".") || word.word.hasSuffix("!") || word.word.hasSuffix("?") {
          appendGroup()
        }
      }
      appendGroup()
    }
    return result.sorted { $0.start < $1.start }
  }
}
