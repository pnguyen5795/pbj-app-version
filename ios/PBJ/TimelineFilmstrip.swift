import AVFoundation
import PBJCore
import SwiftUI
import UIKit

/// Only visible thumbnail cells are requested; long source files are not read
/// into memory or decoded in full to draw the timeline.
struct TimelineFilmstrip: View {
    let clip: TimelineClip
    let source: MediaSource?
    let url: URL?
    let scale: Double
    let viewportWidth: Double
    let offset: Double
    private let cellWidth = 44.0

    var body: some View {
        let width = Double(clip.outputDuration)/60000*scale
        let count = max(1,Int(ceil(width/cellWidth)))
        let first = min(count-1,max(0,Int(floor(-offset/cellWidth))-1))
        let last = min(count-1,max(first,Int(ceil((viewportWidth-offset)/cellWidth))+1))
        return ZStack(alignment:.leading) {
            Color.black.opacity(0.12)
            if let source, let url {
                ForEach(first...last,id:\.self) { index in
                    let relative = Int64((Double(index)*cellWidth/scale*60000*clip.playbackRate).rounded())
                    let sourceTime = min(clip.sourceIn+clip.sourceDuration-1,clip.sourceIn+relative)
                    FilmstripFrame(url:url,sourceID:source.id,sourceTime:sourceTime+source.mediaStart)
                        .frame(width:cellWidth,height:64).clipped().offset(x:Double(index)*cellWidth)
                }
            }
        }.frame(width:max(1,width),height:64,alignment:.leading).clipped()
    }
}

private struct FilmstripFrame: View {
    let url: URL
    let sourceID: String
    let sourceTime: Int64
    @State private var thumbnail: UIImage?
    @State private var failed = false
    private var key: String { "\(sourceID):\(sourceTime)" }

    var body: some View {
        ZStack {
            Color.black.opacity(0.12)
            if let thumbnail {
                Image(uiImage:thumbnail).resizable().scaledToFill()
            } else if failed {
                Image(systemName:"film").font(.caption).foregroundStyle(.secondary)
            }
        }.task(id:key) {
            thumbnail = nil
            failed = false
            let image = await FilmstripCache.shared.image(url:url,key:key,time:sourceTime)
            guard !Task.isCancelled else { return }
            thumbnail = image
            failed = image == nil
        }
    }
}

@MainActor
private final class FilmstripCache {
    static let shared = FilmstripCache()
    private let cache = NSCache<NSString,UIImage>()
    private var active = 0
    private init() {
        cache.countLimit = 240
        cache.totalCostLimit = 24*1024*1024
    }
    func image(url:URL,key:String,time:Int64) async -> UIImage? {
        if let image = cache.object(forKey:key as NSString) { return image }
        // SwiftUI cancels off-screen cell tasks. Limit concurrent AV decoders
        // so rapid scrolling/zooming does not launch one per requested frame.
        while active >= 3 {
            do { try await Task.sleep(for:.milliseconds(20)) } catch { return nil }
            if let image = cache.object(forKey:key as NSString) { return image }
        }
        guard !Task.isCancelled else { return nil }
        active += 1
        defer { active -= 1 }
        let generator = AVAssetImageGenerator(asset:AVURLAsset(url:url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width:160,height:192)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        do {
            let result = try await withTaskCancellationHandler {
                try await generator.image(at:CMTime(value:time,timescale:60000))
            } onCancel: { generator.cancelAllCGImageGeneration() }
            guard !Task.isCancelled else { return nil }
            let image = UIImage(cgImage:result.image)
            cache.setObject(image,forKey:key as NSString,cost:result.image.bytesPerRow*result.image.height)
            return image
        } catch { return nil }
    }
}
