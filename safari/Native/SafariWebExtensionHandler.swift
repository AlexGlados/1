import Foundation
import SafariServices
import UserNotifications

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private enum Action: String {
        case status, authorize, create, getAll, clear
    }

    private enum Status: String {
        case notDetermined, denied, disabled, authorized

        init(_ settings: UNNotificationSettings) {
            switch settings.authorizationStatus {
            case .notDetermined:
                self = .notDetermined
            case .denied:
                self = .denied
            case .authorized, .provisional:
                self = settings.alertSetting == .enabled || settings.notificationCenterSetting == .enabled
                    ? .authorized : .disabled
            default:
                self = .disabled
            }
        }

        var refusal: String {
            self == .disabled ? "notificationsDisabled" : "notAuthorized"
        }
    }

    func beginRequest(with context: NSExtensionContext) {
        guard let input = context.inputItems.first as? NSExtensionItem,
              let userInfo = input.userInfo,
              let payload = userInfo[SFExtensionMessageKey] as? [String: Any],
              let version = payload["version"] as? Int, version == 1,
              let name = payload["action"] as? String,
              let action = Action(rawValue: name) else {
            Self.complete(context, ["ok": false, "code": "invalidRequest"])
            return
        }

        let center = UNUserNotificationCenter.current()
        let namespace = Self.namespace(for: userInfo)
        switch action {
        case .status:
            Self.reportStatus(center, context)
        case .authorize:
            center.getNotificationSettings { settings in
                let status = Status(settings)
                guard status == .notDetermined else {
                    Self.complete(context, ["ok": true, "status": status.rawValue])
                    return
                }

                // Safari sends this command only from the explicit test control.
                center.requestAuthorization(options: [.alert, .sound]) { _, error in
                    Self.reportStatus(center, context, failed: error != nil)
                }
            }
        case .create:
            guard let id = Self.identifier(payload),
                  let title = Self.notificationText(payload["title"], limit: 240),
                  let body = Self.notificationText(payload["message"], limit: 800) else {
                Self.complete(context, ["ok": false, "code": "invalidRequest"])
                return
            }
            Self.post(center, context, id: id, namespace: namespace, title: title, body: body)
        case .getAll:
            Self.identifiers(center) { identifiers in
                let ids = identifiers.filter { $0.hasPrefix(namespace) }
                    .map { String($0.dropFirst(namespace.count)) }
                    .sorted()
                Self.complete(context, ["ok": true, "ids": ids])
            }
        case .clear:
            guard let id = Self.identifier(payload) else {
                Self.complete(context, ["ok": false, "code": "invalidRequest"])
                return
            }
            let key = namespace + id
            Self.identifiers(center) { identifiers in
                center.removePendingNotificationRequests(withIdentifiers: [key])
                center.removeDeliveredNotifications(withIdentifiers: [key])
                Self.complete(context, ["ok": true, "cleared": identifiers.contains(key)])
            }
        }
    }

    private static func post(
        _ center: UNUserNotificationCenter, _ context: NSExtensionContext,
        id: String, namespace: String, title: String, body: String
    ) {
        center.getNotificationSettings { settings in
            let status = Status(settings)
            guard status == .authorized else {
                Self.complete(context, ["ok": false, "code": status.refusal, "status": status.rawValue])
                return
            }

            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            let request = UNNotificationRequest(identifier: namespace + id, content: content, trigger: nil)
            center.add(request) { error in
                guard error == nil else {
                    Self.reportStatus(center, context, failed: true)
                    return
                }
                Self.complete(context, ["ok": true, "id": id])
            }
        }
    }

    private static func identifiers(_ center: UNUserNotificationCenter, complete: @escaping (Set<String>) -> Void) {
        center.getPendingNotificationRequests { pending in
            center.getDeliveredNotifications { delivered in
                complete(Set(pending.map(\.identifier) + delivered.map { $0.request.identifier }))
            }
        }
    }

    private static func reportStatus(_ center: UNUserNotificationCenter, _ context: NSExtensionContext, failed: Bool = false) {
        center.getNotificationSettings { settings in
            let status = Status(settings)
            if failed {
                Self.complete(context, ["ok": false, "code": status == .authorized ? "nativeError" : status.refusal,
                                   "status": status.rawValue])
            } else {
                Self.complete(context, ["ok": true, "status": status.rawValue])
            }
        }
    }

    private static func namespace(for userInfo: [AnyHashable: Any]) -> String {
        if #available(macOS 14.0, *), let profile = userInfo[SFExtensionProfileKey] as? UUID {
            return "shkolkovo.\(profile.uuidString.lowercased())."
        }
        return "shkolkovo.default."
    }

    private static func identifier(_ payload: [String: Any]) -> String? {
        guard let id = payload["id"] as? String, (1...160).contains(id.utf8.count),
              id.utf8.allSatisfy({ (48...57).contains($0) || (65...90).contains($0) ||
                  (97...122).contains($0) || [45, 46, 58, 95].contains($0) }) else { return nil }
        return id
    }

    private static func notificationText(_ value: Any?, limit: Int) -> String? {
        guard let value = value as? String, value.utf8.count <= 8_192 else { return nil }
        let text = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.isEmpty ? nil : String(text.prefix(limit))
    }

    private static func complete(_ context: NSExtensionContext, _ payload: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: payload]
        context.completeRequest(returningItems: [response], completionHandler: nil)
    }
}
