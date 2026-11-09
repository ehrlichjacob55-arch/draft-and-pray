const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGIT = "23456789";
const SYMBOL = "!@#$%^&*-_=+?";
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

/** Uniform random int in [0, max) via rejection sampling over crypto.getRandomValues. */
function randomInt(max: number): number {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % max;
  }
}

const pick = (set: string) => set[randomInt(set.length)]!;

/**
 * 32-char random password with upper, lower, digit and symbol. Used once to satisfy Cognito's
 * NEW_PASSWORD_REQUIRED challenge; it is never stored or shown (docs/design/13 §1.3).
 */
export function randomPassword(length = 32): string {
  const chars = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join("");
}
