import AVFoundation
import XCTest
@testable import PBJCore

final class CompositorAudioTests: XCTestCase {
    /// Generate the exact two-second constant-tone source these tests need.
    /// An arbitrary speech/music fixture changes amplitude over time and cannot
    /// establish the volume ratio between clips played at different speeds.
    private func fixture() async throws -> (directory: URL, url: URL, source: MediaSource) {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var complete = false
        defer { if !complete { try? FileManager.default.removeItem(at: directory) } }
        let videoURL = directory.appendingPathComponent("video.mov")
        let toneURL = directory.appendingPathComponent("tone.caf")
        let url = directory.appendingPathComponent("constant-tone.mp4")
        let writer = try AVAssetWriter(outputURL: videoURL, fileType: .mov)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64])
        let frames = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video,
            sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB,
                                          kCVPixelBufferWidthKey as String: 64, kCVPixelBufferHeightKey as String: 64])
        writer.add(video)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        var pixel: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(frames.pixelBufferPool), &pixel), kCVReturnSuccess)
        let buffer = try XCTUnwrap(pixel)
        CVPixelBufferLockBaseAddress(buffer, [])
        memset(CVPixelBufferGetBaseAddress(buffer), 0, CVPixelBufferGetDataSize(buffer))
        CVPixelBufferUnlockBaseAddress(buffer, [])
        let deadline = Date().addingTimeInterval(10)
        for frame in 0..<60 {
            while !video.isReadyForMoreMediaData {
                guard writer.status == .writing, Date() < deadline else {
                    writer.cancelWriting()
                    throw TimelineError.invalid("Synthetic video fixture could not be written")
                }
                try await Task.sleep(for: .milliseconds(5))
            }
            XCTAssertTrue(frames.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30)))
        }
        writer.endSession(atSourceTime: CMTime(value: 2, timescale: 1))
        video.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed)
        // Scope closes the audio file before AVFoundation opens it for muxing.
        do {
            let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
            let audio = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 96_000))
            audio.frameLength = 96_000
            let samples = try XCTUnwrap(audio.floatChannelData)[0]
            for sample in 0..<96_000 { samples[sample] = Float(0.25 * sin(2 * .pi * 440 * Double(sample) / 48_000)) }
            try AVAudioFile(forWriting: toneURL, settings: format.settings).write(from: audio)
        }
        let composition = AVMutableComposition()
        let assets = [(AVURLAsset(url: videoURL), AVMediaType.video), (AVURLAsset(url: toneURL), AVMediaType.audio)]
        for (asset, type) in assets {
            let tracks = try await asset.loadTracks(withMediaType: type)
            let track = try XCTUnwrap(tracks.first)
            let destination = try XCTUnwrap(composition.addMutableTrack(withMediaType: type,
                preferredTrackID: kCMPersistentTrackID_Invalid))
            try destination.insertTimeRange(CMTimeRange(start: .zero, duration: CMTime(value: 2, timescale: 1)),
                                            of: track, at: .zero)
        }
        let export = try XCTUnwrap(AVAssetExportSession(asset: composition, presetName: AVAssetExportPresetHighestQuality))
        try await export.export(to: url, as: .mp4)
        withExtendedLifetime(assets) {}
        let source = try await MediaImport.inspect(url)
        complete = true
        return (directory, url, source)
    }

    func testSequentialCutsUseBoundedAudioTracksWhileFinishingSoundStaysIndependent() async throws {
        let (directory, url, source) = try await fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        var timeline = Timeline(clips: (0..<120).map { index in
            var clip = TimelineClip(sourceID: source.id, sourceIn: 30_000,
                                    sourceDuration: 60_000, volume: 0.4, muted: index % 3 == 0)
            clip.speed = [0.5, 1, 2, 4][index % 4]
            return clip
        })
        timeline.reflow()
        timeline.sounds = [.init(sourceID: source.id, sourceDuration: 60_000, outputStart: 30_000)]
        let prepared = try await NativeCompositor.prepare(timeline, sources: [source], urls: [source.id: url])
        let tracks = try await prepared.composition.loadTracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 3, "Sequential source audio alternates two tracks; overlapping finishing sound uses another")
        XCTAssertEqual(prepared.audioMix.inputParameters.count, 3)
        XCTAssertEqual(prepared.composition.duration.seconds, Double(timeline.duration) / 60_000, accuracy: 0.001)
    }

    func testSharedAudioKeepsMuteAndVolumeAcrossMixedSpeeds() async throws {
        let (directory, url, source) = try await fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        var clips = (0..<3).map { _ in TimelineClip(sourceID: source.id, sourceDuration: 120_000, fit: "fit") }
        clips[0].speed = 2
        clips[1].muted = true
        clips[2].volume = 0.25
        clips[2].speed = 0.5
        var timeline = Timeline(clips: clips)
        timeline.width = 160; timeline.height = 240; timeline.reflow()
        let prepared = try await NativeCompositor.prepare(timeline, sources: [source], urls: [source.id: url])
        let retained = ProcessInfo.processInfo.environment["PBJ_AUDIO_AUDIT_EXPORT"]
        let output = retained.map { URL(fileURLWithPath: $0) }
            ?? FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mp4")
        defer { if retained == nil { try? FileManager.default.removeItem(at: output) } }
        let report = try await NativeCompositor.export(prepared, to: output)
        XCTAssertEqual(report.durationSeconds, 7, accuracy: 0.1)
        let asset = AVURLAsset(url: output)
        let audios = try await asset.loadTracks(withMediaType: .audio)
        let audio = try XCTUnwrap(audios.first)
        func rms(from start: Double, duration: Double) throws -> Double {
            let reader = try AVAssetReader(asset: asset)
            reader.timeRange = CMTimeRange(start: CMTime(seconds: start, preferredTimescale: 60_000),
                                          duration: CMTime(seconds: duration, preferredTimescale: 60_000))
            let decoded = AVAssetReaderTrackOutput(track: audio, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMIsFloatKey: true,
                AVLinearPCMBitDepthKey: 32, AVLinearPCMIsNonInterleaved: false])
            reader.add(decoded)
            XCTAssertTrue(reader.startReading())
            var sum = 0.0, count = 0
            while let sample = decoded.copyNextSampleBuffer(), let buffer = CMSampleBufferGetDataBuffer(sample) {
                let length = CMBlockBufferGetDataLength(buffer)
                var values = [Float](repeating: 0, count: length / MemoryLayout<Float>.size)
                let status = values.withUnsafeMutableBytes {
                    CMBlockBufferCopyDataBytes(buffer, atOffset: 0, dataLength: length, destination: $0.baseAddress!)
                }
                XCTAssertEqual(status, kCMBlockBufferNoErr)
                for value in values { sum += Double(value * value); count += 1 }
            }
            XCTAssertEqual(reader.status, .completed)
            return sqrt(sum / Double(max(1, count)))
        }
        let full = try rms(from: 0.2, duration: 0.5)
        let muted = try rms(from: 1.3, duration: 1)
        let quiet = try rms(from: 3.5, duration: 1)
        XCTAssertGreaterThan(full, 0.001)
        XCTAssertLessThan(muted, full * 0.01)
        XCTAssertEqual(quiet / full, 0.25, accuracy: 0.06)
    }
}
