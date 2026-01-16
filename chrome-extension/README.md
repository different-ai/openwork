# OpenWork Chrome Extension

A Chrome extension that brings OpenWork's AI-powered task runner directly into your browser as a side panel.

## Features

- **Side Panel Integration**: Access OpenWork without leaving your current tab
- **Real-time Updates**: Live streaming of task progress via Server-Sent Events (SSE)
- **Session Management**: Create, view, and manage your OpenCode sessions
- **Template System**: Save and reuse common workflows
- **Permission Handling**: Approve or deny OpenCode permissions directly in the browser
- **Model Selection**: Choose your preferred AI model (Zen models work without setup)

## Prerequisites

- Google Chrome 114+ (with Side Panel support)
- OpenCode server running locally (`opencode serve`)
- Node.js 18+ (for building)

## Quick Start

### 1. Build the Extension

```bash
cd chrome-extension
npm install
npm run build
```

### 2. Load in Chrome

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `chrome-extension/dist` folder

### 3. Connect to OpenCode

1. Click the OpenWork icon in Chrome's toolbar
2. Enter your OpenCode server URL (default: `http://127.0.0.1:4096`)
3. Click "Connect"

## Development

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Type check
npm run typecheck
```

## Architecture

This extension is built with:
- **SolidJS**: Reactive UI framework
- **TailwindCSS**: Utility-first styling
- **Vite**: Fast build tool
- **Manifest V3**: Latest Chrome extension format

The extension operates in "Client" mode only, connecting to an existing OpenCode server rather than running one itself.

## Documentation

For detailed installation instructions and Chrome Web Store publishing guide, see [MANUAL.md](./MANUAL.md).

## License

Same as the main OpenWork project.
