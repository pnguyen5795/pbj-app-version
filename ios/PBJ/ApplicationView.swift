import AVKit
import PBJCore
import SwiftUI

struct ApplicationView: View {
  @EnvironmentObject private var app: ApplicationModel
  @EnvironmentObject private var auth: AuthenticationModel
  @EnvironmentObject private var editor: EditorModel
  @EnvironmentObject private var mediaImport: MediaImportProgress
  @Environment(\.scenePhase) private var scenePhase
  @ObservedObject private var notifications = CompletionNotifications.shared
  @ObservedObject private var backgroundWork = BackgroundWorkController.shared
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    ZStack {
      PBJDesign.background.ignoresSafeArea()
      content.id(app.route).transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 8)))
    }
    .animation(
      reduceMotion ? nil : .timingCurve(0.22, 1, 0.36, 1, duration: 0.25), value: app.route
    )
    .tint(PBJDesign.purple)
    .overlay(alignment: .top) {
      if let stage = app.stage, app.route != .cooking, !mediaImport.active {
        HStack {
          ProgressView()
          VStack(alignment: .leading, spacing: 4) {
            Text(stage).font(.system(size: 14, weight: .semibold))
            Text(backgroundWork.message ?? JobProgressMessage.operationDetail(stage)).font(.system(size: 12)).foregroundStyle(.secondary)
          }
        }.padding(12).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16)).padding(.top, 4).allowsHitTesting(
          false)
      }
    }
    .overlay(alignment: .bottom) {
      if let notice = notifications.latest {
        HStack(spacing: 12) {
          Button { notifications.open(notice) } label: {
            VStack(alignment: .leading, spacing: 4) {
              Text(notice.title).font(.headline)
              Text(notice.body).font(.caption).multilineTextAlignment(.leading)
            }.frame(maxWidth: .infinity, alignment: .leading)
          }
          Button { notifications.latest = nil } label: { Image(systemName: "xmark") }.accessibilityLabel("Dismiss completion message")
        }.padding(16).background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18)).padding(16)
      }
    }
    .mediaImportFeedback()
    .task {
      if ProcessInfo.processInfo.arguments.contains("--studio-test") {
        app.localProject = true
        app.route = .studio
        return
      }
      await auth.restore()
      try? await Task.sleep(for: .milliseconds(500))
      if auth.signedIn {
        await app.activate(auth: auth, editor: editor)
      } else {
        app.deactivate(editor: editor)
      }
    }
    .task(id: auth.signedIn) {
      guard app.route != .splash else { return }
      if auth.signedIn {
        await app.activate(auth: auth, editor: editor)
      } else {
        app.deactivate(editor: editor)
      }
    }
    .task(id: "\(app.activeOwnerID ?? "")|\(scenePhase == .active)") {
      guard scenePhase == .active else { return }
      // The operation owns its execution lease. This foreground refresh task
      // ending on a scene change must not cancel an allowed background upload.
      while app.hasPendingWork && app.busy && !Task.isCancelled {
        do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
      }
      guard !Task.isCancelled else { return }
      if app.hasPendingWork { Task { await app.resumePendingWork(editor: editor) } }
      while auth.signedIn && app.activeOwnerID != nil && !Task.isCancelled {
        await app.refresh()
        await app.flushPending(editor: editor)
        await notifications.sync()
        try? await Task.sleep(for: .seconds(5))
      }
    }
    .task(id: "\(app.activeOwnerID ?? "")|\(notifications.pendingOpen?.id ?? "")|\(scenePhase == .active)") {
      guard scenePhase == .active, let notice = notifications.pendingOpen else { return }
      await app.openCompletion(notice, editor: editor)
    }
    .onChange(of: scenePhase, initial: true) { _, phase in
      notifications.isActive = phase != .background
      backgroundWork.setBackground(phase == .background)
      if phase == .background { editor.player.pause() }
    }
    .onChange(of: app.activeOwnerID) { _, owner in
      editor.onExportCompleted = { job in
        guard let owner, app.activeOwnerID == owner else { return }
        if !notifications.isActive {
          _ = await notifications.receive(.init(id: "export-" + job.id, title: "Your video is ready",
            body: "Your finished video is saved. Tap to return to its project and share it.",
            destination: .init(ownerID: owner, projectID: job.projectID, exportID: job.id)))
        }
      }
      editor.onExportPaused = { job in
        guard let owner, app.activeOwnerID == owner, !notifications.isActive else { return }
        _ = await notifications.receive(.init(id: "export-paused-" + job.id, title: "Your export needs you to continue",
          body: "The export stopped before finishing. Your edit is saved; tap to return and restart the export.",
          destination: .init(ownerID: owner, projectID: job.projectID, exportID: job.id)))
      }
      mediaImport.destination = {
        guard let owner, app.activeOwnerID == owner else { return nil }
        return .init(ownerID: owner, projectID: app.route == .studio ? editor.root.lastPathComponent : nil,
          screen: app.route == .studio ? nil : app.route == .teachIt ? "teaching" : "draft")
      }
      mediaImport.onStart = { app.error = nil; editor.error = nil }
      mediaImport.didSaveSuccessfully = { app.error == nil && editor.error == nil }
    }
    .onChange(of: editor.timeline.id) { _, _ in
      if app.route == .studio { app.scheduleSync(editor: editor) }
    }
    .onChange(of: editor.verification?.sha256) { _, value in
      if value != nil { Task { await app.recordExport(editor) } }
    }
    .alert(
      "Couldn’t finish this step",
      isPresented: Binding(get: { app.error != nil }, set: { if !$0 { app.error = nil } })
    ) {
      Button("OK") { app.error = nil }
    } message: {
      Text(app.error ?? "")
    }
  }
  @ViewBuilder private var content: some View {
    switch app.route {
    case .splash:
      VStack(spacing: 20) {
        Image("sandwich-logo").resizable().scaledToFit().frame(width: 140)
        Text("pb&j").font(.system(size: 52, weight: .bold))
      }
    case .signIn: SignInScreen()
    case .yourStyle: YourStyleScreen()
    case .teachIt: TeachingScreen()
    case .home: HomeScreen()
    case .upload: UploadScreen()
    case .recipe: RecipeScreen()
    case .cooking: CookingScreen()
    case .review: ReviewScreen()
    case .studio: StudioView()
    case .projects: ProjectsScreen()
    case .settings: SettingsScreen()
    case .memory: LearningScreen()
    case .recovery:
      VStack(spacing: 24) {
        PBJHeading(title: "Saved Work Needs Recovery", subtitle: "Your Original Files Are Preserved")
        Text(app.stateRecoveryError ?? "Your saved state is unavailable.").foregroundStyle(.secondary)
        PBJButton(title: "Try Again") { Task { await app.activate(auth: auth, editor: editor) } }
        PBJButton(title: "Sign Out", secondary: true, disabled: !app.canSignOut || editor.busy) {
          Task { await CompletionNotifications.shared.unregister(); await auth.signOut() }
        }
      }.padding(24)
    }
  }
}

private struct SignInScreen: View {
  @EnvironmentObject var auth: AuthenticationModel
  @State private var emailMode = false
  @State private var creating = true
  @State private var email = ""
  @State private var password = ""
  @State private var code = ""
  var body: some View {
    VStack(spacing: 24) {
      if emailMode {
        HStack {
          PBJBack {
            emailMode = false
            auth.codeSent = false
          }
          Spacer()
        }
        PBJHeading(
          title: auth.codeSent
            ? "Check Your Inbox" : creating ? "Create Your Account" : "Sign In With Email",
          subtitle: auth.codeSent
            ? "Enter the code we sent you"
            : creating
              ? "Choose a Password, Then We’ll Verify Your Email"
              : "We’ll Send a Code to Your Inbox")
        VStack(spacing: 16) {
          if auth.codeSent {
            TextField("Verification code", text: $code).keyboardType(.numberPad).textContentType(
              .oneTimeCode
            ).pbjInput()
          } else {
            TextField("Email", text: $email).textContentType(.emailAddress).keyboardType(
              .emailAddress
            ).textInputAutocapitalization(.never).pbjInput()
            if creating {
              SecureField("Password", text: $password).textContentType(.newPassword).pbjInput()
            }
          }
          PBJButton(
            title: auth.codeSent ? "Verify Email" : "Continue",
            disabled: auth.busy
              || (auth.codeSent ? code.isEmpty : email.isEmpty || (creating && password.isEmpty))
          ) {
            Task {
              if auth.codeSent {
                await auth.verify(code, creating: creating)
              } else {
                await auth.sendCode(email: email, password: password, creating: creating)
              }
            }
          }
          Button(creating ? "Already have an account? Sign In" : "Create an account") {
            creating.toggle()
            auth.codeSent = false
            auth.error = nil
          }.font(.system(size: 13))
        }
      } else {
        Image("sandwich-logo").resizable().scaledToFit().frame(width: 70, height: 80).padding(
          .top, 60)
        PBJHeading(title: "Welcome to pb&j", subtitle: "let’s cook").padding(.top, 24)
        VStack(spacing: 16) {
          PBJButton(
            title: "  Continue With Apple", accent: true,
            disabled: !auth.appleConfigured || auth.busy
          ) { Task { await auth.social(apple: true) } }
          HStack {
            Rectangle().frame(height: 1)
            Text("Or").font(.system(size: 13))
            Rectangle().frame(height: 1)
          }.foregroundStyle(.black.opacity(0.12))
          PBJButton(
            title: "Continue With Google", secondary: true, disabled: !auth.configured || auth.busy
          ) { Task { await auth.social(apple: false) } }
          PBJButton(
            title: "✉  Continue With Email", secondary: true,
            disabled: !auth.configured || auth.busy
          ) { emailMode = true }
        }.padding(.top, 24)
        if !auth.configured {
          Text(
            "Account sign-in will be available when this build is connected to your account service."
          ).font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        #if DEBUG
          Button("Use Local Workspace") { auth.enterLocalWorkspace() }.font(.system(size: 13))
        #endif
      }
      if let error = auth.error {
        Text(error).font(.system(size: 13)).foregroundStyle(.red).multilineTextAlignment(.center)
      }
      Spacer()
    }.padding(24)
  }
}
private struct YourStyleScreen: View {
  @EnvironmentObject var app: ApplicationModel
  let options = [
    ("💪", "Fitness"), ("🍔", "Food"), ("🌿", "Lifestyle"), ("🎮", "Gaming"), ("🎵", "Music"),
    ("✈️", "Travel"), ("😂", "Comedy"), ("💄", "Beauty"), ("🏀", "Sports"), ("🎥", "Vlog"),
    ("💼", "Business"), ("🐾", "Pets"),
  ]
  var body: some View {
    VStack(spacing: 24) {
      PBJHeading(title: "What’s Your Style", subtitle: "Just So We Know Where to Start").padding(
        .top, 44)
      ScrollView {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
          ForEach(options, id: \.1) { emoji, title in
            let selected = app.state.styleHints.contains(title)
            Button {
              if selected {
                app.state.styleHints.removeAll { $0 == title }
              } else {
                app.state.styleHints.append(title)
              }
              app.save()
            } label: {
              HStack {
                Text(emoji)
                Text(title).font(.system(size: 17, weight: .semibold))
              }
              .frame(maxWidth: .infinity, minHeight: 68)
              .foregroundStyle(selected ? PBJDesign.purple : .primary)
              .background(.white, in: Capsule())
              .overlay(
                Capsule().stroke(
                  selected ? PBJDesign.purple : .black.opacity(0.1), lineWidth: selected ? 2 : 1)
              )
              .shadow(color: .black.opacity(0.08), radius: 2, y: 2)
            }
          }
        }
      }
      PBJButton(title: "Continue", disabled: app.state.styleHints.isEmpty) {
        app.beginTeaching(settings: false)
      }
      Button("Skip") { app.beginTeaching(settings: false) }.foregroundStyle(.secondary).font(
        .system(size: 17)
      ).padding(.bottom, 8)
    }.padding(.horizontal, 24)
  }
}
private struct HomeScreen: View {
  @EnvironmentObject var app: ApplicationModel
  var body: some View {
    VStack(spacing: 24) {
      HStack {
        Spacer()
        Button {
          app.route = .settings
        } label: {
          Image(systemName: "gearshape").foregroundStyle(.secondary).frame(width: 44, height: 44)
            .background(.black.opacity(0.03), in: Circle())
        }.accessibilityLabel("Settings")
      }
      Image("sandwich-logo").resizable().scaledToFit().frame(width: 64, height: 68)
      ScrollView {
        VStack(spacing: 16) {
          SavedRevisionCard()
          ForEach(app.visibleJobs) { job in JobCard(job: job) }
          if let error = app.connectionError {
            Text(error).font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(
              .center
            ).padding(.top, 16)
          } else if app.api.pairedMacName != nil {
            Label("Connected to your Mac", systemImage: "desktopcomputer")
              .font(.system(size: 13)).foregroundStyle(.secondary).padding(.top, 16)
          }
        }
      }
      Spacer(minLength: 20)
      VStack(spacing: 12) {
        PBJButton(
          title: "New Project",
          disabled: app.busy
        ) {
          app.resetDraft()
          app.newProject()
        }
        PBJButton(title: "My Projects", secondary: true) { app.route = .projects }
      }
    }.padding(24)
  }
}
private struct UploadScreen: View {
  @EnvironmentObject var app: ApplicationModel
  var body: some View {
    VStack(spacing: 24) {
      HStack {
        PBJBack { app.route = .home }
        Spacer()
      }
      TextField("New Project", text: $app.state.title).font(.system(size: 34, weight: .bold))
        .multilineTextAlignment(.center).disabled(app.busy || app.hasPendingGeneration).onChange(of: app.state.title) { _, _ in
          app.save()
        }
      Spacer(minLength: 16)
      if app.state.footage.isEmpty {
        VideoSelectionButton(onPick: { await app.importFootage($0) }) {
          VStack(spacing: 12) {
            Image(systemName: "photo.on.rectangle")
            Text("Add Your Footage").font(.system(size: 13))
          }.foregroundStyle(.secondary).frame(width: 220, height: 220).background(
            .black.opacity(0.03), in: RoundedRectangle(cornerRadius: 22)
          ).overlay(
            RoundedRectangle(cornerRadius: 22).stroke(
              .black.opacity(0.1), style: StrokeStyle(lineWidth: 1, dash: [3])))
        }.disabled(app.busy || app.hasPendingGeneration)
      } else {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 12) {
            ForEach(app.state.footage) { asset in
              VStack {
                SourceThumbnail(url: URL(fileURLWithPath: asset.localPath)).frame(
                  width: 130, height: 170
                ).clipShape(RoundedRectangle(cornerRadius: 16))
                Text(asset.source.fileName).font(.system(size: 13)).lineLimit(1)
                Button("Remove") {
                  app.state.footage.removeAll { $0.id == asset.id }
                  app.save()
                }.font(.system(size: 13)).disabled(app.busy || app.hasPendingGeneration)
              }
            }
            VideoSelectionButton(onPick: { await app.importFootage($0) }) {
              Image(systemName: "plus").frame(width: 70, height: 170).background(
                .black.opacity(0.04), in: RoundedRectangle(cornerRadius: 16))
            }.disabled(app.busy || app.hasPendingGeneration)
          }
        }
      }
      Spacer(minLength: 16)
      VStack(spacing: 8) {
        Text("How Long?").font(.system(size: 13)).foregroundStyle(.secondary)
        Text(durationLabel(app.state.duration)).font(.system(size: 22, weight: .semibold))
        Slider(value: $app.state.duration, in: 15...180, step: 5).disabled(app.busy || app.hasPendingGeneration).tint(.black)
          .onChange(
            of: app.state.duration
          ) { _, _ in app.save() }
        Toggle("Exact duration", isOn: $app.state.exactDuration).disabled(app.busy || app.hasPendingGeneration).font(
          .system(size: 13)
        ).onChange(
          of: app.state.exactDuration
        ) { _, _ in app.save() }
      }
      PBJButton(title: "Next", disabled: app.state.footage.isEmpty || app.busy) {
        app.route = .recipe
      }
    }.padding(24)
  }
}
private struct RecipeScreen: View {
  @EnvironmentObject var app: ApplicationModel
  let hints = [
    "Fast & Punchy", "Clean", "Loud", "Slow & Cinematic", "Story First", "Keep the Dialogue",
  ]
  var body: some View {
    VStack(spacing: 24) {
      HStack {
        PBJBack { app.route = .upload }
        Spacer()
      }
      PBJHeading(title: "The Recipe", subtitle: "tell us how you want it cut")
      ZStack(alignment: .topLeading) {
        if app.state.brief.isEmpty {
          Text("write your recipe").foregroundStyle(.secondary).padding(16)
        }
        TextEditor(text: $app.state.brief).disabled(app.busy || app.hasPendingGeneration).scrollContentBackground(.hidden)
          .padding(10).opacity(
            app.state.brief.isEmpty ? 0.8 : 1)
      }
      .frame(minHeight: 180, maxHeight: 240)
      .background(PBJDesign.cream.opacity(0.35), in: RoundedRectangle(cornerRadius: 16))
      .overlay(RoundedRectangle(cornerRadius: 16).stroke(.black.opacity(0.06)))
      .onChange(of: app.state.brief) { _, _ in app.save() }
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(hints, id: \.self) { hint in
            let selected = app.state.ingredients.contains(hint)
            Button {
              if selected {
                app.state.ingredients.removeAll { $0 == hint }
              } else {
                app.state.ingredients.append(hint)
              }
              app.save()
            } label: {
              Text(hint).font(.system(size: 13, weight: .semibold)).padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(selected ? PBJDesign.purple.opacity(0.15) : .white, in: Capsule())
                .overlay(Capsule().stroke(.black.opacity(0.08)))
            }
          }
        }
      }
      .disabled(app.busy || app.hasPendingGeneration)
      if !app.state.ingredients.isEmpty {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(app.state.ingredients, id: \.self) { Text("+  " + $0).font(.system(size: 17)) }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }
      Spacer()
      if app.hasPendingGeneration {
        Text("Your request is saved on this iPhone. Check whether your Mac received it before changing the recipe. Checking reuses the same request.")
          .font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      if app.aiProcessingEnabled == false {
        Text("AI processing is paused on your Mac. This saves your request; editing starts only after AI processing is enabled.")
          .font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      PBJButton(
        title: app.hasPendingGeneration ? "Check saved request" : (app.aiProcessingEnabled == false ? "Save request for later" : "let’s cook!"),
        disabled: app.state.brief.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
          || app.busy
      ) { Task { await app.generate() } }
    }.padding(24)
  }
}
private struct JobCard: View {
  @EnvironmentObject var app: ApplicationModel
  let job: ServerJob
  private var progress: JobProgressMessage {
    .describe(kind: job.kind, status: job.status, stage: job.stage,
      processingEnabled: app.aiProcessingEnabled, connected: app.connectionError == nil)
  }
  var body: some View {
    PBJCard {
      VStack(alignment: .leading, spacing: 10) {
        HStack {
          if progress.showsActivity { ProgressView() }
          else { Image(systemName: job.status == "attention" ? "exclamationmark.circle" : "pause.circle").foregroundStyle(PBJDesign.purple) }
          Text(progress.title).font(.system(size: 17, weight: .semibold))
          Spacer()
        }
        Text(progress.detail).font(.system(size: 13)).foregroundStyle(.secondary)
        Text(progress.next).font(.system(size: 13))
        if let error = job.lastError, job.status == "attention" {
          Text(error).font(.system(size: 13)).foregroundStyle(.secondary)
          Button("Resume saved work") { Task { await app.resume(job) } }
            .disabled(app.aiProcessingEnabled == false || app.connectionError != nil)
        }
        if let projectID = job.payload.projectID {
          Button("View Project") {
            app.state.watchingProjectID = projectID
            app.save()
            app.route = .cooking
          }
        }
      }
    }
  }
}
private struct CookingScreen: View {
  @EnvironmentObject var app: ApplicationModel
  var jobs: [ServerJob] { app.jobs.filter { $0.payload.projectID == app.state.watchingProjectID } }
  private var currentJob: ServerJob? {
    jobs.first(where: { $0.active }) ?? jobs.first(where: { $0.kind == "plan" }) ?? jobs.first
  }
  private var progress: JobProgressMessage {
    .describe(kind: currentJob?.kind ?? "plan", status: currentJob?.status ?? "queued",
      stage: currentJob?.stage ?? "Waiting", processingEnabled: app.aiProcessingEnabled,
      connected: app.connectionError == nil)
  }
  var body: some View {
    ScrollView {
      VStack(spacing: 22) {
        HStack { PBJBack { app.route = .home }; Spacer() }
        SandwichArtwork().frame(width: 130, height: 130).padding(.top, 20)
        Text(progress.title).font(.system(size: 28, weight: .bold)).multilineTextAlignment(.center)
        if progress.showsActivity { ProgressView().controlSize(.large) }
        else { Image(systemName: app.connectionError != nil ? "wifi.slash" : (currentJob?.status == "attention" ? "exclamationmark.circle" : "pause.circle")).font(.system(size: 32)).foregroundStyle(PBJDesign.purple) }
        Text(progress.detail).font(.system(size: 16)).multilineTextAlignment(.center)
        PBJCard {
          VStack(alignment: .leading, spacing: 10) {
            Text("What happens next").font(.headline)
            Text(progress.next).font(.system(size: 14)).foregroundStyle(.secondary)
            if let checked = app.lastProgressCheck {
              Text("Last checked \(checked.formatted(date: .omitted, time: .standard))")
                .font(.system(size: 12)).foregroundStyle(.secondary)
            }
            Button("Check status now") { Task { await app.refresh() } }
          }.frame(maxWidth: .infinity, alignment: .leading)
        }
        if let stage = app.stage {
          HStack { ProgressView(); Text(stage) }.font(.system(size: 14))
          Text(JobProgressMessage.operationDetail(stage)).font(.system(size: 13)).foregroundStyle(.secondary)
        }
        ForEach(jobs.filter { $0.status == "attention" }) { JobCard(job: $0) }
        Text("Your Mac keeps working when you leave PB&J. " + CompletionNotifications.shared.deliveryDescription)
          .font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center)
        Button("Back to Home") { app.route = .home }.padding(.vertical, 12)
      }.padding(24)
    }
  }
}
private struct ReviewScreen: View {
  @EnvironmentObject var app: ApplicationModel
  @EnvironmentObject var editor: EditorModel
  @State private var instruction = ""
  @State private var versions = false
  @State private var feedback = false
  @State private var feedbackText = ""
  @State private var reusable = true
  var body: some View {
    VStack(spacing: 16) {
      HStack {
        PBJBack { app.route = .projects }
        Spacer()
        Text("Your First Cut").font(.system(size: 17, weight: .semibold))
        Spacer()
        Button {
          versions = true
        } label: {
          Image(systemName: "clock.arrow.circlepath").frame(width: 44, height: 44)
        }.accessibilityLabel("Previous versions")
      }
      VideoPlayer(player: editor.player).frame(maxHeight: .infinity).background(.black).clipShape(
        RoundedRectangle(cornerRadius: 16))
      ScrollView {
        Text(
          app.detail?.revisions.first(where: { $0.id == app.detail?.project.currentRevisionId })?
            .summary ?? "Your cut is ready to review."
        ).font(.system(size: 13)).foregroundStyle(.secondary).frame(
          maxWidth: .infinity, alignment: .leading)
      }.frame(maxHeight: 80)
      HStack {
        TextField("What would you change?", text: $instruction, axis: .vertical).lineLimit(1...3)
        Button {
          let text = instruction
          Task {
            await app.revise(text, editor: editor, scoped: false)
            if app.route == .cooking { instruction = "" }
          }
        } label: {
          Image(systemName: "arrow.up.circle.fill").font(.system(size: 32))
        }.disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || app.busy)
      }.padding(16).background(.black.opacity(0.04), in: RoundedRectangle(cornerRadius: 22))
      PBJButton(title: "Approve & Open Studio", disabled: app.busy) {
        Task { await app.approve(editor: editor) }
      }
      Button("Save Feedback") { feedback = true }.font(.system(size: 13))
    }.padding(24)
      .task(id: app.detail?.project.currentRevisionId) {
        while app.busy {
          do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
        }
        guard !Task.isCancelled else { return }
        await app.loadReview(editor: editor)
      }
      .sheet(isPresented: $versions) {
        NavigationStack {
          List(app.detail?.revisions.reversed() ?? []) { revision in
            Button {
              versions = false
              Task { await app.restore(revision, editor: editor) }
            } label: {
              VStack(alignment: .leading) {
                Text(revision.origin.replacingOccurrences(of: "_", with: " ").capitalized).font(
                  .headline)
                Text(revision.summary).font(.caption)
                if !revision.accepted {
                  Text("Saved alongside newer edits").foregroundStyle(.orange)
                }
              }
            }
          }.navigationTitle("Previous Versions").toolbar { Button("Done") { versions = false } }
        }
      }
      .sheet(isPresented: $feedback) {
        NavigationStack {
          Form {
            TextEditor(text: $feedbackText).frame(height: 160)
            Toggle("Use this feedback in future projects", isOn: $reusable)
            Text(
              reusable
                ? "PB&J can use your explicit preference in similar future projects. Patterns inferred from edits stay tentative until independent examples support them."
                : "This feedback stays with this project and will not shape other projects."
            ).font(.footnote).foregroundStyle(.secondary)
            Text("You can turn saved lessons off in Settings → Manage Saved Learning.")
              .font(.footnote).foregroundStyle(.secondary)
            Button("Save Feedback") {
              feedback = false
              Task { await app.feedback(feedbackText, reusable: reusable) }
            }.disabled(feedbackText.isEmpty)
          }.navigationTitle("Your Feedback").toolbar { Button("Cancel") { feedback = false } }
        }
      }
  }
}
private struct ProjectsScreen: View {
  @EnvironmentObject var app: ApplicationModel
  @EnvironmentObject var editor: EditorModel
  @State private var renameProject: ServerProject?
  @State private var title = ""
  var body: some View {
    VStack(spacing: 24) {
      HStack {
        PBJBack { app.route = .home }
        Spacer()
      }
      Text("My Projects").font(.system(size: 34, weight: .bold)).tracking(-1).frame(
        maxWidth: .infinity, alignment: .leading)
      ScrollView {
        SavedRevisionCard().padding(.bottom, app.hasPendingRevision ? 16 : 0)
        LazyVGrid(
          columns: [GridItem(.flexible(), spacing: 16), GridItem(.flexible(), spacing: 16)],
          spacing: 24
        ) {
          if let footage = app.state.footage.first {
            Button { app.newProject() } label: {
              VStack(alignment: .leading, spacing: 10) {
                SourceThumbnail(url: URL(fileURLWithPath: footage.localPath))
                  .aspectRatio(3 / 4, contentMode: .fit)
                  .clipShape(RoundedRectangle(cornerRadius: 16))
                Text(app.state.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text("Continue setup · \(app.state.footage.count) videos")
                  .font(.system(size: 11)).foregroundStyle(.secondary)
              }.padding(5)
            }.buttonStyle(.plain).disabled(app.busy)
          }
          ForEach(app.projects) { project in
            VStack(spacing: 5) {
              Button {
                Task { await app.openRemote(project.id, editor: editor) }
              } label: {
                ProjectCover(project: project)
                  .aspectRatio(3 / 4, contentMode: .fit)
                  .clipShape(RoundedRectangle(cornerRadius: 16))
                  .overlay(alignment: .bottomTrailing) {
                    Text(
                      project.durationSeconds.map {
                        String(format: "%d:%02d", Int($0) / 60, Int($0) % 60)
                      } ?? project.status.capitalized
                    ).font(.system(size: 10, weight: .bold))
                      .foregroundStyle(.white).padding(5).background(
                        .black.opacity(0.5), in: Capsule()
                      ).padding(6)
                  }
              }.buttonStyle(.plain)
              HStack(spacing: 2) {
                Text(project.title).font(.system(size: 13, weight: .semibold)).lineLimit(1).frame(
                  maxWidth: .infinity, alignment: .leading)
                Menu {
                  Button("Rename") {
                    renameProject = project
                    title = project.title
                  }
                  Button("Archive") { Task { await app.archive(project) } }
                } label: {
                  Image(systemName: "ellipsis").foregroundStyle(.secondary).frame(
                    width: 44, height: 44)
                }
              }
            }.padding(5)
          }
          ForEach(
            editor.projects.filter { local in
              !app.projects.contains { $0.id == local.root.lastPathComponent }
                && !(app.state.archivedProjectIDs ?? []).contains(local.root.lastPathComponent)
            }
          ) { project in
            Button {
              app.openSavedLocal(project, editor: editor)
            } label: {
              VStack(alignment: .leading, spacing: 10) {
                LocalProjectCover(project: project).aspectRatio(3 / 4, contentMode: .fit).clipShape(
                  RoundedRectangle(cornerRadius: 16))
                Text(project.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text("On this device").font(.system(size: 11)).foregroundStyle(.secondary)
              }.padding(5)
            }.buttonStyle(.plain)
          }
        }
        if app.projects.isEmpty && editor.projects.isEmpty && app.state.footage.isEmpty {
          VStack(spacing: 12) {
            Text("No Projects Yet").font(.system(size: 17, weight: .semibold))
            Text("Start One From the Home Screen").font(.system(size: 13)).foregroundStyle(
              .secondary)
          }.padding(.top, 100)
        }
      }
      PBJButton(title: "New Project", disabled: app.busy) {
        app.resetDraft()
        app.newProject()
      }
    }
    .padding(24)
    .task {
      editor.refreshProjects()
      await app.refresh()
    }
    .alert(
      "Rename Project",
      isPresented: Binding(get: { renameProject != nil }, set: { if !$0 { renameProject = nil } })
    ) {
      TextField("Project name", text: $title)
      Button("Save") {
        if let project = renameProject { Task { await app.rename(project, title: title) } }
        renameProject = nil
      }
      Button("Cancel", role: .cancel) { renameProject = nil }
    }
  }
}
private struct SavedRevisionCard: View {
  @EnvironmentObject var app: ApplicationModel
  @EnvironmentObject var editor: EditorModel
  @State private var discard = false
  var body: some View {
    if let request = app.state.pendingRevision {
      PBJCard {
        VStack(alignment: .leading, spacing: 12) {
          Text("Revision request saved").font(.headline)
          Text(request.projectTitle).font(.subheadline)
          Text(request.instruction).font(.footnote).foregroundStyle(.secondary)
          Button("Resume saved revision") { Task { await app.resumePendingRevision(editor: editor) } }
          if request.request == nil {
            Button("Open its project in Studio") { Task { await app.openRemote(request.projectID, editor: editor, editing: true) } }
          }
          Button("Discard saved request", role: .destructive) { discard = true }
        }.frame(maxWidth: .infinity, alignment: .leading)
      }.disabled(app.busy || editor.busy)
      .alert("Discard this saved request?", isPresented: $discard) {
        Button("Discard", role: .destructive) { app.discardPendingRevision() }
        Button("Keep Request", role: .cancel) {}
      } message: {
        Text("This removes the phone's saved retry. A request already accepted by your Mac may still finish. Your project and edits stay saved.")
      }
    }
  }
}
private struct ProjectCover: View {
  @EnvironmentObject var app: ApplicationModel
  let project: ServerProject
  @State private var image: UIImage?
  var body: some View {
    GeometryReader { geometry in
      ZStack {
        Color.gray.opacity(0.18)
        if let image {
          Image(uiImage: image).resizable().scaledToFill().frame(
            width: geometry.size.width, height: geometry.size.height
          ).clipped()
        } else {
          Image(systemName: "film").foregroundStyle(.secondary)
        }
      }
    }.task(id: project.currentRevisionId) {
      if let data = try? await app.api.projectCover(project) { image = UIImage(data: data) }
    }
  }
}
private struct LocalProjectCover: View {
  let project: EditorModel.LocalProject
  @State private var url: URL?
  var body: some View {
    GeometryReader { geometry in
      ZStack {
        Color.gray.opacity(0.18)
        if let url {
          SourceThumbnail(url: url).frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        } else {
          Image(systemName: "film").foregroundStyle(.secondary)
        }
      }
    }.task(id: project.id) {
      if let document = try? ProjectStore(root: project.root).load(),
        let clip = document.current.clips.first,
        let source = document.sources.first(where: { $0.id == clip.sourceID })
      {
        url = project.root.appendingPathComponent("media").appendingPathComponent(source.id)
          .appendingPathExtension((source.fileName as NSString).pathExtension)
      }
    }
  }
}
private struct SettingsScreen: View {
  @ObservedObject private var notifications = CompletionNotifications.shared
  @EnvironmentObject var editor: EditorModel
  @EnvironmentObject var app: ApplicationModel
  @EnvironmentObject var auth: AuthenticationModel
  var body: some View {
    ScrollView {
    VStack(spacing: 24) {
      HStack {
        PBJBack { app.route = .home }
        Spacer()
      }
      PBJHeading(title: "Your Account", subtitle: "Make Every Edit More You")
      Image(systemName: "person.fill").foregroundStyle(.white).frame(width: 64, height: 64)
        .background(PBJDesign.purple, in: Circle()).padding(.vertical, 8)
      PBJCard {
        VStack(spacing: 20) {
          HStack {
            Text("Workspace")
            Spacer()
            Text(auth.localWorkspace ? "Local Workspace" : "Your Account").foregroundStyle(
              .secondary)
          }
          if let host = app.api.pairedMacName {
            VStack(alignment: .leading, spacing: 6) {
              Label("Mac AI Service", systemImage: "desktopcomputer")
              Text(app.connectionError == nil ? "Connected · \(host)" : "Mac unavailable · keep it awake and on the same network")
                .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
          }
          if let usage = app.usage {
            HStack {
              Text("Footage Saved")
              Spacer()
              Text(durationLabel(usage.sourceSeconds)).foregroundStyle(.secondary)
            }
            HStack {
              Text("Planner Requests Recorded")
              Spacer()
              Text(String(usage.providerRequests ?? 0))
            }
            HStack {
              Text("Video Analyses Saved")
              Spacer()
              Text(String(usage.analyzedFiles ?? 0))
            }
            HStack {
              Text("Speech Timed")
              Spacer()
              Text(durationLabel(usage.speechSeconds ?? 0))
            }
            HStack {
              Text("Input / Output Tokens")
              Spacer()
              Text("\(usage.inputTokens ?? 0) / \(usage.outputTokens ?? 0)")
            }
          }
        }.font(.system(size: 13))
      }
      VStack(alignment: .leading, spacing: 10) {
        Label("Completion notifications", systemImage: "bell")
        Text(notifications.deliveryDescription).font(.footnote).foregroundStyle(.secondary)
        Button(notifications.permissionDenied ? "Open Notification Settings" : "Enable Notifications") {
          if notifications.permissionDenied, let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
          else { Task { await notifications.requestPermission() } }
        }
      }.frame(maxWidth: .infinity, alignment: .leading)
      PBJButton(title: "Teach It", secondary: true) { app.beginTeaching(settings: true) }
      PBJButton(title: "Manage Saved Learning", secondary: true) { app.route = .memory }
      PBJButton(title: "Sign Out", secondary: true, disabled: !app.canSignOut || editor.busy) {
        Task { await CompletionNotifications.shared.unregister(); await auth.signOut() }
      }
      Spacer()
    }.padding(24).task { await app.loadMemory() }
    }
  }
}
private struct LearningScreen: View {
  @EnvironmentObject var app: ApplicationModel
  var body: some View {
    VStack(spacing: 24) {
      HStack {
        PBJBack { app.route = .settings }
        Spacer()
      }
      PBJHeading(title: "Saved Learning", subtitle: "Choose what shapes your next cut")
      ScrollView {
        VStack(spacing: 16) {
          Text("Reference observations and your personal lessons stay separate. Your instructions for each cut come first.")
            .font(.system(size: 13)).foregroundStyle(.secondary)
          ForEach(app.memory) { entry in
            PBJCard {
              VStack(alignment: .leading, spacing: 8) {
                Text(learningLabel(entry)).font(.system(size: 13, weight: .semibold))
                  .foregroundStyle(PBJDesign.purple)
                Text(entry.statement).font(.system(size: 17, weight: .semibold))
                Text("Applies to: " + entry.context).font(.system(size: 13))
                  .foregroundStyle(.secondary)
                let applicability = applicabilityLabel(entry)
                if !applicability.isEmpty {
                  Text(applicability).font(.system(size: 13)).foregroundStyle(.secondary)
                }
                Text(entry.attribution).font(.system(size: 13)).foregroundStyle(.secondary)
                if let count = entry.supportCount {
                  Text("\(count) independent \(count == 1 ? "example" : "examples")")
                    .font(.system(size: 13)).foregroundStyle(.secondary)
                }
                Text(entry.projectScope == nil ? "Scope: similar future projects" : "Scope: original project only")
                  .font(.system(size: 13)).foregroundStyle(.secondary)
                if let status = inactiveLabel(entry) {
                  Text(status).font(.system(size: 13, weight: .medium)).foregroundStyle(.secondary)
                }
                Button(entry.enabled ? "Disable" : "Enable") {
                  Task { await app.toggleMemory(entry) }
                }.disabled(app.busy)
              }
            }
          }
          ForEach(app.groups) { group in
            PBJCard {
              VStack(alignment: .leading, spacing: 8) {
                Text(group.attribution).font(.headline)
                Text(group.notes).font(.caption)
                Text(group.excluded == true ? "Reference excluded from future cuts" : "Teaching reference")
                  .font(.caption).foregroundStyle(.secondary)
                HStack {
                  Button(group.excluded == true ? "Restore Reference" : "Exclude Reference") {
                    Task { await app.excludeGroup(group, excluded: group.excluded != true) }
                  }.disabled(app.busy)
                }.font(.system(size: 13))
              }
            }
          }
          if app.memory.isEmpty && app.groups.isEmpty {
            Text("References and your feedback will appear here once processed.").foregroundStyle(
              .secondary
            ).padding(.top, 48)
          }
        }
      }
    }.padding(24).task { await app.loadMemory() }
  }

  private func learningLabel(_ entry: MemoryEntry) -> String {
    if entry.kind == "reference" { return "Reference observation" }
    switch entry.effectiveStrength ?? entry.strength {
    case "strong": return "Confirmed preference"
    case "moderate": return "Supported lesson"
    default: return "Tentative lesson"
    }
  }
  private func inactiveLabel(_ entry: MemoryEntry) -> String? {
    switch entry.status ?? (entry.enabled ? "active" : "disabled") {
    case "superseded": return "Replaced by newer feedback · Not used in future cuts"
    case "excluded": return "Supporting evidence excluded · Not used in future cuts"
    case "disabled": return "Disabled · Not used in future cuts"
    default: return nil
    }
  }
  private func applicabilityLabel(_ entry: MemoryEntry) -> String {
    var parts: [String] = []
    if let formats = entry.learning?.formats, !formats.isEmpty {
      parts.append("Format: " + formats.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: ", "))
    }
    if let subjects = entry.learning?.subjects, !subjects.isEmpty {
      parts.append("Subject: " + subjects.joined(separator: ", "))
    }
    return parts.joined(separator: " · ")
  }
}
private struct TeachingScreen: View {
  @EnvironmentObject var app: ApplicationModel
  private var finals: [URL] { (app.state.teaching?.finals ?? []).map { URL(fileURLWithPath: $0) } }
  private var raw: [URL] { (app.state.teaching?.raw ?? []).map { URL(fileURLWithPath: $0) } }
  private var attribution: Binding<String> {
    Binding(
      get: { app.state.teaching?.attribution ?? "My work" },
      set: {
        if app.state.teaching == nil { app.state.teaching = TeachingDraft() }
        app.state.teaching?.attribution = $0
        app.save()
      })
  }
  private var notes: Binding<String> {
    Binding(
      get: { app.state.teaching?.notes ?? "" },
      set: {
        if app.state.teaching == nil { app.state.teaching = TeachingDraft() }
        app.state.teaching?.notes = $0
        app.save()
      })
  }
  var body: some View {
    VStack(spacing: 24) {
      HStack {
        PBJBack { app.route = app.teachingFromSettings ? .settings : .yourStyle }
        Spacer()
      }
      PBJHeading(
        title: "Teach Us Your Style", subtitle: "Add Finished Videos to Help Shape Your Next Cut")
      ScrollView {
        VStack(spacing: 20) {
          VideoSelectionButton(onPick: { await app.importTeaching($0, final: true) }) {
            VStack(spacing: 12) {
              Image(systemName: "photo.on.rectangle")
              Text(
                finals.isEmpty ? "Tap to Choose From Your Camera Roll" : "Add More Finished Videos"
              ).font(.system(size: 13, weight: .semibold)).multilineTextAlignment(.center)
            }.foregroundStyle(.primary).frame(width: 160, height: 160).overlay(
              RoundedRectangle(cornerRadius: 22).stroke(.primary, lineWidth: 1))
          }.disabled(!raw.isEmpty).padding(.top, finals.isEmpty ? 70 : 0)
          ForEach(finals, id: \.path) {
            Text($0.lastPathComponent).font(.system(size: 13)).lineLimit(1)
          }
          if !finals.isEmpty {
            TextField("Creator or attribution", text: attribution).pbjInput()
            TextField("What should we learn? (optional)", text: notes, axis: .vertical).pbjInput()
            Text("Example: “Learn the quick openings, but ignore the on-screen text.” These notes guide what PB&J takes from this reference.")
              .font(.system(size: 13)).foregroundStyle(.secondary)
            VideoSelectionButton(onPick: { await app.importTeaching($0, final: false) }) {
              Label("Add Matching Raw Footage", systemImage: "plus").font(.system(size: 13))
            }.disabled(finals.count != 1)
            if !raw.isEmpty {
              Text("\(raw.count) raw files grouped with this final").font(.system(size: 13))
                .foregroundStyle(.secondary)
            }
            Text(
              "Grouping applies to one finished video at a time. Multiple finished videos can be added as separate references."
            ).font(.system(size: 13)).foregroundStyle(.secondary)
          }
        }
      }.disabled(app.busy || app.hasPendingTeaching)
      if app.hasPendingTeaching {
        Text("Your reference request is saved. Resume to continue its upload; its videos and notes stay together.")
          .font(.footnote).foregroundStyle(.secondary)
      }
      if !finals.isEmpty || app.hasPendingTeaching {
        PBJButton(title: app.hasPendingTeaching ? "Resume Saved Upload" : "Save & Learn", disabled: app.busy || (!app.hasPendingTeaching && attribution.wrappedValue.isEmpty)) {
          Task {
            await app.teach(
              finals: finals, raw: raw, attribution: attribution.wrappedValue,
              notes: notes.wrappedValue)
          }
        }
      }
      Button(finals.isEmpty ? "Start From Scratch Instead" : "Leave and Continue Later") {
        app.finishOnboarding()
      }.font(.system(size: 17)).foregroundStyle(.secondary)
    }.padding(24)
  }
}

extension View {
  fileprivate func pbjInput() -> some View {
    self.padding(16).frame(minHeight: 56).background(
      Color(red: 0.95, green: 0.95, blue: 0.97), in: RoundedRectangle(cornerRadius: 14))
  }
}
private func durationLabel(_ seconds: Double) -> String {
  seconds < 60
    ? "\(Int(seconds)) sec"
    : seconds.truncatingRemainder(dividingBy: 60) == 0
      ? "\(Int(seconds/60)) min" : "\(Int(seconds/60))m \(Int(seconds)%60)s"
}
