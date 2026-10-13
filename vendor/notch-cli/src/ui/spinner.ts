import createSpinner, { type Options } from 'ora';

// Ora's stdin discarder pauses input and resets raw mode when it stops on Windows.
export default function spinner(options?: string | Options) {
  return createSpinner({
    ...(typeof options === 'string' ? { text: options } : options),
    discardStdin: false,
    isEnabled: process.stderr.isTTY && process.env.TERM !== 'dumb',
  });
}
