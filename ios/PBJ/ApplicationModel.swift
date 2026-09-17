import Combine
import CryptoKit
import Foundation
import PBJCore

struct DraftFootage: Codable, Identifiable {
  var source: MediaSource
  var localPath: String
  var remoteID: String?
  var id: String { source.id }
}
struct TeachingDraft: Codable {
  var finals: [String] = []
  var raw: [String] = []
  var attribution = "My work"
  var notes = ""
  var groupIDs: [String: String] = [:]
  var sourcesByPath: [String: MediaSource]?
}
struct QueuedFeedback: Codable, Identifiable {
  var id = UUID().uuidString.lowercased()
  let projectID: String
  let revisionID: String
  let text: String
  let reusable: Bool
}
struct QueuedExport: Codable, Identifiable {
  var id = UUID().uuidString.lowercased()
  let projectID: String
  let report: ExportVerification
  let snapshot: ProjectDocument
  let paths: [String: String]
}
struct ProjectSubmission: Codable {
  struct Goal: Codable {
    let seconds: Double
    let mode: String
    let toleranceSeconds: Double
  }
  let id: String
  let title: String
  let brief: String
  let assetIDs: [String]
  let durationGoal: Goal
}
struct RevisionRequest: Codable {
  let id: String
  let baseRevisionID: String
  let instruction: String
  let scopeClipIDs: [String]?
}
struct PendingRevision: Codable {
  let projectID: String
  let projectTitle: String
  let instruction: String
  let scopeClipIDs: [String]?
  let localRevisionID: String
  let startingRemoteRevisionID: String?
  var request: RevisionRequest?
}
struct PendingGeneration: Codable {
  let id: String
  let title: String
  let brief: String
  let durationGoal: ProjectSubmission.Goal
  var footage: [DraftFootage]
}
struct ApplicationState: Codable {
  var cachedDetails: [String: ServerProjectDetail]?
  var assetIDsByHash: [String: String]?
  var originalPathsByHash: [String: String]?
  var archivedProjectIDs: [String]?
  var feedbackQueue: [QueuedFeedback]?
  var exportQueue: [QueuedExport]?
  var revisionMappings: [String: String]?

  var teaching: TeachingDraft?
  var syncedLocalRevisions: [String: String]?

  var onboarded = false
  var styleHints: [String] = []
  var title = "New Project"
  var brief = ""
  var duration = 60.0
  var exactDuration = false
  var ingredients: [String] = []
  var footage: [DraftFootage] = []
  var pendingProjectID: String?
  // Written when the user starts, before uploading; recover the same frozen
  // request even if iOS stops us before its first complete original arrives.
  var pendingGeneration: PendingGeneration?
  var pendingTeaching: TeachingDraft?
  var pendingRevision: PendingRevision?
  // Keep the exact request until its response and local completion are saved.
  var pendingSubmission: ProjectSubmission?
  var watchingProjectID: String?
  var syncedRevisions: [String: String] = [:]
  var savedFeedback: [String: String] = [:]

  func mappingMediaPaths(_ transform: (String) throws -> String) throws -> ApplicationState {
    var copy = self
    for index in copy.footage.indices {
      copy.footage[index].localPath = try transform(copy.footage[index].localPath)
    }
    if var generation = copy.pendingGeneration {
      for index in generation.footage.indices {
        generation.footage[index].localPath = try transform(generation.footage[index].localPath)
      }
      copy.pendingGeneration = generation
    }
    copy.originalPathsByHash = try copy.originalPathsByHash?.mapValues(transform)
    func mappedTeaching(_ draft: TeachingDraft?) throws -> TeachingDraft? {
      guard var teaching = draft else { return nil }
      teaching.finals = try teaching.finals.map(transform)
      teaching.raw = try teaching.raw.map(transform)
      var groups: [String: String] = [:]
      for (path, id) in teaching.groupIDs {
        let resolved = try transform(path)
        if let existing = groups[resolved], existing != id {
          throw TimelineError.invalid("Conflicting saved teaching paths need recovery.")
        }
        groups[resolved] = id
      }
      teaching.groupIDs = groups
      if let sources = teaching.sourcesByPath {
        var resolved: [String: MediaSource] = [:]
        for (path, source) in sources {
          let path = try transform(path)
          if let existing = resolved[path], existing != source {
            throw TimelineError.invalid("Conflicting saved teaching metadata needs recovery.")
          }
          resolved[path] = source
        }
        teaching.sourcesByPath = resolved
      }
      return teaching
    }
    copy.teaching = try mappedTeaching(copy.teaching)
    copy.pendingTeaching = try mappedTeaching(copy.pendingTeaching)
    copy.exportQueue = try copy.exportQueue?.map { item in
      QueuedExport(id: item.id, projectID: item.projectID, report: item.report,
        snapshot: item.snapshot, paths: try item.paths.mapValues(transform))
    }
    return copy
  }
}

@MainActor
final class ApplicationModel: ObservableObject {
  enum Route: String {
    case splash, signIn, yourStyle, teachIt, home, upload, recipe, cooking, review, studio,
      projects, settings, memory, recovery
  }
  @Published var route: Route = .splash {
    didSet {
      if route == .studio, oldValue != .studio {
        studioReturnRoute = [.home, .projects, .review].contains(oldValue) ? oldValue : .projects
      }
    }
  }
  private(set) var studioReturnRoute: Route = .projects
  @Published var state = ApplicationState()
  @Published var projects: [ServerProject] = []
  @Published var jobs: [ServerJob] = []
  @Published var aiProcessingEnabled: Bool?
  @Published var lastProgressCheck: Date?
  @Published var detail: ServerProjectDetail?
  @Published var memory: [MemoryEntry] = []
  @Published var groups: [TeachingGroup] = []
  @Published var usage: AccountUsage?
  @Published var stage: String? {
    didSet { if let stage { BackgroundWorkController.shared.update(0, stage) } }
  }
  @Published var error: String?
  @Published var openedExportID: String?
  @Published var connectionError: String?
  @Published var teachingFromSettings = false
  @Published var localProject = false
  @Published var hasUnsentEdits = false
  @Published private(set) var activeOwnerID: String?
  @Published private(set) var stateRecoveryError: String?
  @Published private(set) var unsavedState = false
  let api: AppAPI
  private let documents: URL
  private var root: URL
  private var syncTask: Task<Void, Never>?
  private var syncing = false
  private var flushing = false
  private var feedbackSending = false
  private var refreshing = false
  private var accountGeneration = UUID()
  var canSignOut: Bool { !busy && !syncing && !flushing && !feedbackSending && !unsavedState }
  var busy: Bool { stage != nil }
  var hasPendingGeneration: Bool { state.pendingGeneration != nil || state.pendingSubmission != nil }
  var hasPendingTeaching: Bool { state.pendingTeaching != nil }
  var hasPendingRevision: Bool { state.pendingRevision != nil }
  var hasPendingWork: Bool { hasPendingGeneration || hasPendingTeaching || hasPendingRevision }
  var visibleJobs: [ServerJob] { jobs.filter { $0.active || $0.status == "attention" } }
  var projectID: String? { detail?.project.id }
  init(api: AppAPI? = nil, documents: URL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]) {
    self.api = api ?? AppAPI()
    self.api.usesContinuedExecution = { BackgroundWorkController.shared.hasContinuedExecution }
    self.documents = documents
    root = documents.appendingPathComponent("PBJApplication")
  }
  func activate(auth: AuthenticationModel, editor: EditorModel) async {
    while busy || syncing || flushing || feedbackSending || editor.busy {
      do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
    }
    guard !Task.isCancelled else { return }
    let owner = auth.localWorkspace ? "local-spike" : (auth.clerk?.user?.id ?? "")
    if owner == activeOwnerID { return }
    syncTask?.cancel()
    accountGeneration = UUID()
    activeOwnerID = nil
    guard !owner.isEmpty else {
      deactivate(editor: editor)
      return
    }
    let account = documents.appendingPathComponent("Accounts").appendingPathComponent(
      SHA256.hash(data: Data(owner.utf8)).map { String(format: "%02x", $0) }.joined())
    root =
      auth.localWorkspace
      ? documents.appendingPathComponent("PBJApplication")
      : account.appendingPathComponent("Application")
    projects = []
    jobs = []
    aiProcessingEnabled = nil
    lastProgressCheck = nil
    memory = []
    groups = []
    usage = nil
    detail = nil
    localProject = false
    hasUnsentEdits = false
    connectionError = nil
    error = nil
    stateRecoveryError = nil
    unsavedState = false
    api.token = { [weak auth] in
      guard let auth, auth.signedIn,
        (auth.localWorkspace ? "local-spike" : auth.clerk?.user?.id) == owner
      else { throw TimelineError.invalid("Sign in again to continue.") }
      return try await auth.token()
    }
    editor.useAccountDirectory(auth.localWorkspace ? nil : account)
    do {
      state = try stateStore.load(or: ApplicationState()).mappingMediaPaths {
        try DocumentMediaPath.resolved($0, documents: documents)
      }
    } catch {
      state = ApplicationState()
      stateRecoveryError = "Your saved app state could not be read. It has been preserved, including pending uploads and feedback. \(error.localizedDescription)"
      route = .recovery
      return
    }
    activeOwnerID = owner
    CompletionNotifications.shared.activate(ownerID: owner, api: api)
    route = state.onboarded ? .home : .yourStyle
    await refresh()
  }
  func deactivate(editor: EditorModel) {
    CompletionNotifications.shared.deactivate()
    syncTask?.cancel()
    accountGeneration = UUID()
    activeOwnerID = nil
    api.token = { throw TimelineError.invalid("Sign in again to continue.") }
    aiProcessingEnabled = nil; lastProgressCheck = nil
    projects = []; jobs = []; memory = []; groups = []; usage = nil; detail = nil
    state = ApplicationState()
    stateRecoveryError = nil
    unsavedState = false
    connectionError = nil
    hasUnsentEdits = false
    editor.player.pause()
    route = .signIn
  }
  private var stateStore: PreservedJSONStore<ApplicationState> {
    PreservedJSONStore(file: root.appendingPathComponent("state.json"))
  }
  @discardableResult
  func save() -> Bool {
    do {
      guard stateRecoveryError == nil, activeOwnerID != nil else { return false }
      try stateStore.save(state.mappingMediaPaths { try DocumentMediaPath.stored($0, documents: documents) })
      unsavedState = false
      return true
    } catch {
      unsavedState = true
      self.error = "Could not save your progress: \(error.localizedDescription). Keep the app open and retry after storage is available."
      return false
    }
  }
  private func requireSavedState() throws {
    guard save() else {
      throw TimelineError.invalid(error ?? "Save your progress before continuing.")
    }
  }
  func finishOnboarding() {
    state.onboarded = true
    save()
    route = teachingFromSettings ? .settings : .home
  }
  func beginTeaching(settings: Bool) {
    teachingFromSettings = settings
    route = .teachIt
  }
  func newProject() {
    guard !busy else { return }
    detail = nil
    localProject = false
    route = state.footage.isEmpty ? .upload : .recipe
  }
  func resetDraft() {
    guard !busy else { return }
    clearDraft()
  }
  private func clearDraft() {
    state.title = "New Project"
    state.brief = ""
    state.footage = []
    state.ingredients = []
    state.pendingProjectID = nil
    state.pendingSubmission = nil
    state.pendingGeneration = nil
    save()
  }
  func importFootage(_ files: [URL]) async {
    guard !hasPendingGeneration else {
      error = "Check your saved request on The Recipe before changing its footage, or start a new project."
      return
    }
    await perform("Saving original footage") {
      for file in files {
        try Task.checkCancellation()
        let access = file.startAccessingSecurityScopedResource()
        defer { if access { file.stopAccessingSecurityScopedResource() } }
        let directory = self.root.appendingPathComponent("originals")
        let importing = Task.detached {
          try await MediaImport.copy(file, into: directory)
        }
        let (source, url) = try await withTaskCancellationHandler {
          try await importing.value
        } onCancel: { importing.cancel() }
        if !self.state.footage.contains(where: { $0.source.sha256 == source.sha256 }) {
          self.state.originalPathsByHash = (self.state.originalPathsByHash ?? [:]).merging([
            source.sha256: url.path
          ]) { _, new in new }
          self.state.footage.append(.init(source: source, localPath: url.path))
          try self.requireSavedState()
        } else {
          // The importer created this redundant copy; retain the existing original.
          try? FileManager.default.removeItem(at: url)
        }
      }
    }
  }
  /// Call after account activation/foreground recovery. Merely saving a draft
  /// does not authorize uploads or AI work; only an explicit persisted start does.
  func resumePendingWork(editor: EditorModel? = nil) async {
    guard !busy, activeOwnerID != nil, stateRecoveryError == nil, !Task.isCancelled else { return }
    if hasPendingGeneration { await generate() }
    if !Task.isCancelled, let teaching = state.pendingTeaching {
      await teach(finals: teaching.finals.map { URL(fileURLWithPath: $0) },
        raw: teaching.raw.map { URL(fileURLWithPath: $0) },
        attribution: teaching.attribution, notes: teaching.notes)
    }
    if !Task.isCancelled, let pending = state.pendingRevision,
      pending.request != nil || (editor != nil && projectID == pending.projectID) {
      await resumePendingRevision(editor: editor)
    }
  }
  func generate() async {
    guard hasPendingGeneration || !state.footage.isEmpty else {
      error = "Add footage first."
      return
    }
    await perform("Sending your footage") {
      if self.state.pendingSubmission == nil {
        if self.state.pendingGeneration == nil {
          let draft = self.state
          let id = draft.pendingProjectID ?? UUID().uuidString.lowercased()
          let brief = [
            draft.brief,
            draft.styleHints.isEmpty
              ? ""
              : "Optional starter hints, not learned preferences: "
                + draft.styleHints.joined(separator: ", "),
            draft.ingredients.isEmpty
              ? "" : "Optional treatment: " + draft.ingredients.joined(separator: ", "),
          ].filter { !$0.isEmpty }.joined(separator: "\n")
          self.state.pendingProjectID = id
          self.state.pendingGeneration = PendingGeneration(
            id: id, title: draft.title, brief: brief,
            durationGoal: .init(seconds: draft.duration,
              mode: draft.exactDuration ? "exact" : "preferred",
              toleranceSeconds: draft.exactDuration ? 1.0 / 30 : max(1.5, draft.duration * 0.1)),
            footage: draft.footage)
        }
        try self.requireSavedState()
        guard let draft = self.state.pendingGeneration else { return }
        var ids: [String] = []
        for index in draft.footage.indices {
          try Task.checkCancellation()
          var asset = draft.footage[index]
          if asset.remoteID == nil {
            let id = try await self.api.upload(
              asset.source, url: URL(fileURLWithPath: asset.localPath)
            ) { sent, total in
              self.stage =
                "Uploading \(index + 1) of \(draft.footage.count) · \(Int(Double(sent) / Double(total) * 100))%"
              BackgroundWorkController.shared.update(
                0.9 * (Double(index) + Double(sent) / Double(max(1, total))) / Double(draft.footage.count),
                self.stage ?? "Uploading footage")
            }
            asset.remoteID = id
            self.state.pendingGeneration?.footage[index] = asset
            if let current = self.state.footage.firstIndex(where: { $0.id == asset.id }) {
              self.state.footage[current] = asset
            }
            self.state.assetIDsByHash = (self.state.assetIDsByHash ?? [:]).merging([
              asset.source.sha256: id
            ]) { _, new in new }
            try self.requireSavedState()
          }
          ids.append(asset.remoteID!)
        }
        self.state.pendingSubmission = ProjectSubmission(
          id: draft.id, title: draft.title, brief: draft.brief, assetIDs: ids,
          durationGoal: draft.durationGoal)
      }
      try self.requireSavedState()
      try Task.checkCancellation()
      guard let submission = self.state.pendingSubmission else { return }
      self.stage = "Saving your editing request"
      try await CompletionNotifications.shared.prepareSubmission()
      let _: ServerProject = try await self.api.request("projects", method: "POST", body: submission)
      await CompletionNotifications.shared.watch(projectID: submission.id)
      let pending = self.state
      self.state.watchingProjectID = submission.id
      // One durable write hands off the draft to its saved project. Never erase
      // its retry receipt before saving the project we should return to.
      self.clearDraft()
      guard !self.unsavedState else {
        self.state = pending
        throw TimelineError.invalid(self.error ?? "Could not save your project. Retry this request.")
      }
      if self.route == .recipe { self.route = .cooking }
      await self.refresh()
    }
  }
  func refresh() async {
    guard activeOwnerID != nil, stateRecoveryError == nil, !Task.isCancelled, !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    let generation = accountGeneration
    do {
      let projectList: ProjectList = try await api.get("projects")
      let jobList: JobList = try await api.get("jobs")
      let service: ServiceStatus = try await api.get("service-status")
      guard generation == accountGeneration, !Task.isCancelled else { return }
      let archived = projectList.archivedProjectIDs ?? []
      if state.archivedProjectIDs != archived {
        state.archivedProjectIDs = archived
        save()
      }
      projects = projectList.projects
      jobs = jobList.jobs
      aiProcessingEnabled = service.aiProcessingEnabled
      CompletionNotifications.shared.serverPushEnabled = service.pushNotificationsEnabled ?? false
      lastProgressCheck = Date()
      connectionError = nil
      if route == .cooking, let id = state.watchingProjectID {
        let result: ServerProjectDetail = try await api.get("projects/\(id)")
        guard generation == accountGeneration, !Task.isCancelled,
          route == .cooking, state.watchingProjectID == id else { return }
        detail = result
        // Detail jobs arrive oldest first. An earlier failed request must not
        // hide a later successful cut; the latest failed revision stays visible.
        let latestPlan = result.jobs.last(where: { $0.kind == "plan" })
        if result.project.currentRevisionId != nil
          && !result.jobs.contains(where: { $0.kind == "plan" && $0.active })
          && latestPlan?.status != "attention"
        {
          route = .review
        }
      }
    } catch {
      if generation == accountGeneration && !Task.isCancelled { connectionError = error.localizedDescription }
    }
  }
  func openSavedLocal(
    _ project: EditorModel.LocalProject, editor: EditorModel, withinOperation: Bool = false
  ) {
    guard !busy || withinOperation, !editor.busy else { return }
    detail = state.cachedDetails?[project.root.lastPathComponent]
    localProject = detail == nil
    editor.openProject(project)
    route = .studio
    hasUnsentEdits =
      !localProject
      && state.syncedLocalRevisions?[project.root.lastPathComponent] != editor.timeline.id
  }
  func openCompletion(_ notice: CompletionNotice, editor: EditorModel) async {
    guard notice.destination.ownerID == activeOwnerID else { return }
    while busy || editor.busy {
      do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
    }
    guard !Task.isCancelled, notice.destination.ownerID == activeOwnerID else { return }
    let destination = notice.destination
    if let projectID = destination.projectID {
      if destination.exportID != nil, let local = editor.projects.first(where: {
        $0.root.lastPathComponent == projectID || (try? ProjectStore(root: $0.root).load().id) == projectID
      }) {
        openSavedLocal(local, editor: editor)
      } else { await openRemote(projectID, editor: editor) }
      guard !Task.isCancelled, notice.destination.ownerID == activeOwnerID else { return }
      if let exportID = destination.exportID {
        guard (try? ProjectStore(root: editor.root).load().id) == projectID else { return }
        do { try await editor.openSavedExport(exportID); openedExportID = exportID }
        catch { self.error = "This export could not be opened. Its project is preserved. \(error.localizedDescription)" }
      }
    } else if destination.screen == "teaching" {
      route = .teachIt
    } else if destination.screen == "memory" {
      route = .memory
    } else if destination.screen == "home" {
      route = .home
    } else if destination.screen == "draft" {
      route = state.footage.isEmpty ? .upload : .recipe
    } else {
      if hasPendingGeneration { route = .recipe }
      else if let projectID = state.watchingProjectID { await openRemote(projectID, editor: editor) }
      else { route = state.footage.isEmpty ? .upload : .recipe }
    }
    guard !Task.isCancelled, notice.destination.ownerID == activeOwnerID else { return }
    CompletionNotifications.shared.opened(notice.id)
  }
  func openRemote(_ id: String, editor: EditorModel, editing: Bool = false) async {
    await perform("Opening project") {
      let detail: ServerProjectDetail
      do { detail = try await self.api.get("projects/\(id)") } catch {
        if let cached = self.state.cachedDetails?[id],
          let local = editor.projects.first(where: { $0.root.lastPathComponent == id })
        {
          self.detail = cached
          self.openSavedLocal(local, editor: editor, withinOperation: true)
          return
        }
        throw error
      }
      self.state.cachedDetails = (self.state.cachedDetails ?? [:]).merging([id: detail]) { _, new in
        new
      }
      self.save()
      self.detail = detail
      if let local = editor.projects.first(where: { $0.root.lastPathComponent == id }),
        let document = try? ProjectStore(root: local.root).load(),
        self.state.syncedLocalRevisions?[id] != document.current.id
      {
        self.openSavedLocal(local, editor: editor, withinOperation: true)
        return
      }
      self.localProject = false
      if let current = detail.revisions.first(where: { $0.id == detail.project.currentRevisionId })
      {
        try await self.openRevision(current, detail: detail, editor: editor)
        self.route =
          editing || detail.project.status == "approved" || detail.project.status == "editing"
          ? .studio : .review
      } else {
        self.state.watchingProjectID = id
        self.save()
        self.route = .cooking
      }
    }
  }
  func loadReview(editor: EditorModel) async {
    guard let detail,
      let revision = detail.revisions.first(where: { $0.id == detail.project.currentRevisionId })
    else { return }
    await perform("Opening preview") {
      try await self.openRevision(revision, detail: detail, editor: editor)
    }
  }
  private func openRevision(
    _ revision: ServerRevision, detail: ServerProjectDetail, editor: EditorModel
  ) async throws {
    var urls: [String: URL] = [:]
    let needed = Set(
      revision.timeline.clips.map(\.sourceID) + (revision.timeline.sounds ?? []).map(\.sourceID)
        + (revision.timeline.overlays ?? []).compactMap(\.sourceID))
    let neededSources = detail.sources.filter { needed.contains($0.id) }
    for source in neededSources {
      state.assetIDsByHash = (state.assetIDsByHash ?? [:]).merging([source.sha256: source.id]) {
        _, new in new
      }
      if let localPath = state.originalPathsByHash?[source.sha256]
        ?? state.footage.first(where: { $0.source.sha256 == source.sha256 })?.localPath,
        FileManager.default.fileExists(atPath: localPath)
      {
        urls[source.id] = URL(fileURLWithPath: localPath)
      } else {
        urls[source.id] = try await api.download(
          source, into: root.appendingPathComponent("downloads"))
      }
    }
    while editor.busy { try await Task.sleep(for: .milliseconds(100)) }
    try await editor.installSnapshot(
      projectID: detail.project.id, title: detail.project.title, timeline: revision.timeline,
      sources: neededSources, sourceURLs: urls)
    var cachedProject = detail.project
    cachedProject.currentRevisionId = revision.id
    cachedProject.status =
      revision.origin == "approved"
      ? "approved" : revision.origin == "manual" ? "editing" : "review"
    let cachedRevisions =
      detail.revisions.contains(where: { $0.id == revision.id })
      ? detail.revisions : detail.revisions + [revision]
    let cached = ServerProjectDetail(
      project: cachedProject, sources: detail.sources, revisions: cachedRevisions, jobs: detail.jobs
    )
    state.cachedDetails = (state.cachedDetails ?? [:]).merging([detail.project.id: cached]) {
      _, new in new
    }
    state.revisionMappings = (state.revisionMappings ?? [:]).merging([
      detail.project.id + "|" + revision.id: revision.id
    ]) { _, new in new }
    state.syncedRevisions[detail.project.id] = revision.id
    state.syncedLocalRevisions = (state.syncedLocalRevisions ?? [:]).merging([
      detail.project.id: revision.id
    ]) { _, new in new }
    hasUnsentEdits = false
    save()
  }
  func approve(editor: EditorModel) async {
    guard let detail, let revisionID = detail.project.currentRevisionId else { return }
    await perform("Saving approved cut") {
      struct Snapshot: Encodable {
        let id: String
        let revisionID: String
        let baseRevisionID: String
      }
      let revision: ServerRevision = try await self.api.request(
        "projects/\(detail.project.id)/approve", method: "POST",
        body: Snapshot(
          id: self.requestID(["approve", detail.project.id, revisionID]), revisionID: revisionID, baseRevisionID: revisionID))
      guard revision.accepted else {
        throw TimelineError.invalid("A newer version exists. This approval was kept separately. Reopen the project to review the current version.")
      }
      try await self.openRevision(revision, detail: detail, editor: editor)
      self.detail = try await self.api.get("projects/\(detail.project.id)")
      self.route = .studio
    }
  }
  func revise(_ instruction: String, editor: EditorModel, scoped: Bool) async {
    guard !busy else { return }
    guard let detail,
      EditorProjectIdentity.matches(editorRoot: editor.root, remoteProjectID: detail.project.id) else {
      error = "Open a generated project to request an AI revision."
      return
    }
    let scopeIDs = scoped ? editor.selectedID.map { [$0] } : nil
    guard !instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      !scoped || scopeIDs != nil else {
      error = scoped && scopeIDs == nil ? "Select a clip to revise." : "Describe the change you want."
      return
    }
    if let pending = state.pendingRevision {
      guard pending.projectID == detail.project.id, pending.instruction == instruction,
        pending.scopeClipIDs == scopeIDs else {
        error = "Resume or discard your saved revision request before starting another change."
        return
      }
    } else {
      state.pendingRevision = PendingRevision(projectID: detail.project.id, projectTitle: detail.project.title,
        instruction: instruction, scopeClipIDs: scopeIDs, localRevisionID: editor.timeline.id,
        startingRemoteRevisionID: state.syncedRevisions[detail.project.id])
    }
    // Save the user's words and scope before permissions, synchronization, or
    // uploading. A suspended view never becomes the only owner of this intent.
    guard save() else { return }
    await resumePendingRevision(editor: editor)
  }
  @discardableResult
  func discardPendingRevision() -> Bool {
    guard !busy else { return false }
    let pending = state.pendingRevision
    state.pendingRevision = nil
    guard save() else { state.pendingRevision = pending; return false }
    return true
  }
  func resumePendingRevision(editor: EditorModel? = nil) async {
    guard let pending = state.pendingRevision else { return }
    await perform("Sending your revision") {
      if pending.request == nil {
        guard let editor, self.projectID == pending.projectID,
          EditorProjectIdentity.matches(editorRoot: editor.root, remoteProjectID: pending.projectID),
          editor.timeline.id == pending.localRevisionID else {
          throw TimelineError.invalid("Open the saved version of \(pending.projectTitle) in Studio to finish sending this revision. Your original instructions are kept.")
        }
        let mapped = self.state.revisionMappings?[pending.projectID + "|" + pending.localRevisionID]
        let alreadySynced = self.state.syncedLocalRevisions?[pending.projectID] == pending.localRevisionID
          && mapped != nil && mapped == self.state.syncedRevisions[pending.projectID]
        guard self.state.syncedRevisions[pending.projectID] == pending.startingRemoteRevisionID || alreadySynced else {
          throw TimelineError.invalid("The project's saved base has changed. Your revision instructions are kept; review the original version or discard this request before asking for a new change.")
        }
        try await self.syncEdits(editor)
        try Task.checkCancellation()
        guard self.projectID == pending.projectID, editor.timeline.id == pending.localRevisionID,
          EditorProjectIdentity.matches(editorRoot: editor.root, remoteProjectID: pending.projectID) else {
          throw TimelineError.invalid("The open edit changed before the revision was sent. Reopen its original saved version to continue.")
        }
        let base = self.state.syncedRevisions[pending.projectID] ?? pending.localRevisionID
        self.state.pendingRevision?.request = RevisionRequest(
          id: self.requestID(["revise", pending.projectID, base, pending.instruction] + (pending.scopeClipIDs ?? []).sorted()),
          baseRevisionID: base, instruction: pending.instruction, scopeClipIDs: pending.scopeClipIDs)
      }
      try self.requireSavedState()
      guard let request = self.state.pendingRevision?.request else { return }
      // Once frozen, never sync a newer editor before retrying this exact POST.
      // The server decides whether its original base is still current.
      try await CompletionNotifications.shared.prepareSubmission()
      try Task.checkCancellation()
      let job: ServerJob = try await self.api.request(
        "projects/\(pending.projectID)/revise", method: "POST", body: request)
      await CompletionNotifications.shared.watch(jobID: job.id)
      let saved = self.state
      self.state.watchingProjectID = pending.projectID
      self.state.pendingRevision = nil
      guard self.save() else {
        self.state = saved
        throw TimelineError.invalid(self.error ?? "Could not save your revision request. Retry the saved request.")
      }
      self.route = .cooking
    }
  }
  func restore(_ revision: ServerRevision, editor: EditorModel) async {
    guard let detail, let base = detail.project.currentRevisionId else { return }
    await perform("Restoring version") {
      struct Snapshot: Encodable {
        let id: String
        let revisionID: String
        let baseRevisionID: String
      }
      let restored: ServerRevision = try await self.api.request(
        "projects/\(detail.project.id)/restore", method: "POST",
        body: Snapshot(
          id: self.requestID(["restore", detail.project.id, base, revision.id]), revisionID: revision.id, baseRevisionID: base))
      guard restored.accepted else {
        throw TimelineError.invalid("A newer version exists. The restored version was kept separately. Reopen the project to choose which version to use.")
      }
      try await self.openRevision(restored, detail: detail, editor: editor)
      self.detail = try await self.api.get("projects/\(detail.project.id)")
    }
  }
  func scheduleSync(editor: EditorModel) {
    guard !localProject, EditorProjectIdentity.matches(editorRoot: editor.root, remoteProjectID: projectID),
      state.syncedLocalRevisions?[projectID!] != editor.timeline.id
    else { return }
    hasUnsentEdits = true
    syncTask?.cancel()
    syncTask = Task {
      try? await Task.sleep(for: .seconds(1))
      guard !Task.isCancelled else { return }
      do { try await syncEdits(editor) } catch {
        connectionError = "Edits saved on this device. Sync pending: \(error.localizedDescription)"
      }
    }
  }
  private func syncEdits(_ editor: EditorModel, allowFlushing: Bool = false) async throws {
    while syncing || (flushing && !allowFlushing) { try await Task.sleep(for: .milliseconds(100)) }
    guard let projectID, !localProject,
      EditorProjectIdentity.matches(editorRoot: editor.root, remoteProjectID: projectID),
      state.syncedLocalRevisions?[projectID] != editor.timeline.id
    else { return }
    syncing = true
    defer { syncing = false }
    let snapshot = editor.document
    let paths = Dictionary(
      uniqueKeysWithValues: snapshot.sources.compactMap { source in
        editor.sourceURL(source.id).map { (source.id, $0.path) }
      })
    _ = try await saveSnapshot(snapshot, projectID: projectID, paths: paths)
    if self.projectID == projectID {
      hasUnsentEdits = editor.timeline.id != snapshot.current.id
      let refreshed: ServerProjectDetail = try await api.get("projects/\(projectID)")
      if self.projectID == projectID { detail = refreshed }
    }
  }
  private func saveSnapshot(_ snapshot: ProjectDocument, projectID: String, paths: [String: String])
    async throws -> String
  {
    let mappingKey = projectID + "|" + snapshot.current.id
    // An exported old version must retain its original server identity.
    var timeline = snapshot.current
    let base = state.syncedRevisions[projectID]
    timeline.id = stableUUID(SHA256.hash(
      data: Data([projectID, timeline.id, base ?? "initial"].joined(separator: "|").utf8)
    ), preservingValidLegacy: true)
    timeline.parentID = base
    var ids: [String] = []
    for source in snapshot.sources {
      guard let path = paths[source.id] else { throw TimelineError.invalid("Original unavailable") }
      let id: String
      if let cached = state.assetIDsByHash?[source.sha256] {
        id = cached
      } else {
        id = try await api.upload(source, url: URL(fileURLWithPath: path)) { _, _ in }
        state.assetIDsByHash = (state.assetIDsByHash ?? [:]).merging([source.sha256: id]) {
          _, new in new
        }
        save()
      }
      ids.append(id)
      for index in timeline.clips.indices where timeline.clips[index].sourceID == source.id {
        timeline.clips[index].sourceID = id
      }
      for index in timeline.sounds?.indices ?? 0..<0
      where timeline.sounds?[index].sourceID == source.id { timeline.sounds?[index].sourceID = id }
      for index in timeline.overlays?.indices ?? 0..<0
      where timeline.overlays?[index].sourceID == source.id {
        timeline.overlays?[index].sourceID = id
      }
    }
    struct Inputs: Encodable { let assetIDs: [String] }
    let _: Acknowledgement = try await api.request(
      "projects/\(projectID)/inputs", method: "POST", body: Inputs(assetIDs: ids))
    struct Save: Encodable {
      let timeline: Timeline
      let baseRevisionID: String?
      let summary: String
    }
    let saved: ServerRevision = try await api.request(
      "projects/\(projectID)/revisions", method: "POST",
      body: Save(timeline: timeline, baseRevisionID: base, summary: "Studio edit"))
    guard saved.accepted else {
      throw TimelineError.invalid(
        "A newer version exists. Your local edit is kept as a separate version for review.")
    }
    state.syncedRevisions[projectID] = saved.id
    state.syncedLocalRevisions = (state.syncedLocalRevisions ?? [:]).merging([
      projectID: snapshot.current.id
    ]) { _, new in new }
    state.revisionMappings = (state.revisionMappings ?? [:]).merging([mappingKey: saved.id]) {
      _, new in new
    }
    save()
    return saved.id
  }
  func recordExport(_ editor: EditorModel) async {
    guard let projectID, let report = editor.verification, !localProject,
      EditorProjectIdentity.matches(editorRoot: editor.root, remoteProjectID: projectID) else { return }
    guard report.revisionID == editor.timeline.id else {
      error =
        "Export is saved, but its earlier project version must be reopened before syncing the outcome."
      return
    }
    if !(state.exportQueue ?? []).contains(where: {
      $0.projectID == projectID && $0.report.sha256 == report.sha256
    }) {
      let snapshot = editor.document
      let paths = Dictionary(
        uniqueKeysWithValues: snapshot.sources.compactMap { source in
          editor.sourceURL(source.id).map { (source.id, $0.path) }
        })
      state.exportQueue =
        (state.exportQueue ?? []) + [
          QueuedExport(projectID: projectID, report: report, snapshot: snapshot, paths: paths)
        ]
      guard save() else { return }
    }
    await flushPending(editor: editor)
  }
  func feedback(_ text: String, reusable: Bool) async {
    guard let detail, let revisionID = detail.project.currentRevisionId else { return }
    state.feedbackQueue =
      (state.feedbackQueue ?? []) + [
        QueuedFeedback(
          projectID: detail.project.id, revisionID: revisionID, text: text, reusable: reusable)
      ]
    guard save() else { return }
    await sendFeedbackQueue()
  }
  private func sendFeedbackQueue() async {
    guard !feedbackSending, !(state.feedbackQueue ?? []).isEmpty else { return }
    guard save() else { return }
    feedbackSending = true
    defer { feedbackSending = false }
    do {
      for item in state.feedbackQueue ?? [] {
        let _: ServerJob = try await api.request(
          "projects/\(item.projectID)/feedback", method: "POST", body: item)
        state.feedbackQueue?.removeAll { $0.id == item.id }
        save()
      }
    } catch {
      connectionError = "Feedback saved on this device. Sync pending: \(error.localizedDescription)"
    }
  }
  func flushPending(editor: EditorModel) async {
    guard activeOwnerID != nil, stateRecoveryError == nil, !flushing, !syncing, !busy, !Task.isCancelled else { return }
    let needsEditSync = projectID.map {
      !editor.busy && !localProject
        && EditorProjectIdentity.matches(editorRoot: editor.root, remoteProjectID: $0)
        && state.syncedLocalRevisions?[$0] != editor.timeline.id
    } ?? false
    guard unsavedState || needsEditSync || !(state.feedbackQueue ?? []).isEmpty
      || !(state.exportQueue ?? []).isEmpty else { return }
    guard save() else { return }
    flushing = true
    defer { flushing = false }
    await sendFeedbackQueue()
    do {
      for item in state.exportQueue ?? [] {
        let key = item.projectID + "|" + item.report.revisionID
        let remoteID: String
        if let saved = state.revisionMappings?[key] {
          remoteID = saved
        } else if state.syncedLocalRevisions?[item.projectID] == item.report.revisionID,
          let saved = state.syncedRevisions[item.projectID]
        {
          remoteID = saved
        } else {
          remoteID = try await saveSnapshot(
            item.snapshot, projectID: item.projectID, paths: item.paths)
        }
        struct Verification: Encodable {
          let revisionID: String
          let durationSeconds: Double
          let hasAudio: Bool
          let decodedVideoSamples: Int
          let sha256: String
        }
        struct Export: Encodable {
          let id: String
          let verification: Verification
        }
        let verified = Verification(
          revisionID: remoteID, durationSeconds: item.report.durationSeconds,
          hasAudio: item.report.hasAudio, decodedVideoSamples: item.report.decodedVideoSamples,
          sha256: item.report.sha256)
        let _: ServerJob = try await api.request(
          "projects/\(item.projectID)/exports", method: "POST",
          body: Export(id: item.id, verification: verified))
        state.exportQueue?.removeAll { $0.id == item.id }
        save()
      }
      if !editor.busy { try await syncEdits(editor, allowFlushing: true) }
    } catch {
      connectionError =
        "Your work is saved on this device. Sync pending: \(error.localizedDescription)"
    }
  }
  func teach(finals: [URL], raw: [URL], attribution: String, notes: String) async {
    guard hasPendingTeaching || !finals.isEmpty else { error = "Add a finished video first."; return }
    guard hasPendingTeaching || raw.isEmpty || finals.count == 1 else {
      error = "Pair each raw group with one finished video. Send finished-only batches separately."
      return
    }
    await perform("Saving teaching material") {
      if self.state.pendingTeaching == nil {
        var draft = self.state.teaching ?? TeachingDraft()
        draft.finals = finals.map(\.path)
        draft.raw = raw.map(\.path)
        draft.attribution = attribution
        draft.notes = notes
        for file in draft.finals where draft.groupIDs[file] == nil {
          draft.groupIDs[file] = UUID().uuidString.lowercased()
        }
        self.state.teaching = draft
        self.state.pendingTeaching = draft
      }
      try self.requireSavedState()
      guard let draft = self.state.pendingTeaching else { return }
      try await CompletionNotifications.shared.prepareSubmission()
      var rawIDs: [String] = []
      let totalFiles = draft.raw.count + draft.finals.count
      for (index, path) in draft.raw.enumerated() {
        try Task.checkCancellation()
        rawIDs.append(try await self.uploadTeaching(URL(fileURLWithPath: path), index: index, count: totalFiles))
      }
      for (index, path) in draft.finals.enumerated() {
        try Task.checkCancellation()
        let finalID = try await self.uploadTeaching(URL(fileURLWithPath: path), index: index + draft.raw.count, count: totalFiles)
        struct Group: Encodable {
          let id: String
          let finalAssetID: String
          let rawAssetIDs: [String]
          let attribution: String
          let notes: String
        }
        try Task.checkCancellation()
        let job: ServerJob = try await self.api.request(
          "teaching", method: "POST",
          body: Group(
            id: draft.groupIDs[path]!, finalAssetID: finalID, rawAssetIDs: rawIDs,
            attribution: draft.attribution, notes: draft.notes))
        await CompletionNotifications.shared.watch(jobID: job.id)
      }
      let submittedDraft = self.state.teaching
      let pendingTeaching = self.state.pendingTeaching
      self.state.teaching = nil
      self.state.pendingTeaching = nil
      guard self.save() else {
        self.state.teaching = submittedDraft
        self.state.pendingTeaching = pendingTeaching
        throw TimelineError.invalid(self.error ?? "Could not save your submitted reference. Keep the app open and retry.")
      }
      // Every group now refers to verified Mac originals, and the phone has
      // durably released this draft. Only its submitted, unreferenced copies
      // can be removed; interrupted groups and save failures keep their files.
      let draftPaths = Set((submittedDraft?.finals ?? []) + (submittedDraft?.raw ?? []))
      await self.removeSubmittedTeachingFiles(draftPaths.intersection(draft.finals + draft.raw))
      await self.refresh()
      if self.route == .teachIt {
        self.finishOnboarding()
      } else {
        self.state.onboarded = true
        self.save()
      }
    }
  }
  private func removeSubmittedTeachingFiles(_ paths: Set<String>) async {
    let directory = root.appendingPathComponent("teaching-draft").resolvingSymlinksInPath()
    let retainedPaths = state.footage.map(\.localPath)
      + Array((state.originalPathsByHash ?? [:]).values)
      + (state.exportQueue ?? []).flatMap { Array($0.paths.values) }
    let retained = Set(retainedPaths.map { URL(fileURLWithPath: $0).resolvingSymlinksInPath().path })
    await Task.detached(priority: .utility) {
      for path in paths {
        let file = URL(fileURLWithPath: path).resolvingSymlinksInPath()
        guard file.path.hasPrefix(directory.path + "/"), !retained.contains(file.path),
          (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        else { continue }
        do {
          try FileManager.default.removeItem(at: file)
          let folder = file.deletingLastPathComponent()
          if folder.deletingLastPathComponent() == directory,
            UUID(uuidString: folder.lastPathComponent) != nil,
            (try? FileManager.default.contentsOfDirectory(atPath: folder.path).isEmpty) == true
          { try? FileManager.default.removeItem(at: folder) }
        } catch { /* A failed cleanup leaves an owned cache copy, never a lost draft. */ }
      }
    }.value
  }
  func importTeaching(_ urls: [URL], final: Bool) async {
    guard !hasPendingTeaching else {
      error = "Finish sending your saved reference before changing its videos."
      return
    }
    await perform("Saving teaching originals") {
      if self.state.teaching == nil { self.state.teaching = TeachingDraft() }
      for url in urls {
        try Task.checkCancellation()
        let access = url.startAccessingSecurityScopedResource()
        defer { if access { url.stopAccessingSecurityScopedResource() } }
        let folder = self.root.appendingPathComponent("teaching-draft").appendingPathComponent(
          UUID().uuidString)
        let importing = Task.detached { try await MediaImport.copy(url, into: folder) }
        let (source, target) = try await withTaskCancellationHandler {
          try await importing.value
        } onCancel: { importing.cancel() }
        if final {
          self.state.teaching?.finals.append(target.path)
          self.state.teaching?.groupIDs[target.path] = UUID().uuidString.lowercased()
        } else {
          self.state.teaching?.raw.append(target.path)
        }
        self.state.teaching?.sourcesByPath = (self.state.teaching?.sourcesByPath ?? [:]).merging([
          target.path: source
        ]) { _, new in new }
        try self.requireSavedState()
      }
    }
  }
  private func uploadTeaching(_ file: URL, index: Int, count: Int) async throws -> String {
    let access = file.startAccessingSecurityScopedResource()
    defer { if access { file.stopAccessingSecurityScopedResource() } }
    let source: MediaSource
    if let cached = state.pendingTeaching?.sourcesByPath?[file.path] ?? state.teaching?.sourcesByPath?[file.path] {
      source = cached
    } else {
      // Legacy teaching drafts already own this file. Inspect once, retaining
      // the same original and metadata across network retries and relaunches.
      source = try await Task.detached { try await MediaImport.inspect(file) }.value
      state.teaching?.sourcesByPath = (state.teaching?.sourcesByPath ?? [:]).merging([
        file.path: source
      ]) { _, new in new }
      state.pendingTeaching?.sourcesByPath = (state.pendingTeaching?.sourcesByPath ?? [:]).merging([
        file.path: source
      ]) { _, new in new }
      try requireSavedState()
    }
    return try await api.upload(source, url: file) { sent, total in
      self.stage = "Uploading reference · \(Int(Double(sent) / Double(total) * 100))%"
      BackgroundWorkController.shared.update(
        0.9 * (Double(index) + Double(sent) / Double(max(1, total))) / Double(max(1, count)),
        "Uploading reference \(index + 1) of \(count)")
    }
  }
  func generateCaptions(editor: EditorModel, style: String) async {
    guard let projectID else { return }
    let localRevision = editor.timeline.id
    await perform("Timing your speech") {
      try await self.syncEdits(editor)
      struct CaptionStatus: Decodable {
        let complete: Bool
        let wordsBySource: [String: [TimedWord]]
        let issues: [String]
      }
      var result: CaptionStatus = try await self.api.request(
        "projects/\(projectID)/captions", method: "POST", body: EmptyRequest())
      var polls = 0
      while !result.complete && result.issues.isEmpty && polls < 720 {
        try await Task.sleep(for: .seconds(5))
        polls += 1
        result = try await self.api.get("projects/\(projectID)/captions")
      }
      guard result.issues.isEmpty else {
        throw TimelineError.invalid(result.issues.joined(separator: "\n"))
      }
      guard result.complete else {
        throw TimelineError.invalid(
          "Speech timing is still processing. Progress is saved; return to generate captions later."
        )
      }
      guard editor.timeline.id == localRevision, self.projectID == projectID else {
        throw TimelineError.invalid(
          "Speech timing is saved. Your edit changed; generate captions again to apply it to the current cut."
        )
      }
      // Native imports may have local IDs; map cached words by original hash.
      var mapped = result.wordsBySource
      if let detail = self.detail {
        for source in editor.document.sources {
          if let remote = detail.sources.first(where: { $0.sha256 == source.sha256 }),
            let words = result.wordsBySource[remote.id]
          {
            mapped[source.id] = words
          }
        }
      }
      editor.addCaptions(mapped, style: style)
    }
  }
  func loadMemory() async {
    await perform("Loading saved learning") {
      let list: MemoryList = try await self.api.get("memory")
      self.memory = list.records
      let groups: TeachingList = try await self.api.get("teaching")
      self.groups = groups.groups
      self.usage = try await self.api.get("account")
    }
  }
  func toggleMemory(_ entry: MemoryEntry) async {
    await perform("Updating learning") {
      struct Toggle: Encodable { let enabled: Bool }
      let _: Acknowledgement = try await self.api.request(
        "memory/\(entry.id)", method: "PATCH", body: Toggle(enabled: !entry.enabled))
      let memory: MemoryList = try await self.api.get("memory")
      let teaching: TeachingList = try await self.api.get("teaching")
      self.memory = memory.records
      self.groups = teaching.groups
    }
  }
  func excludeGroup(_ group: TeachingGroup, excluded: Bool) async {
    await perform("Updating reference") {
      struct Exclude: Encodable {
        let evidenceID: String
        let excluded: Bool
      }
      let _: Acknowledgement = try await self.api.request(
        "exclusions", method: "POST", body: Exclude(evidenceID: group.id, excluded: excluded))
      let memory: MemoryList = try await self.api.get("memory")
      let teaching: TeachingList = try await self.api.get("teaching")
      self.memory = memory.records
      self.groups = teaching.groups
    }
  }
  func rename(_ project: ServerProject, title: String) async {
    await perform("Saving project name") {
      struct Rename: Encodable { let title: String }
      let _: Acknowledgement = try await self.api.request(
        "projects/\(project.id)", method: "PATCH", body: Rename(title: title))
      await self.refresh()
    }
  }
  func archive(_ project: ServerProject) async {
    await perform("Archiving project") {
      struct Archive: Encodable { let archived: Bool }
      let _: Acknowledgement = try await self.api.request(
        "projects/\(project.id)", method: "PATCH", body: Archive(archived: true))
      await self.refresh()
    }
  }
  func resume(_ job: ServerJob) async {
    await perform("Resuming saved work") {
      let _: Acknowledgement = try await self.api.request(
        "jobs/\(job.id)/resume", method: "POST", body: EmptyRequest())
      await self.refresh()
    }
  }
  private func perform(_ label: String, action: @escaping @MainActor () async throws -> Void) async {
    while flushing || syncing {
      do { try await Task.sleep(for: .milliseconds(100)) } catch { return }
    }
    guard !busy, stateRecoveryError == nil, !Task.isCancelled else { return }
    stage = label
    error = nil
    defer { stage = nil }
    let notices = CompletionNotifications.shared
    let background = BackgroundWorkController.shared
    let nested = background.isNestedOperation
    let owner = activeOwnerID
    let originalProject = label == "Sending your revision" ? state.pendingRevision?.projectID ?? projectID : projectID
    let started = Date()
    let operationID = UUID().uuidString.lowercased()
    let teaching = label == "Saving teaching material" || label == "Saving teaching originals"
    let memory = label == "Loading saved learning" || label == "Updating learning" || label == "Updating reference"
    let isDraft = label == "Saving original footage" || label == "Sending your footage"
    var reportedFailure = false
    let reportFailure: @MainActor (Error) async -> Void = { failure in
      reportedFailure = true
      let paused = failure is CancellationError || (failure as? URLError)?.code == .cancelled
      self.error = paused ? "This step paused. Your saved progress is kept; return to PB&J to continue." : failure.localizedDescription
      if !nested, let owner, owner == self.activeOwnerID, !notices.isActive || Date().timeIntervalSince(started) > 10 {
        _ = await notices.receive(.init(id: operationID, title: paused ? "PB&J needs you to continue" : "This step needs attention",
          body: paused ? "Your progress is saved. Tap to reopen PB&J and continue." : "The step could not finish. Tap to review the issue and your saved work.",
          destination: .init(ownerID: owner, projectID: teaching || memory || isDraft ? nil : originalProject,
            screen: teaching ? "teaching" : memory ? "memory" : isDraft || originalProject == nil ? "draft" : nil)))
      }
    }
    do {
      try requireSavedState()
      if !nested { await notices.requestPermission() }
      try await background.run(title: label, projectID: originalProject) { update in
        do {
          try await action()
          try Task.checkCancellation()
          await update(1, "Saved")
          // Keep the execution allowance until the saved result's alert is scheduled.
          if !nested, !notices.isActive, let owner, owner == self.activeOwnerID {
            let project = teaching || memory || label == "Saving original footage" ? nil
              : label == "Sending your revision" ? originalProject
              : self.projectID ?? self.state.watchingProjectID ?? originalProject
            let isSubmission = label == "Sending your footage" || label == "Sending your revision" || label == "Saving teaching material"
            _ = await notices.receive(.init(id: operationID, title: isSubmission ? "Your request is saved" : "Your step is finished",
              body: isSubmission ? "Your Mac has the request. AI work continues there; open PB&J to check progress." : "Your work is saved. Tap to continue in PB&J.",
              destination: .init(ownerID: owner, projectID: project, screen: teaching ? "teaching" : memory ? "memory" : project == nil ? "draft" : nil)))
          }
        } catch { await reportFailure(error); throw error }
      }
    } catch {
      if !reportedFailure { await reportFailure(error) }
    }
  }
  private func requestID(_ parts: [String]) -> String {
    // Byte lengths prevent ambiguous concatenations. Same intent and
    // base version keep one server identity after a lost response or relaunch.
    stableUUID(SHA256.hash(data: Data(parts.map { "\($0.utf8.count):\($0)" }.joined().utf8)))
  }
  private func stableUUID(_ hash: SHA256.Digest, preservingValidLegacy: Bool = false) -> String {
    var bytes = Array(hash.prefix(16))
    // A hash with dashes is usually not a valid UUID. API validation requires
    // version/variant bits. Keep previously valid Studio IDs for retry compatibility.
    let validLegacy = (1...8).contains(bytes[6] >> 4) && bytes[8] >> 6 == 2
    if !preservingValidLegacy || !validLegacy {
      bytes[6] = (bytes[6] & 0x0f) | 0x80 // RFC 9562 custom UUID v8
      bytes[8] = (bytes[8] & 0x3f) | 0x80
    }
    let digest = bytes.map { String(format: "%02x", $0) }.joined()
    return [String(digest.prefix(8)), String(digest.dropFirst(8).prefix(4)),
      String(digest.dropFirst(12).prefix(4)), String(digest.dropFirst(16).prefix(4)),
      String(digest.dropFirst(20).prefix(12))].joined(separator: "-")
  }
}
