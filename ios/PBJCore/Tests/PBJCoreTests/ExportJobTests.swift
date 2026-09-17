import AVFoundation
import CryptoKit
import XCTest
@testable import PBJCore

final class ExportJobTests: XCTestCase {
    private func fixture() throws -> (URL, ExportJobStore, ExportJob) {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let source = MediaSource(fileName: "fixture.mp4", sha256: String(repeating: "a", count: 64), duration: 60_000, hasAudio: true)
        let timeline = Timeline(clips: [TimelineClip(sourceID: source.id, sourceDuration: 60_000)])
        let document = ProjectDocument(title: "Original project", sources: [source], timeline: timeline)
        return (root, ExportJobStore(root: root), ExportJob(snapshot: document, expectsAudio: true))
    }
    private func report(_ job: ExportJob, bytes: Data) -> ExportVerification {
        // The persisted-job tests use opaque synthetic bytes; media decoding is
        // covered separately by NativeCompositor tests, never asserted here.
        ExportVerification(revisionID: job.revisionID, durationSeconds: 1, hasAudio: true,
                           decodedVideoSamples: 3, sha256: digest(bytes))
    }
    private func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    func testJobFreezesOneRevisionAndSurvivesProjectContainerRelocation() throws {
        let (root, store, job) = try fixture()
        let moved = root.appendingPathExtension("moved")
        defer { try? FileManager.default.removeItem(at: root); try? FileManager.default.removeItem(at: moved) }
        var edited = job.snapshot
        edited.title = "A different name"
        var revision = edited.current; revision.clips[0].volume = 0.3
        try edited.commit(revision)
        XCTAssertNotEqual(job.revisionID, edited.current.id)
        XCTAssertEqual(job.snapshot.history.count, 1)
        try store.save(job)
        try FileManager.default.moveItem(at: root, to: moved)
        let restored = try ExportJobStore(root: moved).load(job.id)
        XCTAssertEqual(restored.title, "Original project")
        XCTAssertEqual(restored.projectID, job.projectID)
        XCTAssertEqual(restored.revisionID, job.revisionID)
        XCTAssertEqual(try ExportJobStore(root: moved).partialURL(job.id).deletingLastPathComponent().deletingLastPathComponent().path, moved.path)
    }

    func testInterruptedRenderDiscardsOnlyItsPartialAndKeepsExactSnapshot() async throws {
        let (root, store, job) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try store.save(job)
        let partial = try store.partialURL(job.id)
        try Data("unfinished".utf8).write(to: partial)
        let unrelated = root.appendingPathComponent("other.mp4")
        try Data("preserve".utf8).write(to: unrelated)
        let stopped = try await store.recover(job) { _, _ in XCTFail("A partial video is not complete"); throw CancellationError() }
        XCTAssertEqual(stopped.status, .interrupted)
        XCTAssertNil(stopped.verification)
        XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path))
        XCTAssertEqual(try store.load(job.id).snapshot, job.snapshot)
    }

    func testCrashAfterPublicationRecoversVerifiedCompletionAndDoesNotReverifyEveryOpen() async throws {
        let (root, store, job) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try store.save(job)
        let bytes = Data("verified synthetic output".utf8)
        let output = try store.outputURL(job.id)
        try bytes.write(to: output)
        var checks = 0
        let complete = try await store.recover(job) { url, snapshot in
            checks += 1
            XCTAssertEqual(url, output)
            return self.report(snapshot, bytes: bytes)
        }
        XCTAssertEqual(checks, 1)
        XCTAssertEqual(complete.status, .completed)
        let ready = try await store.recover(store.load(job.id)) { _, _ in XCTFail("Immutable verified export should reopen immediately"); throw CancellationError() }
        XCTAssertEqual(ready.verification?.sha256, report(job, bytes: bytes).sha256)
    }

    func testCompletionRejectsAnotherRevisionAndConflictingPublishedBytes() throws {
        let (root, store, job) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try store.save(job)
        let bytes = Data("first".utf8)
        try bytes.write(to: store.partialURL(job.id))
        let wrong = ExportVerification(revisionID: UUID().uuidString, durationSeconds: 1, hasAudio: true,
                                       decodedVideoSamples: 3, sha256: digest(bytes))
        XCTAssertThrowsError(try store.complete(job, report: wrong))
        XCTAssertEqual(try store.load(job.id).status, .rendering)
        try Data("different".utf8).write(to: store.outputURL(job.id))
        XCTAssertThrowsError(try store.complete(job, report: report(job, bytes: bytes)))
        XCTAssertEqual(try Data(contentsOf: store.outputURL(job.id)), Data("different".utf8))
    }

    func testMissingCompletedFileBecomesRestartableAndNeverRemainsShareable() async throws {
        let (root, store, job) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try store.save(job)
        let bytes = Data("output".utf8)
        try bytes.write(to: store.partialURL(job.id))
        let completed = try store.complete(job, report: report(job, bytes: bytes))
        try FileManager.default.removeItem(at: store.outputURL(job.id))
        let recovered = try await store.recover(completed) { _, _ in XCTFail("Missing file cannot be verified"); throw CancellationError() }
        XCTAssertEqual(recovered.status, .interrupted)
        XCTAssertNil(recovered.verification)
    }

    func testCorruptRecordAndInvalidPathsArePreservedRatherThanOverwritten() throws {
        let (root, store, job) = try fixture()
        defer { try? FileManager.default.removeItem(at: root) }
        try store.save(job)
        let manifest = root.appendingPathComponent("exports/jobs/\(job.id).json")
        let damaged = Data("incomplete JSON".utf8)
        try damaged.write(to: manifest)
        XCTAssertThrowsError(try store.save(job))
        XCTAssertEqual(try Data(contentsOf: manifest), damaged)
        XCTAssertThrowsError(try store.outputURL("../../somewhere"))
        XCTAssertThrowsError(try store.load("../job"))
    }

    func testCancelledExportNeverCreatesOutputOrReportsSuccess() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let prepared = PreparedTimeline(composition: AVMutableComposition(), videoComposition: AVMutableVideoComposition(),
                                        audioMix: AVMutableAudioMix(), revisionID: UUID().uuidString, expectedDuration: 1, expectsAudio: false)
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await NativeCompositor.export(prepared, to: root) { _, _ in XCTFail("Cancelled work must not report render progress") }
        }
        do { _ = try await task.value; XCTFail("Cancelled export must not succeed") }
        catch is CancellationError { }
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
    }

    func testRunningSyntheticExportReportsProgressAndCancelsWithoutACompletedFile() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let original = root.appendingPathComponent("synthetic.mov")
        let writer = try AVAssetWriter(outputURL: original, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64])
        let pixels = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
            kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        var candidate: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(pixels.pixelBufferPool), &candidate), kCVReturnSuccess)
        let buffer = try XCTUnwrap(candidate)
        CVPixelBufferLockBaseAddress(buffer, [])
        memset(CVPixelBufferGetBaseAddress(buffer), 64, CVPixelBufferGetDataSize(buffer))
        CVPixelBufferUnlockBaseAddress(buffer, [])
        let deadline = Date().addingTimeInterval(10)
        for frame in 0..<30 {
            while !input.isReadyForMoreMediaData {
                guard Date() < deadline, writer.status == .writing else { writer.cancelWriting(); throw TimelineError.invalid("Synthetic fixture failed") }
                try await Task.sleep(for: .milliseconds(5))
            }
            XCTAssertTrue(pixels.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)))
        }
        writer.endSession(atSourceTime: CMTime(value: 1, timescale: 1))
        input.markAsFinished(); await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed)
        let source = try await MediaImport.inspect(original)
        var timeline = Timeline(clips: (0..<300).map { _ in TimelineClip(sourceID: source.id, sourceDuration: source.duration) })
        timeline.width = 320; timeline.height = 480; timeline.reflow()
        let prepared = try await NativeCompositor.prepare(timeline, sources: [source], urls: [source.id: original])
        actor Events {
            var rendering = false
            var completed = false
            func add(_ value: Double, _ message: String) {
                rendering = rendering || message == "Rendering video"
                completed = completed || value == 1
            }
        }
        let events = Events(), output = root.appendingPathComponent("cancelled.mp4")
        let task = Task { try await NativeCompositor.export(prepared, to: output) { value, message in await events.add(value, message) } }
        for _ in 0..<500 {
            if await events.rendering { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let didRender = await events.rendering
        XCTAssertTrue(didRender, "The test must interrupt an active render, not only a task cancelled before start")
        task.cancel()
        do { _ = try await task.value; XCTFail("Interrupted rendering must not succeed") }
        catch is CancellationError { }
        let claimedComplete = await events.completed
        XCTAssertFalse(claimedComplete)
        XCTAssertFalse(FileManager.default.fileExists(atPath: output.path))
    }
}
