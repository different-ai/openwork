import OpenWorkKit
import SwiftUI

/// The conversation with Workbot: what was said, the answer as it arrives, and a place to write.
struct ChatView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var showingAccount = false
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var sentCount = 0
    @FocusState private var writing: Bool

    private var chat: ChatModel {
        model.chat
    }

    var body: some View {
        NavigationStack {
            content
                // The composer is a bar the system knows about, so the conversation fades under it.
                .safeAreaBar(edge: .bottom) { composer }
                .scrollEdgeEffectStyle(.soft, for: .bottom)
                .navigationTitle("Workbot")
                .navigationSubtitle(model.me?.organizationName ?? "")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Account", systemImage: "person.crop.circle") { showingAccount = true }
                            .accessibilityIdentifier("account-button")
                    }
                }
                .sheet(isPresented: $showingAccount) { AccountView() }
        }
        .sensoryFeedback(.impact(weight: .light), trigger: sentCount)
        .sensoryFeedback(.error, trigger: chat.sendProblems.count) { old, new in new > old }
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
            ContentUnavailableView {
                Label(offline ? "You're Offline" : "Couldn't Load Your Conversation", systemImage: offline ? "wifi.slash" : "exclamationmark.bubble")
            } actions: {
                Button("Try Again") {
                    Task { await chat.load() }
                }
                .buttonStyle(.bordered)
            }
            .accessibilityIdentifier("chat-message")
        case let .unavailable(reason):
            ContentUnavailableView {
                Label("Workbot Is Unavailable", systemImage: "moon.zzz")
            } description: {
                Text(Wording.unavailable(reason))
            } actions: {
                Button("Check Again") {
                    Task { await chat.load() }
                }
                .buttonStyle(.bordered)
            }
            .accessibilityIdentifier("chat-message")
        case .ready:
            conversation
        }
    }

    private var conversation: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 22) {
                if chat.turns.isEmpty {
                    intro
                }
                ForEach(chat.turns) { turn in
                    TurnView(turn: turn, send: send)
                }
                if chat.connectionLost {
                    Label("Can't reach Workbot. Trying again…", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("connection-lost")
                }
            }
            .padding(.horizontal, Layout.gutter)
            .padding(.vertical, 16)
        }
        .scrollPosition($position)
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        .onChange(of: chat.turns.count) { position.scrollTo(edge: .bottom) }
    }

    /// The first open: who this is and a few things to try.
    private var intro: some View {
        VStack(alignment: .leading, spacing: 12) {
            MarkView(size: 56)
            Text("Hi\(firstName.isEmpty ? "" : " \(firstName)"), I'm Workbot.")
                .font(.title2.bold())
                .accessibilityIdentifier("chat-intro")
            Text("Ask me about your work, or hand me something to do.")
                .font(.body)
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(["What can you do?", "Help me plan my day", "Draft a message for me"], id: \.self) { starter in
                    Button(starter) { send(starter) }
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .padding(.top, 6)
        }
        .padding(.top, 24)
    }

    /// The field and its one button float over the conversation as glass, the way the system's own bars do.
    private var composer: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message Workbot", text: $draft, axis: .vertical)
                    .lineLimit(1 ... 6)
                    .focused($writing)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .glassEffect(.regular.interactive(), in: .rect(cornerRadius: Layout.composerRadius))
                    .accessibilityIdentifier("composer-field")
                if chat.isBusy, trimmedDraft.isEmpty {
                    Button("Stop", systemImage: "stop.fill") {
                        Task { await chat.stop() }
                    }
                    .buttonStyle(.glass)
                    .disabled(chat.isStopping)
                    .accessibilityIdentifier("stop-button")
                } else {
                    Button("Send", systemImage: "arrow.up") { send(draft) }
                        .buttonStyle(.glassProminent)
                        .foregroundStyle(Color(.systemBackground))
                        .disabled(trimmedDraft.isEmpty || chat.state != .ready)
                        .accessibilityIdentifier("send-button")
                }
            }
            .labelStyle(.iconOnly)
            .buttonBorderShape(.circle)
            .controlSize(.large)
            .fontWeight(.semibold)
        }
        .padding(.horizontal, Layout.gutter)
        .padding(.vertical, 8)
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
        sentCount += 1
        Task { await chat.send(text) }
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
                problemLine(Wording.sendProblem(problem), action: "Send Again") {
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
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(.fill.tertiary, in: .rect(cornerRadius: Layout.bubbleRadius))
                .textSelection(.enabled)
                .accessibilityLabel(Text("You: \(turn.text)"))
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
                    ShareLink(item: answer)
                    Button("Report This Answer", systemImage: "flag") {
                        openURL(Links.support(subject: "Report a Workbot answer", body: "Answer reference: \(turn.id)\n\nWhat was wrong with it:\n"))
                    }
                }
        }
        switch turn.status {
        case .queued:
            note(String(localized: "Up next"))
        case .working:
            if answer.isEmpty || live?.working == true {
                Label("Working…", systemImage: "ellipsis")
                    .symbolEffect(.variableColor.iterative, options: .repeat(.continuous))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("working")
            }
        case .stopped:
            note(String(localized: "Stopped"))
        case .failed:
            if let issue = turn.modelIssue {
                problemLine(Wording.modelIssue(issue), action: nil, perform: {})
            } else {
                problemLine(turn.error ?? String(localized: "Workbot couldn't answer that."), action: turn.retryable ? "Try Again" : nil) {
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
                    Button(suggestion) { send(suggestion) }
                }
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(.secondary)
    }

    private func problemLine(_ text: String, action: LocalizedStringKey?, perform: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(text, systemImage: "exclamationmark.circle")
                .font(.callout)
                .foregroundStyle(.red)
            if let action {
                Button(action, action: perform)
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
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
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case let .paragraph(text):
            Text(Markdown.inline(text)).font(.body).textSelection(.enabled)
        case let .heading(level, text):
            Text(Markdown.inline(text))
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .accessibilityAddTraits(.isHeader)
        case let .bullet(text, depth):
            listItem("•", text, depth: depth)
        case let .numbered(marker, text, depth):
            listItem(marker, text, depth: depth)
        case let .quote(text):
            Text(Markdown.inline(text))
                .font(.body)
                .foregroundStyle(.secondary)
                .padding(.leading, 12)
                .overlay(alignment: .leading) { Capsule().fill(.separator).frame(width: 3) }
        case let .code(text):
            ScrollView(.horizontal) {
                Text(text).font(.callout.monospaced()).textSelection(.enabled).padding(12)
            }
            .background(.fill.quaternary, in: .rect(cornerRadius: 12))
        case .rule:
            Divider()
        }
    }

    private func listItem(_ marker: String, _ text: String, depth: Int) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(marker).font(.body).foregroundStyle(.secondary)
            Text(Markdown.inline(text)).font(.body).textSelection(.enabled)
        }
        .padding(.leading, CGFloat(min(depth, 4)) * 16)
    }
}
