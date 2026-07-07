/** Minimal ANSI color helpers — no dependency, respects NO_COLOR and non-TTY output. */
const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code: string) {
  return (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);
}

export const ansi = {
  // Anvil brand orange (#E8501A) via 24-bit truecolor, degrades gracefully on non-color terminals.
  brand: wrap('38;2;232;80;26'),
  bold: wrap('1'),
  dim: wrap('2'),
  green: wrap('32'),
  gray: wrap('90'),
  cyan: wrap('36'),
};
