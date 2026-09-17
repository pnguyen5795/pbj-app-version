import Foundation

public enum EditorProjectIdentity {
    /// A loaded Studio document may sync only to its own project directory.
    /// The current screen's selected remote project is not sufficient identity.
    public static func matches(editorRoot: URL, remoteProjectID: String?) -> Bool {
        guard let remoteProjectID, let remote = UUID(uuidString: remoteProjectID),
            let loaded = UUID(uuidString: editorRoot.lastPathComponent) else { return false }
        return loaded == remote
    }
}
