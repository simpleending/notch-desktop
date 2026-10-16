export function patchWebToolCatalog(source) {
  const original = 'KHe=["Read","Write","Edit","Glob","Grep","Bash","WebSearch","WebFetch",';
  const updated = original + '"BrowserRead","BrowserInteract",';
  if (source.includes(updated)) return source;
  if (source.split(original).length !== 2) throw Error('The default agent tool catalog differs from the tested version.');
  return source.replace(original, updated);
}
