import { uiMessage } from "./ui-messages.mjs";
import { createLoadingSkeleton } from './loading-skeleton.mjs';
import { focusModelOption, rovingModelOption, focusModelTab, syncModelOptions } from './model-navigation.mjs';

export function shouldCloseVoicePicker({ origin, ready } = {}) {
    return origin === 'mic' && ready === true;
}
export function createVoiceModels(React, { ContentDialog } = {}) {
    const h = React.createElement, api = (action, input) => window.notchModels.voiceModels(action, input);
    const LoadingSkeleton = createLoadingSkeleton(React);
    const choose = (role, autoInstall = false) => window.dispatchEvent(new CustomEvent('notch:choose-voice', { detail: { role, autoInstall } }));
    function Settings() {
        const [state, setState] = React.useState(null), [error, setError] = React.useState(''), [text, setText] = React.useState('Your local speech voice is ready.'), [playing, setPlaying] = React.useState(false), audio = React.useRef(null), generation = React.useRef(0);
        React.useEffect(() => { let live = true; const update = () => window.notchModels.voice().then(value => { if (live)
            setState(value); }).catch(error => { if (live)
            setError(error.message); }); void update(); const timer = setInterval(update, 1500); return () => { live = false; clearInterval(timer); generation.current++; audio.current?.close().catch(() => {}); void api('cancelPreview').catch(() => { }); }; }, []);
        const preview = async () => { const current = ++generation.current; setError(''); setPlaying(true); audio.current?.close().catch(() => {}); const context = new AudioContext(); audio.current = context; try {
            await context.resume();
            const value = await api('preview', { text });
            if (current !== generation.current)
                return;
            const bytes = Uint8Array.from(atob(value.audio), character => character.charCodeAt(0)), view = new DataView(bytes.buffer), buffer = context.createBuffer(1, bytes.length / 2, value.sampleRate);
            for (let i = 0; i < buffer.length; i++)
                buffer.getChannelData(0)[i] = view.getInt16(i * 2, true) / 32768;
            const source = context.createBufferSource();
            source.buffer = buffer;
            source.connect(context.destination);
            source.onended = () => { void context.close().catch(() => {}); if (current === generation.current)
                setPlaying(false); };
            source.start();
        }
        catch (error) {
            if (current === generation.current) {
                setError(error.message);
                setPlaying(false);
            }
            await context.close().catch(() => {});
        } };
        return h('section', { className: 'notch-voice-model-settings', 'aria-label': 'Speech models' }, h('h3', null, 'Speech models'), h('p', null, 'Local speech is the default. The first time you click the microphone, notch downloads Cactus Whistle (about 18 MB) and opens this picker. Review the dictated text before sending it.'), ...[['stt', 'Speech recognition', 'Choose dictation model'], ['tts', 'Speech output', 'Choose speech output']].map(([role, label, button]) => h('div', { className: 'notch-setting-row', key: role }, h('span', null, h('strong', null, label), h('small', null, state?.[role] ? `${state[role].name}${state.selection[role].voice ? ' · ' + state.selection[role].voice : ''} · ${state.selection[role].provider === 'local' ? 'Local' : 'OpenRouter cloud'}` : state || error ? 'Unavailable' : h(LoadingSkeleton, { label: 'Loading speech settings…', rows: 1, inline: true }))), h('button', { type: 'button', onClick: () => choose(role) }, button))), state && !state.ready ? h('p', null, 'Click the composer microphone to download Cactus Whistle, or choose another local dictation model here.') : null, h('label', { className: 'notch-voice-preview' }, 'Speech preview', h('input', { 'aria-label': 'Speech preview text', value: text, maxLength: 240, onChange: event => setText(event.target.value) })), h('button', { type: 'button', disabled: playing || !text.trim() || !state?.tts?.ready, onClick: preview }, playing ? 'Playing preview…' : 'Test speech output'), state?.selection.tts.provider === 'openrouter' ? h('p', null, 'Preview text is sent to your selected OpenRouter speech provider; provider charges apply.') : null, error ? h('p', { role: 'alert' }, uiMessage(error)) : null);
    }
    function Host() {
        const [open, setOpen] = React.useState(false), [role, setRole] = React.useState('stt'), [source, setSource] = React.useState('installed'), [origin, setOrigin] = React.useState('settings'), [rows, setRows] = React.useState([]), [state, setState] = React.useState(null), [selected, setSelected] = React.useState(null), [voice, setVoice] = React.useState(''), [query, setQuery] = React.useState(''), [confirmed, setConfirmed] = React.useState(false), [busy, setBusy] = React.useState(false), [loading, setLoading] = React.useState(false), [error, setError] = React.useState(''), request = React.useRef(0), started = React.useRef(false);
        const list = React.useRef(null), acting = React.useRef(false);
        React.useEffect(() => syncModelOptions(list.current));
        React.useEffect(() => { if (list.current) list.current.scrollTop = 0; }, [query, source]);
        React.useEffect(() => { const listener = event => { if (!['stt', 'tts'].includes(event.detail?.role))
            return; request.current++; acting.current = false; setBusy(false); setRole(event.detail.role); setSource('installed'); setOrigin(event.detail.autoInstall ? 'mic' : 'settings'); setQuery(''); setSelected(null); setConfirmed(false); setError(''); started.current = false; setOpen(true); }; window.addEventListener('notch:choose-voice', listener); return () => window.removeEventListener('notch:choose-voice', listener); }, []);
        React.useEffect(() => { if (!open)
            return; let live = true; setSelected(null); setRows([]); setError(''); setLoading(true); const revision = ++request.current; Promise.all([api('catalog', { role, source }), window.notchModels.voice()]).then(async ([models, status]) => { if (!live || revision !== request.current)
            return; setRows(models); setState(status); if (role === 'stt') {
            const recommended = models.find(row => row.id === 'cactus/whistle');
            if (recommended)
                try {
                    const value = await api('details', { role, id: recommended.id, provider: recommended.provider });
                    if (live && revision === request.current) {
                        setSelected(value);
                        setVoice(value.voices?.[0] ?? '');
                    }
                }
                catch (error) {
                    if (live && revision === request.current)
                        setError(error.message);
                }
            if (live && revision === request.current && origin === 'mic' && !status.ready && status.job?.phase !== 'downloading' && !started.current) {
                started.current = true;
                try {
                    const next = await api('install', { role: 'stt', id: 'cactus/whistle' });
                    if (live && revision === request.current)
                        setState(next);
                }
                catch (error) {
                    if (live && revision === request.current)
                        setError(error.message);
                }
            }
        } }).catch(error => { if (live && revision === request.current)
            setError(error.message); }).finally(() => { if (live && revision === request.current)
            setLoading(false); }); const timer = setInterval(() => { if (acting.current) return; const current = request.current; window.notchModels.voice().then(status => { if (live && current === request.current)
            setState(status); }).catch(error => { if (live && current === request.current)
            setError(error.message); }); }, 1000); return () => { live = false; clearInterval(timer); request.current++; }; }, [open, role, source, origin]);
        React.useEffect(() => { if (!open || !shouldCloseVoicePicker({ origin, ready: state?.ready }))
            return; const timer = setTimeout(() => setOpen(false), 600); return () => clearTimeout(timer); }, [open, origin, state?.ready]);
        const inspect = async (row) => { const id = ++request.current; setSelected(null); setError(''); setLoading(true); try {
            const value = await api('details', { role, id: row.id, provider: row.provider });
            if (id === request.current) {
                setSelected(value);
                setVoice(value.voices?.[0] ?? '');
            }
        }
        catch (error) {
            if (id === request.current)
                setError(error.message);
        }
        finally {
            if (id === request.current)
                setLoading(false);
        } };
        const act = async (download) => { const revision = ++request.current; acting.current = true; setBusy(true); setError(''); try {
            if (download) {
                const value = await api('install', { role, id: selected.id }); if (revision === request.current) setState(value);
            }
            else {
                const value = await api('select', { role, selection: { provider: selected.provider, id: selected.id, voice }, cloudConfirmed: confirmed });
                if (revision === request.current) { setState(value); setOpen(false); }
            }
        }
        catch (error) {
            if (revision === request.current) setError(error.message);
        }
        finally {
            if (revision === request.current) { acting.current = false; setBusy(false); }
        } };
        if (!open)
            return null;
        const installed = selected && (selected.installed || state?.[role]?.id === selected.id && state[role].ready), downloading = state?.job?.phase === 'downloading', cloud = selected?.provider === 'openrouter', available = rows.filter(row => (row.name + ' ' + row.id + ' ' + (row.description ?? '')).toLowerCase().includes(query.toLowerCase()));
        const jobLabel = state?.job?.id === 'cactus/whistle' ? 'Downloading Cactus Whistle' : 'Downloading speech files';
        return h(ContentDialog, { open, onClose: () => { request.current++; acting.current = false; setBusy(false); setOpen(false); setOrigin('settings'); started.current = false; }, title: role === 'stt' ? 'Choose speech recognition model' : 'Choose speech output model', description: origin === 'mic' ? 'Downloading Cactus Whistle for local dictation. The picker closes when the model is ready.' : 'Choose a compatible local download or an optional OpenRouter service.', closeLabel: 'Close speech model picker', maxWidth: 720,
            children: h('div', { className: 'notch-voice-picker' }, h('div', { role: 'tablist', 'aria-label': 'Speech model source' }, ...[['installed', 'Installed'], ['huggingface', 'Hugging Face'], ['openrouter', 'OpenRouter']].map(([id, label]) => h('button', { type: 'button', key: id, role: 'tab', tabIndex: source === id ? 0 : -1, disabled: busy, onKeyDown: focusModelTab, 'aria-selected': source === id, onClick: () => { if (id === source) return; setSource(id); setRows([]); setSelected(null); setLoading(true); setConfirmed(false); } }, label))), h('input', { type: 'search', 'aria-label': 'Search speech models', placeholder: 'Search compatible speech models', value: query, maxLength: 120, disabled: busy, onKeyDown: event => focusModelOption(event, list.current), onChange: event => setQuery(event.target.value) }), source === 'huggingface' ? h('p', null, role === 'stt' ? 'Cactus Whistle is recommended. Compatible Whisper models remain available; models marked .en recognize English only.' : 'Compatible Piper voices converted for the local speech engine. Other model formats are excluded.') : null, source === 'openrouter' ? h('p', null, 'Cloud speech uses your OpenRouter key. ' + (state?.connected ? 'Provider charges apply.' : 'Connect a key in Settings → Models to use these services.')) : null, h('div', { ref: list, className: 'notch-voice-model-list', role: 'listbox', onKeyDown: event => focusModelOption(event, list.current), onFocus: event => rovingModelOption(event, list.current), 'aria-label': 'Compatible speech models', 'aria-busy': loading, hidden: loading && !rows.length && !error }, ...available.map((row, index) => h('button', { type: 'button', role: 'option', tabIndex: index === 0 ? 0 : -1, 'aria-selected': selected?.id === row.id, 'data-recommended': row.id === 'cactus/whistle' || undefined, key: row.id, disabled: busy, onClick: () => inspect(row) }, h('strong', null, row.name), h('small', null, [row.description, row.installed ? 'Installed' : null].filter(Boolean).join(' · '))))), loading && !rows.length && !error ? h(LoadingSkeleton, { label: 'Loading compatible models…' }) : loading && rows.length ? h('p', { role: 'status' }, 'Loading model details…') : !available.length && !error ? h('p', null, 'No matching compatible speech models.') : null, selected ? h('section', { 'aria-label': 'Selected speech model' }, h('h4', null, selected.name), selected.downloadBytes ? h('p', null, `${Math.ceil(selected.downloadBytes / 1024 ** 2)} MB download · approximately ${Math.ceil(selected.requiredMemory / 1024 ** 2)} MB of free RAM needed. Available memory is checked again before use.`) : null, selected.url ? h('a', { href: selected.url, target: '_blank', rel: 'noopener noreferrer' }, 'Model details and license') : null, role === 'tts' && (selected.id === 'windows' || cloud) ? h('label', null, 'Voice', selected.voices?.length ? h('select', { 'aria-label': 'Speech voice', value: voice, onChange: event => setVoice(event.target.value) }, ...(selected.id === 'windows' ? [h('option', { value: '', key: 'default' }, 'System default')] : []), ...selected.voices.map(name => h('option', { value: name, key: name }, name))) : h('input', { 'aria-label': 'Speech voice ID', value: voice, maxLength: 200, placeholder: cloud ? 'Enter a voice ID supported by this model' : 'System default', onChange: event => setVoice(event.target.value) })) : null, cloud ? h('label', { className: 'notch-voice-cloud-consent' }, h('input', { type: 'checkbox', checked: confirmed, onChange: event => setConfirmed(event.target.checked) }), role === 'stt' ? 'Send microphone audio to this OpenRouter speech provider.' : 'Send speech text to this OpenRouter speech provider.') : null, h('button', { type: 'button', disabled: busy || downloading || selected.supported === false || cloud && (!confirmed || !state?.connected || role === 'tts' && !voice.trim()), onClick: () => act(!cloud && !installed) }, cloud ? 'Use OpenRouter model' : installed ? 'Use model' : 'Download & use')) : null, downloading ? h('div', { role: 'status' }, h('progress', { max: state.job.total || 1, value: state.job.bytes, 'aria-label': jobLabel }), h('p', null, `${jobLabel}: ${Math.floor(state.job.bytes / 1024 ** 2)} MB`), h('button', { type: 'button', onClick: () => api('cancel').then(() => window.notchModels.voice()).then(setState).catch(error => setError(error.message)) }, 'Cancel download')) : null, state?.job?.phase === 'ready' ? h('p', { role: 'status' }, origin === 'mic' ? 'Whistle is ready. You can now dictate your message.' : 'Download complete. The speech model is selected.') : null, error || state?.job?.error ? h('p', { role: 'alert' }, uiMessage(error || state.job.error)) : null)
        });
    }
    return { Settings, Host };
}
