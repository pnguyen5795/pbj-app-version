import Foundation

/// Explanations of observed state, never an estimated percentage or completion time.
public struct JobProgressMessage: Equatable {
    public let title: String
    public let detail: String
    public let next: String
    public let showsActivity: Bool

    public static func describe(kind: String, status: String, stage: String, processingEnabled: Bool?, connected: Bool) -> Self {
        if status == "complete" {
            return .init(title: kind == "plan" ? "Your cut is ready" : "Work saved", detail: "This step has finished and its result is saved.", next: kind == "plan" ? "Open your project to review the cut." : "Saved results can be reused.", showsActivity: false)
        }
        if !connected {
            return .init(title: "Can't reach the editing service", detail: "We can't check progress right now. Your saved project is still available.", next: "Keep your Mac awake, start PBJ, and connect both devices to the same home network. We'll check again automatically.", showsActivity: false)
        }
        if status == "attention" {
            return .init(title: "This step needs attention", detail: "Work stopped at: \(stage). Your footage and any completed results are saved.", next: "Review the error below. Resume saved work retries from the saved state.", showsActivity: false)
        }
        if processingEnabled == false {
            return .init(title: "AI processing is paused", detail: "Your request is saved on your Mac. Its AI worker is off, so this request has not started or resumed.", next: "Ask to enable AI processing on your Mac when you're ready. It uses paid TwelveLabs and OpenAI requests. You can keep editing saved projects meanwhile.", showsActivity: false)
        }
        if stage.hasPrefix("Analyzed ") {
            return .init(title: stage, detail: "Completed video analyses are saved. We're waiting for TwelveLabs to finish the remaining videos; each one can take a different amount of time.", next: "Next: check speech boundaries if needed, then choose the cut. You don't need to upload again.", showsActivity: true)
        }
        let key = stage.lowercased()
        if key.contains("speech") {
            return .init(title: "Checking spoken-word timing", detail: "OpenAI is locating words in the original audio so edits don't cut through them. This does not add captions.", next: "Next: choose the shots and assemble your cut.", showsActivity: true)
        }
        if key.contains("choosing") || key.contains("revising") {
            return .init(title: key.contains("revising") ? "Revising your cut" : "Choosing your shots", detail: "OpenAI is using your recipe and saved video analysis to select shots, arrange them, and choose trim points. The result is then checked against the source footage.", next: "Next: your cut will be ready to preview and approve.", showsActivity: true)
        }
        if kind == "analysis" || key.contains("analyzing") || key.contains("preparing footage") {
            return .init(title: key.contains("preparing") ? "Preparing video for analysis" : "Understanding your video", detail: "Your Mac prepares the video, then TwelveLabs identifies scenes, actions and audio. The result is saved for reuse.", next: "Next: use the completed analysis to make editing decisions.", showsActivity: true)
        }
        if kind == "teach" || kind == "lesson" {
            return .init(title: kind == "teach" ? "Learning from your reference" : "Saving what you changed", detail: "The service uses the saved evidence and your feedback to record editing observations.", next: "Next: those observations become available to future editing requests.", showsActivity: true)
        }
        return .init(title: "Request saved · waiting to start", detail: "Your Mac has the request. It is waiting for the AI worker to pick it up; no completion time is available yet.", next: "Next: reuse any saved analyses, analyze missing videos, then build your cut.", showsActivity: false)
    }

    public static func operationDetail(_ stage: String) -> String {
        let key = stage.lowercased()
        if key.contains("upload") || key.contains("sending your footage") { return "Copying your videos to the editing service. Progress is saved after each part; if iOS pauses the transfer, reopen PB&J to continue." }
        if key.contains("preview") || key.contains("opening") { return "Loading the saved timeline and preparing its original videos for playback on this iPhone." }
        if key.contains("approved") { return "Saving your approval on the Mac, then opening the editable timeline in Studio. This step does not call an AI provider." }
        if key.contains("export") { return "Rendering the edited video on this iPhone. If background rendering isn't available, your edit stays saved and you can restart the export from its project." }
        if key.contains("revision") { return "Saving your latest edits and sending your instructions to the Mac. AI processing must be enabled before the revision can run." }
        if key.contains("original") || key.contains("import") { return "Saving a local copy of your media so this project can reopen later." }
        if key.contains("request") { return "Saving your recipe and uploaded video references on the Mac before any AI work can begin." }
        return "Saving or loading the information needed for this step. If iOS pauses work, return to PB&J to continue." 
    }
}
