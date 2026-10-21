#!/usr/bin/env node
/* 依存のクールダウン検査（2026-10-22・正本は arcrise-labs の cyber-securities/tools/dep-age-check.mjs）
   守るもの: package-lock.json に新しく入った版・変わった版が、
     - npm レジストリで公開から MIN_DAYS 日（既定 7）以上たっていること
     - 非推奨（deprecated）でないこと
   なぜ: `.npmrc` の min-release-age は npm install / update の版選びにしか効かず、
     lock に入った版は npm ci でそのまま入る（2026-10-22 に npm 11.19.1 で実測）。
     npm 10 は min-release-age を読まない。lock をすり抜けた分をここで止める。
   使い方: node dep-age-check.mjs --base <git ref> [--days 7] [lock のパス ...]
     lock を省くと、base と HEAD の差分に出た package-lock.json を全部見る。
   例外: リポジトリ直下の .dep-age-allow に「名前@版 理由」を 1 行ずつ書く（急ぎのセキュリティ修正だけ）。
   依存パッケージは使わない（Node 18 以上の標準機能だけ）。 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const REGISTRY = "https://registry.npmjs.org/";

/** lockfileVersion 2/3 の packages から「名前@版」の集合を作る。npm レジストリ以外（file:・git・link）は外す。純関数 */
export function entries(lockText) {
  if (!lockText) return new Map();
  const lock = JSON.parse(lockText);
  const out = new Map();
  for (const [path, p] of Object.entries(lock.packages || {})) {
    if (!path || p.link || !p.version) continue;
    if (p.resolved && !p.resolved.startsWith(REGISTRY)) continue;
    const name = p.name || path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    out.set(`${name}@${p.version}`, { name, version: p.version });
  }
  return out;
}

/** base に無く head にある「名前@版」だけを返す。純関数 */
export function added(baseText, headText) {
  const b = entries(baseText);
  return [...entries(headText)].filter(([k]) => !b.has(k)).map(([, v]) => v);
}

/** 公開日・非推奨の情報から違反を返す。純関数 */
export function judge(pkg, meta, now, minDays) {
  const t = meta?.time?.[pkg.version];
  if (!t) return `${pkg.name}@${pkg.version}: 公開日がレジストリで見つからない`;
  const days = (now - Date.parse(t)) / 86400000;
  const dep = meta?.versions?.[pkg.version]?.deprecated;
  if (dep) return `${pkg.name}@${pkg.version}: 非推奨（${String(dep).slice(0, 120)}）`;
  if (days < minDays) return `${pkg.name}@${pkg.version}: 公開から ${days.toFixed(1)} 日（${minDays} 日未満）`;
  return null;
}

function allowList() {
  if (!fs.existsSync(".dep-age-allow")) return new Set();
  return new Set(
    fs
      .readFileSync(".dep-age-allow", "utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((s) => s && !s.startsWith("#")),
  );
}

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
}

function show(ref, path) {
  try {
    return git("show", `${ref}:${path}`);
  } catch {
    return "";
  }
}

async function main(argv) {
  const i = argv.indexOf("--base");
  if (i < 0 || !argv[i + 1]) {
    console.error("--base <git ref> が要る");
    process.exit(2);
  }
  const base = argv[i + 1];
  const d = argv.indexOf("--days");
  const minDays = d >= 0 ? Number(argv[d + 1]) : 7;
  const skip = new Set([i, i + 1, d, d + 1]);
  let locks = argv.filter((a, k) => !skip.has(k) && !a.startsWith("--"));
  if (locks.length === 0) {
    locks = git("diff", "--name-only", `${base}...HEAD`)
      .split("\n")
      .filter((f) => /(^|\/)package-lock\.json$/.test(f));
  }
  const allow = allowList();
  const pkgs = new Map();
  for (const lock of locks) {
    const headText = fs.existsSync(lock) ? fs.readFileSync(lock, "utf8") : "";
    for (const p of added(show(base, lock), headText)) pkgs.set(`${p.name}@${p.version}`, p);
  }
  const now = Date.now();
  const bad = [];
  for (const [key, p] of pkgs) {
    if (allow.has(key)) {
      console.log(`許可リストで通す: ${key}`);
      continue;
    }
    const res = await fetch(REGISTRY + p.name.replace("/", "%2f"), { headers: { accept: "application/json" } });
    if (!res.ok) {
      bad.push(`${key}: レジストリから読めない（HTTP ${res.status}）`);
      continue;
    }
    const v = judge(p, await res.json(), now, minDays);
    if (v) bad.push(v);
  }
  console.log(`lock ${locks.length} 個、新しく入った版 ${pkgs.size} 件を確かめた`);
  if (bad.length) {
    console.error(`✗ ${bad.length} 件が通らない:\n  ${bad.join("\n  ")}`);
    console.error("急ぎのセキュリティ修正なら、承認のうえ .dep-age-allow に「名前@版 理由」を書く");
    process.exit(1);
  }
  console.log("OK");
}

if (process.argv.includes("--selftest")) {
  const lock = (pk) => JSON.stringify({ lockfileVersion: 3, packages: pk });
  const now = Date.parse("2026-10-22T00:00:00Z");
  const meta = {
    time: { "1.0.0": "2026-10-01T00:00:00Z", "1.0.1": "2026-10-20T00:00:00Z" },
    versions: { "1.0.0": {}, "1.0.1": {}, "0.9.0": { deprecated: "使わない" } },
  };
  meta.time["0.9.0"] = "2025-01-01T00:00:00Z";
  const cases = [
    [
      "ルートと file: と link を外す",
      () =>
        entries(
          lock({
            "": { version: "1" },
            "node_modules/a": { version: "1.0.0", resolved: REGISTRY + "a/-/a-1.0.0.tgz" },
            "node_modules/b": { version: "1.0.0", resolved: "file:../b" },
            "node_modules/c": { link: true },
          }),
        ).size === 1,
    ],
    [
      "入れ子の node_modules から名前を取る",
      () =>
        entries(
          lock({
            "node_modules/x/node_modules/@s/y": { version: "2.0.0" },
          }),
        ).has("@s/y@2.0.0"),
    ],
    [
      "増えた版だけを返す",
      () =>
        added(
          lock({ "node_modules/a": { version: "1.0.0" } }),
          lock({ "node_modules/a": { version: "1.0.1" }, "node_modules/b": { version: "1.0.0" } }),
        ).length === 2,
    ],
    [
      "変わらない版は返さない",
      () =>
        added(lock({ "node_modules/a": { version: "1.0.0" } }), lock({ "node_modules/a": { version: "1.0.0" } }))
          .length === 0,
    ],
    [
      "新しい lock だけ（base に無い）は全部返す",
      () => added("", lock({ "node_modules/a": { version: "1.0.0" } })).length === 1,
    ],
    ["7 日以上は通す", () => judge({ name: "a", version: "1.0.0" }, meta, now, 7) === null],
    ["7 日未満は落とす", () => /日未満/.test(judge({ name: "a", version: "1.0.1" }, meta, now, 7))],
    ["非推奨は落とす", () => /非推奨/.test(judge({ name: "a", version: "0.9.0" }, meta, now, 7))],
    ["公開日が無ければ落とす", () => /見つからない/.test(judge({ name: "a", version: "9.9.9" }, meta, now, 7))],
  ];
  let ng = 0;
  for (const [n, f] of cases) {
    const ok = f();
    if (!ok) ng++;
    console.log(`  ${ok ? "ok" : "NG"}   ${n}`);
  }
  console.log(ng ? `NG ${ng}件` : `OK ${cases.length}件`);
  process.exit(ng ? 1 : 0);
} else {
  main(process.argv.slice(2)).catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
