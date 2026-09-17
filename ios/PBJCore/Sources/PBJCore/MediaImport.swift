import AVFoundation
import CryptoKit
import Foundation
import ImageIO

public enum MediaImport {
    /// Streaming hash of original bytes; import never rewrites the original.
    public static func hash(_ url: URL) throws -> String {
        try Task.checkCancellation()
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1_048_576), !chunk.isEmpty {
            try Task.checkCancellation()
            hash.update(data: chunk)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    public static func inspect(_ url: URL, id: String = UUID().uuidString) async throws -> MediaSource {
        let asset = AVURLAsset(url: url)
        // AVFoundation can wait indefinitely on inaccessible provider URLs.
        // Cancel this metadata load; the original remains available for retry.
        let timeout = Task {
            do { try await Task.sleep(for: .seconds(30)); asset.cancelLoading() }
            catch { /* completed metadata load cancels its timeout */ }
        }
        defer { timeout.cancel() }
        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw TimelineError.invalid("This file has no readable video track")
        }
        let range = try await video.load(.timeRange)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        return MediaSource(id: id, fileName: url.lastPathComponent, sha256: try hash(url),
                           duration: CMTimeConvertScale(range.duration, timescale: timelineTimescale, method: .roundHalfAwayFromZero).value,
                           mediaStart: CMTimeConvertScale(range.start, timescale: timelineTimescale, method: .roundHalfAwayFromZero).value,
                           hasAudio: !audio.isEmpty)
    }

    public static func copy(_ url: URL, into directory: URL) async throws -> (MediaSource, URL) {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let source = try await inspect(url)
        let target = directory.appendingPathComponent(source.id).appendingPathExtension(url.pathExtension)
        let temporary = directory.appendingPathComponent(source.id + ".importing")
        do {
            try FileManager.default.copyItem(at: url, to: temporary)
            guard try hash(temporary) == source.sha256 else { throw TimelineError.invalid("Import changed during transfer; try again") }
            try FileManager.default.moveItem(at: temporary, to: target)
            return (source, target)
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }
    public static func copySound(_ url: URL, into directory: URL) async throws -> (MediaSource, URL) {
        let asset = AVURLAsset(url: url)
        guard let audio = try await asset.loadTracks(withMediaType: .audio).first else { throw TimelineError.invalid("This file has no readable audio") }
        let range = try await audio.load(.timeRange)
        var source = MediaSource(fileName:url.lastPathComponent,sha256:try hash(url),duration:CMTimeConvertScale(range.duration,timescale:60000,method:.roundHalfAwayFromZero).value,mediaStart:CMTimeConvertScale(range.start,timescale:60000,method:.roundHalfAwayFromZero).value,hasAudio:true)
        source.kind = "audio"
        return try copyFinishing(url, source: source, into: directory)
    }
    public static func copyImage(_ url: URL, into directory: URL) throws -> (MediaSource, URL) {
        guard let image = CGImageSourceCreateWithURL(url as CFURL,nil), CGImageSourceGetCount(image)>0 else { throw TimelineError.invalid("This image could not be read") }
        var source = MediaSource(fileName:url.lastPathComponent,sha256:try hash(url),duration:1,hasAudio:false)
        source.kind = "image"
        return try copyFinishing(url, source: source, into: directory)
    }
    private static func copyFinishing(_ url: URL, source: MediaSource, into directory: URL) throws -> (MediaSource, URL) {
        try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
        let target = directory.appendingPathComponent(source.id).appendingPathExtension(url.pathExtension)
        let temporary = target.appendingPathExtension("importing")
        do {try FileManager.default.copyItem(at:url,to:temporary);guard try hash(temporary)==source.sha256 else {throw TimelineError.invalid("Original changed during import")};try FileManager.default.moveItem(at:temporary,to:target);return (source,target)}
        catch {try? FileManager.default.removeItem(at:temporary);throw error}
    }

}
