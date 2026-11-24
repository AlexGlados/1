import SafariServices
import SwiftUI

@main
struct ShkolkovoSafariApp: App {
    var body: some Scene {
        WindowGroup("Школково для Safari") {
            ExtensionSetupView()
        }
        .defaultSize(width: 490, height: 235)
    }
}

private struct ExtensionSetupView: View {
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Школково для Safari")
                .font(.title.bold())
            Text("Включи расширение в Safari и открой чаты Школково. При первом запуске введи имя и фамилию куратора в меню расширения, затем запусти мониторинг.")
                .fixedSize(horizontal: false, vertical: true)
            Button("Открыть настройки расширения") {
                guard let identifier = Bundle.main.bundleIdentifier else { return }
                SFSafariApplication.showPreferencesForExtension(withIdentifier: identifier + ".Extension") { failure in
                    let failed = failure != nil
                    DispatchQueue.main.async {
                        error = failed ? "Открой Safari → Настройки → Расширения и включи «Школково»." : nil
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            if let error {
                Text(error).foregroundStyle(.secondary)
            }
        }
        .frame(minWidth: 390, minHeight: 180, maxHeight: .infinity, alignment: .topLeading)
        .padding(28)
    }
}
