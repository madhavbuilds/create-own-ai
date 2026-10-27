const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChatStore } = require('../templates/chat-files/lib/chats');

test('creates, lists, reloads and deletes chats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cla-chats-'));
  const store = new ChatStore(dir);
  const a = store.create({ title: 'First' });
  const b = store.create();
  b.messages.push({ role: 'user', content: 'hi' });
  store.save(b);
  assert.deepEqual(store.list().map((c) => [c.title, c.count]), [['New chat', 1], ['First', 0]]);

  fs.writeFileSync(path.join(dir, 'chats', 'broken.json'), '{nope');
  const reloaded = new ChatStore(dir);
  assert.equal(reloaded.get(b.id).messages[0].content, 'hi');
  assert.equal(reloaded.get('../../etc'), null);
  assert.ok(reloaded.remove(a.id));
  assert.equal(new ChatStore(dir).list().length, 1);
});
