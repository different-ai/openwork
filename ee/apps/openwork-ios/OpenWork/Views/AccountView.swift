import OpenWorkKit
import SwiftUI

/// Who is signed in, how Workbot uses AI, how to reach OpenWork, and the way out.
struct AccountView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirmingSignOut = false

    var body: some View {
        NavigationStack {
            Form {
                if let me = model.me {
                    Section {
                        LabeledContent("Name", value: me.name)
                        LabeledContent("Email", value: me.email)
                        LabeledContent("Workspace", value: me.organizationName)
                    }
                }
                Section {
                    NavigationLink {
                        ScrollView {
                            AIUseText().padding(24)
                        }
                        .navigationTitle("How Workbot Uses AI")
                        .navigationBarTitleDisplayMode(.inline)
                    } label: {
                        Label("How Workbot Uses AI", systemImage: "sparkles")
                    }
                    Link(destination: Links.privacy) { Label("Privacy Policy", systemImage: "hand.raised") }
                    Link(destination: Links.terms) { Label("Terms", systemImage: "doc.text") }
                    Link(destination: Links.support(subject: "OpenWork for iPhone")) { Label("Contact Support", systemImage: "envelope") }
                    Link(destination: Links.support(subject: "Report a problem with Workbot")) { Label("Report a Problem", systemImage: "flag") }
                } footer: {
                    Text("To report one of Workbot's answers, touch and hold it in the conversation.")
                }
                Section {
                    Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmingSignOut = true }
                        .foregroundStyle(.red)
                        .accessibilityIdentifier("sign-out-button")
                        // Attached to the row, so the confirmation comes from the control that asked for it.
                        .confirmationDialog("Sign out of OpenWork?", isPresented: $confirmingSignOut, titleVisibility: .visible) {
                            Button("Sign Out", role: .destructive) {
                                dismiss()
                                Task { await model.signOut() }
                            }
                        }
                } footer: {
                    Text("OpenWork \(version)")
                }
            }
            .formStyle(.grouped)
            .navigationTitle("Account")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(role: .close) { dismiss() }
                        .accessibilityIdentifier("account-close")
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
