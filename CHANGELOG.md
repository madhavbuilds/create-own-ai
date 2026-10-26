# Changelog

## 1.0.0

First public release.

### CLI
- `npx create-own-ai <name>`, or `.` for the current folder
- Creates a git repo with a first commit (`--no-git` to skip)
- Checks whether Ollama is running and prints next steps for npm, pnpm, yarn or bun
- `--version`, `--help`, `--template`

### chat-files template
- Chat with PDF, DOCX, PPTX, Markdown, text, CSV and 50+ code file types
- Drop whole folders (skips `node_modules`, `.git`, build output and lock files)
- Cited answers: click a `[1]` marker or a source chip to read the passage
- Streaming with Stop (button or Esc), tokens/sec, copy and retry
- Reasoning models show their thinking in a collapsible panel instead of in the answer
- Model switcher listing your installed Ollama models
- Default model picked by RAM: `qwen3:4b-instruct`, `gemma3:12b` or `qwen3:30b-instruct`
- In-browser first-run setup with a model download progress bar
- One-click sample document
- Chat history kept across reloads, New chat button
- Blocks cross-site requests and DNS rebinding against the local server
- Finds a free port if 3000 is taken, opens the browser on start
- Light and dark mode, mobile layout
- Zero dependencies
