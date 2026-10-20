export function focusModelOption(event, list) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || !list || list.hidden) return;
  if (['Home', 'End'].includes(event.key) && ['INPUT', 'TEXTAREA'].includes(event.target?.tagName)) return;
  const rows = [...list.querySelectorAll('[role=option]:not(:disabled)')];
  if (!rows.length) return;
  event.preventDefault();
  const index = rows.indexOf(list.ownerDocument.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : event.key === 'PageDown' ? Math.min(rows.length - 1, Math.max(0, index) + 8) : event.key === 'PageUp' ? Math.max(0, index - 8) : event.key === 'ArrowDown' ? (index + 1) % rows.length : (index <= 0 ? rows.length : index) - 1;
  rows[next].focus();
}

export function rovingModelOption(event, list) {
  if (event.target?.getAttribute('role') !== 'option') return;
  for (const row of list.querySelectorAll('[role=option]')) row.tabIndex = row === event.target ? 0 : -1;
}

export function syncModelOptions(list) {
  if (!list) return;
  const rows = [...list.querySelectorAll('[role=option]:not(:disabled)')];
  const active = rows.find(row => row === list.ownerDocument.activeElement) || rows.find(row => row.getAttribute('aria-selected') === 'true') || rows[0];
  for (const row of list.querySelectorAll('[role=option]')) row.tabIndex = row === active ? 0 : -1;
}

export function focusModelTab(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = [...event.currentTarget.parentElement.querySelectorAll('[role=tab]:not(:disabled)')];
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
  tabs[next].click(); tabs[next].focus();
}
