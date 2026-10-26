#!/usr/bin/env node
// create-local-ai: copies a template into a new folder and prints next steps.
// Zero dependencies on purpose, so `npx create-local-ai` is instant.

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { execFileSync } = require('node:child_process');

const { version } = require('../package.json');

const TEMPLATES = {
  'chat-files': 'Chat with your files (PDFs, docs, notes, code; answers cite their sources)',
};

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { bold: paint(1), dim: paint(2), green: paint(32), red: paint(31), yellow: paint(33), cyan: paint(36) };

function parseArgs(argv) {
  const args = { name: null, template: null, git: true, unknown: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--template' || a === '-t') args.template = argv[++i];
    else if (a.startsWith('--template=')) args.template = a.slice('--template='.length);
    else if (a === '--no-git') args.git = false;
    else if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a.startsWith('-')) args.unknown.push(a);
    else if (!args.name) args.name = a;
  }
  return args;
}

function usage() {
  console.log(`
${c.bold('create-local-ai')} ${c.dim(`v${version}`)} - build AI apps that run 100% on your machine

Usage:
  npx create-local-ai ${c.cyan('<app-name>')} [options]
  npx create-local-ai ${c.cyan('.')}            ${c.dim('scaffold into the current (empty) folder')}

Options:
  -t, --template <name>   Template to use (default: chat-files)
      --no-git            Don't create a git repository
  -v, --version           Print the version
  -h, --help              Show this help

Templates:
${Object.entries(TEMPLATES).map(([k, v]) => `  ${c.cyan(k.padEnd(12))} ${v}`).join('\n')}
`);
}

// Which package manager ran us, so next steps match what the user typed.
function packageManager() {
  const agent = process.env.npm_config_user_agent || '';
  if (agent.startsWith('pnpm')) return { name: 'pnpm', run: 'pnpm dev' };
  if (agent.startsWith('yarn')) return { name: 'yarn', run: 'yarn dev' };
  if (agent.startsWith('bun')) return { name: 'bun', run: 'bun run dev' };
  return { name: 'npm', run: 'npm run dev' };
}

function copyTemplate(src, dest, vars) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    // npm strips .gitignore from published packages, so templates ship it as _gitignore.
    const to = path.join(dest, entry.name === '_gitignore' ? '.gitignore' : entry.name);
    if (entry.isDirectory()) {
      copyTemplate(from, to, vars);
    } else {
      let text = fs.readFileSync(from, 'utf8');
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{{${k}}}`, v);
      fs.writeFileSync(to, text);
    }
  }
}

// A git repo with one commit, like create-next-app. Skipped quietly if git is missing or not set up.
function initGit(dir) {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, stdio: 'ignore' });
    return false; // already inside a repo: don't nest one
  } catch {
    // not inside a repo (or no git), carry on
  }
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'Initial commit from create-local-ai'], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    return false;
  }
}

async function ollamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    const { models = [] } = await res.json();
    return { running: true, models: models.length };
  } catch {
    return { running: false };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.version) return console.log(version);
  if (args.help) return usage();
  if (args.unknown.length) console.log(c.yellow(`Ignoring unknown option${args.unknown.length > 1 ? 's' : ''}: ${args.unknown.join(' ')}`));

  console.log(`\n${c.bold('create-local-ai')} ${c.dim('- private, offline, free')}\n`);

  const interactive = process.stdin.isTTY;
  const rl = interactive ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    let name = args.name;
    if (!name) name = interactive ? (await rl.question(`App name ${c.dim('(my-local-ai-app)')}: `)).trim() : '';
    name = name || 'my-local-ai-app';

    const here = name === '.';
    const dest = path.resolve(process.cwd(), name);
    const appName = here ? path.basename(dest) : name;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(appName)) {
      console.error(c.red(`"${appName}" is not a valid name. Use letters, numbers, ".", "-" and "_".`));
      process.exit(1);
    }

    let template = args.template;
    if (!template) {
      const keys = Object.keys(TEMPLATES);
      if (keys.length === 1 || !interactive) {
        template = keys[0];
      } else {
        keys.forEach((k, i) => console.log(`  ${i + 1}. ${c.cyan(k)} ${c.dim(TEMPLATES[k])}`));
        const pick = parseInt(await rl.question('Template [1]: '), 10) || 1;
        template = keys[pick - 1] || keys[0];
      }
    }
    if (!TEMPLATES[template]) {
      console.error(c.red(`Unknown template "${template}".`));
      usage();
      process.exit(1);
    }

    // Harmless leftovers that shouldn't block scaffolding into a folder.
    const ignorable = new Set(['.DS_Store', '.git', 'Thumbs.db', '.idea', '.vscode']);
    if (fs.existsSync(dest) && fs.readdirSync(dest).some((f) => !ignorable.has(f))) {
      console.error(c.red(`Folder ${here ? 'here' : name} already exists and is not empty.`));
      console.error(c.dim('Pick a new name, or empty the folder first.'));
      process.exit(1);
    }

    copyTemplate(path.join(__dirname, '..', 'templates', template), dest, {
      APP_NAME: appName,
      PACKAGE_NAME: appName.toLowerCase().replace(/^[._]+/, ''),
    });
    const git = args.git && initGit(dest);

    const pm = packageManager();
    const ollama = await ollamaStatus();

    console.log(`${c.green('✔')} Created ${c.bold(appName)} ${c.dim(`in ${dest}`)}`);
    if (git) console.log(`${c.green('✔')} Initialized a git repository`);
    if (ollama.running) console.log(`${c.green('✔')} Ollama is running`);
    else console.log(`${c.yellow('!')} Ollama isn't running. Get it free at ${c.cyan('https://ollama.com/download')} ${c.dim('(the app will remind you)')}`);

    console.log('\nNext steps:');
    if (!here) console.log(`  ${c.cyan(`cd ${name}`)}`);
    console.log(`  ${c.cyan(pm.run)}`);
    console.log(`\n${c.dim('No install step needed. Your browser opens at http://localhost:3000.')}`);
    console.log(c.dim('Files and chats never leave your computer.\n'));
  } finally {
    rl?.close();
  }
}

main().catch((err) => {
  if (err.code === 'ABORT_ERR') process.exit(130); // Ctrl+C at a prompt
  console.error(c.red(err.message));
  process.exit(1);
});
