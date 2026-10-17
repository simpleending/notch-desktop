export const welcomeNote = {
  text: 'Keep notes with notch.\n\nSave ideas, decisions, and details. Attach a note to a task when you want notch to use it.',
  richText: { version: 1, marks: [], entities: [] },
};
const legacyWelcome = new Set([
  "This is your first Quick Note 🌲.\n\nKeep what's already on your mind but not quite ready to send — a decision, a clue, or something to follow up on...\n\nCatch it before it slips.",
  '这是你的第一条速记 🌲。\n\n先记下脑海里那些还没准备发送的内容——一个决定、一条线索，或一件待跟进的事……\n\nCatch it before it slips.',
]);
function originalFormatting(note) {
  const rich = note.richText, text = note.text, underline = text.startsWith('This') ? 'not quite ready to send' : '还没准备发送的', tagline = 'Catch it before it slips.';
  if (rich?.version !== 1 || !Array.isArray(rich.entities) || rich.entities.length !== 0 || !Array.isArray(rich.marks) || rich.marks.length !== 4 || Object.keys(rich).some(key => !['version', 'marks', 'entities'].includes(key))) return false;
  const expected = [['bold', 0, text.indexOf('\n\n'), null], ['underline', text.indexOf(underline), text.indexOf(underline) + underline.length, 'yellow'], ['font_serif', text.indexOf(tagline), text.length, null], ['italic', text.indexOf(tagline), text.length, null]].map(mark => JSON.stringify(mark)).sort();
  const actual = rich.marks.map(mark => !mark || Object.keys(mark).some(key => !['type', 'start', 'end', 'tone'].includes(key)) ? '' : JSON.stringify([mark.type, mark.start, mark.end, mark.tone ?? null])).sort();
  return JSON.stringify(actual) === JSON.stringify(expected);
}
export async function refreshBuiltinWelcomeNotes(notes, update) {
  const result = [...notes];
  for (let index = 0; index < result.length; index++) {
    const note = result[index];
    // Only the untouched bundled sample is migrated; personal notes and attachments stay intact.
    if (note.origin !== 'onboarding' || !legacyWelcome.has(note.text) || note.attachments?.length !== 1 || note.attachments[0].id !== 'quick-note-onboarding-first-note' || note.attachments[0].name !== 'firstnote.webp' || note.attachments[0].mimeType !== 'image/webp') continue;
    const image = note.attachments[0];
    if (!originalFormatting(note) || image.size !== 561096 || typeof image.data !== 'string' || image.data.length !== 748128) continue;
    let bytes; try { bytes = Uint8Array.from(atob(image.data), char => char.charCodeAt(0)); } catch { continue; }
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (digest !== '19422e970e2fb5969c1be6916fddd56129c047f4b2d73eca0d413e2007a7a2bf') continue;
    result[index] = await update({ id: note.id, ...structuredClone(welcomeNote), attachments: [] });
  }
  return result;
}
