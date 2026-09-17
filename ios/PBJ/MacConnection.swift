import Foundation
import Security

struct MacPairing: Codable {
  let serverURL: URL
  let token: String
  let certificateDER: Data

  func matchesHost(_ host: String?) -> Bool {
    // DNS names are case-insensitive. Background transfers may lowercase the
    // host even when foreground URLSession requests preserve the paired URL.
    guard let host, let pairedHost = serverURL.host else { return false }
    return host.lowercased() == pairedHost.lowercased()
  }

  func validate() throws {
    guard serverURL.scheme == "https", let host = serverURL.host, host.hasSuffix(".local"),
      serverURL.user == nil, serverURL.password == nil, serverURL.query == nil,
      serverURL.fragment == nil, serverURL.path.isEmpty || serverURL.path == "/",
      token.count == 64, token.allSatisfy({ $0.isHexDigit && !$0.isUppercase }),
      SecCertificateCreateWithData(nil, certificateDER as CFData) != nil
    else { throw URLError(.badURL) }
  }

  func trusts(_ trust: SecTrust, host: String) -> Bool {
    guard matchesHost(host),
      let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
      SecCertificateCopyData(leaf) as Data == certificateDER,
      let anchor = SecCertificateCreateWithData(nil, certificateDER as CFData)
    else { return false }
    guard SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess,
      SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess else { return false }
    return SecTrustEvaluateWithError(trust, nil)
  }
}

/// Device-only pairing, provisioned over the attached phone connection for the personal build.
/// Trust is limited to the paired certificate AND its hostname; normal TLS checks still apply.
final class MacConnection: NSObject, URLSessionDelegate, URLSessionTaskDelegate, @unchecked Sendable {
  static let shared = MacConnection()
  let pairing: MacPairing?
  let configurationError: String?
  lazy var session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)

  override private init() {
    var saved: MacPairing?
    var failure: String?
    #if DEBUG
    let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "com.pbj.personal-mac", kSecAttrAccount as String: "pairing"]
    do {
      var result: CFTypeRef?
      var lookup = query
      lookup[kSecReturnData as String] = true
      let status = SecItemCopyMatching(lookup as CFDictionary, &result)
      if status == errSecSuccess, let data = result as? Data {
        saved = try JSONDecoder().decode(MacPairing.self, from: data)
        try saved?.validate()
      } else if status != errSecItemNotFound {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
      }
      let incoming = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("PBJMacPairing.json")
      if FileManager.default.fileExists(atPath: incoming.path) {
        let data = try Data(contentsOf: incoming)
        let replacement = try JSONDecoder().decode(MacPairing.self, from: data)
        try replacement.validate()
        let attributes: [String: Any] = [kSecValueData as String: data,
          kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        var write = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if write == errSecItemNotFound {
          write = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
        }
        guard write == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(write)) }
        saved = replacement
        try FileManager.default.removeItem(at: incoming)
      }
    } catch {
      failure = "Mac pairing could not be loaded. Reconnect this iPhone to the Mac to repair it."
    }
    #endif
    pairing = saved
    configurationError = failure
    super.init()
  }

  func answer(_ challenge: URLAuthenticationChallenge,
              completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    guard let pairing, pairing.matchesHost(challenge.protectionSpace.host) else {
      completion(.performDefaultHandling, nil); return
    }
    guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
      let trust = challenge.protectionSpace.serverTrust,
      pairing.trusts(trust, host: challenge.protectionSpace.host) else {
      completion(.cancelAuthenticationChallenge, nil); return
    }
    completion(.useCredential, URLCredential(trust: trust))
  }
  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                  completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    answer(challenge, completion: completionHandler)
  }
  func redirect(_ response: HTTPURLResponse, request: URLRequest) -> URLRequest? {
    guard let pairing, pairing.matchesHost(response.url?.host) else { return request }
    guard request.url?.scheme == "https", pairing.matchesHost(request.url?.host),
      request.url?.port == pairing.serverURL.port else { return nil }
    return request
  }
  func urlSession(_ session: URLSession, task: URLSessionTask,
                  willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                  completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(redirect(response, request: request))
  }
}
