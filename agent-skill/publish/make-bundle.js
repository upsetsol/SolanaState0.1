#!/usr/bin/env node
'use strict'

// Build the PUBLIC repository folder for the skill and the CLI, ready to be uploaded to a neutral GitHub account.
//
//   node agent-skill/publish/make-bundle.js --owner <github account> --repo <repository name> [--out <folder>] [--force]
//
// Layout of the result (what the public repository will look like):
//   README.md  LICENSE  package.json      (no dot-files on purpose: they are hidden in Finder and would be missed by a drag-and-drop upload)
//   skills/onchain-state/SKILL.md + references/   <- the skill (`npx skills add <owner>/<repo>` finds it under skills/)
//   cli/bin  cli/src  cli/idl                     <- the `onstate` command (`npm install -g github:<owner>/<repo>`)
//   docs/RED_TEAM_ROUND_1.md
//
// Before it finishes, the script checks that no file contains a personal name, path or account (a list of forbidden words) and that every
// JavaScript file parses. It leaves the folder in place for inspection and exits with an error when something is wrong.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const flag = (n) => args.includes('--' + n)
const die = (m) => { console.error('ERROR: ' + m); process.exit(1) }

const OWNER = opt('owner')
const REPO = opt('repo')
if (!OWNER || !REPO) die('usage: node make-bundle.js --owner <github account> --repo <repository name> [--out <folder>] [--force]')
if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(OWNER)) die(`"${OWNER}" is not a valid GitHub account name`)
if (!/^[A-Za-z0-9._-]{1,100}$/.test(REPO)) die(`"${REPO}" is not a valid repository name`)

const AS = path.resolve(__dirname, '..') // agent-skill
const TPL = path.join(__dirname, 'templates')
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)
const OUT = path.resolve(expand(opt('out', path.join(os.homedir(), 'Desktop', 'onstate-public'))))

// ---------- the output folder ----------
if (fs.existsSync(OUT) && fs.readdirSync(OUT).length) {
  let ours = false
  try { ours = JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8')).name === 'onstate-cli' } catch { /* not ours */ }
  if (!flag('force')) die(`${OUT} is not empty. Pass --force to rebuild it (only a folder produced by this script is replaced).`)
  if (!ours) die(`${OUT} does not look like a folder produced by this script (no package.json named onstate-cli); I will not delete it.`)
  fs.rmSync(OUT, { recursive: true, force: true })
}
fs.mkdirSync(OUT, { recursive: true })

// ---------- helpers ----------
const render = (s) => s.replace(/\{\{OWNER\}\}/g, OWNER).replace(/\{\{REPO\}\}/g, REPO)
function put(rel, content) {
  const p = path.join(OUT, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
function copyFile(srcAbs, rel) { put(rel, fs.readFileSync(srcAbs)) }
function copyTree(srcDir, relDir, keep = () => true) {
  for (const e of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.DS_Store') continue
    const abs = path.join(srcDir, e.name)
    const rel = path.join(relDir, e.name)
    if (e.isDirectory()) copyTree(abs, rel, keep)
    else if (keep(e.name)) copyFile(abs, rel)
  }
}

// ---------- the content ----------
copyTree(path.join(AS, 'cli', 'bin'), 'cli/bin')
copyTree(path.join(AS, 'cli', 'src'), 'cli/src')
copyTree(path.join(AS, 'cli', 'idl'), 'cli/idl')

put('skills/onchain-state/SKILL.md', fs.readFileSync(path.join(AS, 'SKILL.md')))
copyTree(path.join(AS, 'references'), 'skills/onchain-state/references', (n) => n !== 'setup.md')
put('skills/onchain-state/references/setup.md', render(fs.readFileSync(path.join(TPL, 'setup.md'), 'utf8')))

put('README.md', render(fs.readFileSync(path.join(TPL, 'README.md'), 'utf8')))
put('LICENSE', fs.readFileSync(path.join(TPL, 'LICENSE')))

const results = fs.readFileSync(path.join(AS, 'test', 'redteam', 'RESULTS-2026-10-25.md'), 'utf8')
const [title, ...rest] = results.split('\n')
put('docs/RED_TEAM_ROUND_1.md', [title, '', '*The test lab itself (fake wallet, local chain, helper scripts) is not part of this repository; this page only reports what it found.*', ...rest].join('\n'))

const dev = JSON.parse(fs.readFileSync(path.join(AS, 'cli', 'package.json'), 'utf8'))
const pkg = {
  name: 'onstate-cli',
  version: dev.version,
  description: "Agent CLI for an On-Chain State on Solana: it reads the chain and builds unsigned transactions that the user's agent wallet signs. It never holds keys.",
  license: 'MIT',
  type: 'commonjs',
  bin: { onstate: 'cli/bin/onstate.js' },
  files: ['cli/bin', 'cli/src', 'cli/idl', 'skills', 'README.md', 'LICENSE'],
  engines: { node: '>=18' },
  dependencies: dev.dependencies,
  repository: { type: 'git', url: `git+https://github.com/${OWNER}/${REPO}.git` },
  homepage: `https://github.com/${OWNER}/${REPO}#readme`,
  keywords: ['solana', 'ai-agent', 'agent-skill', 'governance', 'dao'],
}
put('package.json', JSON.stringify(pkg, null, 2) + '\n')

// ---------- checks ----------
const FORBIDDEN = [
  /roman/i, /nikita/i, /роман/, /Роман/, /никит/i, /talanin/i, /upsetsol/i, /degenjess/i, /outlook/i, /gmail/i, /\bpoop\b/i,
  /\/Users\//, /\/home\/[a-z]/i, /C:\\Users/i, /SolanaState/i, /onchain-state-solana-main/, /Desktop/, /\{\{/,
]
const files = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name)
    if (e.isDirectory()) walk(abs)
    else files.push(abs)
  }
})(OUT)

const problems = []
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8')
  text.split('\n').forEach((line, i) => {
    for (const rx of FORBIDDEN) if (rx.test(line)) problems.push(`${path.relative(OUT, f)}:${i + 1} matches ${rx}: ${line.trim().slice(0, 110)}`)
  })
  if (f.endsWith('.js')) {
    try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }) } catch (e) { problems.push(`${path.relative(OUT, f)}: does not parse: ${String(e.stderr || e.message).split('\n')[0]}`) }
  }
}
try { JSON.parse(fs.readFileSync(path.join(OUT, 'package.json'), 'utf8')); JSON.parse(fs.readFileSync(path.join(OUT, 'cli/idl/onchain_state_solana.json'), 'utf8')) } catch (e) { problems.push('a JSON file does not parse: ' + e.message) }

// ---------- report ----------
const total = files.reduce((s, f) => s + fs.statSync(f).size, 0)
console.log(`bundle for github.com/${OWNER}/${REPO} written to ${OUT}`)
for (const f of files.sort()) console.log(`  ${String(fs.statSync(f).size).padStart(8)}  ${path.relative(OUT, f)}`)
console.log(`  ${files.length} files, ${(total / 1024).toFixed(0)} KiB`)
if (problems.length) {
  console.error('\nPROBLEMS (fix them before uploading anything):')
  problems.forEach((p) => console.error('  ' + p))
  process.exit(1)
}
console.log('\nchecks passed: no personal names, paths or accounts in any file; every JavaScript file parses; JSON files are valid.')
