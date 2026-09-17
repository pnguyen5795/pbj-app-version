import Foundation

/// All times use 60,000 ticks per second. Source positions are relative to
/// the first video presentation timestamp, never to a proxy or transcript.
public let timelineTimescale: Int32 = 60_000

public struct MediaSource: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var fileName: String
    public var sha256: String
    public var duration: Int64
    public var mediaStart: Int64
    public var hasAudio: Bool
    public var kind: String?
    public init(id: String = UUID().uuidString, fileName: String, sha256: String, duration: Int64, mediaStart: Int64 = 0, hasAudio: Bool) {
        self.id = id; self.fileName = fileName; self.sha256 = sha256
        self.duration = duration; self.mediaStart = mediaStart; self.hasAudio = hasAudio
    }
}

public struct TimelineClip: Codable, Equatable, Identifiable, Sendable {
    public enum TrimEdge: Sendable { case start, end }
    public var id: String
    public var sourceID: String
    public var sourceIn: Int64
    public var sourceDuration: Int64
    public var outputStart: Int64
    public var volume: Float
    public var muted: Bool
    public var fit: String
    public var speed: Double?
    public var rotation: Int?
    public var playbackRate: Double { speed ?? 1 }
    public var outputDuration: Int64 {
        let value = Double(sourceDuration) / playbackRate
        guard value.isFinite, value > 0, value < Double(Int64.max) else { return 0 }
        return Int64(value.rounded())
    }
    public init(id: String = UUID().uuidString, sourceID: String, sourceIn: Int64 = 0, sourceDuration: Int64, outputStart: Int64 = 0, volume: Float = 1, muted: Bool = false, fit: String = "fill") {
        self.id = id; self.sourceID = sourceID; self.sourceIn = sourceIn
        self.sourceDuration = sourceDuration; self.outputStart = outputStart
        self.volume = volume; self.muted = muted; self.fit = fit
    }

    /// Move one edge against the original media, preserving the opposite edge.
    public func trimmed(edge: TrimEdge, by delta: Int64, sourceLength: Int64, minimumDuration: Int64) throws -> Self {
        guard sourceIn >= 0, sourceDuration > 0, sourceIn <= sourceLength,
              sourceDuration <= sourceLength - sourceIn else {
            throw TimelineError.invalid("Clip exceeds source bounds")
        }
        let minimum = min(sourceDuration, max(1, minimumDuration))
        var result = self
        switch edge {
        case .start:
            let movement = min(max(delta, -sourceIn), sourceDuration - minimum)
            result.sourceIn += movement
            result.sourceDuration -= movement
        case .end:
            let movement = min(max(delta, minimum - sourceDuration), sourceLength - sourceIn - sourceDuration)
            result.sourceDuration += movement
        }
        return result
    }
}

public struct Timeline: Codable, Equatable, Sendable {
    public var schemaVersion = 2
    public var id: String
    public var parentID: String?
    public var clips: [TimelineClip]
    public var width = 1080
    public var height = 1920
    public var fps = 30
    public var sounds: [TimelineSound]?
    public var overlays: [TimelineOverlay]?
    public var duration: Int64 { clips.reduce(0) { $0 + $1.outputDuration } }
    public init(id: String = UUID().uuidString, parentID: String? = nil, clips: [TimelineClip]) {
        self.id = id; self.parentID = parentID; self.clips = clips
    }

    public func validate(sources: [MediaSource], eligibleIDs: Set<String>) throws {
        guard [1,2].contains(schemaVersion), width > 0, height > 0, width <= 3840, height <= 3840, fps > 0, fps <= 60 else {
            throw TimelineError.invalid("Unsupported timeline format")
        }
        guard Set(sources.map(\.id)).count == sources.count else { throw TimelineError.invalid("Duplicate source IDs") }
        let lookup = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
        var position: Int64 = 0
        var seen = Set<String>()
        for clip in clips {
            guard seen.insert(clip.id).inserted else { throw TimelineError.invalid("Duplicate clip ID") }
            guard eligibleIDs.contains(clip.sourceID), let source = lookup[clip.sourceID] else {
                throw TimelineError.invalid("Clip uses footage outside this project")
            }
            guard source.kind != "audio", source.kind != "image", source.duration > 0, clip.sourceIn >= 0, clip.sourceDuration > 0,
                  clip.sourceIn <= source.duration, clip.sourceDuration <= source.duration - clip.sourceIn else {
                throw TimelineError.invalid("Clip exceeds source bounds")
            }
            guard clip.playbackRate.isFinite, (0.25...4).contains(clip.playbackRate),
                  [0,90,180,270].contains(clip.rotation ?? 0), clip.outputDuration > 0,
                  clip.outputStart == position, clip.volume.isFinite, (0...2).contains(clip.volume),
                  ["fit", "fill"].contains(clip.fit), position <= Int64.max - clip.outputDuration else {
                throw TimelineError.invalid("Invalid placement or audio settings")
            }
            position += clip.outputDuration
        }
        try validateFinishing(sources: sources.filter { eligibleIDs.contains($0.id) })
    }

    public func validateFinishing(sources: [MediaSource]) throws {
        let lookup = Dictionary(uniqueKeysWithValues: sources.map { ($0.id, $0) })
        var ids = Set(clips.map(\.id))
        for sound in sounds ?? [] {
            guard ids.insert(sound.id).inserted, let source = lookup[sound.sourceID], source.hasAudio,
                  sound.sourceIn >= 0, sound.sourceDuration > 0, sound.sourceIn <= source.duration,
                  sound.sourceDuration <= source.duration - sound.sourceIn, sound.outputStart >= 0,
                  sound.volume.isFinite, (0...2).contains(sound.volume), sound.playbackRate.isFinite, (0.25...4).contains(sound.playbackRate) else { throw TimelineError.invalid("Invalid sound range or original source") }
        }
        for overlay in overlays ?? [] {
            guard ids.insert(overlay.id).inserted, ["text","caption","image","video"].contains(overlay.kind), overlay.start >= 0, overlay.end > overlay.start,
                  overlay.x.isFinite, overlay.y.isFinite, (0...1).contains(overlay.x), (0...1).contains(overlay.y),
                  overlay.width.isFinite, (0.05...1.5).contains(overlay.width), overlay.rotation.isFinite,
                  overlay.opacity.isFinite, (0...1).contains(overlay.opacity), overlay.fontSize.isFinite, (16...200).contains(overlay.fontSize),
                  (overlay.volume ?? 0).isFinite, (0...2).contains(overlay.volume ?? 0),
                  ["Classic","Bold","Minimal"].contains(overlay.style),
                  overlay.color.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) != nil else { throw TimelineError.invalid("Invalid overlay settings") }
            if ["text","caption"].contains(overlay.kind) {
                guard let text = overlay.text, !text.isEmpty, text.count <= 2000 else { throw TimelineError.invalid("Add text for this overlay") }
            } else {
                guard let sourceID = overlay.sourceID, let source = lookup[sourceID] else { throw TimelineError.invalid("Overlay original unavailable") }
                if overlay.kind == "image" { guard source.kind == "image" else { throw TimelineError.invalid("Overlay is not an image") } }
                else {
                    let start = overlay.sourceIn ?? 0
                    guard source.kind != "image", source.kind != "audio", start >= 0, start <= source.duration, overlay.end - overlay.start <= source.duration - start else { throw TimelineError.invalid("Overlay exceeds its original video") }
                }
            }
        }
    }

    public mutating func reflow() {
        var cursor: Int64 = 0
        for index in clips.indices {
            clips[index].outputStart = cursor
            cursor += clips[index].outputDuration
        }
    }

    public mutating func split(clipID: String, at sourceOffset: Int64) throws {
        guard let index = clips.firstIndex(where: { $0.id == clipID }),
              sourceOffset > 0, sourceOffset < clips[index].sourceDuration else {
            throw TimelineError.invalid("Place the playhead inside the selected clip")
        }
        var right = clips[index]
        right.id = UUID().uuidString
        right.sourceIn += sourceOffset
        right.sourceDuration -= sourceOffset
        clips[index].sourceDuration = sourceOffset
        clips.insert(right, at: index + 1)
        reflow()
    }
}

public enum TimelineError: LocalizedError {
    case invalid(String)
    public var errorDescription: String? { switch self { case .invalid(let message): return message } }
}

public struct ProjectDocument: Codable, Equatable, Sendable {
    public var id = UUID().uuidString
    public var title: String
    public var sources: [MediaSource]
    public var history: [Timeline]
    public var historyIndex: Int
    public var current: Timeline { history[historyIndex] }
    public init(title: String, sources: [MediaSource] = [], timeline: Timeline = Timeline(clips: [])) {
        self.title = title; self.sources = sources; self.history = [timeline]; self.historyIndex = 0
    }
    public mutating func commit(_ timeline: Timeline) throws {
        try timeline.validate(sources: sources, eligibleIDs: Set(sources.map(\.id)))
        guard timeline != current else { return }
        var version = timeline
        version.schemaVersion = 2
        version.id = UUID().uuidString
        version.parentID = current.id
        // Abandoned redo entries remain in the archive below; the active branch
        // is represented by this simple linear undo history in the local spike.
        history = Array(history.prefix(historyIndex + 1)) + [version]
        historyIndex = history.count - 1
    }
    public mutating func undo() { if historyIndex > 0 { historyIndex -= 1 } }
    public mutating func redo() { if historyIndex + 1 < history.count { historyIndex += 1 } }
    public func validate() throws {
        guard !history.isEmpty, history.indices.contains(historyIndex) else { throw TimelineError.invalid("Damaged project history") }
        for timeline in history { try timeline.validate(sources: sources, eligibleIDs: Set(sources.map(\.id))) }
    }
}

public struct ProjectStore {
    public let root: URL
    public init(root: URL) { self.root = root }
    public func save(_ project: ProjectDocument) throws {
        try project.validate()
        guard project.history.allSatisfy({ $0.id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil }) else {
            throw TimelineError.invalid("Invalid saved revision identifier")
        }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(project)
        // Keep immutable snapshots so undone or superseded edits stay history.
        let archive = root.appendingPathComponent("revisions", isDirectory: true)
        try FileManager.default.createDirectory(at: archive, withIntermediateDirectories: true)
        for timeline in project.history {
            let destination = archive.appendingPathComponent(timeline.id + ".json")
            if !FileManager.default.fileExists(atPath: destination.path) {
                try JSONEncoder().encode(timeline).write(to: destination, options: .atomic)
            }
        }
        try data.write(to: root.appendingPathComponent("project.json"), options: .atomic)
    }
    public func load() throws -> ProjectDocument {
        let project = try JSONDecoder().decode(ProjectDocument.self, from: Data(contentsOf: root.appendingPathComponent("project.json")))
        try project.validate()
        return project
    }
}
