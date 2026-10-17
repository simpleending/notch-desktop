import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { patchWorkingStatus } from '../src/working-status-patch.mjs';
import { rebrandWorkbenchText } from '../src/bundle-patch.mjs';

const messages = JSON.parse(readFileSync(new URL('../vendor/notch-cli/src/ui/working-messages.json', import.meta.url)));
const fixture = 'const en={processing:{almost:"Nearly done",baking:"Preparing",bearWithMe:"Hold on",working:"Old working",considering:"Old considering",stirring:"Old stirring"}};function ThinkingStatusMessagesDialog(){}';

test('shared defaults replace inherited phrases, keeping all historical preference keys and patch idempotence', () => {
  const patched = patchWorkingStatus(fixture);
  parse(patched, { ecmaVersion: 'latest' });
  const catalog = new Function(patched + ';return en.processing;')();
  assert.deepEqual([...new Set(Object.values(catalog))], Object.values(messages));
  assert.deepEqual(Object.keys(catalog), ['almost', 'baking', 'bearWithMe', ...Object.keys(messages)]);
  assert.equal(patchWorkingStatus(patched), patched);
  assert.equal(patchWorkingStatus(rebrandWorkbenchText(patched)), rebrandWorkbenchText(patched));
});

test('custom canonical messages replace defaults while explicit historical custom messages remain in the rotation', () => {
  const source = 'function rotation(v2,J2,a2){return thinkingStatusMessageKeys.map(W2=>v2[J2][W2]??a2(`chatActivity.processing.${W2}`))}';
  const patched = patchWorkingStatus(source);
  const rotation = new Function('thinkingStatusMessageKeys', patched + ';return rotation;')(['almost', 'baking', ...Object.keys(messages)]);
  const translate = key => messages[key.split('.').at(-1)] ?? messages.working;
  assert.deepEqual(rotation({ en: {} }, 'en', translate), Object.values(messages));
  const custom = { working: 'My working phrase', considering: 'My next step', stirring: 'My assembling phrase', almost: 'My older custom phrase' };
  assert.deepEqual(rotation({ en: custom }, 'en', translate), Object.values(custom));
  assert.equal(patchWorkingStatus(patched), patched);
});

test('status editor shows current-language defaults and preserves other-language and historical custom phrases on save and reset', () => {
  const patched = patchWorkingStatus(fixture);
  for (const language of ['en', 'zh']) {
    let saved, state;
    const overrides = { en: { almost: 'My custom phrase' }, zh: { almost: '我的自定义文字' } };
    const keys = ['almost', 'baking', 'bearWithMe', ...Object.keys(messages)];
    const defaults = Object.fromEntries(keys.map((key, index) => [key, messages[key] ?? Object.values(messages)[index % 3]]));
    const jsx = (type, props) => ({ type, props });
    const react = { useMemo: fn => fn(), useEffect() {}, useState(fn) { state ??= fn(); return [state, fn => { state = fn(state); }]; } };
    const render = new Function('reactExports', 'useTranslation', 'thinkingStatusMessageKeys', 'createDrafts', 'createOverrides', 'haveSameOverrides', 'jsxRuntimeExports', 'ContentDialog', 'Button', 'Input', 'IconButton', 'notchResetLeftLine', patched + ';return ThinkingStatusMessagesDialog;')(
      react, () => ({ t: key => key, i18n: { language, getFixedT: () => key => defaults[key.split('.').at(-1)] } }), keys,
      (base, custom) => Object.fromEntries(['en', 'zh'].map(lang => [lang, { ...base[lang], ...custom[lang] }])),
      (draft, base) => Object.fromEntries(['en', 'zh'].map(lang => [lang, Object.fromEntries(Object.entries(draft[lang]).filter(([key, value]) => value.trim() && value !== base[lang][key]))])),
      (a, b) => JSON.stringify(a) === JSON.stringify(b), { jsx, jsxs: jsx }, 'dialog', 'button', 'input', 'reset', 'icon');
    const props = { open: true, overrides, onOpenChange() {}, onSave(value) { saved = value; } };
    const visit = node => node && typeof node === 'object' ? [node, ...[node.props?.children].flat(Infinity).flatMap(visit)] : [];
    let tree = render(props), nodes = visit(tree);
    // Footer is a dialog prop; include it when finding its buttons.
    const footer = () => visit(tree.props.footer);
    assert.deepEqual(nodes.filter(node => node.type === 'input').map(node => node.props.value), [...Object.values(messages), overrides[language].almost]);
    nodes.find(node => node.type === 'input').props.onChange({ target: { value: 'My new working phrase' } });
    tree = render(props);
    footer().find(node => node.type === 'button' && node.props.children === 'common.save').props.onClick();
    assert.equal(saved[language].working, 'My new working phrase');
    assert.equal(saved[language].almost, overrides[language].almost);
    assert.deepEqual(saved[language === 'en' ? 'zh' : 'en'], overrides[language === 'en' ? 'zh' : 'en']);
    footer().find(node => node.type === 'button' && node.props.children === 'settings.thinkingStatusMessagesResetAll').props.onClick();
    tree = render(props);
    footer().find(node => node.type === 'button' && node.props.children === 'common.save').props.onClick();
    assert.deepEqual(saved[language], {});
    assert.deepEqual(saved[language === 'en' ? 'zh' : 'en'], overrides[language === 'en' ? 'zh' : 'en']);
  }
});
