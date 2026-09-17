import AVFoundation
import Combine
import Foundation
import PBJCore

@MainActor
final class EditorModel: ObservableObject {
    @Published private(set) var document: ProjectDocument
    @Published var selectedID: String?
    @Published var error: String?
    @Published private(set) var stage: String?
    @Published private(set) var position = 0.0
    @Published private(set) var isPlaying = false
    @Published private(set) var exportURL: URL?
    @Published private(set) var verification: ExportVerification?
    @Published private(set) var exportJob: ExportJob?
    @Published private(set) var exportProgress: Double?
    var onExportCompleted: ((ExportJob) async -> Void)?
    var onExportPaused: ((ExportJob) async -> Void)?
    let player = AVPlayer()
    private(set) var root: URL
    private var store: ProjectStore { ProjectStore(root: root) }
    @Published private(set) var projects: [LocalProject] = []
    struct LocalProject: Identifiable { let root: URL; let title: String; var id: String { root.path } }
    private var observer: Any?
    private var itemObservation: NSKeyValueObservation?
    private var preparation: Task<Void, Never>?
    private var exportRecovery: Task<Void, Never>?
    private var prepared: PreparedTimeline?
    private var damaged = false
    private var seekQueue = LatestSeekQueue()
    private var scrubbing = false
    var timeline: Timeline { document.current }
    var seconds: Double { Double(timeline.duration) / 60_000 }
    var busy: Bool { stage != nil }
    var selected: TimelineClip? { timeline.clips.first { $0.id == selectedID } }

    init() {
        root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("PBJ", isDirectory: true)
        if let projectID = UserDefaults.standard.string(forKey: "PBJActiveProject"), UUID(uuidString: projectID) != nil {
            root = root.deletingLastPathComponent().appendingPathComponent("PBJProjects").appendingPathComponent(projectID)
        }
        document = ProjectDocument(title: "Media test")
        player.automaticallyWaitsToMinimizeStalling = false
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback,mode:.moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch { self.error = "Audio playback could not start: \(error.localizedDescription)" }
        if FileManager.default.fileExists(atPath: root.appendingPathComponent("project.json").path) {
            do { document = try store.load() }
            catch { self.error = "Saved project could not be opened. It has been preserved. \(error.localizedDescription)"; damaged = true }
        }
        observer = player.addPeriodicTimeObserver(forInterval: CMTime(seconds: 1.0 / 30, preferredTimescale: 60000), queue: .main) { [weak self] time in
            Task { @MainActor in
                guard let self else { return }
                // Paused decoder callbacks must not pull the strip away from
                // the finger's requested position, even between seek completions.
                if !self.scrubbing, !self.seekQueue.hasWork, self.player.rate > 0 {
                    let current = self.player.currentTime().seconds
                    let next = max(0,current.isFinite ? current : 0)
                    if self.position != next { self.position = next }
                }
                let playing = self.player.timeControlStatus == .playing
                if self.isPlaying != playing { self.isPlaying = playing }
            }
        }
        refreshProjects()
        prepare()
        restoreLatestExport()
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("--import-planned-project") {
            Task { await preparation?.value; await importPlannedProject() }
        }

        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--test-media"),
           ProcessInfo.processInfo.arguments.indices.contains(index + 1), document.sources.isEmpty {
            let url = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[index + 1])
            Task { await importFiles([url]) }
        }
        if let index = ProcessInfo.processInfo.arguments.firstIndex(of: "--append-test-media"),
           ProcessInfo.processInfo.arguments.indices.contains(index + 1) {
            let url = URL(fileURLWithPath: ProcessInfo.processInfo.arguments[index + 1])
            Task { while busy { try? await Task.sleep(for: .milliseconds(100)) }; await importFiles([url]) }
        }
        #endif
    }

    private var accountRoot: URL?
    private var documentsRoot: URL { accountRoot ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0] }
    func useAccountDirectory(_ directory: URL?) {
        guard !busy else { return }
        accountRoot = directory
        root = documentsRoot.appendingPathComponent("PBJ")
        damaged=false
        if FileManager.default.fileExists(atPath:root.appendingPathComponent("project.json").path) {
            do {document=try ProjectStore(root:root).load()}
            catch {damaged=true;document=ProjectDocument(title:"Saved project needs recovery");self.error="The saved project is damaged. It has been preserved: \(error.localizedDescription)"}
        } else {document=ProjectDocument(title:"Media test")}
        selectedID = nil; position = 0; exportURL = nil; verification = nil
        refreshProjects(); prepare(); restoreLatestExport()
    }
    func installSnapshot(projectID: String, title: String, timeline: Timeline, sources: [MediaSource], sourceURLs: [String: URL]) async throws {
        guard !busy else { throw TimelineError.invalid("Finish the current editor operation first.") }
        guard UUID(uuidString: projectID) != nil else { throw TimelineError.invalid("Invalid project ID") }
        try timeline.validate(sources: sources, eligibleIDs: Set(sources.map(\.id)))
        stage = "Opening your cut"
        player.pause()
        let destination = documentsRoot.appendingPathComponent("PBJProjects").appendingPathComponent(projectID)
        do {
            // Finish this stage before openProject starts its own preview task.
            // A function-wide defer would erase that task's busy/loading state.
            defer { stage = nil }
            let destinationStore = ProjectStore(root: destination)
            let media = destination.appendingPathComponent("media")
            try FileManager.default.createDirectory(at: media, withIntermediateDirectories: true)
            for source in sources {
                guard UUID(uuidString: source.id) != nil, let original = sourceURLs[source.id] else { throw TimelineError.invalid("Original source unavailable") }
                let target = media.appendingPathComponent(source.id).appendingPathExtension((source.fileName as NSString).pathExtension)
                try await Task.detached {
                    if !FileManager.default.fileExists(atPath: target.path) {
                        let temporary = target.appendingPathExtension("importing")
                        try? FileManager.default.removeItem(at: temporary)
                        try FileManager.default.copyItem(at: original, to: temporary)
                        guard try MediaImport.hash(temporary) == source.sha256 else { try? FileManager.default.removeItem(at: temporary); throw TimelineError.invalid("Original checksum changed") }
                        try FileManager.default.moveItem(at: temporary, to: target)
                    } else if try MediaImport.hash(target) != source.sha256 { throw TimelineError.invalid("Saved original checksum changed") }
                }.value
            }
            var next: ProjectDocument
            if FileManager.default.fileExists(atPath: destination.appendingPathComponent("project.json").path) {
                next = try destinationStore.load()
                for source in sources where !next.sources.contains(where: { $0.id == source.id }) { next.sources.append(source) }
                if let index = next.history.firstIndex(where: { $0.id == timeline.id }) { next.historyIndex = index }
                else { next.history = Array(next.history.prefix(next.historyIndex + 1)) + [timeline]; next.historyIndex = next.history.count - 1 }
            } else { next = ProjectDocument(title: title, sources: sources, timeline: timeline); next.id = projectID }
            next.title = title
            try destinationStore.save(next)
        }
        refreshProjects()
        openProject(LocalProject(root: destination, title: title))
    }

    func refreshProjects() {
        let original = documentsRoot.appendingPathComponent("PBJ")
        let library = documentsRoot.appendingPathComponent("PBJProjects")
        let children = (try? FileManager.default.contentsOfDirectory(at: library, includingPropertiesForKeys: nil)) ?? []
        projects = ([original] + children.filter { UUID(uuidString: $0.lastPathComponent) != nil }).compactMap { folder in
            guard let saved = try? ProjectStore(root: folder).load() else { return nil }
            return LocalProject(root: folder, title: saved.title)
        }.sorted { $0.title < $1.title }
    }
    func openProject(_ project: LocalProject) {
        guard !busy else { return }
        do {
            let saved = try ProjectStore(root: project.root).load()
            // Invalidate old preparation immediately before changing the document.
            preparation?.cancel()
            root = project.root
            document = saved
            damaged = false
            selectedID = nil
            position = 0
            exportURL = nil
            verification = nil
            if project.root.lastPathComponent == "PBJ" { UserDefaults.standard.removeObject(forKey: "PBJActiveProject") }
            else { UserDefaults.standard.set(project.root.lastPathComponent, forKey: "PBJActiveProject") }
            prepare()
            restoreLatestExport()
        } catch { self.error = "This project could not be opened. \(error.localizedDescription)" }
    }
    #if DEBUG
    var hasIncomingPlannedCut: Bool { FileManager.default.fileExists(atPath: documentsRoot.appendingPathComponent("IncomingPlannedCut/timeline.json").path) }
    func importPlannedProject() async {
        guard !busy else { return }
        stage = "Opening saved AI rough cut"
        player.pause()
        let bundle = documentsRoot.appendingPathComponent("IncomingPlannedCut")
        let library = documentsRoot.appendingPathComponent("PBJProjects")
        do {
            let destination = try await Task.detached { try await PlannedProjectImport.install(bundle: bundle, library: library) }.value
            stage = nil
            refreshProjects()
            if let project = projects.first(where: { $0.root == destination }) { openProject(project) }
        } catch { stage = nil; self.error = "The rough cut could not be imported. Your projects are preserved. \(error.localizedDescription)" }
    }
    #endif

    private var urls: [String: URL] {
        Dictionary(uniqueKeysWithValues: document.sources.map { source in
            (source.id, root.appendingPathComponent("media").appendingPathComponent(source.id)
                .appendingPathExtension((source.fileName as NSString).pathExtension))
        })
    }
    func sourceURL(_ id: String) -> URL? {
        guard let source = document.sources.first(where: { $0.id == id }) else { return nil }
        return root.appendingPathComponent("media").appendingPathComponent(id)
            .appendingPathExtension((source.fileName as NSString).pathExtension)
    }

    func importFiles(_ files: [URL], replacing: String? = nil) async {
        guard !busy, !damaged else { error = "Import has not started. Finish the current operation or recover the saved project, then retry."; return }
        stage = "Importing original footage"
        player.pause()
        var next = document
        var edit = timeline
        var failures: [String] = []
        for (index, file) in files.enumerated() {
            if Task.isCancelled { failures.append("Import paused. Choose the remaining videos again."); break }
            let access = file.startAccessingSecurityScopedResource()
            do {
                let directory = root.appendingPathComponent("media")
                let importing = Task.detached { try await MediaImport.copy(file, into: directory) }
                let (source, _) = try await withTaskCancellationHandler {
                    try await importing.value
                } onCancel: { importing.cancel() }
                next.sources.append(source)
                var clip = TimelineClip(sourceID: source.id, sourceDuration: source.duration)
                if index == 0, let replacing, let target = edit.clips.firstIndex(where: { $0.id == replacing }) {
                    clip.id = replacing
                    clip.volume = edit.clips[target].volume
                    clip.muted = edit.clips[target].muted
                    clip.fit = edit.clips[target].fit
                    edit.clips[target] = clip
                } else { edit.clips.append(clip) }
            } catch { failures.append("\(file.lastPathComponent): \(error.localizedDescription)") }
            if access { file.stopAccessingSecurityScopedResource() }
        }
        edit.reflow()
        do {
            try next.commit(edit)
            try store.save(next)
            document = next
            refreshProjects()
            exportURL = nil
        } catch { failures.append(error.localizedDescription) }
        stage = nil
        if !failures.isEmpty { error = failures.joined(separator: "\n") }
        prepare()
    }

    func edit(_ change: (inout Timeline) throws -> Void) {
        guard !busy, !damaged else { return }
        do {
            var next = document
            var timeline = next.current
            try change(&timeline)
            timeline.reflow()
            guard timeline != next.current else { return }
            try next.commit(timeline)
            try store.save(next)
            document = next
            exportURL = nil
            verification = nil
            prepare()
        } catch { self.error = error.localizedDescription }
    }

    func history(redo: Bool) {
        guard !busy, !damaged else { return }
        var next = document
        if redo { next.redo() } else { next.undo() }
        guard next.historyIndex != document.historyIndex else { return }
        do { try store.save(next); document = next; exportURL = nil; verification = nil; prepare() }
        catch { self.error = error.localizedDescription }
    }

    func seek(_ seconds: Double) { requestSeek(seconds,precise:true) }

    func beginScrub() {
        guard !scrubbing else { return }
        scrubbing = true
        player.pause()
        if isPlaying { isPlaying = false }
    }
    func scrub(to seconds: Double) {
        beginScrub()
        requestSeek(seconds,precise:false)
    }
    func endScrub() {
        guard scrubbing else { return }
        scrubbing = false
        requestSeek(position,precise:true)
    }
    private func requestSeek(_ seconds:Double,precise:Bool) {
        guard seconds.isFinite else { return }
        let target = min(max(seconds,0),self.seconds)
        if position != target { position = target }
        guard player.currentItem != nil else { return }
        if let request = seekQueue.enqueue(ticks:Int64((target*60000).rounded()),precise:precise) {
            performSeek(request)
        }
    }
    private func performSeek(_ request:LatestSeekQueue.Request) {
        // Moving previews may use a nearby frame; release always requests an
        // exact frame. Only a completed seek starts the newest pending request.
        let tolerance = request.precise ? CMTime.zero : CMTime(value:4000,timescale:60000)
        player.seek(to:CMTime(value:request.ticks,timescale:60000),toleranceBefore:tolerance,toleranceAfter:tolerance) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if let next = self.seekQueue.complete(id:request.id) { self.performSeek(next) }
            }
        }
    }
    func togglePlayback() {
        guard prepared != nil else { return }
        if player.rate > 0 { player.pause() }
        else {
            if position >= seconds - 0.01 { seek(0) }
            let before = player.currentTime().seconds
            let revisionID = timeline.id
            player.playImmediately(atRate:1)
            Task { [weak self] in
                try? await Task.sleep(for:.seconds(4))
                guard let self, self.timeline.id == revisionID, self.player.rate > 0 else { return }
                if abs(self.player.currentTime().seconds - before) < 0.03 {
                    self.player.pause(); self.isPlaying = false
                    self.error = "Preview playback did not advance on this device. Your edits and originals are saved. Export remains available; preview requires further testing."
                }
            }
        }
        isPlaying = player.rate > 0
    }

    func split() {
        guard let selected else { return }
        let offset = Int64(((position * 60000 - Double(selected.outputStart)) * selected.playbackRate).rounded())
        edit { try $0.split(clipID: selected.id, at: offset) }
    }
    func trim(_ clip: TimelineClip) {
        guard !busy, !damaged, let current = selected, current.id == clip.id, current != clip else { return }
        // Set the desired position before preparing the committed composition.
        // A complete drag creates one persisted revision, not one per frame.
        position = min(position, Double(timeline.duration - current.outputDuration + clip.outputDuration) / 60000)
        edit { timeline in
            guard let index = timeline.clips.firstIndex(where: { $0.id == clip.id }) else { return }
            timeline.clips[index].sourceIn = clip.sourceIn
            timeline.clips[index].sourceDuration = clip.sourceDuration
        }
    }
    func setSpeed(_ value: Double) {
        guard let id = selectedID else { return }
        edit { timeline in
            guard let index = timeline.clips.firstIndex(where: { $0.id == id }) else { return }
            timeline.schemaVersion = 2; timeline.clips[index].speed = value
        }
    }
    func rotateSelected() {
        guard let id = selectedID else { return }
        edit { timeline in
            guard let index = timeline.clips.firstIndex(where: { $0.id == id }) else { return }
            timeline.schemaVersion = 2; timeline.clips[index].rotation = ((timeline.clips[index].rotation ?? 0) + 90) % 360
        }
    }
    func setFit(_ fit: String) {
        guard let id = selectedID else { return }
        edit { timeline in
            guard let index = timeline.clips.firstIndex(where: { $0.id == id }) else { return }
            timeline.clips[index].fit = fit
        }
    }
    func addText(caption: Bool = false) {
        let start = Int64((position * 60000).rounded())
        guard timeline.duration > start else { error = "Move the playhead inside the video first."; return }
        edit { timeline in
            timeline.schemaVersion = 2
            var overlays = timeline.overlays ?? []
            overlays.append(TimelineOverlay(kind:caption ? "caption":"text",start:start,end:min(timeline.duration,start+180000),text:"Your text"))
            timeline.overlays = overlays
        }
    }
    func updateOverlay(_ overlay: TimelineOverlay) {
        edit { timeline in
            guard let index = timeline.overlays?.firstIndex(where: { $0.id == overlay.id }) else { return }
            timeline.overlays?[index] = overlay
        }
    }
    func deleteOverlay(_ id: String) { edit { $0.overlays?.removeAll { $0.id == id } } }
    func updateSound(_ sound: TimelineSound) {
        edit { timeline in
            guard let index = timeline.sounds?.firstIndex(where: { $0.id == sound.id }) else { return }
            timeline.sounds?[index] = sound
        }
    }
    func deleteSound(_ id: String) { edit { $0.sounds?.removeAll { $0.id == id } } }
    func extractSelectedSound() {
        guard let clip = selected, document.sources.first(where: { $0.id == clip.sourceID })?.hasAudio == true else { error = "Select a clip with original sound first."; return }
        edit { timeline in
            var sound = TimelineSound(sourceID:clip.sourceID,sourceIn:clip.sourceIn,sourceDuration:clip.sourceDuration,outputStart:clip.outputStart,volume:clip.volume)
            sound.speed = clip.speed
            timeline.sounds = (timeline.sounds ?? []) + [sound]
            timeline.schemaVersion = 2
            if let index = timeline.clips.firstIndex(where: { $0.id == clip.id }) { timeline.clips[index].muted = true }
        }
    }
    func importFinishing(_ file: URL, kind: String) async {
        guard !busy, !damaged, !timeline.clips.isEmpty else { return }
        stage = "Importing \(kind)"; player.pause()
        let access = file.startAccessingSecurityScopedResource(); defer { if access { file.stopAccessingSecurityScopedResource() } }
        do {
            let directory = root.appendingPathComponent("media")
            let (source, _) = try await Task.detached {
                if kind == "sound" { return try await MediaImport.copySound(file, into: directory) }
                if kind == "image" { return try MediaImport.copyImage(file, into: directory) }
                return try await MediaImport.copy(file, into: directory)
            }.value
            var next = document; next.sources.append(source)
            var timeline = next.current; timeline.schemaVersion = 2
            let start = min(max(0,Int64((position * 60000).rounded())),max(0,timeline.duration-2000))
            if kind == "sound" { timeline.sounds = (timeline.sounds ?? []) + [TimelineSound(sourceID:source.id,sourceDuration:source.duration,outputStart:start)] }
            else {
                var overlay = TimelineOverlay(kind:kind,start:start,end:min(timeline.duration,start+(kind=="image" ? 180000:source.duration)),sourceID:source.id)
                overlay.width = 0.45; overlay.y = 0.5
                timeline.overlays = (timeline.overlays ?? []) + [overlay]
            }
            try next.commit(timeline); try store.save(next); document = next; exportURL = nil; verification = nil
            stage = nil; prepare()
        } catch { stage = nil; self.error = error.localizedDescription }
    }
    func addCaptions(_ wordsBySource: [String: [TimedWord]], style: String) {
        let captions = CaptionBuilder.overlays(timeline:timeline,wordsBySource:wordsBySource,style:style)
        guard !captions.isEmpty else { error = "No timed speech is available inside these unmuted clips."; return }
        edit { timeline in
            timeline.schemaVersion = 2
            timeline.overlays = (timeline.overlays ?? []).filter { $0.kind != "caption" } + captions
        }
    }
    func deleteSelected() {
        guard let selectedID else { return }
        edit { $0.clips.removeAll { $0.id == selectedID } }
        self.selectedID = nil
    }
    func moveClip(_ id:String,to target:Int) {
        edit { timeline in
            guard let index=timeline.clips.firstIndex(where:{$0.id==id}),timeline.clips.indices.contains(target),index != target else {return}
            let clip=timeline.clips.remove(at:index);timeline.clips.insert(clip,at:target)
        }
    }
    func moveSelected(by delta: Int) {
        guard let selectedID else { return }
        edit { timeline in
            guard let index = timeline.clips.firstIndex(where: { $0.id == selectedID }), timeline.clips.indices.contains(index + delta) else { return }
            timeline.clips.swapAt(index,index + delta)
        }
    }

    private func prepare() {
        preparation?.cancel()
        seekQueue.cancel()
        scrubbing = false
        player.currentItem?.cancelPendingSeeks()
        player.pause()
        prepared = nil
        player.replaceCurrentItem(with: nil)
        guard !timeline.clips.isEmpty else { position = 0; return }
        let revision = timeline, sources = document.sources, urls = urls, oldPosition = position
        stage = "Preparing local preview"
        preparation = Task {
            do {
                let prepared = try await NativeCompositor.prepare(revision,sources:sources,urls:urls)
                guard !Task.isCancelled, document.current.id == revision.id else { return }
                self.prepared = prepared
                var item = prepared.playerItem()
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--direct-preview-test"), let first=revision.clips.first, let url=urls[first.sourceID] {
                    item=AVPlayerItem(url:url)
                }
                #endif
                itemObservation = item.observe(\.status,options:[.new,.initial]) { [weak self] item, _ in
                    if item.status == .failed {
                        let message = item.error?.localizedDescription ?? "The device could not decode this source."
                        Task { @MainActor in self?.error = message; self?.isPlaying = false }
                    }
                }
                player.replaceCurrentItem(with: item)
                #if DEBUG
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(3))
                    guard let self else { return }
                    NSLog("PBJ preview item=%ld control=%ld rate=%f reason=%@ error=%@",item.status.rawValue,self.player.timeControlStatus.rawValue,self.player.rate,self.player.reasonForWaitingToPlay?.rawValue ?? "none",String(describing:item.error))
                }
                #endif
                seek(oldPosition)
                stage = nil
            } catch {
                guard !Task.isCancelled else { return }
                stage = nil
                self.error = error.localizedDescription
            }
        }
    }

    func export() async {
        guard let prepared, !busy else { return }
        await performExport(ExportJob(snapshot: document, expectsAudio: prepared.expectsAudio), prepared: prepared)
    }

    func resumeExport() async {
        guard !busy, let job = exportJob, job.status == .interrupted else { return }
        if let output = try? ExportJobStore(root: root).outputURL(job.id), FileManager.default.fileExists(atPath: output.path) {
            do { try await openSavedExport(job.id) }
            catch { self.error = error.localizedDescription }
            return
        }
        await performExport(job, prepared: nil)
    }

    private func performExport(_ saved: ExportJob, prepared initial: PreparedTimeline?) async {
        exportRecovery?.cancel()
        player.pause()
        stage = "Exporting on this device"
        exportURL = nil; verification = nil; exportProgress = 0
        let projectRoot = root, store = ExportJobStore(root: root)
        var job = saved
        job.status = .rendering; job.message = nil; job.verification = nil
        exportJob = job
        defer { stage = nil; exportProgress = nil }
        var recordedFailure = false
        do {
            // Persist identity and the frozen revision before starting any work.
            try store.save(job)
            let partial = try store.partialURL(job.id)
            try? FileManager.default.removeItem(at: partial)
            let frozen = job
            let completed = try await BackgroundWorkController.shared.run(
                title: "Exporting video", projectID: job.projectID, requiresGPU: true
            ) { update in
              do {
                let composition: PreparedTimeline
                if let initial { composition = initial }
                else {
                    let paths = Dictionary(uniqueKeysWithValues: frozen.snapshot.sources.map { source in
                        (source.id, projectRoot.appendingPathComponent("media").appendingPathComponent(source.id)
                            .appendingPathExtension((source.fileName as NSString).pathExtension))
                    })
                    composition = try await NativeCompositor.prepare(frozen.snapshot.current,
                        sources: frozen.snapshot.sources, urls: paths)
                }
                let report = try await NativeCompositor.export(composition, to: partial) { value, message in
                    guard !Task.isCancelled else { return }
                    await update(value, message)
                    await MainActor.run {
                        guard !Task.isCancelled, self.root == projectRoot, self.exportJob?.id == frozen.id else { return }
                        self.exportProgress = value; self.stage = message
                    }
                }
                try Task.checkCancellation()
                let completed = try store.complete(frozen, report: report)
                self.exportJob = completed
                self.verification = completed.verification
                self.exportURL = try store.outputURL(completed.id)
                // Schedule the notification while the execution allowance is
                // still held, after both the output and its record are saved.
                await self.onExportCompleted?(completed)
                return completed
              } catch {
                recordedFailure = true
                await self.recordExportFailure(frozen, store: store, failure: error)
                throw error
              }
            }
            exportJob = completed
            verification = completed.verification
            exportURL = try store.outputURL(job.id)
        } catch {
            if !recordedFailure { await recordExportFailure(job, store: store, failure: error) }
        }
    }

    private func recordExportFailure(_ job: ExportJob, store: ExportJobStore, failure: Error) async {
        // Cancellation can race the final record commit. A durable completion
        // remains completed even if the caller stopped awaiting its result.
        if let saved = try? store.load(job.id), saved.status == .completed,
           let output = try? store.outputURL(job.id), FileManager.default.fileExists(atPath: output.path) {
            exportJob = saved; verification = saved.verification; exportURL = output
            return
        }
        let paused = failure is CancellationError || Task.isCancelled
        let message = paused ? "Export paused. Your edit is saved. Open PB&J to restart this export." : failure.localizedDescription
        do {
            let stopped = try store.interrupt(job, message: message)
            exportJob = stopped
            await onExportPaused?(stopped)
        } catch { self.error = "The export needs recovery. Its saved files have been preserved. \(error.localizedDescription)" }
        if !paused { self.error = message }
    }

    func openSavedExport(_ id: String) async throws {
        let recovery = exportRecovery
        exportRecovery = nil
        recovery?.cancel()
        await recovery?.value
        let projectRoot = root
        if stage == "Preparing local preview" { await preparation?.value }
        try Task.checkCancellation()
        guard root == projectRoot else { throw TimelineError.invalid("The active project changed before its export opened.") }
        try await recoverSavedExport(id)
    }

    private func recoverSavedExport(_ id: String) async throws {
        guard !busy else { throw TimelineError.invalid("Finish the current editor operation first.") }
        stage = "Checking saved export"
        defer { stage = nil }
        let store = ExportJobStore(root: root)
        let saved = try store.load(id)
        guard saved.projectID == document.id else { throw TimelineError.invalid("Saved export belongs to another project.") }
        let recovered = try await store.recover(saved) { output, job in
            try await NativeCompositor.verify(output, revisionID: job.revisionID,
                expectedDuration: Double(job.snapshot.current.duration) / Double(timelineTimescale),
                expectsAudio: job.expectsAudio)
        }
        exportJob = recovered
        if recovered.status == .completed {
            verification = recovered.verification
            exportURL = try store.outputURL(recovered.id)
            if saved.status != .completed { await onExportCompleted?(recovered) }
        } else { exportURL = nil; verification = nil }
    }

    private func restoreLatestExport() {
        exportRecovery?.cancel()
        exportJob = nil; exportProgress = nil
        let projectRoot = root, preview = preparation
        exportRecovery = Task {
            await preview?.value
            guard !Task.isCancelled, root == projectRoot, !busy else { return }
            do {
                if let job = try ExportJobStore(root: projectRoot).latest() { try await recoverSavedExport(job.id) }
            } catch {
                guard !Task.isCancelled, root == projectRoot else { return }
                self.error = "Saved export needs recovery. Its files have been preserved. \(error.localizedDescription)"
            }
        }
    }
}
