// The agent's key for one SQL statement (store-local `query_fingerprint`): the first 16 hex of SHA-1 over
// "alias|statement". Computed here, synchronously, because `crypto.subtle` is missing on plain-http hosts the
// panel is served from (an app on 192.168.x.x).

const encoder = new TextEncoder();

function sha1(bytes: Uint8Array): string {
  const length = bytes.length;
  const words = new Uint32Array((((length + 8) >>> 6) + 1) * 16);
  for (let i = 0; i < length; i++) words[i >>> 2] = (words[i >>> 2] ?? 0) | ((bytes[i] ?? 0) << (24 - (i % 4) * 8));
  words[length >>> 2] = (words[length >>> 2] ?? 0) | (0x80 << (24 - (length % 4) * 8));
  words[words.length - 1] = length * 8;
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Uint32Array(80);
  const rotl = (value: number, by: number) => (value << by) | (value >>> (32 - by));
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 80; t++) {
      w[t] =
        t < 16
          ? (words[block + t] ?? 0)
          : rotl((w[t - 3] ?? 0) ^ (w[t - 8] ?? 0) ^ (w[t - 14] ?? 0) ^ (w[t - 16] ?? 0), 1);
    }
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let t = 0; t < 80; t++) {
      const [f, k] =
        t < 20
          ? [(b & c) | (~b & d), 0x5a827999]
          : t < 40
            ? [b ^ c ^ d, 0x6ed9eba1]
            : t < 60
              ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc]
              : [b ^ c ^ d, 0xca62c1d6];
      const next = (rotl(a, 5) + f + e + k + (w[t] ?? 0)) >>> 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30) >>> 0, a, next];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) >>> 0, (h1 + b) >>> 0, (h2 + c) >>> 0, (h3 + d) >>> 0, (h4 + e) >>> 0];
  }
  return [h0, h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

/** The key the agent files a statement under, as `query:<key>` searches for it. */
export function queryFingerprint(statement: string, alias: string): string {
  return sha1(encoder.encode(`${alias}|${statement}`)).slice(0, 16);
}
