import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebSettings } from '../src/web-settings-view.mjs';
import { createUpdateSettings } from '../src/update-settings-view.mjs';
import { createPhoneSettings } from '../src/phone-settings-view.mjs';
import { createVoiceModels } from '../src/voice-model-picker.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const all = node => node && typeof node === 'object' ? [node, ...[...node.children.flat(Infinity), node.props.children].flatMap(all)] : [];
const field = (tree, label) => all(tree).find(node => node.props['aria-label'] === label);
const button = (tree, label) => all(tree).find(node => node.type === 'button' && node.children.includes(label));
function harness(factory, bridge) {
  const states = [], refs = [], effects = [], intervals = [], listeners = new Map();
  let stateCursor, refCursor, effectCursor;
  const previous = { window: globalThis.window, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval };
  globalThis.window = { notchModels: bridge, addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) };
  globalThis.setInterval = callback => { intervals.push(callback); return callback; };
  globalThis.clearInterval = () => {};
  const React = {
    useState(initial) { const index = stateCursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef(initial) { return refs[refCursor++] ??= { current: initial }; },
    useEffect(callback, deps) { const index = effectCursor++, old = effects[index]; if (!old || !deps || deps.some((value, i) => value !== old.deps[i])) { old?.cleanup?.(); effects[index] = { deps, callback, pending: true }; } },
    createElement(type, props, ...children) { return { type, props: props || {}, children }; }
  };
  const Component = factory(React);
  return {
    render() { stateCursor = refCursor = effectCursor = 0; const tree = Component(); for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup = effect.callback(); } return tree; },
    poll() { for (const callback of intervals) callback(); }, listeners,
    close() { for (const effect of effects) effect.cleanup?.(); Object.assign(globalThis, previous); }
  };
}

test('web settings retry a failed load and retain an unsaved key when another setting changes', async () => {
  let fail = true;
  let settings = { enabled: true, browser: 'auto', searchProvider: 'duckduckgo' };
  const view = harness(createWebSettings, { async web(patch) { if (fail) throw Error('Temporarily unavailable'); return settings = { ...settings, ...patch }; } });
  try {
    view.render(); await tick();
    assert.ok(button(view.render(), 'Retry web settings'));
    fail = false; await button(view.render(), 'Retry web settings').props.onClick();
    field(view.render(), 'Tavily API key').props.onChange({ target: { value: 'unsaved-user-key' } });
    await field(view.render(), 'Research browser').props.onChange({ target: { value: 'chrome' } });
    assert.equal(field(view.render(), 'Tavily API key').props.value, 'unsaved-user-key');
    assert.equal(field(view.render(), 'Research browser').props.value, 'chrome');
    await all(view.render()).find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await tick();
    assert.equal(field(view.render(), 'Tavily API key').props.value, '');
    assert.equal(settings.key, 'unsaved-user-key');
  } finally { view.close(); }
});

test('a slow update status reply cannot undo a newly saved preference or erase an action error', async () => {
  const stale = deferred(); let polls = 0, fail = false;
  const state = { supported: true, canInstall: true, automatic: true, phase: 'idle' };
  const view = harness(createUpdateSettings, { async updates(action) { if (action) { if (fail) throw Error('offline'); return { ...state, automatic: false }; } return polls++ === 1 ? stale.promise : state; } });
  try {
    view.render(); await tick(); view.poll();
    field(view.render(), 'Automatic updates').props.onChange({ target: { checked: false } }); await tick();
    stale.resolve(state); await tick();
    assert.equal(field(view.render(), 'Automatic updates').props.checked, false);
    fail = true; button(view.render(), 'Check for updates').props.onClick(); await tick();
    view.poll(); await tick();
    assert.match(all(view.render()).find(node => node.props.role === 'alert').children.join(''), /could not finish/);
  } finally { view.close(); }
});

test('phone settings retain address and token drafts through unrelated changes and stale polls', async () => {
  let state = { enabled: false, reach: 'address', publicUrl: 'https://old.example', devices: [] }, polls = 0;
  const stale = deferred();
  const view = harness(createPhoneSettings, { async phone(action, patch) { if (action === 'update') return state = { ...state, ...patch }; return polls++ === 1 ? stale.promise : state; } });
  try {
    view.render(); await tick();
    field(view.render(), 'Address you host').props.onChange({ target: { value: 'https://draft.example' } });
    view.poll(); field(view.render(), 'Phone access').props.onChange({ target: { checked: true } }); await tick();
    stale.resolve({ enabled: false, reach: 'address', devices: [] }); await tick();
    assert.equal(field(view.render(), 'Phone access').props.checked, true);
    assert.equal(field(view.render(), 'Address you host').props.value, 'https://draft.example');
    field(view.render(), 'Away from this Wi-Fi').props.onChange({ target: { value: 'ngrok' } }); await tick();
    field(view.render(), 'ngrok authtoken').props.onChange({ target: { value: 'draft-token' } });
    field(view.render(), 'Phone access').props.onChange({ target: { checked: false } }); await tick();
    assert.equal(field(view.render(), 'ngrok authtoken').props.value, 'draft-token');
  } finally { view.close(); }
});

test('late recommended speech details cannot replace the model the user selected', async () => {
  const recommended = deferred(), selected = { id: 'user-choice', name: 'User choice', provider: 'local', installed: true };
  const view = harness(React => createVoiceModels(React, { ContentDialog: 'dialog' }).Host, {
    async voice() { return { ready: false, selection: { stt: {} } }; },
    async voiceModels(action, input) { if (action === 'catalog') return [{ id: 'cactus/whistle', provider: 'local', name: 'Recommended' }, selected]; if (action === 'details') return input.id === 'cactus/whistle' ? recommended.promise : selected; }
  });
  try {
    view.render(); view.listeners.get('notch:choose-voice')({ detail: { role: 'stt' } }); view.render(); await tick();
    const options = all(view.render()).filter(node => node.props.role === 'option');
    await options[1].props.onClick();
    recommended.resolve({ id: 'cactus/whistle', name: 'Late recommendation' }); await tick();
    assert.equal(field(view.render(), 'Selected speech model').children[0].children[0], 'User choice');
    button(view.render(), 'Use model').props.onClick(); await tick();
    assert.equal(view.render(), null);
  } finally { view.close(); }
});
