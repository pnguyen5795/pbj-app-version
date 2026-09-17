import SwiftUI

@main
struct PBJApp: App {
  @UIApplicationDelegateAdaptor(PBJAppDelegate.self) private var delegate
  @StateObject private var editor = EditorModel()
  @StateObject private var application = ApplicationModel()
  @StateObject private var authentication = AuthenticationModel()
  @StateObject private var mediaImport = MediaImportProgress()
  var body: some Scene {
    WindowGroup {
      ApplicationView().environmentObject(editor).environmentObject(application).environmentObject(
        authentication
      ).environmentObject(mediaImport).preferredColorScheme(.light)
    }
  }
}
