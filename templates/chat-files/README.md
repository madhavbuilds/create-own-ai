# {{APP_NAME}}

Chat with your files, 100% on your machine. Made with [create-own-ai](https://github.com/madhavbuilds/create-own-ai).

## Run it

```bash
npm run dev
```

Your browser opens at http://localhost:3000. If Ollama or the model is missing, the page shows you what to do.

## How it works

1. You drop files (or whole folders) in the browser. PDFs, Word and PowerPoint files are turned into text by `lib/extract.js`; everything is split into chunks and indexed by the local server.
2. When you ask a question, `lib/search.js` finds the most relevant chunks with BM25 keyword search. Broad questions like "summarize my files" get an overview of your most recent files instead.
3. Those chunks go to the local model through Ollama (`lib/ollama.js`), which streams back an answer citing them as `[1]`, `[2]`...

Your files are indexed in `data/index.json`. Delete that folder to start fresh. Chats are kept in your browser's local storage; "New chat" clears them.

## Customize

- **Change the personality or rules:** edit `SYSTEM_PROMPT` in `server.js`.
- **Use a different model:** pick one from the menu at the top, run `MODEL=llama3.2:3b npm run dev`, or change `pickModel()` in `lib/ollama.js`.
- **Change the look:** everything is in `public/style.css`. The colors are at the top.
- **Change the sample document:** replace the file in `samples/`.
- **Support another file type:** add a reader to `extractText()` in `lib/extract.js` and its extension to `DOC_EXT` in `public/app.js`.

## Settings

| Variable | Default | |
|---|---|---|
| `MODEL` | picked by your RAM | any model from `ollama list` |
| `PORT` | 3000 (or the next free port) | |
| `NO_OPEN` | unset | set to `1` to not open the browser |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |

## Privacy

The server only listens on `127.0.0.1`, so nothing else on your network can reach it, and it rejects requests from other websites. The only thing it talks to is Ollama on this machine.
