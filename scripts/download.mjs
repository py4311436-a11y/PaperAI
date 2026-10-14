// Small download helper. Used because `curl -o` writes are blocked in this
// sandbox while Node's fs writes are permitted.
// Usage: node scripts/download.mjs <url> <destPath>
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [, , url, dest] = process.argv;
if (!url || !dest) {
  console.error("usage: node scripts/download.mjs <url> <dest>");
  process.exit(2);
}

mkdirSync(dirname(dest), { recursive: true });

const BUF = 1 << 16;
let received = 0;

async function main() {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const chunks = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received % (8 * BUF) < value.length) {
      const pct = total ? ` ${((received / total) * 100).toFixed(1)}%` : "";
      process.stdout.write(`\r  ${(received / 1048576).toFixed(1)} MB${pct}   `);
    }
  }
  const buf = Buffer.concat(chunks);
  writeFileSync(dest, buf);
  process.stdout.write("\n");
  console.log(`OK ${dest}  ${buf.length} bytes`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
