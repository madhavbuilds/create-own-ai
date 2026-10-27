// Saved conversations: one JSON file per chat in ./data/chats. Plain files you can read,
// back up or delete, and they don't depend on which browser or port you open the app in.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = /^[a-z0-9]{6,32}$/;

class ChatStore {
  constructor(dir) {
    this.dir = path.join(dir, 'chats');
    fs.mkdirSync(this.dir, { recursive: true });
    this.chats = new Map();
    for (const f of fs.readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const chat = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (ID.test(chat.id) && Array.isArray(chat.messages)) this.chats.set(chat.id, chat);
      } catch {
        // skip a damaged file rather than refusing to start
      }
    }
  }

  // Newest first, without the messages (for the sidebar).
  list() {
    return [...this.chats.values()]
      .map(({ id, title, created, updated, messages }) => ({ id, title: title || 'New chat', created, updated, count: messages.length }))
      .sort((a, b) => b.updated - a.updated);
  }

  get(id) {
    return ID.test(String(id)) ? this.chats.get(id) || null : null;
  }

  create({ title = '', messages = [] } = {}) {
    const now = Date.now();
    const chat = { id: now.toString(36) + crypto.randomBytes(4).toString('hex'), title, created: now, updated: now, messages };
    this.chats.set(chat.id, chat);
    this.save(chat);
    return chat;
  }

  save(chat) {
    chat.updated = Date.now();
    const file = path.join(this.dir, `${chat.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(chat));
    fs.renameSync(`${file}.tmp`, file);
  }

  remove(id) {
    if (!this.get(id)) return false;
    this.chats.delete(id);
    fs.rmSync(path.join(this.dir, `${id}.json`), { force: true });
    return true;
  }
}

module.exports = { ChatStore };
