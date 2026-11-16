import OpenWorkKit
import SwiftUI

/// The conversation with Workbot: what was said, the answer as it arrives, and a place to write.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var showingAccount = false
    @State private var position = ScrollPosition(edge: .bottom)
    @FocusState private var writing: Bool

    private var chat: ChatModel {
        model.chat
    }

    var body: some View {
        NavigationStack {
            content
                .background(Theme.background)
                .safeAreaInset(edge: .bottom, spacing: 0) { composer }
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 0) {
                            Text("Workbot").font(.headline).foregroundStyle(Theme.ink)
                            if let organization = model.me?.organizationName, !organization.isEmpty {
                                Text(organization).font(.caption).foregroundStyle(Theme.muted)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Account", systemImage: "person.crop.circle") { showingAccount = true }
                            .accessibilityIdentifier("account-button")
                    }
                }
                .sheet(isPresented: $showingAccount) { AccountView() }
        }
        .onAppear { chat.activate() }
        .onDisappear { chat.deactivate() }
        // Live updates run only while the app is in front; coming back reads once and listens again.
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                chat.activate()
            } else if phase == .background {
                chat.deactivate()
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch chat.state {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case let .failed(offline):
            message(offline ? "You're offline." : "Couldn't load your conversation.", action: "Try again") {
                Task { await chat.load() }
            }
        case let .unavailable(reason):
            message(LocalizedStringKey(Wording.unavailable(reason)), action: "Check again") {
                Task { await chat.load() }
            }
        case .ready:
            conversation
        }
    }

    private var conversation: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 20) {
                if chat.turns.isEmpty {
                    intro
                }
                ForEach(chat.turns) { turn in
                    TurnView(turn: turn, send: send)
                }
                if chat.connectionLost {
                    Label("Can't reach Workbot. Trying again…", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(Theme.muted)
                        .accessibilityIdentifier("connection-lost")
                }
            }
            .padding(.horizontal, Theme.gutter)
            .padding(.vertical, 16)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: chat.turns.count) { position.scrollTo(edge: .bottom) }
    }

    /// The first open: who this is and a few things to try.
    private var intro: some View {
        VStack(alignment: .leading, spacing: 14) {
            Image("Mark")
                .resizable()
                .frame(width: 56, height: 56)
                .clipShape(.rect(cornerRadius: 13))
                .accessibilityHidden(true)
            Text("Hi\(firstName.isEmpty ? "" : " \(firstName)"), I'm Workbot.")
                .font(.title2.bold())
                .foregroundStyle(Theme.ink)
                .accessibilityIdentifier("chat-intro")
            Text("Ask me about your work, or hand me something to do.")
                .font(.body)
                .foregroundStyle(Theme.muted)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(["What can you do?", "Help me plan my day", "Draft a message for me"], id: \.self) { starter in
                    Button(starter) { send(starter) }
                        .buttonStyle(ChipStyle())
                }
            }
            .padding(.top, 4)
        }
        .padding(.top, 24)
    }

    private var composer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message Workbot", text: $draft, axis: .vertical)
                .lineLimit(1 ... 6)
                .focused($writing)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.surface, in: .rect(cornerRadius: 22))
                .overlay { RoundedRectangle(cornerRadius: 22).stroke(Theme.hairline) }
                .accessibilityIdentifier("composer-field")
            if chat.isBusy, trimmedDraft.isEmpty {
                Button("Stop", systemImage: "stop.fill") {
                    Task { await chat.stop() }
                }
                .buttonStyle(RoundButtonStyle())
                .disabled(chat.isStopping)
                .accessibilityIdentifier("stop-button")
            } else {
                Button("Send", systemImage: "arrow.up") { send(draft) }
                    .buttonStyle(RoundButtonStyle())
                    .disabled(trimmedDraft.isEmpty || chat.state != .ready)
                    .accessibilityIdentifier("send-button")
            }
        }
        .padding(.horizontal, Theme.gutter)
        .padding(.vertical, 8)
        .background(Theme.background)
    }

    private var trimmedDraft: String {
        draft.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var firstName: String {
        model.me?.name.split(separator: " ").first.map(String.init) ?? ""
    }

    private func send(_ text: String) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        if text == trimmedDraft {
            draft = ""
        }
        Task { await chat.send(text) }
    }

    private func message(_ title: LocalizedStringKey, action: LocalizedStringKey, perform: @escaping () -> Void) -> some View {
        VStack(spacing: 12) {
            Text(title)
                .font(.body)
                .foregroundStyle(Theme.text)
                .multilineTextAlignment(.center)
            Button(action, action: perform).buttonStyle(.bordered)
        }
        .padding(.horizontal, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityIdentifier("chat-message")
    }
}

/// One message and Workbot's answer to it.
struct TurnView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let turn: Turn
    let send: (String) -> Void

    private var chat: ChatModel {
        model.chat
    }

    private var live: LiveAnswer? {
        turn.status.isActive ? chat.live[turn.id] : nil
    }

    private var answer: String {
        live?.display ?? turn.answerText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !turn.greeting {
                question
            }
            if let problem = chat.sendProblems[turn.id] {
                problemLine(Wording.sendProblem(problem), action: "Send again") {
                    Task {
                        if chat.isUnsent(turn) {
                            await chat.sendAgain(turn)
                        } else {
                            await chat.retry(turn)
                        }
                    }
                }
            } else if !chat.isUnsent(turn) || turn.status != .failed {
                reply
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var question: some View {
        VStack(alignment: .trailing, spacing: 4) {
            Text(turn.text)
                .font(.body)
                .foregroundStyle(Theme.text)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.userBubble, in: .rect(cornerRadius: Theme.bubbleRadius))
                .textSelection(.enabled)
            if !turn.attachments.isEmpty {
                note(String(localized: "Sent with \(turn.attachments.map(\.name).formatted(.list(type: .and)))"))
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .padding(.leading, 44)
    }

    @ViewBuilder private var reply: some View {
        if !turn.workLabels.isEmpty {
            note(String(localized: "Used \(turn.workLabels.prefix(4).formatted(.list(type: .and)))"))
        }
        if !answer.isEmpty {
            MarkdownText(source: answer)
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") { UIPasteboard.general.string = answer }
                    Button("Report this answer", systemImage: "flag") {
                        openURL(Links.support(subject: "Report a Workbot answer", body: "Answer reference: \(turn.id)\n\nWhat was wrong with it:\n"))
                    }
                }
        }
        switch turn.status {
        case .queued:
            note(String(localized: "Up next"))
        case .working:
            if answer.isEmpty || live?.working == true {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Working…").font(.callout).foregroundStyle(Theme.muted)
                }
                .accessibilityIdentifier("working")
            }
        case .stopped:
            note(String(localized: "Stopped"))
        case .failed:
            if let issue = turn.modelIssue {
                problemLine(Wording.modelIssue(issue), action: nil, perform: {})
            } else {
                problemLine(turn.error ?? String(localized: "Workbot couldn't answer that."), action: turn.retryable ? "Try again" : nil) {
                    Task { await chat.retry(turn) }
                }
            }
        case .done:
            EmptyView()
        }
        ForEach(turn.tasks.filter(\.isRunning)) { task in
            note(String(localized: "Working in the background: \(task.title)"))
        }
        if !turn.outputs.isEmpty {
            note(String(localized: "Made \(turn.outputs.map(\.name).formatted(.list(type: .and))). Open Workbot on the web to see files."))
        }
        if turn.greeting, !turn.suggestions.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(turn.suggestions, id: \.self) { suggestion in
                    Button(suggestion) { send(suggestion) }.buttonStyle(ChipStyle())
                }
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Theme.muted)
    }

    private func problemLine(_ text: String, action: LocalizedStringKey?, perform: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(text).font(.callout).foregroundStyle(Theme.danger)
            if let action {
                Button(action, action: perform).font(.callout.weight(.semibold))
            }
        }
        .accessibilityIdentifier("turn-problem")
    }
}

/// An answer drawn natively from its Markdown: no web view, and only web and mail links can be opened.
struct MarkdownText: View {
    let source: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Markdown.blocks(source).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
        .foregroundStyle(Theme.text)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case let .paragraph(text):
            Text(Markdown.inline(text)).font(.body).textSelection(.enabled)
        case let .heading(level, text):
            Text(Markdown.inline(text)).font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
        case let .bullet(text, depth):
            listItem("•", text, depth: depth)
        case let .numbered(marker, text, depth):
            listItem(marker, text, depth: depth)
        case let .quote(text):
            Text(Markdown.inline(text))
                .font(.body)
                .foregroundStyle(Theme.muted)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Rectangle().fill(Theme.hairline).frame(width: 3) }
        case let .code(text):
            ScrollView(.horizontal) {
                Text(text).font(.callout.monospaced()).textSelection(.enabled).padding(12)
            }
            .background(Theme.chip, in: .rect(cornerRadius: 10))
        case .rule:
            Divider()
        }
    }

    private func listItem(_ marker: String, _ text: String, depth: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).font(.body).foregroundStyle(Theme.muted)
            Text(Markdown.inline(text)).font(.body).textSelection(.enabled)
        }
        .padding(.leading, CGFloat(min(depth, 4)) * 16)
    }
}

struct ChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout)
            .foregroundStyle(Theme.text)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Theme.chip, in: .capsule)
            .opacity(configuration.isPressed ? 0.6 : 1)
    }
}

struct RoundButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .labelStyle(.iconOnly)
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .frame(width: 40, height: 40)
            .background(isEnabled ? Theme.ink : Theme.muted.opacity(0.4), in: .circle)
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
