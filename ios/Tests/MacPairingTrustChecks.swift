// Run with MacConnection.swift as a standalone macOS executable. Pass a local
// pairing JSON path; credentials are never printed or sent by this check.
import Foundation
import Security

@main struct MacPairingTrustChecks {
  static func main() throws {
    let pairing = try JSONDecoder().decode(MacPairing.self,
      from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
    try pairing.validate()
    let host = pairing.serverURL.host!
    let certificate = SecCertificateCreateWithData(nil, pairing.certificateDER as CFData)!
    func trust() -> SecTrust {
      var result: SecTrust?
      precondition(SecTrustCreateWithCertificates([certificate] as CFArray,
        SecPolicyCreateBasicX509(), &result) == errSecSuccess)
      return result!
    }
    precondition(pairing.trusts(trust(), host: host))
    precondition(pairing.trusts(trust(), host: host.lowercased()))
    precondition(pairing.trusts(trust(), host: host.uppercased()))
    precondition(!pairing.trusts(trust(), host: "unpaired.local"))
    precondition(!pairing.trusts(trust(), host: host + ".attacker.local"))
    precondition(!pairing.matchesHost(nil))
    let expired = trust()
    SecTrustSetVerifyDate(expired, Date(timeIntervalSinceNow: 400 * 86400) as CFDate)
    precondition(!pairing.trusts(expired, host: host))
    let mismatched = MacPairing(serverURL: URL(string: "https://unpaired.local:8788")!,
      token: pairing.token, certificateDER: pairing.certificateDER)
    precondition(!mismatched.trusts(trust(), host: "unpaired.local"))
    var otherCertificate = pairing.certificateDER
    otherCertificate[otherCertificate.count - 1] ^= 1
    let wrongPin = MacPairing(serverURL: pairing.serverURL, token: pairing.token,
      certificateDER: otherCertificate)
    precondition(!wrongPin.trusts(trust(), host: host))
    print("TLS regression checks passed: case variants accepted; wrong hosts, expiry, hostname mismatch and wrong pin rejected.")
  }
}
