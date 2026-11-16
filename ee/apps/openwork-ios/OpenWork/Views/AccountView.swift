import OpenWorkKit
import SwiftUI

/// Who is signed in, how Workbot uses AI, how to reach OpenWork, and the way out.
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            List {
                if let me = model.me {
                    Section {
                        LabeledContent("Name", value: me.name)
                        LabeledContent("Email", value: me.email)
                        LabeledContent("Workspace", value: me.organizationName)
                    }
                }
                Section {
                    NavigationLink("How Workbot uses AI") {
                        ScrollView {
                            AIUseText().padding(24)
                        }
                        .background(Theme.background)
                        .navigationTitle("How Workbot uses AI")
                        .navigationBarTitleDisplayMode(.inline)
                    }
                    Link("Privacy Policy", destination: Links.privacy)
                    Link("Terms", destination: Links.terms)
                    Link("Contact support", destination: Links.support(subject: "OpenWork for iPhone"))
                    Link("Report a problem", destination: Links.support(subject: "Report a problem with Workbot"))
                } footer: {
                    Text("To report one of Workbot's answers, touch and hold it in the conversation.")
                }
                Section {
                    Button("Sign out", role: .destructive) { confirmingSignOut = true }
                        .accessibilityIdentifier("sign-out-button")
                } footer: {
                    Text("OpenWork \(version)")
                }
            }
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .confirmationDialog("Sign out of OpenWork?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    dismiss()
                    Task { await model.signOut() }
                }
            }
        }
    }

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? ""
        let build = info?["CFBundleVersion"] as? String ?? ""
        return build.isEmpty ? short : "\(short) (\(build))"
    }
}
