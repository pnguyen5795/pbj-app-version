import AVKit
import Photos
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import PBJCore

private let purple = Color(red: 139/255, green: 92/255, blue: 246/255)
private let cream = Color(red: 254/255, green: 246/255, blue: 238/255)

struct StudioView: View {
    @EnvironmentObject private var editor: EditorModel
    @EnvironmentObject private var app: ApplicationModel
    @EnvironmentObject private var mediaImport: MediaImportProgress
    @ObservedObject private var backgroundWork = BackgroundWorkController.shared
    @State private var revisionPrompt = ""
    @State private var selectedOnly = true
    @State private var finishing = false
    @State private var chooseFootage = false
    @State private var files = false
    @State private var showPhotos = false
    @State private var photos: [PhotosPickerItem] = []
    @State private var fullscreen = false
    @State private var showExport = false
    @State private var replaceID: String?

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                HStack {
                    PBJBack {
                        editor.player.pause()
                        app.route = app.studioReturnRoute
                    }.disabled(editor.busy || app.busy)
                    Spacer()
                    Menu {
                        Button("Home") { app.route = .home }
                        Button("My Projects") { app.route = .projects }
                        if app.detail != nil { Button("Review & Previous Versions") { app.route = .review } }
                        Divider()
                        #if DEBUG
                        if editor.hasIncomingPlannedCut {
                            Button("Open AI test cut") { Task { await editor.importPlannedProject() } }
                            Divider()
                        }
                        #endif
                        ForEach(editor.projects) { project in
                            Button(project.title) {
                                if let remote = app.projects.first(where: { $0.id == project.root.lastPathComponent }) { Task { await app.openRemote(remote.id, editor: editor, editing: true) } }
                                else { app.localProject = true; app.detail = nil; editor.openProject(project) }
                            }
                        }
                    } label: {
                        HStack(spacing: 5) { Text("Studio"); Image(systemName: "chevron.down").font(.caption) }
                            .font(.system(size:17,weight:.semibold))
                    }.disabled(editor.busy).accessibilityLabel("Choose project")
                    Spacer()
                    Button { Task { await CompletionNotifications.shared.requestPermission(); await editor.export(); if editor.exportURL != nil { showExport = true } } } label: {
                        Image(systemName:"arrow.right").foregroundStyle(.white).frame(width:44,height:44).background(.black,in:Circle())
                    }.disabled(editor.timeline.clips.isEmpty || editor.busy).accessibilityLabel("Export video")
                }.padding(.horizontal,24).padding(.vertical,8)

                ZStack {
                    Color.black
                    if editor.timeline.clips.isEmpty {
                        VStack(spacing:16) {
                            Image("sandwich-logo").resizable().scaledToFit().frame(width:140)
                            Text("Bring your footage").font(.system(size:24,weight:.bold))
                            Text("Import a video to test the native timeline.").font(.system(size:17)).multilineTextAlignment(.center)
                            Button("Choose Files") { files = true }.buttonStyle(.borderedProminent).tint(purple)
                        }.foregroundStyle(.white).padding(24)
                    } else { PlayerSurface(player:editor.player) }
                }.frame(height:max(200,min(geometry.size.height * 0.46,410))).clipped()

                VStack(spacing:8) {
                    if let stage = editor.stage {
                        HStack(spacing: 8) { ProgressView(); Text(stage).font(.system(size: 13, weight: .semibold)) }
                        Text(JobProgressMessage.operationDetail(stage)).font(.system(size: 12)).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal, 20)
                    }
                    Text(editor.stage == nil ? "Original footage · edits saved on this device" : "")
                        .font(.system(size:13)).foregroundStyle(.secondary).lineLimit(2)
                    Text(editor.document.title)
                        .font(.system(size:13)).foregroundStyle(.secondary).lineLimit(1)
                }.padding(.horizontal,24).padding(.top,10)

                HStack(spacing:8) {
                    Text("\(time(editor.position)) / \(time(editor.seconds))").monospacedDigit().font(.system(size:13)).foregroundStyle(.secondary)
                    Spacer()
                    Button { editor.togglePlayback() } label: {
                        Image(systemName:editor.isPlaying ? "pause.fill" : "play.fill").foregroundStyle(.white).frame(width:44,height:44).background(.black,in:Circle())
                    }.accessibilityLabel(editor.isPlaying ? "Pause" : "Play").disabled(editor.busy)
                    Spacer()
                    icon("arrow.uturn.backward","Undo") { editor.history(redo:false) }.disabled(editor.document.historyIndex == 0 || editor.busy)
                    icon("arrow.uturn.forward","Redo") { editor.history(redo:true) }.disabled(editor.document.historyIndex + 1 >= editor.document.history.count || editor.busy)
                    icon("arrow.up.left.and.arrow.down.right","Fullscreen") { fullscreen = true }
                }.padding(.horizontal,24)

                StudioTimeline { replaceID = nil; chooseFootage = true }.frame(height:144)
                Divider()
                ScrollView(.horizontal,showsIndicators:false) {
                    HStack(spacing:24) {
                        if editor.selected != nil {
                        tool("chevron.down","Done") { editor.selectedID = nil }
                        tool("scissors","Split") { editor.split() }
                        Menu {
                            ForEach([0.25,0.5,1.0,1.5,2.0,4.0], id: \.self) { speed in Button(String(format: "%g×", speed)) { editor.setSpeed(speed) } }
                        } label: { toolLabel("speedometer", "Speed") }
                        Menu {
                            Button("Rotate 90°") { editor.rotateSelected() }
                            Button("Fit in frame") { editor.setFit("fit") }
                            Button("Fill frame") { editor.setFit("fill") }
                        } label: { toolLabel("crop.rotate", "Crop") }
                        tool("arrow.triangle.2.circlepath","Replace") { replaceID = editor.selectedID; files = true }.disabled(editor.selected == nil)
                        Menu {
                            Button("Mute / unmute") { toggleMute() }
                            Button("50% volume") { setVolume(0.5) }
                            Button("100% volume") { setVolume(1) }
                            Button("150% volume") { setVolume(1.5) }
                        } label: { toolLabel("speaker.wave.2","Volume") }.disabled(editor.selected == nil)
                        tool("trash","Delete") { editor.deleteSelected() }.disabled(editor.selected == nil)
                        } else {
                            tool("plus","Add clips") { replaceID = nil; chooseFootage = true }
                            tool("waveform", "Sound") { finishing = true }
                            tool("textformat", "Text") { finishing = true }
                            tool("square.on.square", "Overlays") { finishing = true }
                            Text("Tap a clip to edit").font(.system(size:13)).foregroundStyle(.secondary)
                        }
                    }.padding(.horizontal,24).padding(.vertical,10)
                }.disabled(editor.busy)
                Divider()
                VStack(spacing: 6) {
                    if editor.selected != nil && app.detail != nil {
                        Toggle("Revise selected clip only", isOn: $selectedOnly).font(.system(size: 13))
                    }
                    HStack {
                        TextField(app.detail == nil ? "AI revisions need a generated project" : "Tell us what to change", text: $revisionPrompt, axis: .vertical).font(.system(size: 13)).lineLimit(1...3).disabled(app.detail == nil)
                        Button {
                            let prompt = revisionPrompt
                            Task { await app.revise(prompt, editor: editor, scoped: selectedOnly && editor.selected != nil);if app.route == .cooking {revisionPrompt=""} }
                        } label: { Image(systemName: "arrow.up.circle.fill").font(.system(size: 28)) }
                        .disabled(app.detail == nil || app.busy || revisionPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                    if app.hasUnsentEdits { Text("Saved on this device · sync pending").font(.system(size: 11)).foregroundStyle(.secondary) }
                }.padding(16).background(Color(red:0.95,green:0.95,blue:0.97),in:RoundedRectangle(cornerRadius:24)).padding(16)
                Spacer(minLength:0)
            }.frame(width:geometry.size.width,alignment:.leading)
                .background(LinearGradient(colors:[.white,cream],startPoint:.top,endPoint:.bottom))
        }
        // Keep the presentation attached to Studio after the menu dismisses.
        .confirmationDialog("Choose footage", isPresented: $chooseFootage, titleVisibility: .visible) {
            Button("Photos") { showPhotos = true }
            Button("Files") { files = true }
        }
        .photosPicker(isPresented:$showPhotos,selection:$photos,matching:.videos)
        .fileImporter(isPresented:$files,allowedContentTypes:[.movie,.video,.mpeg4Movie],allowsMultipleSelection:replaceID == nil) { result in
            switch result {
            case .success(let urls):
                guard !urls.isEmpty else { return }
                let target = replaceID
                mediaImport.run("Saving your videos…", onError: { editor.error = $0.localizedDescription }) {
                    await editor.importFiles(urls, replacing: target)
                }
            case .failure(let error): editor.error = error.localizedDescription
            }
        }
        .onChange(of:photos) { _, items in
            guard !items.isEmpty else { return }
            photos = []
            let target = replaceID
            mediaImport.videos(items, onPick: { await editor.importFiles($0, replacing: target) },
                               onError: { editor.error = $0.localizedDescription })
        }
        .fullScreenCover(isPresented:$fullscreen) {
            ZStack(alignment:.topTrailing) { Color.black.ignoresSafeArea(); VideoPlayer(player:editor.player).ignoresSafeArea()
                Button("Done") { fullscreen = false }.padding().buttonStyle(.borderedProminent)
            }
        }
        .sheet(isPresented:$finishing) { FinishingPanel().environmentObject(editor).environmentObject(app) }
        .sheet(isPresented:$showExport) { ExportSheet().environmentObject(editor) }
        .onChange(of: app.openedExportID) { _, id in
            if id != nil, editor.exportURL != nil { showExport = true }
            app.openedExportID = nil
        }
        .overlay(alignment: .top) {
            if editor.exportProgress != nil {
                VStack(spacing: 8) {
                    ProgressView(value: editor.exportProgress)
                    Text(editor.stage ?? "Rendering video").font(.headline)
                    Text(backgroundWork.message ?? "Preparing your export. Progress is saved.").font(.caption)
                }.padding(16).background(.regularMaterial, in:RoundedRectangle(cornerRadius:16)).padding()
            } else if editor.exportJob?.status == .interrupted {
                HStack {
                    Text("Export paused · your edit is saved").font(.caption)
                    Button("Resume export") { Task { await CompletionNotifications.shared.requestPermission(); await editor.resumeExport(); if editor.exportURL != nil { showExport = true } } }
                }.padding(12).background(.regularMaterial, in:RoundedRectangle(cornerRadius:16)).padding()
            } else if editor.exportURL != nil {
                Button("View finished export") { showExport = true }.padding(12).background(.regularMaterial, in:Capsule()).padding()
            }
        }
        .alert("Couldn’t finish this step",isPresented:Binding(get:{editor.error != nil},set:{if !$0 {editor.error = nil}})) {
            Button("OK") { editor.error = nil }
        } message: { Text(editor.error ?? "") }
    }

    private func sourceName(_ clip:TimelineClip)->String { editor.document.sources.first{$0.id == clip.sourceID}?.fileName ?? "Source" }
    private func time(_ seconds:Double)->String { String(format:"%02d:%02d",Int(max(0,seconds))/60,Int(max(0,seconds))%60) }
    private func icon(_ symbol:String,_ label:String,action:@escaping()->Void)->some View {
        Button(action:action) { Image(systemName:symbol).font(.system(size:13)).frame(width:32,height:44) }.accessibilityLabel(label)
    }
    private func toolLabel(_ symbol:String,_ label:String)->some View {
        VStack(spacing:6) { Image(systemName:symbol).font(.system(size:18));Text(label).font(.system(size:11)) }.frame(minWidth:44,minHeight:44)
    }
    private func tool(_ symbol:String,_ label:String,action:@escaping()->Void)->some View { Button(action:action) { toolLabel(symbol,label) } }
    private func toggleMute() { guard let id=editor.selectedID else{return};editor.edit { t in if let i=t.clips.firstIndex(where:{$0.id == id}) {t.clips[i].muted.toggle()} } }
    private func setVolume(_ value:Float) { guard let id=editor.selectedID else{return};editor.edit { t in if let i=t.clips.firstIndex(where:{$0.id == id}) {t.clips[i].volume=value} } }
}

private struct PlayerSurface:UIViewRepresentable {
    let player:AVPlayer
    final class Surface:UIView { override class var layerClass:AnyClass { AVPlayerLayer.self } }
    func makeUIView(context:Context)->Surface { let v=Surface();(v.layer as? AVPlayerLayer)?.videoGravity = .resizeAspect;return v }
    func updateUIView(_ view:Surface,context:Context) {
        if let layer=view.layer as? AVPlayerLayer, layer.player !== player { layer.player=player }
    }
}

private struct ExportSheet:View {
    @EnvironmentObject var editor:EditorModel
    @State private var saved=false
    @State private var saving=false
    var body:some View {
        VStack(spacing:24) {
            Text("Your export is ready").font(.system(size:28,weight:.bold))
            Text("Video, audio and duration verified. Creative quality still needs your review.").foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let url=editor.exportURL {
                ShareLink(item:url) {Label("Share video",systemImage:"square.and.arrow.up")}.buttonStyle(.borderedProminent).tint(.black)
                Button(saved ? "Saved to Photos" : "Save to Photos") { Task { await save(url) } }.disabled(saved || saving)
            }
        }.padding(32).presentationDetents([.medium])
    }
    private func save(_ url:URL) async {
        saving=true;defer{saving=false}
        let status=await PHPhotoLibrary.requestAuthorization(for:.addOnly)
        guard status == .authorized || status == .limited else {editor.error="Allow Photos access in Settings to save this video.";return}
        let notices = CompletionNotifications.shared, owner = CompletionNotifications.shared.ownerID
        let projectID = editor.exportJob?.projectID ?? editor.document.id
        let exportID = editor.exportJob?.id
        do {
            try await BackgroundWorkController.shared.run(title: "Saving video to Photos", projectID: projectID) { update in
                try await PHPhotoLibrary.shared().performChanges { PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL:url) }
                saved = true
                await update(1, "Saved to Photos")
                if let owner, !notices.isActive {
                    _ = await notices.receive(.init(id: UUID().uuidString, title: "Your video is in Photos",
                        body: "The finished video was saved to your photo library. Tap to return to its project.",
                        destination: .init(ownerID: owner, projectID: projectID, exportID: exportID)))
                }
            }
        } catch { if !saved { editor.error = "Saving to Photos did not finish. Your exported video is still saved in PB&J. \(error.localizedDescription)" } }
    }
}

struct PickedMovie:Transferable {
    let url:URL
    static var transferRepresentation:some TransferRepresentation {
        FileRepresentation(contentType:.movie) { movie in SentTransferredFile(movie.url) } importing: { received in
            let url=FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at:received.file,to:url)
            return PickedMovie(url:url)
        }
    }
}
