import Foundation

/// A render can be restarted from this exact revision after the process ends.
/// Partial AVAssetExportSession output is not a resumable video checkpoint.
public struct ExportJob: Codable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable { case rendering, interrupted, completed }
    public let id: String
    public let createdAt: Date
    public let snapshot: ProjectDocument
    public let expectsAudio: Bool
    public var status: Status
    public var verification: ExportVerification?
    public var message: String?
    public var projectID: String { snapshot.id }
    public var revisionID: String { snapshot.current.id }
    public var title: String { snapshot.title }

    public init(snapshot: ProjectDocument, expectsAudio: Bool) {
        id = UUID().uuidString.lowercased()
        createdAt = Date()
        var frozen = ProjectDocument(title: snapshot.title, sources: snapshot.sources, timeline: snapshot.current)
        frozen.id = snapshot.id
        self.snapshot = frozen
        self.expectsAudio = expectsAudio
        status = .rendering
    }
}

/// Files live beneath their project, so app-container relocation cannot break
/// saved exports. Only a verified, atomically published output is shareable.
public struct ExportJobStore {
    public let root: URL
    public init(root: URL) { self.root = root }
    private var directory: URL { root.appendingPathComponent("exports") }
    private func checked(_ id: String) throws -> String {
        guard UUID(uuidString: id) != nil else { throw TimelineError.invalid("Invalid saved export identifier") }
        return id
    }
    public func outputURL(_ id: String) throws -> URL {
        directory.appendingPathComponent(try checked(id) + ".mp4")
    }
    public func partialURL(_ id: String) throws -> URL {
        directory.appendingPathComponent(try checked(id) + ".rendering.mp4")
    }
    private func recordURL(_ id: String) throws -> URL {
        directory.appendingPathComponent("jobs").appendingPathComponent(try checked(id) + ".json")
    }
    private func validate(_ job: ExportJob) throws {
        try job.snapshot.validate()
        if job.status == .completed {
            guard let report = job.verification, report.revisionID == job.revisionID,
                  report.durationSeconds.isFinite, report.durationSeconds > 0,
                  abs(report.durationSeconds - Double(job.snapshot.current.duration) / Double(timelineTimescale)) <= 0.1,
                  !job.expectsAudio || report.hasAudio, report.decodedVideoSamples == 3,
                  report.sha256.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                throw TimelineError.invalid("Saved export verification does not match its project version")
            }
        }
    }
    public func save(_ job: ExportJob) throws {
        try validate(job)
        try PreservedJSONStore<ExportJob>(file: recordURL(job.id)).save(job)
    }
    public func load(_ id: String) throws -> ExportJob {
        let job = try JSONDecoder().decode(ExportJob.self, from: Data(contentsOf: recordURL(id)))
        guard job.id == id else { throw TimelineError.invalid("Saved export identity changed") }
        try validate(job)
        return job
    }
    public func latest() throws -> ExportJob? {
        let files: [URL]
        do { files = try FileManager.default.contentsOfDirectory(at: directory.appendingPathComponent("jobs"), includingPropertiesForKeys: nil) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
        return try files.filter { $0.pathExtension == "json" }.map { try load($0.deletingPathExtension().lastPathComponent) }
            .max { $0.createdAt < $1.createdAt }
    }
    public func interrupt(_ job: ExportJob, message: String) throws -> ExportJob {
        var stopped = job
        stopped.status = .interrupted; stopped.verification = nil; stopped.message = message
        try save(stopped)
        try? FileManager.default.removeItem(at: partialURL(job.id))
        return stopped
    }
    public func complete(_ job: ExportJob, report: ExportVerification) throws -> ExportJob {
        guard report.revisionID == job.revisionID else { throw TimelineError.invalid("Export belongs to another project version") }
        var finished = job
        finished.status = .completed; finished.verification = report; finished.message = nil
        try validate(finished)
        let output = try outputURL(job.id), partial = try partialURL(job.id)
        if !FileManager.default.fileExists(atPath: output.path) {
            try FileManager.default.moveItem(at: partial, to: output)
        } else if try MediaImport.hash(output) != report.sha256 {
            throw TimelineError.invalid("The existing export differs from the verified video. Its file has been preserved.")
        }
        try save(finished)
        try? FileManager.default.removeItem(at: partial)
        return finished
    }
    /// A crash after output publication but before the record save must recover
    /// that output. A partial render is discarded and offered for restart.
    public func recover(_ job: ExportJob,
                        verify: (URL, ExportJob) async throws -> ExportVerification) async throws -> ExportJob {
        let output = try outputURL(job.id)
        if FileManager.default.fileExists(atPath: output.path) {
            if job.status == .completed, job.verification?.revisionID == job.revisionID { return job }
            let report = try await verify(output, job)
            return try complete(job, report: report)
        }
        return try interrupt(job, message: job.status == .completed
            ? "The exported file is missing. Your edit is saved; export it again."
            : "Export paused. Your edit is saved. Open PB&J to restart this export.")
    }
}
