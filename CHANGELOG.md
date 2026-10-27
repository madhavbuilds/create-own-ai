# Changelog

## 1.1.0

### Chat history
- Chats are saved on disk (`data/chats/`, one JSON file each) instead of in the browser, so they survive a different port or browser
- Sidebar with all chats grouped by date, search, rename (sidebar or title bar), and delete with undo
- Each new chat gets a short title written by the model
- Edit a question or regenerate the last answer; the chat is cut back and asked again
- The URL points at the open chat, so reload and the back button work
- A chat from 1.0 (browser storage) is moved over automatically

### Better answers in long chats
- Follow-ups stay on the same document: the previous question re-ranks passages, and files used in the last answer are favored
- A question that names a file ("what does the car insurance cover?") only looks in that file
- Weak matches from unrelated files are left out, which was the main cause of answers mixing documents
- The model's context window is set to 8,192 tokens (`NUM_CTX`); Ollama's 4,096 default silently dropped earlier turns
- Earlier answers are sent without their `[n]` markers and long ones are shortened, so stale citations don't confuse the model
- Search matches word forms ("payments" finds "payment"); older indexes are upgraded on load

### Interface
- Redesigned layout: chats and files tabs, rounded composer with an attach button, drop files anywhere
- "Searching your files / Reading lease.md…" while the model starts, then a typing caret
- Copy buttons on code blocks, copy and edit on questions, a scroll-to-latest button
- Source viewer highlights the words from your question
- Collapsible sidebar on desktop, Ctrl/⌘+Shift+O for a new chat, `/` to focus the input
- Fixes a bug where sending a follow-up right after an answer could leave the new answer stuck

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
