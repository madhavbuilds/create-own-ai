# Contributing

Thanks for helping make local AI easier to build with.

## Running it locally

```bash
git clone https://github.com/madhavbuilds/create-own-ai
cd create-own-ai
npm test                           # unit + end-to-end tests, no model needed
node bin/cli.js /tmp/test-app      # scaffold an app from your working copy
cd /tmp/test-app && npm run dev
```

The end-to-end tests start a scaffolded app against a fake Ollama server, so they run anywhere in a few seconds.

## Ground rules

- **Zero runtime dependencies.** Templates should run with plain Node.js and no `npm install`. If a feature truly needs a package, open an issue first.
- **Local only.** Nothing in a template may send user data off the machine. The only network call allowed by default is to the local model runtime (and the one-time model download).
- **Readable over clever.** People will learn from and edit these templates. Comments explain *why*.

## Adding a template

1. Create `templates/<name>/` with a `package.json` whose `name` is `{{PACKAGE_NAME}}`. Use `{{APP_NAME}}` anywhere else you want the app's name.
2. Name the git-ignore file `_gitignore` (npm strips `.gitignore` when publishing).
3. Register it in the `TEMPLATES` map in `bin/cli.js`.
4. Add a test in `test/`.

## Releasing

1. Bump `version` in `package.json` and add a section to `CHANGELOG.md`.
2. Publish a GitHub release. The `Publish to npm` workflow tests and publishes it (needs the `NPM_TOKEN` secret).
