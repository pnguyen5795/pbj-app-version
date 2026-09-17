import ClerkKit
import Combine
import Foundation

@MainActor
final class AuthenticationModel: ObservableObject {
  @Published var signedIn = false
  @Published var busy = false
  @Published var error: String?
  @Published var codeSent = false
  @Published var localWorkspace = false
  private var signIn: SignIn?
  private var signUp: SignUp?
  let clerk: Clerk?
  var configured: Bool { clerk != nil }
  var appleConfigured: Bool {configured && (Bundle.main.object(forInfoDictionaryKey:"PBJAppleSignInEnabled") as? String)=="YES"}
  init() {
    if let key = Bundle.main.object(forInfoDictionaryKey: "PBJClerkPublishableKey") as? String,
      key.hasPrefix("pk_")
    {
      clerk = Clerk.configure(publishableKey: key)
    } else {
      clerk = nil
    }
    #if DEBUG
      localWorkspace = UserDefaults.standard.bool(forKey: "PBJLocalWorkspace")
    #endif
    signedIn = localWorkspace || clerk?.session != nil
  }
  func restore() async {
    guard let clerk else { return }
    // SDK configuration restores persisted session state asynchronously.
    for _ in 0..<100 {
      if clerk.isLoaded { break }
      try? await Task.sleep(for: .milliseconds(100))
    }
    signedIn = clerk.session != nil || localWorkspace
  }
  func sendCode(email: String, password: String, creating: Bool) async {
    guard let clerk else {
      error = "Account sign-in is not configured in this build yet."
      return
    }
    await perform {
      if creating {
        self.signUp = try await clerk.auth.signUp(emailAddress: email, password: password)
        self.signUp = try await self.signUp?.sendEmailCode()
      } else {
        self.signIn = try await clerk.auth.signInWithEmailCode(emailAddress: email)
      }
      self.codeSent = true
    }
  }
  func verify(_ code: String, creating: Bool) async {
    await perform {
      if creating {
        self.signUp = try await self.signUp?.verifyEmailCode(code)
      } else {
        self.signIn = try await self.signIn?.verifyCode(code)
      }
      self.signedIn = self.clerk?.session != nil
      if !self.signedIn {
        self.error =
          "Sign-in needs another verification step. Complete your account's requirements and try again."
      }
    }
  }
  func social(apple: Bool) async {
    guard let clerk else {
      error = "Account sign-in is not configured in this build yet."
      return
    }
    await perform {
      if apple {
        _ = try await clerk.auth.signInWithApple()
      } else {
        _ = try await clerk.auth.signInWithOAuth(provider: .google)
      }
      self.signedIn = clerk.session != nil
    }
  }
  func signOut() async {
    await perform {
      if let clerk = self.clerk { try await clerk.auth.signOut() }
      self.signedIn = false
      self.localWorkspace = false
      UserDefaults.standard.removeObject(forKey: "PBJLocalWorkspace")
    }
  }
  func token() async throws -> String? {
    #if DEBUG
      if localWorkspace {
        if let error = MacConnection.shared.configurationError {
          throw NSError(domain: "PBJPairing", code: 1, userInfo: [NSLocalizedDescriptionKey: error])
        }
        return MacConnection.shared.pairing?.token
      }
    #endif
    return try await clerk?.auth.getToken()
  }
  func enterLocalWorkspace() {
    #if DEBUG
      localWorkspace = true
      signedIn = true
      UserDefaults.standard.set(true, forKey: "PBJLocalWorkspace")
    #endif
  }
  private func perform(_ operation: () async throws -> Void) async {
    busy = true
    error = nil
    defer { busy = false }
    do { try await operation() } catch { self.error = error.localizedDescription }
  }
}
