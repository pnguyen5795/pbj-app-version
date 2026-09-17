import XCTest
import AVFoundation
@testable import PBJCore

final class FinishingTests: XCTestCase {
    func testSpeedSplitCaptionsAndFinishingEligibility() throws {
        let source = MediaSource(id:"v",fileName:"v.mov",sha256:"v",duration:600000,hasAudio:true)
        var clip = TimelineClip(id:"c",sourceID:"v",sourceIn:120000,sourceDuration:240000)
        clip.speed = 2; clip.rotation = 90
        var timeline = Timeline(clips:[clip])
        let captions = CaptionBuilder.overlays(timeline:timeline,wordsBySource:["v":[.init(word:"Before",start:1,end:1.5),.init(word:"Hello",start:2.5,end:3),.init(word:"world.",start:3.1,end:4),.init(word:"After",start:7,end:8)]])
        XCTAssertEqual(timeline.duration,120000)
        XCTAssertEqual(captions.count,1)
        XCTAssertEqual(captions[0].text,"Hello world.")
        XCTAssertEqual(captions[0].start,15000)
        XCTAssertEqual(captions[0].end,60000)
        timeline.overlays = captions
        try timeline.split(clipID:"c",at:120000)
        XCTAssertEqual(timeline.duration,120000)
        XCTAssertEqual(timeline.clips[1].sourceIn,240000)
        XCTAssertEqual(timeline.clips[1].outputStart,60000)
        timeline.sounds = [.init(sourceID:"v",sourceDuration:60000)]
        try timeline.validate(sources:[source],eligibleIDs:["v"])
        var reference = source; reference.id = "reference"
        timeline.sounds?[0].sourceID = "reference"
        XCTAssertThrowsError(try timeline.validate(sources:[source,reference],eligibleIDs:["v"]))
        timeline.sounds = nil
        timeline.overlays?[0].sourceID = "reference"
        timeline.overlays?[0].kind = "video"
        XCTAssertThrowsError(try timeline.validate(sources:[source,reference],eligibleIDs:["v"]))
    }
    func testFinishingExportUsesSharedRenderer() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let media = env["PBJ_FINISHING_VIDEO"],let image = env["PBJ_FINISHING_IMAGE"],let output = env["PBJ_FINISHING_EXPORT"] else {throw XCTSkip("Set finishing fixture paths for compositor integration")}
        let url = URL(fileURLWithPath:media)
        let source = try await MediaImport.inspect(url)
        var still = MediaSource(id:"still",fileName:"still.png",sha256:"fixture",duration:60000,hasAudio:false);still.kind="image"
        var first = TimelineClip(sourceID:source.id,sourceDuration:240000,muted:true,fit:"fit");first.speed=2
        var second = TimelineClip(sourceID:source.id,sourceIn:240000,sourceDuration:120000,muted:true,fit:"fit");second.rotation=90
        var timeline = Timeline(clips:[first,second]);timeline.width=320;timeline.height=480;timeline.reflow()
        timeline.sounds = [.init(sourceID:source.id,sourceDuration:240000,volume:0.2)]
        var text = TimelineOverlay(start:60000,end:180000,text:"PB&J test");text.fontSize=24
        var picture = TimelineOverlay(kind:"image",start:30000,end:90000,sourceID:"still");picture.y=0.2;picture.width=0.25
        var movie = TimelineOverlay(kind:"video",start:150000,end:210000,sourceID:source.id);movie.y=0.25;movie.width=0.4
        timeline.overlays=[text,picture,movie]
        let prepared = try await NativeCompositor.prepare(timeline,sources:[source,still],urls:[source.id:url,still.id:URL(fileURLWithPath:image)])
        XCTAssertNotNil(prepared.videoComposition.customVideoCompositorClass)
        let report = try await NativeCompositor.export(prepared,to:URL(fileURLWithPath:output))
        XCTAssertEqual(report.durationSeconds,4,accuracy:0.05)
        XCTAssertTrue(report.hasAudio)
        XCTAssertEqual(report.decodedVideoSamples,3)
        try JSONEncoder().encode(timeline).write(to:URL(fileURLWithPath:output+".timeline.json"))
        try JSONEncoder().encode(report).write(to:URL(fileURLWithPath:output+".verification.json"))
    }
}

extension FinishingTests {
    func testCaptionsFollowExtractedSoundEvenWhenVideoIsMuted() {
        var clip=TimelineClip(sourceID:"v",sourceDuration:240000);clip.muted=true
        var timeline=Timeline(clips:[clip])
        var sound=TimelineSound(sourceID:"v",sourceIn:60000,sourceDuration:120000,outputStart:120000);sound.speed=2
        timeline.sounds=[sound]
        let captions=CaptionBuilder.overlays(timeline:timeline,wordsBySource:["v":[.init(word:"Hello.",start:1.5,end:2)]])
        XCTAssertEqual(captions.count,1);XCTAssertEqual(captions[0].start,135000);XCTAssertEqual(captions[0].end,150000)
    }
}
