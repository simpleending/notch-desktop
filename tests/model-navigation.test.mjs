import test from 'node:test';
import assert from 'node:assert/strict';
import { focusModelOption, rovingModelOption, focusModelTab, syncModelOptions } from '../src/model-navigation.mjs';

test('filtering a list repairs extra tab stops while preserving focus on a surviving option', () => {
  const rows = Array.from({ length: 3 }, () => ({ tabIndex: 0, getAttribute: () => 'false' }));
  const document = { activeElement: rows[2] }, list = { ownerDocument: document, querySelectorAll: () => rows };
  syncModelOptions(list); assert.deepEqual(rows.map(row => row.tabIndex), [-1, -1, 0]);
  document.activeElement = { tagName: 'INPUT' }; syncModelOptions(list);
  assert.deepEqual(rows.map(row => row.tabIndex), [0, -1, -1]);
});

test('model lists preserve text editing, skip disabled options and support paging with one tab stop', () => {
  const document = { activeElement: null };
  const rows = Array.from({ length: 12 }, () => ({ tabIndex: -1, getAttribute: () => 'option', focus() { document.activeElement = this; } }));
  const list = { ownerDocument: document, querySelectorAll: () => rows };
  let prevented = 0;
  const press = (key, target = { tagName: 'BUTTON' }, extra = {}) => focusModelOption({ key, target, preventDefault() { prevented++; }, ...extra }, list);
  press('Home', { tagName: 'INPUT' }); press('End', { tagName: 'TEXTAREA' }); press('ArrowDown', undefined, { ctrlKey: true });
  assert.equal(prevented, 0);
  press('ArrowDown'); assert.equal(document.activeElement, rows[0]);
  press('PageDown'); assert.equal(document.activeElement, rows[8]);
  press('End'); assert.equal(document.activeElement, rows[11]);
  press('ArrowDown'); assert.equal(document.activeElement, rows[0]);
  press('ArrowUp'); assert.equal(document.activeElement, rows[11]);
  press('PageUp'); assert.equal(document.activeElement, rows[3]);
  rovingModelOption({ target: rows[3] }, list);
  assert.deepEqual(rows.map(row => row.tabIndex), rows.map((_, i) => i === 3 ? 0 : -1));
  let selector;
  focusModelOption({ key: 'ArrowDown', preventDefault() {} }, { ownerDocument: document, querySelectorAll(value) { selector = value; return []; } });
  assert.equal(selector, '[role=option]:not(:disabled)');
});

test('model tabs wrap and support Home and End without adding extra tab stops', () => {
  let selected, focused;
  const tabs = Array.from({ length: 4 }, (_, i) => ({ click() { selected = i; }, focus() { focused = i; } }));
  for (const tab of tabs) tab.parentElement = { querySelectorAll: () => tabs };
  const press = (index, key) => focusModelTab({ key, currentTarget: tabs[index], preventDefault() {} });
  press(0, 'ArrowLeft'); assert.equal(selected, 3); assert.equal(focused, 3);
  press(3, 'ArrowRight'); assert.equal(selected, 0);
  press(2, 'Home'); assert.equal(selected, 0);
  press(1, 'End'); assert.equal(selected, 3);
});
