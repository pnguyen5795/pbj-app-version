import XCTest
@testable import PBJCore

final class TimelineTests: XCTestCase {
    let source = MediaSource(id: "raw", fileName: "raw.mov", sha256: "test", duration: 600_000, hasAudio: true)
    func testTrimHandlesStopAtOriginalBoundsAndRestoreFootage() throws {
        let original = TimelineClip(id: "clip", sourceID: "raw", sourceDuration: 600_000, volume: 0.4, muted: true)
        XCTAssertEqual(try original.trimmed(edge:.end,by:300_000,sourceLength:600_000,minimumDuration:2000), original)
        XCTAssertEqual(try original.trimmed(edge:.start,by:Int64.min,sourceLength:600_000,minimumDuration:2000), original)
        let shortened = try original.trimmed(edge:.start,by:120_000,sourceLength:600_000,minimumDuration:2000)
        XCTAssertEqual(shortened.sourceIn,120_000)
        XCTAssertEqual(shortened.sourceIn+shortened.sourceDuration,600_000)
        let both = try shortened.trimmed(edge:.end,by:-180_000,sourceLength:600_000,minimumDuration:2000)
        XCTAssertEqual(both.sourceIn,120_000)
        XCTAssertEqual(both.sourceDuration,300_000)
        let restoredEnd = try both.trimmed(edge:.end,by:Int64.max,sourceLength:600_000,minimumDuration:2000)
        let restored = try restoredEnd.trimmed(edge:.start,by:Int64.min,sourceLength:600_000,minimumDuration:2000)
        XCTAssertEqual(restored,original)
    }
    func testTrimHandlesCannotCrossAndRippleRemainsUndoable() throws {
        let clip = TimelineClip(sourceID:"raw",sourceIn:60_000,sourceDuration:300_000)
        for edge in [TimelineClip.TrimEdge.start,.end] {
            let trimmed = try clip.trimmed(edge:edge,by:edge == .start ? Int64.max : Int64.min,sourceLength:600_000,minimumDuration:2000)
            XCTAssertEqual(trimmed.sourceDuration,2000)
        }
        var timeline = Timeline(clips:[clip,.init(sourceID:"raw",sourceDuration:60_000)])
        timeline.reflow()
        var project = ProjectDocument(title:"Trim",sources:[source],timeline:timeline)
        timeline.clips[0] = try clip.trimmed(edge:.end,by:-120_000,sourceLength:600_000,minimumDuration:2000)
        timeline.reflow()
        try project.commit(timeline)
        XCTAssertEqual(project.current.clips[1].outputStart,180_000)
        project.undo()
        XCTAssertEqual(project.current.clips[0],clip)
        project.redo()
        XCTAssertEqual(project.current.clips[0].sourceDuration,180_000)
    }
    func testReferenceCannotEnterOutput() throws {
        let timeline = Timeline(clips: [.init(sourceID: "reference", sourceDuration: 60_000)])
        XCTAssertThrowsError(try timeline.validate(sources: [source], eligibleIDs: ["raw"]))
    }
    func testNoOpEditPreservesRevisionAndRedoBranch() throws {
        var project = ProjectDocument(title: "No-op", sources: [source], timeline:
            Timeline(clips: [.init(sourceID: "raw", sourceDuration: 120_000)]))
        var changed = project.current
        changed.clips[0].muted = true
        try project.commit(changed)
        let redoRevision = project.current.id
        project.undo()
        let saved = project
        // Re-selecting the existing speed/volume or dropping in the same slot
        // must not create a revision, discard redo, or trigger learning sync.
        try project.commit(project.current)
        XCTAssertEqual(project, saved)
        project.redo()
        XCTAssertEqual(project.current.id, redoRevision)
    }
    func testBoundsAndArithmetic() throws {
        for clip in [TimelineClip(sourceID: "raw", sourceIn: 599_999, sourceDuration: 2),
                     TimelineClip(sourceID: "raw", sourceDuration: 60_000, outputStart: 1),
                     TimelineClip(sourceID: "raw", sourceDuration: 60_000, volume: .nan)] {
            XCTAssertThrowsError(try Timeline(clips: [clip]).validate(sources: [source], eligibleIDs: ["raw"]))
        }
        // Subsecond shots are valid: no provider segment floor leaks into editing.
        try Timeline(clips: [.init(sourceID: "raw", sourceDuration: 600)]).validate(sources: [source], eligibleIDs: ["raw"])
    }
    func testSplitPreservesSourceCoverageAndAudio() throws {
        var timeline = Timeline(clips: [.init(id: "clip", sourceID: "raw", sourceIn: 60_000, sourceDuration: 180_000, volume: 0.4)])
        try timeline.split(clipID: "clip", at: 65_000)
        XCTAssertEqual(timeline.duration, 180_000)
        XCTAssertEqual(timeline.clips[1].sourceIn, 125_000)
        XCTAssertEqual(timeline.clips[1].outputStart, 65_000)
        XCTAssertEqual(timeline.clips[1].volume, 0.4)
        try timeline.validate(sources: [source], eligibleIDs: ["raw"])
    }
    func testSaveReopenUndoRedoAndBranchedArchive() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ProjectStore(root: directory)
        var project = ProjectDocument(title: "Test", sources: [source], timeline: Timeline(clips: [.init(sourceID: "raw", sourceDuration: 120_000)]))
        var edit = project.current
        edit.clips[0].sourceDuration = 60_000
        try project.commit(edit)
        let abandoned = project.current.id
        try store.save(project)
        project = try store.load()
        XCTAssertEqual(project.current.duration, 60_000)
        project.undo()
        XCTAssertEqual(project.current.duration, 120_000)
        project.redo()
        XCTAssertEqual(project.current.duration, 60_000)
        project.undo()
        edit = project.current
        edit.clips[0].muted = true
        try project.commit(edit)
        try store.save(project)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent("revisions/\(abandoned).json").path))
        XCTAssertEqual(try store.load(), project)
    }

    func testRevisionIdentifiersCannotWriteOutsideTheirArchive() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = ProjectStore(root: directory)
        let original = ProjectDocument(title: "Keep my project")
        try store.save(original)
        let invalid = ProjectDocument(title: "Invalid", timeline: Timeline(id: "../outside", clips: []))
        XCTAssertThrowsError(try store.save(invalid))
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.appendingPathComponent("outside.json").path))
        XCTAssertEqual(try store.load(), original)
    }

    func testRealMediaCompositionAndExport() async throws {
        guard let path = ProcessInfo.processInfo.environment["PBJ_TEST_VIDEO"],
              let output = ProcessInfo.processInfo.environment["PBJ_TEST_EXPORT"] else {
            throw XCTSkip("Set PBJ_TEST_VIDEO and PBJ_TEST_EXPORT for the real-media export gate")
        }
        let url = URL(fileURLWithPath: path)
        let source = try await MediaImport.inspect(url)
        let duration = min(source.duration, 5 * 60_000)
        var timeline = Timeline(clips: [.init(id: "clip", sourceID: source.id, sourceDuration: duration)])
        try timeline.split(clipID: "clip", at: duration / 2)
        let prepared = try await NativeCompositor.prepare(timeline, sources: [source], urls: [source.id: url])
        let report = try await NativeCompositor.export(prepared, to: URL(fileURLWithPath: output))
        XCTAssertEqual(report.revisionID, timeline.id)
        XCTAssertEqual(report.hasAudio, source.hasAudio)
        XCTAssertEqual(report.decodedVideoSamples, 3)
        XCTAssertEqual(report.durationSeconds, Double(duration) / 60_000, accuracy: 0.1)
        try JSONEncoder().encode(report).write(to: URL(fileURLWithPath: output + ".verification.json"), options: .atomic)
    }

    func testPlannedImportPreservesOtherProjectsAndRepeatDeliveryPreservesEdits() async throws {
        guard let directory = ProcessInfo.processInfo.environment["PBJ_PLAN_DIRECTORY"] else {
            throw XCTSkip("Set PBJ_PLAN_DIRECTORY for the real-source project import gate")
        }
        let root = URL(fileURLWithPath: directory)
        let decoder = JSONDecoder()
        var timeline = try decoder.decode(Timeline.self, from: Data(contentsOf: root.appendingPathComponent("timeline.json")))
        var sources = try decoder.decode([MediaSource].self, from: Data(contentsOf: root.appendingPathComponent("sources.json")))
        let paths = try decoder.decode([String:String].self, from: Data(contentsOf: root.appendingPathComponent("source-paths.json")))
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: temporary) }
        let bundle = temporary.appendingPathComponent("incoming")
        let library = temporary.appendingPathComponent("projects")
        let original = temporary.appendingPathComponent("original")
        let old = ProjectDocument(title: "Keep my edits")
        try ProjectStore(root: original).save(old)
        try FileManager.default.createDirectory(at: bundle.appendingPathComponent("media"), withIntermediateDirectories: true)
        for source in sources {
            let to = bundle.appendingPathComponent("media").appendingPathComponent(source.id).appendingPathExtension((source.fileName as NSString).pathExtension)
            try FileManager.default.copyItem(at: URL(fileURLWithPath: paths[source.id]!), to: to)
        }
        try JSONEncoder().encode(timeline).write(to: bundle.appendingPathComponent("timeline.json"))
        try JSONEncoder().encode(sources).write(to: bundle.appendingPathComponent("sources.json"))
        let installed = try await PlannedProjectImport.install(bundle: bundle, library: library)
        let store = ProjectStore(root: installed)
        var saved = try store.load()
        XCTAssertEqual(saved.current, timeline)
        var edit = saved.current
        edit.clips[0].muted.toggle()
        try saved.commit(edit)
        try store.save(saved)
        let repeated = try await PlannedProjectImport.install(bundle: bundle, library: library)
        XCTAssertEqual(repeated, installed)
        XCTAssertEqual(try store.load(), saved)
        XCTAssertEqual(try ProjectStore(root: original).load(), old)
        // Wrong original bytes cannot become a saved project or affect earlier cuts.
        timeline.id = UUID().uuidString
        sources[0].sha256 = "wrong"
        try JSONEncoder().encode(timeline).write(to: bundle.appendingPathComponent("timeline.json"))
        try JSONEncoder().encode(sources).write(to: bundle.appendingPathComponent("sources.json"))
        do {
            _ = try await PlannedProjectImport.install(bundle: bundle, library: library)
            XCTFail("Mismatched original was accepted")
        } catch { XCTAssertTrue(error.localizedDescription.contains("does not match")) }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: library.path), [installed.lastPathComponent])
        XCTAssertEqual(try store.load(), saved)
    }

    func testPlannedTimelineExport() async throws {
        guard let directory = ProcessInfo.processInfo.environment["PBJ_PLAN_DIRECTORY"],
              let output = ProcessInfo.processInfo.environment["PBJ_PLAN_EXPORT"] else {
            throw XCTSkip("Set PBJ_PLAN_DIRECTORY and PBJ_PLAN_EXPORT to verify the saved planner timeline")
        }
        let root = URL(fileURLWithPath:directory)
        let decoder = JSONDecoder()
        let timeline = try decoder.decode(Timeline.self,from:Data(contentsOf:root.appendingPathComponent("timeline.json")))
        let sources = try decoder.decode([MediaSource].self,from:Data(contentsOf:root.appendingPathComponent("sources.json")))
        let paths = try decoder.decode([String:String].self,from:Data(contentsOf:root.appendingPathComponent("source-paths.json")))
        let prepared = try await NativeCompositor.prepare(timeline,sources:sources,urls:paths.mapValues { URL(fileURLWithPath:$0) })
        let report = try await NativeCompositor.export(prepared,to:URL(fileURLWithPath:output))
        XCTAssertEqual(report.revisionID,timeline.id)
        try JSONEncoder().encode(report).write(to:URL(fileURLWithPath:output+".verification.json"),options:.atomic)
    }
}
