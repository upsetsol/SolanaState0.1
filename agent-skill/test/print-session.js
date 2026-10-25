#!/usr/bin/env node
'use strict'

// Print a Claude Code session log as a readable timeline: what the user typed, what the agent said (in full), which commands it ran
// and the start of each result. Used to judge the live tests (zero-state kit, red-team lab, ...).
//
//   node agent-skill/test/print-session.js --workspace ~/sim-user3             the newest session of that folder
//   node agent-skill/test/print-session.js --workspace ~/sim-user3 --all       list the sessions (id, start, end, user messages)
//   node agent-skill/test/print-session.js --workspace ~/sim-user3 --session <id>
//   node agent-skill/test/print-session.js --file <path to a .jsonl>           a log file directly
//   --chars N   how much of every command result to show (default 260)
//
// The skill text that Claude loads into the conversation is hidden (it is long); e-mail addresses are masked.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d }
const flag = (n) => args.includes('--' + n)
const expand = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p)

const redact = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
const hms = (t) => (t ? t.slice(11, 19) : '')
const maxResult = Number(opt('chars', 260))

function sessionsOf(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => {
    const p = path.join(dir, f)
    let first = null, last = null, users = 0
    for (const l of fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)) {
      try {
        const o = JSON.parse(l)
        if (o.timestamp) { first = first || o.timestamp; last = o.timestamp }
        if (o.type === 'user' && !o.isMeta && o.message && typeof o.message.content === 'string' && !o.message.content.startsWith('Base directory for this skill')) users++
      } catch { /* skip */ }
    }
    return { id: f.replace(/\.jsonl$/, ''), path: p, mtime: fs.statSync(p).mtimeMs, first, last, users }
  }).sort((a, b) => b.mtime - a.mtime)
}

let file = expand(opt('file'))
if (!file) {
  const ws = expand(opt('workspace'))
  if (!ws) { console.error('give --workspace <folder> or --file <log.jsonl>'); process.exit(2) }
  const dir = path.join(os.homedir(), '.claude', 'projects', path.resolve(ws).replace(/[^A-Za-z0-9]/g, '-'))
  const list = sessionsOf(dir)
  if (flag('all')) {
    list.forEach((s) => console.log(`${s.id}  first=${s.first}  last=${s.last}  userMessages=${s.users}`))
    if (!list.length) console.log('no sessions yet in ' + dir)
    process.exit(0)
  }
  const want = opt('session')
  const s = want ? list.find((x) => x.id === want) : list[0]
  if (!s) { console.error('no session found in ' + dir); process.exit(1) }
  file = s.path
}

const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
const results = new Map()
for (const o of lines) {
  if (o.type === 'user' && o.message && Array.isArray(o.message.content)) {
    for (const c of o.message.content) {
      if (c.type === 'tool_result') results.set(c.tool_use_id, typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join('\n') : JSON.stringify(c.content))
    }
  }
}
console.log('=== ' + file)
for (const o of lines) {
  const m = o.message
  if (!m || o.isMeta) continue
  if (o.type === 'user') {
    const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : []
    for (const c of parts) if (c.type === 'text' && !c.text.startsWith('Base directory for this skill')) console.log(`\n[${hms(o.timestamp)}] USER: ${redact(c.text)}`)
  } else if (o.type === 'assistant' && Array.isArray(m.content)) {
    for (const c of m.content) {
      if (c.type === 'text') console.log(`\n[${hms(o.timestamp)}] ASSISTANT:\n${redact(c.text)}`)
      if (c.type === 'tool_use') {
        const what = c.name === 'Bash' ? c.input.command : JSON.stringify(c.input)
        const r = results.get(c.id)
        console.log(`\n[${hms(o.timestamp)}] ${c.name}: ${redact(what)}${r ? '\n    => ' + redact(r).replace(/\s+/g, ' ').slice(0, maxResult) : ''}`)
      }
    }
  }
}
