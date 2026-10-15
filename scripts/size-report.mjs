import { readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = "D:/AIreader/PaperAI-PoC";

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push({ p, size: statSync(p).size });
  }
  return out;
}

const mb = (n) => (n / 1024 / 1024).toFixed(2) + " MiB";

for (const top of ["dist", "public"]) {
  const full = path.join(ROOT, top);
  if (!existsSync(full)) {
    console.log(`${top}: (missing)`);
    continue;
  }
  const files = walk(full);
  const total = files.reduce((a, f) => a + f.size, 0);
  console.log(`\n${top}: ${files.length} files, ${mb(total)}`);

  // group by top-level child
  const groups = new Map();
  for (const f of files) {
    const rel = path.relative(full, f.p);
    const key = rel.split(path.sep)[0];
    const g = groups.get(key) ?? { n: 0, size: 0 };
    g.n++;
    g.size += f.size;
    groups.set(key, g);
  }
  for (const [k, g] of [...groups].sort((a, b) => b[1].size - a[1].size)) {
    console.log(`   ${k.padEnd(24)} ${String(g.n).padStart(4)} files  ${mb(g.size)}`);
  }
}

// Is the release exe stripped?
const exe = "D:/PaperAI-Build/target/release/PaperAI.exe";
if (existsSync(exe)) {
  console.log(`\nrelease exe: ${mb(statSync(exe).size)}`);
}
