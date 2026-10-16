#!/usr/bin/env node
/**
 * Publication audit: is this repository safe to make public?
 *
 * Flipping a repository to public is one-way. The things that make it unsafe are
 * not obvious from the working tree — the worst one is *history*: a file deleted
 * three commits ago is still retrievable, which is exactly how real IEEE papers
 * ended up in this repository for a day.
 *
 * So this checks four layers, and is meant to be run before every flip:
 *
 *   1. Working tree  — no credential stores, no browser profiles, no real PDFs.
 *   2. Every commit  — the same, because history is what people can reach.
 *   3. Identity      — no account name, no email address, no absolute home path.
 *   4. Secrets       — key-shaped strings fail loudly rather than being masked.
 *
 * Exit code 0 means publishable. Non-zero means something must be dealt with
 * first; the output says what.
 *
 * Run: node scripts/verify-publishable.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });

let failures = 0;
let warnings = 0;
const fail = (label, detail = "") => {
  failures++;
  console.log(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
};
const warn = (label, detail = "") => {
  warnings++;
  console.log(`[WARN] ${label}${detail ? ` — ${detail}` : ""}`);
};
const ok = (label, detail = "") => console.log(`[ ok ] ${label}${detail ? ` — ${detail}` : ""}`);

/* ---------------------------------------------- 1. working tree contents -- */

const TRACKED = git("ls-files").split("\n").filter(Boolean);
ok("受控文件", `${TRACKED.length} 个`);

const credentialish = TRACKED.filter((f) =>
  /(^|\/)(Login Data|Cookies|Web Data|Local State|ai-profiles\.json)$/i.test(f)
);
if (credentialish.length) fail("凭据/配置文件入库", credentialish.join(", "));
else ok("无凭据或 AI 配置文件入库");

const pdfs = TRACKED.filter((f) => f.toLowerCase().endsWith(".pdf"));
if (pdfs.length) fail("受控文件中的 PDF", `${pdfs.length} 个：${pdfs.join(", ")}`);
else ok("受控文件中无 PDF");

/* --------------------------------------------- 2. every commit in history -- */

/**
 * One pass over every commit's tree. This is the layer that matters: a deleted
 * file is invisible in the working tree and fully retrievable from history.
 */
const commits = git("rev-list", "--all").split("\n").filter(Boolean);
let historyPdfs = 0;
let historyCreds = 0;
const seenPaths = new Set();
for (const c of commits) {
  const files = git("ls-tree", "-r", "--name-only", c).split("\n");
  for (const f of files) {
    if (seenPaths.has(f)) continue;
    seenPaths.add(f);
    if (f.toLowerCase().endsWith(".pdf")) historyPdfs++;
    if (/(^|\/)(Login Data|Cookies|Web Data|Local State)$/i.test(f)) historyCreds++;
  }
}
if (historyPdfs) fail("历史提交中仍有 PDF", `${historyPdfs} 个（不可逆，必须重写历史）`);
else ok("全部历史提交中无 PDF", `${commits.length} 个提交已检查`);

if (historyCreds) fail("历史提交中仍有凭据数据库", `${historyCreds} 个`);
else ok("全部历史提交中无凭据数据库");

/* ------------------------------------------------------- 3. machine identity */

const IDENTITY = [
  { name: "Windows 账户名", re: /\bpy252\d*/g },
  { name: "用户目录路径", re: /[A-Za-z]:\\Users\\[^\\/\s"']+/g },
  { name: "邮箱地址", re: /\b[\w.+-]+@(?:163|qq|gmail|outlook|hotmail)\.[\w.]{2,}\b/gi },
];
/**
 * Files that legitimately contain the patterns this audit searches for.
 *
 * `scrub-evidence.mjs` and this file both *define* the identity and secret
 * patterns, so they match themselves. Reporting that would train people to
 * ignore the audit, which is worse than not having it.
 */
const PATTERN_DEFINERS = new Set([
  "scripts/scrub-evidence.mjs",
  "scripts/verify-publishable.mjs",
]);

/**
 * Source-code constants that look like credentials but are not.
 *
 * Each is a fixture proving the credential path is exercised: `secrets.rs`
 * plants a known value, and the upgrade test marks a file. Publishing a real
 * key would be a leak; publishing these is the opposite. Keyed by the literal so
 * a *real* key appearing anywhere else still fails.
 */
const KNOWN_TEST_CONSTANTS = new Set([
  "sk-plAnted-control-value-0123456789",
  "sk-upgrade-marker-not-a-real-key",
]);

const isExempt = (file, hits) =>
  PATTERN_DEFINERS.has(file) || hits.every((h) => KNOWN_TEST_CONSTANTS.has(h));

const textFiles = TRACKED.filter((f) => /\.(ts|js|mjs|json|md|css|html|rs|toml|yml|yaml|txt|log)$/i.test(f));
let identityHits = 0;
for (const f of textFiles) {
  const full = path.join(ROOT, f);
  if (!existsSync(full) || statSync(full).size > 4 * 1024 * 1024) continue;
  const text = readFileSync(full, "utf8");
  for (const rule of IDENTITY) {
    const hits = text.match(rule.re);
    if (hits && !isExempt(f, hits)) {
      identityHits++;
      fail(`${rule.name}`, `${f} -> ${hits.slice(0, 2).join(", ")}`);
    }
  }
}
if (!identityHits) ok("无本机身份信息", `${textFiles.length} 个文本文件已扫描`);

/* ------------------------------- 3b. verbatim source-document text in text files */

/**
 * The subtlest leak, and the reason this audit exists rather than a file-name
 * check.
 *
 * Deleting the source PDFs was not enough: `evidence/*.png` were screenshots of
 * the app open on a real paper, and `test-artifacts/*.json` held extracted text —
 * both reproducing title, authors, affiliation and body verbatim. A rule keyed on
 * extensions never sees that. So the document's own distinctive phrases are
 * searched for directly, in text and (via the extension rules above) in binaries.
 *
 * A single *citation* of a paper's title is normal academic practice and is not
 * infringement, so a line that is mostly a citation is not what this looks for:
 * it looks for long verbatim runs, which is what extraction produces.
 */
/**
 * Signatures of the documents these fixtures were originally built from.
 *
 * Titles only, deliberately. A title is a citation and citing one is normal
 * academic practice; the author names and affiliations that were also extracted
 * into `test-artifacts/*.json` are personal data, and an audit whose job is to
 * keep that out of the repository should not carry it in its own source.
 */
const SOURCE_PHRASES = [
  "Bayesian Machine Learning",
  "Junction Temperature Extraction Based on Device Structural",
  "Benchmarking Optimization Algorithms for BSIM-CMG",
];
/** 200 characters of unbroken source text is extraction, not a citation. */
const LONG_RUN = /[A-Za-z][A-Za-z ,.'-]{200,}/g;

/**
 * Where extracted document text can hide.
 *
 * Scoped on purpose: source files and prose legitimately contain long English
 * runs (a schema description, a paragraph in a generator), so a global rule
 * cries wolf and people stop reading the audit. The leak vector is *captured
 * data* — extracted text, logs, dumps — which is where this is aimed.
 */
const CAPTURED = /^(evidence|test-artifacts|output)\//;

let textLeak = 0;
for (const f of textFiles.filter((p) => CAPTURED.test(p))) {
  const full = path.join(ROOT, f);
  if (!existsSync(full) || statSync(full).size > 4 * 1024 * 1024) continue;
  const text = readFileSync(full, "utf8");
  const run = text.match(LONG_RUN);
  if (run) {
    textLeak++;
    fail("疑似逐字复现文献正文", `${f} -> 存在 ${run[0].length} 字符的连续英文`);
  }
  for (const phrase of SOURCE_PHRASES) {
    const count = text.split(phrase).length - 1;
    if (count > 0) {
      textLeak++;
      fail("文献特征短语", `${f} -> "${phrase}" x${count}`);
    }
  }
}
if (!textLeak) ok("捕获产物中无逐字复现的文献正文");

/* ----------------------------------------------------------- 4. secrets -- */

const SECRET = [
  { name: "API 密钥形态", re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: "AWS 访问密钥", re: /\bAKIA[0-9A-Z]{16}\b/g },
];
let secretHits = 0;
for (const f of textFiles) {
  const full = path.join(ROOT, f);
  if (!existsSync(full) || statSync(full).size > 4 * 1024 * 1024) continue;
  const text = readFileSync(full, "utf8");
  for (const rule of SECRET) {
    const hits = text.match(rule.re);
    if (hits && !isExempt(f, hits)) {
      secretHits++;
      // Never masked here on purpose: a key in a tracked file was live, and the
      // only correct response is to rotate it.
      fail(`${rule.name}（必须轮换，不是打码）`, `${f} -> ${hits.slice(0, 1).join(", ")}`);
    }
  }
}
if (!secretHits) ok("无密钥形态字符串");

/* ------------------------------------------------------------ 5. repo size -- */

const sizeOut = git("count-objects", "-vH");
const pack = /size-pack:\s*([\d.]+)\s*(\w+)/.exec(sizeOut);
const packMb = pack ? parseFloat(pack[1]) * (pack[2] === "GiB" ? 1024 : 1) : 0;
if (packMb > 200) warn("仓库 pack 偏大", `${packMb.toFixed(0)} MB`);
else ok("仓库体积", `${packMb.toFixed(1)} MB`);

/* ---------------------------------------------------------------- summary -- */

console.log(
  `\n${failures ? `${failures} 项失败` : "全部通过"}` +
    (warnings ? ` · ${warnings} 项提醒` : "") +
    `\n结论：${failures ? "尚不适合公开" : "可以改为公开（Settings → Danger Zone）"}`
);
process.exit(failures ? 1 : 0);
