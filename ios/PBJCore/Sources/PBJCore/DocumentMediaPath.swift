import Foundation

/// Persist paths relative to Documents: iOS may relocate its app container on update.
public enum DocumentMediaPath {
    private static func relative(_ path: String, documents: URL) throws -> String? {
        let prefix = documents.standardizedFileURL.path + "/"
        let candidate: String
        if path.hasPrefix(prefix) {
            candidate = String(path.dropFirst(prefix.count))
        } else if !path.hasPrefix("/") {
            candidate = path
        } else if let marker = path.range(of: "/Containers/Data/Application/", options: .backwards) {
            let parts = path[marker.upperBound...].split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count >= 3, UUID(uuidString: String(parts[0])) != nil, parts[1] == "Documents" else { return nil }
            candidate = parts.dropFirst(2).joined(separator: "/")
        } else {
            return nil // Never reinterpret an unrelated external file as app-owned media.
        }
        let parts = candidate.split(separator: "/", omittingEmptySubsequences: false)
        guard !candidate.isEmpty, !candidate.contains("\0"),
            parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." }) else {
            throw TimelineError.invalid("Saved media path is invalid; the original record is preserved.")
        }
        return candidate
    }

    public static func stored(_ path: String, documents: URL) throws -> String {
        try relative(path, documents: documents) ?? path
    }

    public static func resolved(_ path: String, documents: URL) throws -> String {
        guard let relative = try relative(path, documents: documents) else { return path }
        return documents.appendingPathComponent(relative).path
    }
}
