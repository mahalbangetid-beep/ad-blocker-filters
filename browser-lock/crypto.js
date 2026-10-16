// Password hashing with PBKDF2-SHA256 (WebCrypto). The plain password is never stored.

const ITERATIONS = 310000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    HASH_BITS
  );
  return new Uint8Array(bits);
}

export async function createPasswordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derive(password, salt, ITERATIONS);
  return { algo: 'PBKDF2-SHA256', iterations: ITERATIONS, salt: toBase64(salt), hash: toBase64(hash) };
}

export async function verifyPassword(password, record) {
  if (!record || typeof password !== 'string') return false;
  const expected = fromBase64(record.hash);
  const actual = await derive(password, fromBase64(record.salt), record.iterations);
  if (actual.length !== expected.length) return false;
  // Constant-time comparison.
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}
