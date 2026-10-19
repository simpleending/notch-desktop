const root = document.documentElement;
try {
  const stored = localStorage.getItem('notch-phone-theme');
  const theme = stored === 'light' || stored === 'dark' ? stored : (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  root.dataset.appearance = theme;
  root.style.colorScheme = theme;
} catch { /* Private browsing can block storage. The dark palette remains. */ }

const state = { theme: root.dataset.appearance || 'dark', token: '', hint: true, snapshot: null, offline: false, error: '', sending: false, pairing: false, draft: '', pairDraft: '', menu: false, recording: false };

function storage(name, value) {
  try {
    if (value === undefined) return localStorage.getItem(name);
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch { return null; }
  return value;
}

state.token = storage('notch-phone-token') || '';
state.hint = storage('notch-phone-hint') !== 'hidden';

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === false || value == null) continue;
    else if (key === 'disabled' || key === 'readOnly' || key === 'checked') node[key] = !!value;
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function svg(tag, props) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props)) node.setAttribute(key, value);
  return node;
}

function icon(name) {
  const node = svg('svg', { viewBox: '0 0 24 24', width: '20', height: '20', 'aria-hidden': 'true' });
  const stroke = { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (name === 'mic') node.append(svg('path', { fill: 'currentColor', d: 'M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3zm-5.2-3a.8.8 0 0 0-1.6 0 6.8 6.8 0 0 0 6 6.75V20H9.2v1.6h5.6V20H13v-2.25a6.8 6.8 0 0 0 6-6.75.8.8 0 0 0-1.6 0 5.2 5.2 0 0 1-10.4 0z' }));
  else if (name === 'moon') node.append(svg('path', { fill: 'currentColor', d: 'M15.5 3.2a8.2 8.2 0 1 0 5.3 14.1A8.5 8.5 0 0 1 15.5 3.2z' }));
  else if (name === 'sun') node.append(svg('circle', { cx: '12', cy: '12', r: '3.2', ...stroke }), svg('path', { d: 'M12 3.2v1.8M12 19v1.8M3.2 12h1.8M19 12h1.8M5.6 5.6l1.3 1.3M17.1 17.1l1.3 1.3M18.4 5.6l-1.3 1.3M6.9 17.1l-1.3 1.3', ...stroke }));
  else node.append(svg('path', { d: name === 'menu' ? 'M4 7h16M4 12h16M4 17h16' : name === 'close' ? 'M6 6l12 12M18 6L6 18' : 'M5 12h12M13 7l5 5-5 5', ...stroke }));
  return node;
}

function fitComposer(node) {
  if (!node) return;
  if (!node.value) { node.style.height = ''; return; }
  node.style.height = 'auto';
  node.style.height = `${Math.min(node.scrollHeight, 88)}px`;
}

function wordmarkSrc() {
  return state.theme === 'light' ? '/assets/notch-wordmark-light.svg' : '/assets/notch-wordmark-dark.svg';
}

function wordmark() {
  return el('img', { class: 'wordmark', src: wordmarkSrc(), alt: 'notch' });
}

function themeButton() {
  const dark = state.theme === 'dark';
  return el('button', { class: 'icon-button theme', type: 'button', role: 'switch', 'aria-checked': dark ? 'true' : 'false', 'aria-label': dark ? 'Dark appearance' : 'Light appearance', title: dark ? 'Switch to light appearance' : 'Switch to dark appearance', onclick: () => setTheme(dark ? 'light' : 'dark') }, icon(dark ? 'moon' : 'sun'));
}

function menuButton(snapshot, open) {
  const waiting = (snapshot?.pending || []).length;
  return el('button', { class: 'icon-button', type: 'button', 'aria-label': open ? 'Close menu' : waiting ? `Menu, ${waiting} waiting` : 'Menu', onclick: () => { state.menu = !open; paint(); } },
    icon(open ? 'close' : 'menu'), waiting && !open ? el('span', { class: 'wait-dot', 'aria-hidden': 'true' }) : null);
}

function setTheme(theme) {
  state.theme = theme;
  root.dataset.appearance = theme;
  root.style.colorScheme = theme;
  const color = document.querySelector('meta[name="theme-color"]');
  if (color) color.setAttribute('content', theme === 'light' ? '#f5f4f6' : '#141416');
  storage('notch-phone-theme', theme);
  const mark = document.querySelector('.wordmark');
  if (mark) mark.src = wordmarkSrc();
  const button = document.querySelector('.theme');
  if (!button) return;
  button.setAttribute('aria-checked', theme === 'dark' ? 'true' : 'false');
  button.title = theme === 'dark' ? 'Switch to light appearance' : 'Switch to dark appearance';
  button.setAttribute('aria-label', theme === 'dark' ? 'Dark appearance' : 'Light appearance');
  button.replaceChildren(icon(theme === 'dark' ? 'moon' : 'sun'));
}

function headers(json) {
  return { 'x-notch-phone': '1', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), ...(json ? { 'Content-Type': 'application/json' } : {}) };
}

async function request(path, body) {
  const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: headers(!!body), credentials: 'same-origin', body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/api/pair') { state.token = ''; storage('notch-phone-token', null); state.snapshot = null; throw Object.assign(new Error(payload.error || 'Pair this phone again.'), { code: 401 }); }
  if (!response.ok) throw new Error(payload.error || 'This computer could not finish that.');
  return payload;
}

function nearBottom(node) {
  return !node || node.scrollHeight - node.scrollTop - node.clientHeight < 80;
}

function paint() {
  const app = document.getElementById('app');
  if (!app) return;
  const view = !state.snapshot ? 'pair' : state.menu ? 'menu' : 'chat';
  if (app.dataset.view !== view) {
    app.dataset.view = view;
    app.replaceChildren(view === 'chat' ? chat(state.snapshot) : view === 'menu' ? menu(state.snapshot) : pair());
    const thread = document.getElementById('thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
    return;
  }
  if (view === 'chat') updateChat(state.snapshot);
  else if (view === 'menu') updateMenu(state.snapshot);
  else updatePair();
}

function leadText() {
  const computer = state.hello ? `${state.hello} is the name of this computer, not the project.` : 'This page talks to notch on this computer.';
  return `${computer} Enter the pairing code from Settings, Appearance, Phone. After it connects, the project open in that window is the one this phone uses.`;
}

function pair() {
  return el('main', { class: 'pair' },
    el('header', { class: 'bar' }, wordmark(), el('div', { class: 'bar-actions' }, themeButton())),
    el('div', { class: 'pair-body' },
      el('p', { class: 'eyebrow' }, 'THIS PHONE'),
      el('h1', null, 'Your computer'),
      el('p', { class: 'lead', id: 'pair-lead' }, leadText()),
      el('form', { onsubmit: submitPair },
        el('label', null, 'Pairing code', el('input', { id: 'pair-code', name: 'code', autocomplete: 'one-time-code', autocapitalize: 'characters', spellcheck: 'false', maxlength: '11', 'aria-label': 'Pairing code', required: 'true', value: state.pairDraft, oninput: event => { state.pairDraft = event.target.value; } })),
        el('button', { class: 'primary', type: 'submit', disabled: state.pairing }, state.pairing ? 'Connecting' : 'Connect')),
      el('p', { class: 'alert', id: 'banner', role: 'alert' }, state.error),
      el('p', { class: 'fine' }, 'After it connects, add notch to your Home Screen from the browser menu. notch by freesyntax.dev. There is no app store and no account.')));
}

function updatePair() {
  const lead = document.getElementById('pair-lead');
  if (lead) lead.textContent = leadText();
  const banner = document.getElementById('banner');
  if (banner) banner.textContent = state.error;
  const input = document.getElementById('pair-code');
  if (input && document.activeElement !== input && input.value !== state.pairDraft) input.value = state.pairDraft;
  const button = input?.form?.querySelector('button');
  if (button) { button.disabled = state.pairing; button.textContent = state.pairing ? 'Connecting' : 'Connect'; }
}

async function submitPair(event) {
  event.preventDefault();
  if (state.pairing) return;
  const code = document.getElementById('pair-code')?.value || '';
  state.pairDraft = code;
  state.error = '';
  state.pairing = true;
  paint();
  try {
    const result = await request('/api/pair', { code });
    state.token = result.token;
    state.pairDraft = '';
    storage('notch-phone-token', result.token);
    history.replaceState(null, '', location.pathname);
    await openStream();
  } catch (error) {
    state.error = error.message;
    paint();
  } finally {
    state.pairing = false;
    paint();
  }
}

function statusLine(snapshot) {
  const offline = state.offline;
  const phase = offline ? 'offline' : snapshot.phase;
  const label = offline ? 'This computer is offline' : snapshot.label;
  return el('p', { class: `status ${phase}`, role: 'status' }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('strong', null, label));
}

function chat(snapshot) {
  const pending = snapshot.pending || [];
  const messages = snapshot.messages || [];
  return el('main', { class: 'shell' },
    el('header', { class: 'bar' }, wordmark(), el('div', { class: 'bar-actions' }, menuButton(snapshot, false), themeButton())),
    state.hint ? el('div', { class: 'hint' }, el('span', null, 'Add notch to your Home Screen from the browser menu. It opens this computer.'), el('button', { type: 'button', onclick: event => { state.hint = false; storage('notch-phone-hint', 'hidden'); event.target.closest('.hint')?.remove(); } }, 'Hide')) : null,
    el('div', { class: 'status-row' }, statusLine(snapshot), snapshot.stopPhone ? el('button', { id: 'stop-phone', class: 'stop', type: 'button', onclick: () => act('/api/stop', { target: 'phone' }) }, 'Stop') : null),
    el('section', { class: 'project', id: 'project', 'aria-label': 'Open project' },
      el('p', { class: 'eyebrow' }, 'PROJECT'),
      el('p', { class: 'project-name', id: 'project-name' }, snapshot.project || 'Open a project on this computer'),
      el('button', { class: 'model', id: 'model-line', type: 'button', onclick: () => { state.menu = true; paint(); } }, [currentTask(snapshot)?.title, snapshot.model, snapshot.access].filter(Boolean).join(' · '))),
    snapshot.computer?.visible ? el('section', { class: 'computer', id: 'computer', 'data-key': `${snapshot.computer.text || ''}\0${snapshot.computer.detail || 'Working with the open project.'}\0${snapshot.stopComputer ? 1 : 0}`, 'aria-label': 'On this computer' },
      el('p', { class: 'eyebrow' }, 'ON THIS COMPUTER'),
      snapshot.computer.text ? el('p', null, snapshot.computer.text) : el('p', { class: 'quiet' }, snapshot.computer.detail || 'Working with the open project.'),
      snapshot.stopComputer ? el('div', { class: 'actions' }, el('button', { type: 'button', onclick: () => act('/api/stop', { target: 'computer' }) }, 'Stop on the computer')) : null) : null,
    el('div', { class: 'thread', id: 'thread', 'aria-live': 'polite', 'data-key': `${snapshot.task || ''}\n${signature(messages, ['role', 'text']) || (snapshot.project ? 'empty-project' : 'empty')}` },
      messages.length ? messages.map(message => el('article', { class: `bubble ${message.role}` }, message.text)) : el('p', { class: 'empty' }, snapshot.project ? 'Describe a change or ask a question. It runs on this computer, and this phone asks before files change or a command runs.' : 'Open a project in notch on the computer. This phone will use that folder.')),
    el('div', { class: 'stack', id: 'approvals', hidden: pending.length ? null : true, 'data-key': signature(pending, ['id', 'title', 'detail', 'source']) }, pending.map(item => el('section', { class: 'approval', 'aria-label': 'Needs your approval' },
      el('p', { class: 'eyebrow' }, item.source === 'computer' ? 'NEEDS YOU · ON THE COMPUTER' : 'NEEDS YOU'),
      el('h2', null, item.title),
      item.detail ? el('pre', null, item.detail) : null,
      el('div', { class: 'actions' },
        el('button', { class: 'primary', type: 'button', onclick: () => act('/api/approval', { id: item.id, behavior: 'allow' }) }, 'Allow'),
        el('button', { type: 'button', onclick: () => act('/api/approval', { id: item.id, behavior: 'deny' }) }, 'Deny'),
        el('button', { class: 'ghost', type: 'button', onclick: () => act('/api/approval', { id: item.id, behavior: 'allow', remember: true }) }, 'Allow for this task'))))),
    el('p', { class: 'alert', id: 'banner', role: 'alert' }, state.error),
    el('form', { class: 'composer', 'data-typing': state.draft.trim() && !state.recording ? 'true' : 'false', onsubmit: submitPrompt },
      el('button', { id: 'mic', class: 'float mic', type: 'button', 'aria-label': state.recording ? 'Stop dictation' : 'Dictate', 'aria-pressed': state.recording ? 'true' : 'false', disabled: snapshot.composer === 'computer' || state.sending, onclick: () => void dictate() }, icon('mic')),
      el('textarea', { id: 'composer', rows: '1', maxlength: '8000', placeholder: snapshot.composer === 'computer' ? 'On the computer' : 'Message', 'aria-label': 'Message', disabled: snapshot.composer === 'computer' || !snapshot.project || snapshot.stopPhone || state.sending, oninput: onComposerInput, onkeydown: onComposerKey }, state.draft),
      el('button', { id: 'send', class: 'float send', type: 'submit', 'aria-label': 'Send', disabled: snapshot.composer === 'computer' || !snapshot.project || snapshot.stopPhone || state.sending || !state.draft.trim() }, icon('send'))));
}

function currentTask(snapshot) { return (snapshot.tasks || []).find(item => item.current); }

function menu(snapshot) {
  return el('div', { class: 'menu', role: 'dialog', 'aria-label': 'Menu' },
    el('header', { class: 'bar' }, wordmark(), el('div', { class: 'bar-actions' }, menuButton(snapshot, true), themeButton())),
    menuBody(snapshot));
}

function menuBody(snapshot) {
  const phases = { ready: 'Ready', working: 'Working', 'needs-you': 'Needs you' };
  const tasks = snapshot.tasks || [];
  const models = (snapshot.models || []).filter(model => model.enabled);
  const voice = snapshot.voice || {};
  return el('div', { class: 'menu-body', id: 'menu-body', 'data-key': menuKey(snapshot) },
    el('h2', null, 'TASKS'),
    el('button', { class: 'menu-row new', type: 'button', onclick: () => void act('/api/task', { action: 'new' }) }, el('span', null, 'New task'), el('small', null, 'Start')),
    ...tasks.map(task => el('button', { class: 'menu-row', type: 'button', 'aria-pressed': task.current ? 'true' : 'false', onclick: () => void openTask(task.id) },
      el('span', null, task.title), el('small', null, `${phases[task.phase] || 'Ready'} · ${task.source === 'computer' ? 'Computer' : task.model}`))),
    el('p', { class: 'note' }, snapshot.workspaceMode === 'isolated' ? 'OpenRouter tasks can run together in isolated worktrees. Local models still take turns.' : 'Tasks in the project folder take turns. Isolated worktrees, in Appearance on the computer, let OpenRouter tasks run together.'),
    el('h2', null, 'MODEL'),
    ...(models.length ? models.map(model => el('button', { class: 'menu-row', type: 'button', 'aria-pressed': model.key === snapshot.modelKey ? 'true' : 'false', disabled: snapshot.composer === 'computer', onclick: () => void act('/api/model', { key: model.key }) },
      el('span', null, model.name), el('small', null, model.provider === 'openrouter' ? 'OpenRouter' : 'On this computer'))) : [el('p', { class: 'note' }, 'Models are still loading on the computer.')]),
    el('p', { class: 'note' }, 'The model applies to the open phone task. A task that is already working keeps its model until it finishes.'),
    el('h2', null, 'VOICE'),
    el('button', { class: 'menu-row', type: 'button', 'aria-pressed': state.recording ? 'true' : 'false', onclick: () => void dictate() }, el('span', null, state.recording ? 'Stop dictation' : 'Dictate'), el('small', null, voice.name || 'Speech')),
    el('p', { class: 'note' }, voice.ready ? `${voice.name || 'Speech'} on this computer writes into the composer. You still send the message.` : 'Set up speech in notch on the computer. The first microphone there downloads Cactus Whistle. Dictation then uses that model and leaves the words here for you to send.'),
    window.isSecureContext ? null : el('p', { class: 'note' }, 'The microphone needs the https address you host. On this Wi-Fi page you can still type.'));
}

function menuKey(snapshot) {
  return JSON.stringify({ tasks: snapshot.tasks, models: snapshot.models, modelKey: snapshot.modelKey, voice: snapshot.voice, mode: snapshot.workspaceMode, recording: state.recording, composer: snapshot.composer });
}

async function openTask(id) {
  await act('/api/task', { action: 'open', id });
  if (!state.error) { state.menu = false; paint(); }
}

function updateMenu(snapshot) {
  const body = document.getElementById('menu-body');
  const key = menuKey(snapshot);
  if (!body || body.dataset.key === key) return;
  body.replaceWith(menuBody(snapshot));
}

let recorder;
async function dictate() {
  if (state.recording) { await finishDictation(); return; }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { state.error = 'Voice needs the https address you host. You can still type.'; paint(); return; }
  state.error = '';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const silent = context.createGain();
    silent.gain.value = 0;
    const samples = [];
    processor.onaudioprocess = event => { samples.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
    source.connect(processor); processor.connect(silent); silent.connect(context.destination);
    recorder = { stream, context, processor, samples, rate: context.sampleRate, started: Date.now() };
    state.recording = true;
    paint();
    recorder.limit = setTimeout(() => { void finishDictation(); }, 15000);
  } catch { state.error = 'The microphone was not available.'; state.recording = false; paint(); }
}

function pcm16(samples, rate) {
  const ratio = rate / 16000;
  const length = Math.floor(samples.reduce((sum, chunk) => sum + chunk.length, 0) / ratio);
  const pcm = new Int16Array(length);
  let offset = 0, index = 0, fraction = 0;
  for (let target = 0; target < length; target += 1) {
    while (samples[offset] && index + fraction >= samples[offset].length) { fraction -= samples[offset].length - index; index = 0; offset += 1; }
    const chunk = samples[offset];
    const value = chunk ? chunk[Math.min(chunk.length - 1, Math.floor(index + fraction))] : 0;
    pcm[target] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    fraction += ratio;
  }
  return pcm;
}

async function finishDictation() {
  const current = recorder;
  recorder = null;
  state.recording = false;
  if (!current) return;
  clearTimeout(current.limit);
  current.processor.disconnect(); current.stream.getTracks().forEach(track => track.stop());
  const pcm = pcm16(current.samples, current.rate);
  await current.context.close().catch(() => {});
  if (pcm.length < 1600) { state.error = 'That recording was too short.'; paint(); return; }
  try {
    const response = await fetch('/api/dictate', { method: 'POST', headers: { 'x-notch-phone': '1', ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}), 'Content-Type': 'application/octet-stream' }, credentials: 'same-origin', body: pcm.buffer });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Speech could not be read on this computer.');
    const text = String(payload.text || '').trim();
    if (text) state.draft = `${state.draft}${state.draft && !state.draft.endsWith(' ') ? ' ' : ''}${text}`;
    else state.error = 'No words were heard.';
  } catch (error) { state.error = error.message; }
  paint();
}

function onComposerKey(event) {
  if (event.key === 'Enter' && !event.shiftKey && !matchMedia('(pointer: coarse)').matches) {
    event.preventDefault();
    event.target.form?.requestSubmit();
  }
}

function signature(items, fields) {
  return items.map(item => fields.map(field => item[field] || '').join('\0')).join('\n');
}

function replaceChildren(node, children) {
  node.replaceChildren(...children.filter(child => child != null && child !== false));
}

function updateChat(snapshot) {
  const stick = nearBottom(document.getElementById('thread'));
  const status = document.querySelector('.status');
  if (status) {
    const offline = state.offline;
    const phase = offline ? 'offline' : snapshot.phase;
    status.className = `status ${phase}`;
    const strong = status.querySelector('strong');
    if (strong) strong.textContent = offline ? 'This computer is offline' : snapshot.label;
  }
  const statusRow = document.querySelector('.status-row');
  const stop = document.getElementById('stop-phone');
  if (statusRow && snapshot.stopPhone && !stop) statusRow.append(el('button', { id: 'stop-phone', class: 'stop', type: 'button', onclick: () => act('/api/stop', { target: 'phone' }) }, 'Stop'));
  if (!snapshot.stopPhone && stop) stop.remove();
  const project = document.getElementById('project-name');
  if (project) project.textContent = snapshot.project || 'Open a project on this computer';
  const model = document.getElementById('model-line');
  if (model) model.textContent = [currentTask(snapshot)?.title, snapshot.model, snapshot.access].filter(Boolean).join(' · ');
  syncComputer(snapshot);
  const messages = snapshot.messages || [];
  const thread = document.getElementById('thread');
  const messageKey = `${snapshot.task || ''}\n${signature(messages, ['role', 'text']) || (snapshot.project ? 'empty-project' : 'empty')}`;
  if (thread && thread.dataset.key !== messageKey) {
    thread.dataset.key = messageKey;
    replaceChildren(thread, messages.length ? messages.map(message => el('article', { class: `bubble ${message.role}` }, message.text)) : [el('p', { class: 'empty' }, snapshot.project ? 'Describe a change or ask a question. It runs on this computer, and this phone asks before files change or a command runs.' : 'Open a project in notch on the computer. This phone will use that folder.')]);
    if (stick) thread.scrollTop = thread.scrollHeight;
  }
  const pending = snapshot.pending || [];
  const stack = document.getElementById('approvals');
  const pendingKey = signature(pending, ['id', 'title', 'detail', 'source']);
  if (stack && stack.dataset.key !== pendingKey) {
    stack.dataset.key = pendingKey;
    stack.hidden = pending.length === 0;
    replaceChildren(stack, pending.map(item => el('section', { class: 'approval', 'aria-label': 'Needs your approval' },
      el('p', { class: 'eyebrow' }, item.source === 'computer' ? 'NEEDS YOU · ON THE COMPUTER' : 'NEEDS YOU'),
      el('h2', null, item.title),
      item.detail ? el('pre', null, item.detail) : null,
      el('div', { class: 'actions' },
        el('button', { class: 'primary', type: 'button', onclick: () => act('/api/approval', { id: item.id, behavior: 'allow' }) }, 'Allow'),
        el('button', { type: 'button', onclick: () => act('/api/approval', { id: item.id, behavior: 'deny' }) }, 'Deny'),
        el('button', { class: 'ghost', type: 'button', onclick: () => act('/api/approval', { id: item.id, behavior: 'allow', remember: true }) }, 'Allow for this task')))));
  }
  const banner = document.getElementById('banner');
  if (banner) banner.textContent = state.error;
  const composer = document.getElementById('composer');
  const send = document.getElementById('send');
  const disabled = snapshot.composer === 'computer' || !snapshot.project || snapshot.stopPhone || state.sending;
  if (composer) {
    composer.disabled = disabled;
    composer.placeholder = snapshot.composer === 'computer' ? 'On the computer' : 'Message';
    if (document.activeElement !== composer && composer.value !== state.draft) { composer.value = state.draft; fitComposer(composer); }
    composer.form.dataset.typing = state.draft.trim() && !state.recording ? 'true' : 'false';
  }
  if (send) send.disabled = disabled || !state.draft.trim();
  const mic = document.getElementById('mic');
  if (mic) { mic.disabled = snapshot.composer === 'computer' || state.sending; mic.setAttribute('aria-pressed', state.recording ? 'true' : 'false'); mic.setAttribute('aria-label', state.recording ? 'Stop dictation' : 'Dictate'); }
}

function onComposerInput(event) {
  state.draft = event.target.value;
  const typing = !!state.draft.trim() && !state.recording;
  event.target.form.dataset.typing = typing ? 'true' : 'false';
  fitComposer(event.target);
  const send = document.getElementById('send');
  if (send) send.disabled = !typing || event.target.disabled;
}

function syncComputer(snapshot) {
  const shell = document.querySelector('.shell');
  const current = document.getElementById('computer');
  const visible = !!snapshot.computer?.visible;
  if (!visible) { current?.remove(); return; }
  const text = snapshot.computer.text || '';
  const detail = snapshot.computer.detail || 'Working with the open project.';
  const key = `${text}\0${detail}\0${snapshot.stopComputer ? 1 : 0}`;
  if (current && current.dataset.key === key) return;
  const section = el('section', { class: 'computer', id: 'computer', 'aria-label': 'On this computer' },
    el('p', { class: 'eyebrow' }, 'ON THIS COMPUTER'),
    text ? el('p', null, text) : el('p', { class: 'quiet' }, detail),
    snapshot.stopComputer ? el('div', { class: 'actions' }, el('button', { type: 'button', onclick: () => act('/api/stop', { target: 'computer' }) }, 'Stop on the computer')) : null);
  section.dataset.key = key;
  if (current) current.replaceWith(section);
  else document.getElementById('project')?.after(section);
  if (!shell) return;
}

async function submitPrompt(event) {
  event.preventDefault();
  const text = (document.getElementById('composer')?.value || state.draft).trim();
  if (!text || state.sending) return;
  state.sending = true; state.error = ''; state.draft = '';
  const composer = document.getElementById('composer');
  if (composer) { composer.value = ''; composer.style.height = ''; }
  paint();
  try { state.snapshot = await request('/api/prompt', { text }); state.offline = false; }
  catch (error) { state.draft = text; state.error = error.message; if (error.code !== 401) state.offline = /fetch|network|offline/i.test(error.message); }
  finally { state.sending = false; paint(); }
}

async function act(path, body) {
  state.error = '';
  try { state.snapshot = await request(path, body); state.offline = false; }
  catch (error) { state.error = error.message; }
  paint();
}

function applySnapshot(snapshot) {
  state.snapshot = snapshot;
  state.offline = false;
  state.error = '';
  if (snapshot.project) document.title = `notch · ${snapshot.project}`;
  paint();
}

async function openStream() {
  if (state.streaming) return;
  state.streaming = true;
  while (state.token) {
    try {
      const response = await fetch('/api/stream', { headers: headers(false), credentials: 'same-origin' });
      if (response.status === 401) { state.token = ''; storage('notch-phone-token', null); state.snapshot = null; break; }
      if (!response.ok || !response.body) throw new Error('stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const packet = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = packet.split('\n').find(item => item.startsWith('data: '));
          if (!line) continue;
          applySnapshot(JSON.parse(line.slice(6)));
        }
      }
    } catch (error) {
      if (state.snapshot) { state.offline = true; paint(); }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  state.streaming = false;
  paint();
}

async function boot() {
  try { state.hello = (await (await fetch('/api/hello')).json()).computer; } catch { /* The pairing screen still explains what to do. */ }
  const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('pair');
  if (code && !state.token) {
    try {
      const result = await request('/api/pair', { code });
      state.token = result.token;
      storage('notch-phone-token', result.token);
      history.replaceState(null, '', location.pathname);
    } catch (error) { state.error = error.message; }
  }
  paint();
  if (state.token) await openStream();
  if (window.isSecureContext && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

document.addEventListener('DOMContentLoaded', () => { void boot(); });
