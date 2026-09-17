import Foundation

/// Missing state is a first launch. Unreadable state is a recovery condition.
/// Never overwrite an existing file that this version cannot decode.
public struct PreservedJSONStore<Value: Codable> {
    public let file: URL
    public init(file: URL) { self.file = file }

    private func existing() throws -> Value? {
        do { return try JSONDecoder().decode(Value.self, from: Data(contentsOf: file)) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    public func load(or initial: @autoclosure () -> Value) throws -> Value {
        try existing() ?? initial()
    }

    public func save(_ value: Value) throws {
        _ = try existing()
        let data = try JSONEncoder().encode(value)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file, options: .atomic)
    }
}
