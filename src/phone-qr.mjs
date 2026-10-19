import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const QRCode = require('./vendor/qrcode/lib/core/qrcode.js');
const Svg = require('./vendor/qrcode/lib/renderer/svg-tag.js');

/** Pairing image for the desktop settings card. MIT QR rendering lives in src/vendor/qrcode. */
export function renderPairingQr(text) {
  if (typeof text !== 'string' || !text || text.length > 500) throw new Error('The pairing image needs a short address.');
  const code = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const svg = Svg.render(code, { margin: 2, width: 168, color: { dark: '#141416', light: '#ffffff' } });
  if (typeof svg !== 'string' || !svg.startsWith('<svg') || /<script|<\?|<!/i.test(svg)) throw new Error('The pairing image could not be drawn.');
  return svg;
}
