import { createWebSettings } from './web-settings-view.mjs';
import { createPhoneSettings } from './phone-settings-view.mjs';
import { createUpdateSettings } from './update-settings-view.mjs';
import { createVoiceModels } from './voice-model-picker.mjs';
const darkWordmark = new URL('./notch-wordmark-dark.svg', import.meta.url).href;
const lightWordmark = new URL('./notch-wordmark-light.svg', import.meta.url).href;
export function createNotchWorkbench(React, useTheme, primitives = {}) {
  const h = React.createElement;
  const WebSettings = createWebSettings(React);
  const PhoneSettings = createPhoneSettings(React);
  const UpdateSettings = createUpdateSettings(React);
  const { Settings: VoiceModels, Host: VoicePickerHost } = createVoiceModels(React, primitives);
  function Wordmark({ width = 100, className = '' } = {}) {
    const { resolvedTheme } = useTheme();
    return h('img', { src: resolvedTheme.endsWith('-dark') ? darkWordmark : lightWordmark, alt: 'notch', width, height: width * 100 / 336, className });
  }
  function Brand() {
    const { resolvedTheme } = useTheme();
    const [queued, setQueued] = React.useState([]);
    React.useEffect(() => {
      if (!window.notchModels?.queue) return;
      let alive = true;
      const update = () => window.notchModels.queue().then(rows => { if (alive) setQueued(rows); }).catch(() => {});
      update(); const timer = setInterval(update, 700);
      return () => { alive = false; clearInterval(timer); };
    }, []);
    return h(React.Fragment,null,h('span', { className: 'notch-window-brand' }, h('img', { src: resolvedTheme.endsWith('-dark') ? darkWordmark : lightWordmark, alt: 'notch', width: 82, height: 25 }),
      queued.length ? h('span', { role: 'status', className: 'notch-queue-status', title: 'Stop a waiting task from its chat.' }, `${queued.length} waiting · ${queued[0].message}`) : null),h(VoicePickerHost));
  }
  function ThemeControls() {
    const { resolvedTheme, setThemeMode } = useTheme();
    const dark = resolvedTheme.endsWith('-dark');
    return h('button', { type: 'button', className: 'notch-theme-toggle', role: 'switch', 'aria-label': 'Dark appearance',
      'aria-checked': dark, title: dark ? 'Switch to light appearance' : 'Switch to dark appearance',
      onClick: () => setThemeMode(dark ? 'light' : 'dark') }, h('span', { 'aria-hidden': true }, dark ? '◐' : '◑'), dark ? 'Dark' : 'Light');
  }
  function ModeSwitch({ value, onValueChange, labels = {} }) {
    return h('div', { className: 'notch-mode-switch', role: 'group', 'aria-label': labels.switcher || 'Work mode' },
      ...[['coding','Code'],['general','Chat']].map(([mode,label]) => h('button', { key: mode, type: 'button',
        'aria-pressed': value === mode, onClick: () => { if (mode !== value) onValueChange(mode); } }, label)));
  }
  function Welcome({ workspace, executor }) {
    return h('section', { className: 'notch-welcome', 'aria-labelledby': 'notch-welcome-title' },
      h('h1', { id: 'notch-welcome-title' }, workspace || 'Start a task'),
      h('p', { className: 'notch-welcome-copy' }, 'Describe a change, ask a question, or open a project.'),
      executor ? h('div', { className: 'notch-executor' }, h('span', null, 'Working with'), executor) : null);
  }
  function QuickStart({ onCreateWorkspace }) {
    return h('div', { className: 'notch-project-action' },
      h('button', { type: 'button', onClick: onCreateWorkspace }, 'Open project'));
  }
  function PanelLauncher({ onOpenCode, onOpenBrowser, onOpenSideChat, onOpenReview, onOpenTerminal, reviewAvailable, codeDisabled, reviewDisabled }) {
    const actions = [['Files', onOpenCode, codeDisabled], ['Browser', onOpenBrowser, false],
      ...(onOpenSideChat ? [['Side chat', onOpenSideChat, false]] : []),
      ...(reviewAvailable ? [['Changes', onOpenReview, reviewDisabled]] : []), ['Terminal', onOpenTerminal, false]];
    return h('nav', { className: 'notch-panel-launcher', 'aria-label': 'Open a workspace panel' },
      h('div', null, h('h2', null, 'Open a panel'), ...actions.map(([label, onClick, disabled]) =>
        h('button', { key: label, type: 'button', disabled, onClick, 'aria-label': label }, label,
          h('span', { 'aria-hidden': true }, '→')))));
  }
  function Appearance({ preferences, language, setLanguage }) {
    const { themeMode, setThemeMode } = useTheme();
    const [workspace, setWorkspace] = React.useState('shared');
    const [workspaceError, setWorkspaceError] = React.useState('');
    const [savingWorkspace, setSavingWorkspace] = React.useState(true);
    React.useEffect(() => { let alive=true; window.notchModels?.workspace?.().then(value=>{if(alive)setWorkspace(value);}).catch(error=>{if(alive)setWorkspaceError(error.message);}).finally(()=>{if(alive)setSavingWorkspace(false);}); return ()=>{alive=false;}; }, []);
    const changeWorkspace = async mode => {
      setSavingWorkspace(true); setWorkspaceError('');
      try { setWorkspace(await window.notchModels.workspace(mode)); } catch(error) { setWorkspaceError(error.message); }
      finally { setSavingWorkspace(false); }
    };
    const select = (label, value, setter, options, description) => h('label', { className: 'notch-setting-row' },
      h('span', null, h('strong', null, label), h('small', null, description)),
      h('select', { 'aria-label': label, value, onChange: event => setter(event.target.value) },
        ...options.map(([value, label]) => h('option', { key: value, value }, label))));
    return h('section', { className: 'notch-appearance', 'aria-labelledby': 'notch-appearance-title' },
      h('h2', { id: 'notch-appearance-title' }, 'Appearance'),
      h('p', { className: 'notch-appearance-copy' }, 'Adjust phone access, task behavior, web research and reading preferences.'),
      h('label', { className: 'notch-setting-row' }, h('span', null, h('strong',null,'Task workspace'), h('small',null,'Project folder is the default; writable tasks take turns. Isolated worktrees allow parallel OpenRouter tasks. Changes apply to new turns; unfinished isolated files stay saved.')),
        h('select', { 'aria-label':'Task workspace', value:workspace, disabled:savingWorkspace, onChange:event=>changeWorkspace(event.target.value) }, h('option',{value:'shared'},'Project folder'),h('option',{value:'isolated'},'Isolated worktrees'))),
      workspaceError ? h('p',{role:'alert'},workspaceError) : null,
      h(PhoneSettings),
      h(UpdateSettings),
      h(WebSettings),
      h('fieldset', { className: 'notch-appearance-modes' }, h('legend', null, 'Appearance'),
        ...[['dark','Dark'],['light','Light'],['auto','System']].map(([value,label]) =>
          h('label', { key: value, className: 'notch-appearance-choice' },
            h('input', { type: 'radio', name: 'notch-appearance', value, checked: themeMode === value, onChange: () => setThemeMode(value) }),
            h('span', null, label)))),
      select('Reading font', preferences.fontStyle, preferences.setFontStyle, [['sans','Sans serif'],['serif','Serif']], 'Choose the font used for conversation text.'),
      select('Text size', preferences.fontSize, preferences.setFontSize, [['small','Small'],['medium','Medium'],['large','Large']], 'Set the reading size of task text.'),
      select('Interface scale', preferences.uiScale, preferences.setUiScale, [['medium','Standard'],['large','Large']], 'Increase the size of navigation and controls.'),
      select('Content width', preferences.chatWidth, preferences.setChatWidth, [['default','Standard'],['wide','Wide']], 'Set the width of task content and the composer.'),
      select('File icons', preferences.fileIconStyle, preferences.setFileIconStyle, [['notch','Minimal'],['material','Material']], 'Choose simple symbols or language-specific file icons.'),
      select('Terminal appearance', preferences.terminalThemeMode, preferences.setTerminalThemeMode, [['follow','Follow workspace'],['manual','Manual']], 'Keep the terminal in step with your workspace, or select it separately.'),
      select('Terminal links', preferences.terminalLinkOpenTarget, preferences.setTerminalLinkOpenTarget, [['external','System browser'],['internal','Built-in browser']], 'Choose where web links from the terminal open.'),
      select('Language', language, setLanguage, [['en','English'],['zh','Chinese (Simplified)']], 'Select the interface language.'));
  }
  function LocalProfile({ name }) {
    return h('section', { className: 'notch-appearance notch-local-profile', 'aria-labelledby': 'notch-profile-title' },
      h('h2', { id: 'notch-profile-title' }, name),
      h('p', { className: 'notch-appearance-copy' }, 'A workspace on your computer. No account needed for local models.'),
      h('p', { className: 'notch-profile-note' }, 'Model and access controls are available in the task composer. Use Appearance to adjust your workspace.'));
  }
  function Symbol({ size = 32, className = '' } = {}) {
    return h('svg', { viewBox: '0 0 100 100', width: size, height: size, className: `notch-symbol ${className}`, 'aria-hidden': true, fill: 'currentColor' },
      h('path', { d: 'M25 76V29H40V39C44 31 51 29 58 29 70 29 77 38 77 51V76H62V53C62 47 59 43 54 43 46 43 40 49 40 56V76z' }),
      h('path', { d: 'M77 18h10v10H77z', className: 'notch-symbol-cut' }));
  }
  function Dot({ size = 16, className = '' } = {}) {
    return h('svg', { viewBox: '0 0 24 24', width: size, height: size, className: `notch-dot ${className}`, 'aria-hidden': true, fill: 'currentColor' },
      h('circle', { cx: 12, cy: 12, r: 4 }));
  }
  return { Brand, ThemeControls, ModeSwitch, Welcome, QuickStart, PanelLauncher, Appearance, LocalProfile, Symbol, Dot, Wordmark, VoiceModels };
}
