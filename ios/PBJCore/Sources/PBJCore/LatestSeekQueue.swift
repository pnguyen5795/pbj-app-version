import Foundation

/// One decoder request in flight and at most one pending destination. Intermediate
/// touch positions are replaced, so they cannot create a growing seek backlog.
public struct LatestSeekQueue {
    public struct Request: Equatable, Sendable {
        public let id: UInt64
        public let ticks: Int64
        public let precise: Bool
    }
    private var serial: UInt64 = 0
    private var active: Request?
    private var pending: (ticks: Int64, precise: Bool)?
    public var hasWork: Bool { active != nil }
    public init() {}

    public mutating func enqueue(ticks: Int64, precise: Bool) -> Request? {
        if let active {
            // Returning to the in-flight destination also invalidates an older
            // pending destination, but exact release seeks must remain distinct.
            pending = active.ticks == ticks && active.precise == precise ? nil : (ticks,precise)
            return nil
        }
        return start(ticks:ticks,precise:precise)
    }
    public mutating func complete(id: UInt64) -> Request? {
        guard active?.id == id else { return nil }
        active = nil
        guard let pending else { return nil }
        self.pending = nil
        return start(ticks:pending.ticks,precise:pending.precise)
    }
    public mutating func cancel() {
        active = nil
        pending = nil
        // Keep the serial so callbacks from an old player item cannot complete
        // work belonging to its replacement.
    }
    private mutating func start(ticks:Int64,precise:Bool) -> Request {
        serial &+= 1
        let request = Request(id:serial,ticks:ticks,precise:precise)
        active = request
        return request
    }
}
