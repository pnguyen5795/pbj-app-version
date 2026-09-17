import Foundation

/// A local transport adapter for validated planner output. The app keeps its
/// own originals and document; opening a new cut never replaces another project.
public enum PlannedProjectImport {
    public static func install(bundle: URL, library: URL) async throws -> URL {
        let decoder = JSONDecoder()
        let timeline = try decoder.decode(Timeline.self, from: Data(contentsOf: bundle.appendingPathComponent("timeline.json")))
        let sources = try decoder.decode([MediaSource].self, from: Data(contentsOf: bundle.appendingPathComponent("sources.json")))
        try timeline.validate(sources: sources, eligibleIDs: Set(sources.map(\.id)))
        guard !timeline.clips.isEmpty, UUID(uuidString: timeline.id) != nil,
              sources.allSatisfy({ UUID(uuidString: $0.id) != nil && !$0.fileName.contains("/") && !$0.fileName.contains("\\") }) else {
            throw TimelineError.invalid("Invalid planned project manifest")
        }
        let destination = library.appendingPathComponent(timeline.id, isDirectory: true)
        if FileManager.default.fileExists(atPath: destination.path) {
            let saved = try ProjectStore(root: destination).load()
            guard saved.history.first == timeline, sources.allSatisfy({ saved.sources.contains($0) }) else {
                throw TimelineError.invalid("Another project already uses this planned revision ID")
            }
            // Retain all user edits when the same planned revision is delivered again.
            return destination
        }
        try FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        let staging = library.appendingPathComponent(".import-" + UUID().uuidString, isDirectory: true)
        do {
            let media = staging.appendingPathComponent("media", isDirectory: true)
            try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
            for source in sources {
                try Task.checkCancellation()
                let name = source.id + "." + (source.fileName as NSString).pathExtension
                let from = bundle.appendingPathComponent("media").appendingPathComponent(name)
                let to = media.appendingPathComponent(name)
                try FileManager.default.copyItem(at: from, to: to)
                let actual = try await MediaImport.inspect(to, id: source.id)
                guard actual.sha256 == source.sha256, actual.duration == source.duration,
                      actual.mediaStart == source.mediaStart, actual.hasAudio == source.hasAudio else {
                    throw TimelineError.invalid("Planned footage does not match the original: \(source.fileName)")
                }
            }
            let project = ProjectDocument(title: "Flight rough cut", sources: sources, timeline: timeline)
            try ProjectStore(root: staging).save(project)
            try FileManager.default.moveItem(at: staging, to: destination)
            return destination
        } catch {
            try? FileManager.default.removeItem(at: staging)
            throw error
        }
    }
}
