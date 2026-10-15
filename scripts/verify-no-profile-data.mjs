#!/usr/bin/env node
/**
 * Fail if browser-profile data has crept into the repository.
 *
 * Why this exists: the CDP experiments in Phase 2 launched Edge with
 * `--user-data-dir` pointing inside `evidence/`. Those directories ended up
 * holding real profile data — Cookies, History, Web Data and a `Login Data`
 * database with 267 saved-credential rows — plus the `Local State` file that
 * carries the key material protecting them. 1477 of those files were committed.
 *
 * A fresh Edge profile provably has zero such rows, so this was not benign
 * filler. Nothing in the pipeline was looking, which is the actual defect this
 * script fixes.
 *
 * Checks, in order:
 *   1. `git ls-files` must contain no profile directory and no credential
 *      database by name.
 *   2. The working tree must contain no directory whose name ends in
 *      `-profile` (a leftover is a loaded gun for the next commit).
 *
 * Usage: node scripts/verify-no-profile-data.mjs
 * Exits non-zero on any finding.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Files that only exist in a browser profile, and are worth naming explicitly. */
const CREDENTIAL_DB_NAMES = new Set([
  "Cookies",
  "Cookies-journal",
  "Login Data",
  "Login Data-journal",
  "Login Data For Account",
  "History",
  "History-journal",
  "Web Data",
  "Web Data-journal",
  "Local State",
  "Secure Preferences",
  "Preferences",
]);

const PROFILE_SUFFIX = "-profile";

const findings = [];

// --- 1. tracked files -------------------------------------------------------
let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} catch (e) {
  console.error(`could not run git ls-files: ${e.message}`);
  process.exit(2);
}

for (const f of tracked) {
  const parts = f.split("/");
  if (parts.some((p) => p.endsWith(PROFILE_SUFFIX))) {
    findings.push({ where: "tracked", what: f, why: "path is inside a *-profile directory" });
    continue;
  }
  const base = parts[parts.length - 1];
  if (CREDENTIAL_DB_NAMES.has(base)) {
    findings.push({ where: "tracked", what: f, why: `browser credential/settings database (${base})` });
  }
}

// --- 2. working tree --------------------------------------------------------
function walk(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(dir, e.name);
    if (e.name.endsWith(PROFILE_SUFFIX)) {
      // Not a symlink, surely — but if it is, say so rather than mislead.
      let link = "";
      try {
        const st = statSync(p);
        link = st.isDirectory() ? "" : " (not a plain directory)";
      } catch {
        link = " (unreadable)";
      }
      findings.push({
        where: "working tree",
        what: path.relative(ROOT, p),
        why: `browser profile directory left on disk${link}`,
      });
      continue; // do not descend into it
    }
    walk(p, depth + 1);
  }
}
walk(ROOT);

// --- report -----------------------------------------------------------------
console.log(`tracked files scanned : ${tracked.length}`);
console.log(`profile directories   : ${findings.length ? "FOUND" : "none"}`);
console.log("");

if (findings.length) {
  console.error("FAIL — browser profile data is present and must not be:\n");
  for (const f of findings.slice(0, 40)) {
    console.error(`  [${f.where}] ${f.what}\n      ${f.why}`);
  }
  if (findings.length > 40) console.error(`  ... and ${findings.length - 40} more`);
  console.error(
    "\nA browser profile holds saved credentials, cookies and full history. It must\n" +
      "never be committed. Delete the directory, add `*-profile/` to .gitignore, and\n" +
      "if it was already committed, purge it from history too — untracking alone\n" +
      "leaves the blobs retrievable in previous commits."
  );
  process.exit(1);
}

console.log("PASS — no browser profile directory and no credential database in the repo.");
