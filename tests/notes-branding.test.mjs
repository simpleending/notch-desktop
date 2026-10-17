import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshBuiltinWelcomeNotes, welcomeNote } from '../src/notes-branding.mjs';
function seed(chinese = false) {
  const text = chinese ? '这是你的第一条速记 🌲。\n\n先记下脑海里那些还没准备发送的内容——一个决定、一条线索，或一件待跟进的事……\n\nCatch it before it slips.' : "This is your first Quick Note 🌲.\n\nKeep what's already on your mind but not quite ready to send — a decision, a clue, or something to follow up on...\n\nCatch it before it slips.";
  const underline = chinese ? '还没准备发送的' : 'not quite ready to send', tail = text.indexOf('Catch it before it slips.');
  return { id: 'seed', origin: 'onboarding', text, richText: { version: 1, entities: [], marks: [
    { type: 'bold', start: 0, end: text.indexOf('\n\n') }, { type: 'italic', start: tail, end: text.length },
    { type: 'underline', tone: 'yellow', start: text.indexOf(underline), end: text.indexOf(underline) + underline.length }, { type: 'font_serif', start: tail, end: text.length },
  ] }, attachments: [{ id: 'quick-note-onboarding-first-note', name: 'firstnote.webp', mimeType: 'image/webp', size: 561096, data: Buffer.alloc(561096).toString('base64') }] };
}
test('unchanged English and Chinese built-in samples migrate through the save API, never in place', async t => {
  t.mock.method(crypto.subtle, 'digest', async (algorithm, bytes) => {
    assert.equal(algorithm, 'SHA-256'); assert.equal(bytes.length, 561096);
    return Buffer.from('19422e970e2fb5969c1be6916fddd56129c047f4b2d73eca0d413e2007a7a2bf', 'hex');
  });
  for (const chinese of [false, true]) {
    const original = seed(chinese), copy = structuredClone(original); let writes = 0;
    const result = await refreshBuiltinWelcomeNotes([original], async input => { writes++; return { ...original, ...input }; });
    assert.equal(writes, 1); assert.equal(result[0].text, welcomeNote.text); assert.deepEqual(result[0].attachments, []); assert.deepEqual(original, copy);
    assert.doesNotMatch(result[0].text, /\p{Extended_Pictographic}/u);
    assert.deepEqual(await refreshBuiltinWelcomeNotes(result, () => assert.fail('Migrated twice')), result);
  }
});
test('personal, text-edited, format-edited and image-edited notes are preserved', async () => {
  const mutations = [note => { note.origin = 'manual'; }, note => { note.text += ' My edit'; }, note => { note.richText.marks[0].end--; }, note => { note.richText.entities.push({ type: 'link' }); }, note => { note.attachments[0].id = 'personal-image'; }, note => { note.attachments.push({ name: 'my-photo.png' }); }, note => { note.richText.marks = { length: 4 }; }, () => {}];
  for (const mutate of mutations) {
    const note = seed(); mutate(note); const copy = structuredClone(note);
    const result = await refreshBuiltinWelcomeNotes([note], () => assert.fail('Personal content was overwritten'));
    assert.deepEqual(result, [copy]); assert.deepEqual(note, copy);
  }
});
test('a failed sample save propagates the error without mutating the original note', async t => {
  t.mock.method(crypto.subtle, 'digest', async () => Buffer.from('19422e970e2fb5969c1be6916fddd56129c047f4b2d73eca0d413e2007a7a2bf', 'hex'));
  const note = seed(), copy = structuredClone(note);
  await assert.rejects(refreshBuiltinWelcomeNotes([note], async () => { throw new Error('Disk full'); }), /Disk full/);
  assert.deepEqual(note, copy);
});
