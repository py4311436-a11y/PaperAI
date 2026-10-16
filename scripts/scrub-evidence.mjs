#!/usr/bin/env node
/**
 * Scrub machine identity out of the committed evidence logs before publishing.
 *
 * Why: `evidence/` is the proof trail behind the claims in
 * `reports/KNOWN_ISSUES_AI.md`, so deleting it would weaken those claims. But
 * those logs were captured on one machine, and they embed the Windows account
 * name — in Edge/WebView2 command lines, credential-target listings, install
 * logs. Publishing that tells a reader whose machine produced the evidence, and
 * hands them a username to try.
 *
 * So the identity is replaced, not the evidence: the shape of every path stays
 * intact, which is the part that makes a log useful for diagnosis.
 *
 * Run: node scripts/scrub-evidence.mjs           (rewrite in place)
 *      node scripts/scrub-evidence.mjs --check    (report only, exit 1 if dirty)
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Both trees hold captured output; both are published, so both are scrubbed. */
const TARGETS = [path.join(ROOT, "evidence"), path.join(ROOT, "reports")];
const checkOnly = process.argv.includes("--check");

/**
 * Order matters: the full profile path is replaced before the bare account
 * name, otherwise `C:\Users\<user>` would end up with the placeholder glued
 * into the middle of a path that is still perfectly readable.
 */
const RULES = [
  // Whole user profile roots.
  { re: /[A-Za-z]:\\Users\\[^\\/\s"']+/g, to: "%USERPROFILE%" },
  { re: /\/Users\/[^/\s"']+/g, to: "~" },
  // Email addresses. These appear in the credential-target listings, and an
  // account address is as identifying as a username. Note the account name is
  // often a *prefix* of the address, so this has to run before the bare-name
  // rule or the result reads "…@163.com" with half the identity intact.
  { re: /\b[\w.+-]+@163\.com\b/g, to: "<email>" },
  { re: /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g, to: "<email>" },
  // The account name on its own (process lists, registry paths, log headers).
  { re: /\bpy252\d*/g, to: "<user>" },
  // Machine-local build roots this project uses by convention. Keeping the
  // layout but dropping the absolute drive letter keeps the docs readable.
  { re: /[A-Za-z]:\\PaperAI-Build/g, to: "%BUILD_ROOT%" },
  { re: /[A-Za-z]:\\AIreader/g, to: "%PROJECT_PARENT%" },
];

/**
 * Patterns that must never appear in a published tree.
 *
 * Deliberately NOT auto-redacted. Identity is replaced because identity in a
 * test log is harmless once anonymised; an API key is not — if one is here, it
 * was live at some point, and the fix is to rotate it, not to hide it.
 */
const FORBIDDEN = [{ name: "疑似 API 密钥", re: /\bsk-[A-Za-z0-9_-]{16,}/g }];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(txt|log|md|json|csv|jsonl)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

let changedFiles = 0;
let totalReplacements = 0;
const forbiddenHits = [];
const allFiles = TARGETS.filter((t) => existsSync(t)).flatMap((t) => walk(t));

for (const file of allFiles) {
  const original = readFileSync(file, "utf8");
  let text = original;

  for (const rule of RULES) {
    const hits = text.match(rule.re);
    if (hits) totalReplacements += hits.length;
    text = text.replace(rule.re, rule.to);
  }

  for (const rule of FORBIDDEN) {
    const hits = text.match(rule.re);
    // agent@paperai.local is the local commit identity, not a real person's
    // address; it is rewritten by the email rule and is not a finding.
    if (hits) {
      const real = hits.filter((h) => !h.includes("paperai.local"));
      if (real.length) forbiddenHits.push({ file: path.relative(ROOT, file), name: rule.name, real });
    }
  }

  if (text !== original) {
    changedFiles++;
    if (!checkOnly) writeFileSync(file, text, "utf8");
  }
}

console.log(
  `${checkOnly ? "[check] " : "[scrub] "}扫描 ${allFiles.length} 个文件 · ` +
    `${changedFiles} 个含本机身份 · ${totalReplacements} 处替换`
);

if (forbiddenHits.length) {
  console.error("\n以下内容不应出现在公开仓库中，请人工处理：");
  for (const hit of forbiddenHits) {
    console.error(`  ${hit.file}: ${hit.name} -> ${hit.real.slice(0, 3).join(", ")}`);
  }
  process.exit(1);
}
if (checkOnly && changedFiles) {
  console.error("\n仍有未清洗的文件。运行：node scripts/scrub-evidence.mjs");
  process.exit(1);
}
console.log("完成。");
