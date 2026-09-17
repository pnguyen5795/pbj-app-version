import AVFoundation
import CoreImage
import CoreText
import ImageIO

/// The same compositor runs inside AVPlayer and AVAssetExportSession. Timed
/// overlays are pixels in both paths, not a SwiftUI-only preview decoration.
final class PBJVideoInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = true
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID = kCMPersistentTrackID_Invalid
    let baseTrackID: CMPersistentTrackID
    let baseTransform: CGAffineTransform
    let baseHeight: CGFloat
    let canvas: CGSize
    let overlays: [OverlayRenderLayer]
    init(timeRange: CMTimeRange, baseTrackID: CMPersistentTrackID, baseTransform: CGAffineTransform, baseHeight: CGFloat, canvas: CGSize, overlays: [OverlayRenderLayer]) {
        self.timeRange=timeRange;self.baseTrackID=baseTrackID;self.baseTransform=baseTransform;self.baseHeight=baseHeight;self.canvas=canvas;self.overlays=overlays
        requiredSourceTrackIDs = [NSNumber(value:baseTrackID)] + overlays.compactMap { $0.trackID.map { NSNumber(value:$0) } }
        super.init()
    }
}
struct OverlayRenderLayer {
    let overlay: TimelineOverlay
    let image: CIImage?
    let trackID: CMPersistentTrackID?
    let sourceTransform: CGAffineTransform
    let sourceHeight: CGFloat
}
final class PBJVideoCompositor: NSObject, AVVideoCompositing {
    var sourcePixelBufferAttributes: [String: Any]? { [kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA] }
    var requiredPixelBufferAttributesForRenderContext: [String: Any] { [kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferIOSurfacePropertiesKey as String:[:]] }
    private let queue = DispatchQueue(label:"com.pbj.overlay-compositor")
    private let context = CIContext(options:[.cacheIntermediates:false])
    private var renderContext: AVVideoCompositionRenderContext?
    private var generation = 0
    private let cancellationLock = NSLock()
    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) { queue.sync {renderContext=newRenderContext} }
    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        let expected = cancellationLock.withLock { generation }
        queue.async { [self] in
            guard cancellationLock.withLock({ generation == expected }) else { request.finishCancelledRequest(); return }
            guard let instruction=request.videoCompositionInstruction as? PBJVideoInstruction,
                  let base=request.sourceFrame(byTrackID:instruction.baseTrackID),
                  let output=renderContext?.newPixelBuffer() else {
                request.finish(with:TimelineError.invalid("An overlay frame could not be decoded"));return
            }
            let canvas=instruction.canvas
            let bounds=CGRect(origin:.zero,size:canvas)
            let image=CIImage(cvPixelBuffer:base)
                .transformed(by:CGAffineTransform(a:1,b:0,c:0,d:-1,tx:0,ty:instruction.baseHeight))
                .transformed(by:instruction.baseTransform)
                .transformed(by:CGAffineTransform(a:1,b:0,c:0,d:-1,tx:0,ty:canvas.height))
            var result=image.composited(over:CIImage(color:CIColor.black).cropped(to:bounds)).cropped(to:bounds)
            for layer in instruction.overlays {
                var foreground:CIImage
                if let track=layer.trackID {
                    guard let frame=request.sourceFrame(byTrackID:track) else {request.finish(with:TimelineError.invalid("An overlay video frame is missing"));return}
                    foreground=CIImage(cvPixelBuffer:frame).transformed(by:CGAffineTransform(a:1,b:0,c:0,d:-1,tx:0,ty:layer.sourceHeight)).transformed(by:layer.sourceTransform)
                    let extent=foreground.extent
                    foreground=foreground.transformed(by:CGAffineTransform(a:1,b:0,c:0,d:-1,tx:0,ty:extent.maxY+extent.minY))
                } else if let image=layer.image {foreground=image}
                else {continue}
                let extent=foreground.extent
                guard extent.width>0,extent.height>0 else {continue}
                let scale=canvas.width*layer.overlay.width/extent.width
                foreground=foreground.transformed(by:CGAffineTransform(translationX:-extent.midX,y:-extent.midY))
                    .transformed(by:CGAffineTransform(scaleX:scale,y:scale))
                    .transformed(by:CGAffineTransform(rotationAngle:-layer.overlay.rotation * .pi/180))
                    .transformed(by:CGAffineTransform(translationX:canvas.width*layer.overlay.x,y:canvas.height*(1-layer.overlay.y)))
                if layer.overlay.opacity<1 {foreground=foreground.applyingFilter("CIColorMatrix",parameters:["inputAVector":CIVector(x:0,y:0,z:0,w:layer.overlay.opacity)])}
                result=foreground.composited(over:result).cropped(to:bounds)
            }
            context.render(result,to:output,bounds:bounds,colorSpace:CGColorSpace(name:CGColorSpace.sRGB))
            request.finish(withComposedVideoFrame:output)
        }
    }
    func cancelAllPendingVideoCompositionRequests() { cancellationLock.withLock {generation += 1} }
}

enum OverlayArtwork {
    static func image(_ url:URL) throws -> CIImage {
        guard let source=CGImageSourceCreateWithURL(url as CFURL,nil),let cg=CGImageSourceCreateThumbnailAtIndex(source,0,[kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,kCGImageSourceThumbnailMaxPixelSize:2160] as CFDictionary) else {throw TimelineError.invalid("Could not decode overlay image")}
        return CIImage(cgImage:cg)
    }
    static func text(_ overlay:TimelineOverlay,canvas:CGSize) throws -> CIImage {
        let width=max(64,Int(canvas.width*overlay.width))
        let fontName=overlay.style=="Bold" ? "HelveticaNeue-CondensedBlack" : "HelveticaNeue-Bold"
        let font=CTFontCreateWithName(fontName as CFString,overlay.fontSize,nil)
        let hex=String(overlay.color.dropFirst());let rgb=UInt32(hex,radix:16) ?? 0xffffff
        let color=CGColor(red:CGFloat((rgb>>16)&255)/255,green:CGFloat((rgb>>8)&255)/255,blue:CGFloat(rgb&255)/255,alpha:1)
        let attributed=NSAttributedString(string:overlay.text ?? "",attributes:[NSAttributedString.Key(kCTFontAttributeName as String):font,NSAttributedString.Key(kCTForegroundColorAttributeName as String):color])
        let setter=CTFramesetterCreateWithAttributedString(attributed)
        let size=CTFramesetterSuggestFrameSizeWithConstraints(setter,CFRange(location:0,length:0),nil,CGSize(width:width-32,height:4096),nil)
        let height=min(4096,max(32,Int(ceil(size.height))+32))
        guard let context=CGContext(data:nil,width:width,height:height,bitsPerComponent:8,bytesPerRow:0,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else {throw TimelineError.invalid("Could not prepare text overlay")}
        if overlay.style != "Minimal" {context.setFillColor(CGColor(gray:0,alpha:0.65));context.addPath(CGPath(roundedRect:CGRect(x:0,y:0,width:width,height:height),cornerWidth:16,cornerHeight:16,transform:nil));context.fillPath()}
        let frame=CTFramesetterCreateFrame(setter,CFRange(location:0,length:0),CGPath(rect:CGRect(x:16,y:16,width:width-32,height:height-32),transform:nil),nil)
        CTFrameDraw(frame,context)
        guard let cg=context.makeImage() else {throw TimelineError.invalid("Could not rasterize text")}
        return CIImage(cgImage:cg)
    }
}
