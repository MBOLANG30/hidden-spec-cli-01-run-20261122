// mend: one patch tool for every AI edit format. Written for the make.fun
// hidden-spec-cli-01 bounty from SPEC.md (version 1). It reads a patch in one
// of four formats (unified diff, SEARCH/REPLACE, V4A, JSON edits), finds the
// lines each edit names at the first of three matching tiers, and writes
// every change or none. Node 22, standard library only; run as
// `node main.ts [options] [PATCH]`.
//
// The trial hand-over at the bottom is kept as the kit has it: when
// MAKEFUN_ENV_URL is set, the run is handed to runner.ts.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse-level failure: the CLI answers exit 2 with this one line. */
class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: the CLI answers exit 1 and names this code and path. */
class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed from each, and the
 * empty piece after a final \n dropped. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines: its line break, its lines, and whether it ends with
 * a line break. An empty file has no lines and no final break. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function fileModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const firstNl = text.indexOf('\n');
  const br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function modelText(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/* ---- Section 5: three-tier line matching ---- */

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimLead = (s: string): string => s.replace(/^[ \t]+/, '');
const trimBoth = (s: string): string => trimLead(trimTrail(s));
const leadOf = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

/** Every 0-based position where O matches the file's lines at this tier. */
function occurrences(lines: string[], oldLines: string[], tier: number): number[] {
  const out: number[] = [];
  if (oldLines.length === 0) return out;
  for (let i = 0; i + oldLines.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < oldLines.length; j += 1) {
      if (!lineEq(oldLines[j]!, lines[i + j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 with --strict) at which O
 * occurs at least once, with all its positions, or null when it never does. */
function findTier(lines: string[], oldLines: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(lines, oldLines, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of N: a context line names its index in O, any other line null. */
interface NewLine {
  text: string;
  ctx: number | null;
}

/** The lines that replace a match: context lines are the file's own matched
 * lines; at tier 2 every other line is re-indented from O's first line's
 * leading whitespace to the file's first matched line's. */
function buildReplacement(entries: NewLine[], fileLines: string[], at: number, tier: number, oldLines: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (e.ctx !== null) {
      out.push(fileLines[at + e.ctx]!);
      continue;
    }
    let t = e.text;
    if (tier === 2 && oldLines.length > 0) {
      const f = leadOf(fileLines[at]!);
      const p = leadOf(oldLines[0]!);
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk; `moves` records successful move edits. */
class Tree {
  private orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; next: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---- Section 9: JSON edits ---- */

/** One JSON edit object, or null when the value is not a valid edit. */
function makeJsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const p = o.path;
  const needExisting = (tree: Tree): string => {
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '' || (o.new_str !== undefined && typeof o.new_str !== 'string')) return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = needExisting(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line) || typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree) => {
      const before = needExisting(tree);
      const m = fileModel(before);
      if (lineNo < 0 || lineNo > m.lines.length) throw new Fail('no-match', p);
      const ls = [...m.lines];
      ls.splice(lineNo, 0, ...add);
      tree.now.set(p, modelText({ lines: ls, br: m.br, final: m.final }));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    const out: Edit[] = [];
    for (const x of v) {
      const e = makeJsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      out.push(e);
    }
    return out;
  }
  const out: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = makeJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    out.push(e);
  });
  return out;
}

/* ---- Section 6: unified diffs ---- */

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  emptySrc: boolean;
}

interface Hunk {
  a: number;
  items: BodyItem[];
  /** A `\` line follows the hunk's last context or `+` line. */
  bsAfterLast: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  bsAfterLastPlus: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  createFlag: boolean;
  deleteFlag: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` / `+++ ` line names, or null for `/dev/null`. */
function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

/** A hunk's body: lines after its header that start with ` `, `-`, `+` or
 * `\`, or are empty; trailing empty lines are not part of it. */
function readHunkBody(lines: string[], start: number): { items: BodyItem[]; next: number } {
  const items: BodyItem[] = [];
  let i = start;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      items.push({ kind: 'ctx', text: '', emptySrc: true });
      i += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ') {
      items.push({ kind: 'ctx', text: l.slice(1), emptySrc: false });
      i += 1;
      continue;
    }
    if (c === '-') {
      items.push({ kind: 'old', text: l.slice(1), emptySrc: false });
      i += 1;
      continue;
    }
    if (c === '+') {
      items.push({ kind: 'new', text: l.slice(1), emptySrc: false });
      i += 1;
      continue;
    }
    if (c === '\\') {
      items.push({ kind: 'bs', text: l.slice(1), emptySrc: false });
      i += 1;
      continue;
    }
    break;
  }
  while (items.length > 0 && items[items.length - 1]!.kind === 'ctx' && items[items.length - 1]!.emptySrc) items.pop();
  return { items, next: i };
}

function hunkFlags(items: BodyItem[]): { bsAfterLast: boolean; bsAfterLastPlus: boolean } {
  let bsAfterLast = false;
  let bsAfterLastPlus = false;
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i]!;
    if ((it.kind === 'ctx' || it.kind === 'new') && items[i + 1]?.kind === 'bs') bsAfterLast = true;
    if (it.kind === 'new' && items[i + 1]?.kind === 'bs') bsAfterLastPlus = true;
  }
  // Only a `\` after the *last* context/`+` (or last `+`) line counts.
  let lastCtx = -1;
  let lastPlus = -1;
  items.forEach((it, i) => {
    if (it.kind === 'ctx' || it.kind === 'new') lastCtx = i;
    if (it.kind === 'new') lastPlus = i;
  });
  bsAfterLast = lastCtx >= 0 && items[lastCtx + 1]?.kind === 'bs';
  bsAfterLastPlus = lastPlus >= 0 && items[lastPlus + 1]?.kind === 'bs';
  return { bsAfterLast, bsAfterLastPlus };
}

/** A hunk's old lines O and new lines N (context lines carry their index). */
function hunkON(h: Hunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of h.items) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      n.push({ text: it.text, ctx: idx });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: null });
    }
  }
  return { o, n };
}

/** Apply a section's hunks in order to a file's model. */
function applyHunks(m: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  let cur = [...m.lines];
  let fin = m.final;
  let d = 0;
  for (const h of hunks) {
    const { o, n } = hunkON(h);
    if (o.length > 0) {
      const found = findTier(cur, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0]!;
      let bestDist = Math.abs(best - target);
      for (const pos of found.positions) {
        const dist = Math.abs(pos - target);
        if (dist < bestDist) {
          best = pos;
          bestDist = dist;
        }
      }
      const rep = buildReplacement(n, cur, best, found.tier, o);
      const touchesEnd = best + o.length === cur.length;
      cur = [...cur.slice(0, best), ...rep, ...cur.slice(best + o.length)];
      if (touchesEnd) fin = !h.bsAfterLast;
    } else {
      const ins = Math.max(0, Math.min(h.a + d, cur.length));
      const rep = n.map((e) => e.text);
      const touchesEnd = ins === cur.length;
      cur = [...cur.slice(0, ins), ...rep, ...cur.slice(ins)];
      if (touchesEnd && rep.length > 0) fin = !h.bsAfterLast;
    }
    d += n.length - o.length;
  }
  return { lines: cur, br: m.br, final: fin };
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  const oldP = sec.pairOld ?? sec.renameOld ?? sec.diffOld ?? null;
  const newP = sec.pairNew ?? sec.renameNew ?? sec.diffNew ?? null;
  let kind: 'create' | 'delete' | 'move' | 'change';
  if ((sec.createFlag || oldP === null) && newP !== null) kind = 'create';
  else if ((sec.deleteFlag || newP === null) && oldP !== null) kind = 'delete';
  else if (oldP !== null && newP !== null && oldP !== newP) kind = 'move';
  else if (oldP !== null) kind = 'change';
  else kind = 'delete';
  return (tree) => {
    if (kind === 'create') {
      const p = newP!;
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusHunk: Hunk | null = null;
      for (const h of sec.hunks) {
        if (h.items.some((it) => it.kind === 'new')) lastPlusHunk = h;
        for (const it of h.items) if (it.kind === 'new') plus.push(it.text);
      }
      const fin = lastPlusHunk === null ? true : !lastPlusHunk.bsAfterLastPlus;
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      return;
    }
    if (kind === 'delete') {
      const p = oldP === null ? '/dev/null' : oldP;
      if (oldP !== null && !isSafe(oldP)) throw new Fail('unsafe', oldP);
      if (oldP === null || tree.get(oldP) === null) throw new Fail('missing', p);
      tree.now.set(oldP, null);
      return;
    }
    if (kind === 'move') {
      const o = oldP!;
      const n = newP!;
      if (!isSafe(o)) throw new Fail('unsafe', o);
      if (!isSafe(n)) throw new Fail('unsafe', n);
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const done = applyHunks(fileModel(cur), sec.hunks, strict, o);
      tree.now.set(n, modelText(done));
      tree.now.set(o, null);
      tree.moves.push({ old: o, next: n });
      return;
    }
    const p = oldP!;
    if (!isSafe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    const done = applyHunks(fileModel(cur), sec.hunks, strict, p);
    tree.now.set(p, modelText(done));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (oldP: string | null, newP: string | null): void => {
    const s: Section = { diffOld: oldP, diffNew: newP, createFlag: false, deleteFlag: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ') || l === 'diff --git') {
      const m = /^diff --git a\/(\S+) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!.trim());
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const op = headerPath(l);
      const np = headerPath(lines[i + 1]!);
      if (cur !== null && inHeader) {
        cur.pairOld = op;
        cur.pairNew = np;
      } else {
        startSection(op, np);
      }
      i += 2;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body = readHunkBody(lines, i + 1);
      const flags = hunkFlags(body.items);
      cur.hunks.push({ a: Number(m[1]), items: body.items, bsAfterLast: flags.bsAfterLast, bsAfterLastPlus: flags.bsAfterLastPlus });
      inHeader = false;
      i = body.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('rename from ')) cur.renameOld = l.slice(12).trim();
      else if (l.startsWith('rename to ')) cur.renameNew = l.slice(10).trim();
      else if (l.startsWith('new file mode')) cur.createFlag = true;
      else if (l.startsWith('deleted file mode')) cur.deleteFlag = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/* ---- Section 7: SEARCH/REPLACE blocks ---- */

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let lastPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (!isBlank(l) && !l.trim().startsWith('```')) {
        path = l.trim();
        break;
      }
    }
    if (path === null) {
      if (lastPath !== null) path = lastPath;
      else throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    lastPath = path;
    let eqIdx = -1;
    for (let k = searchIdx + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        eqIdx = k;
        break;
      }
      if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
    }
    if (eqIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let repIdx = -1;
    for (let k = eqIdx + 1; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        repIdx = k;
        break;
      }
    }
    if (repIdx < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, repIdx);
    const p = path;
    edits.push((tree) => {
      if (!isSafe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const m = fileModel(cur);
      const found = findTier(m.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length > 1) throw new Fail('ambiguous', p);
      const at = found.positions[0]!;
      const entries: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      const rep = buildReplacement(entries, m.lines, at, found.tier, oldLines);
      const out = [...m.lines.slice(0, at), ...rep, ...m.lines.slice(at + oldLines.length)];
      tree.now.set(p, modelText({ lines: out, br: m.br, final: m.final }));
    });
    prevEnd = repIdx;
    i = repIdx + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Section 8: V4A patches ---- */

const ADD_PREFIX = '*** Add File: ';
const DEL_PREFIX = '*** Delete File: ';
const UPD_PREFIX = '*** Update File: ';
const MOV_PREFIX = '*** Move to: ';

function isSectionStart(l: string): boolean {
  return l.startsWith(ADD_PREFIX) || l.startsWith(DEL_PREFIX) || l.startsWith(UPD_PREFIX);
}

interface VChunk {
  anchor: string;
  body: BodyItem[];
  eof: boolean;
}

function chunkON(c: VChunk): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const it of c.body) {
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push(it.text);
      n.push({ text: it.text, ctx: idx });
    } else if (it.kind === 'old') {
      o.push(it.text);
    } else if (it.kind === 'new') {
      n.push({ text: it.text, ctx: null });
    }
  }
  return { o, n };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const firstIdx = lines.findIndex((l) => !isBlank(l));
  if (firstIdx < 0) throw new Exit2('error: parse 1');
  if (lines[firstIdx]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstIdx + 1}`);
  let lastIdx = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      lastIdx = k;
      break;
    }
  }
  if (lines[lastIdx]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = firstIdx + 1;
  while (i < lastIdx) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    if (l.startsWith(ADD_PREFIX)) {
      const p = l.slice(ADD_PREFIX.length).trim();
      const entries: { text: string; blank: boolean }[] = [];
      let j = i + 1;
      while (j < lastIdx && !isSectionStart(lines[j]!)) {
        const x = lines[j]!;
        if (isBlank(x)) entries.push({ text: '', blank: true });
        else if (x.startsWith('+')) entries.push({ text: x.slice(1), blank: false });
        else throw new Exit2(`error: parse ${j + 1}`);
        j += 1;
      }
      while (entries.length > 0 && entries[entries.length - 1]!.blank) entries.pop();
      const fileLines = entries.map((e) => e.text);
      edits.push((tree) => {
        if (!isSafe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (l.startsWith(DEL_PREFIX)) {
      const p = l.slice(DEL_PREFIX.length).trim();
      let j = i + 1;
      while (j < lastIdx && isBlank(lines[j]!)) j += 1;
      if (j < lastIdx && !isSectionStart(lines[j]!)) throw new Exit2(`error: parse ${j + 1}`);
      edits.push((tree) => {
        if (!isSafe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith(UPD_PREFIX)) {
      const p = l.slice(UPD_PREFIX.length).trim();
      const updateIdx = i;
      let j = i + 1;
      let moveTo: string | null = null;
      let k = j;
      while (k < lastIdx && isBlank(lines[k]!)) k += 1;
      if (k < lastIdx && lines[k]!.startsWith(MOV_PREFIX)) {
        moveTo = lines[k]!.slice(MOV_PREFIX.length).trim();
        j = k + 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let afterEof = false;
      let m = j;
      while (m < lastIdx) {
        const x = lines[m]!;
        if (isSectionStart(x)) break;
        if (x.trim() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${m + 1}`);
          curChunk.eof = true;
          curChunk = null;
          afterEof = true;
          m += 1;
          continue;
        }
        if (x.startsWith('@@')) {
          const anchor = x.slice(2).trim();
          const c: VChunk = { anchor, body: [], eof: false };
          chunks.push(c);
          curChunk = c;
          afterEof = false;
          m += 1;
          continue;
        }
        if (x.startsWith('***')) throw new Exit2(`error: parse ${m + 1}`);
        if (x === '' || x.startsWith(' ') || x.startsWith('-') || x.startsWith('+')) {
          if (afterEof) {
            if (isBlank(x)) {
              m += 1;
              continue;
            }
            throw new Exit2(`error: parse ${m + 1}`);
          }
          if (curChunk === null) {
            if (chunks.length === 0) {
              const c: VChunk = { anchor: '', body: [], eof: false };
              chunks.push(c);
              curChunk = c;
            } else {
              throw new Exit2(`error: parse ${m + 1}`);
            }
          }
          if (x === '') curChunk.body.push({ kind: 'ctx', text: '', emptySrc: true });
          else if (x.startsWith(' ')) curChunk.body.push({ kind: 'ctx', text: x.slice(1), emptySrc: isBlank(x) });
          else if (x.startsWith('-')) curChunk.body.push({ kind: 'old', text: x.slice(1), emptySrc: false });
          else curChunk.body.push({ kind: 'new', text: x.slice(1), emptySrc: false });
          m += 1;
          continue;
        }
        throw new Exit2(`error: parse ${m + 1}`);
      }
      if (chunks.length > 0) {
        const last = chunks[chunks.length - 1]!;
        // Blank lines at the end of a section are not part of it; a chunk
        // closed by `*** End of File` is not at the section's end, so its
        // trailing blank body lines stay.
        if (!last.eof) {
          while (last.body.length > 0) {
            const b = last.body[last.body.length - 1]!;
            if (b.kind === 'ctx' && b.text === '' && b.emptySrc) last.body.pop();
            else break;
          }
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateIdx + 1}`);
      const mv = moveTo;
      const cs = chunks;
      edits.push((tree) => {
        if (!isSafe(p)) throw new Fail('unsafe', p);
        if (mv !== null && !isSafe(mv)) throw new Fail('unsafe', mv);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        if (mv !== null && tree.get(mv) !== null) throw new Fail('exists', mv);
        const mod = fileModel(cur);
        let curLines = [...mod.lines];
        let cursor = 0;
        for (const chunk of cs) {
          if (chunk.anchor !== '') {
            let anchorIdx = -1;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const tier of tiers) {
              anchorIdx = -1;
              for (let idx = cursor; idx < curLines.length; idx += 1) {
                if (lineEq(chunk.anchor, curLines[idx]!, tier)) {
                  anchorIdx = idx;
                  break;
                }
              }
              if (anchorIdx >= 0) break;
            }
            if (anchorIdx < 0) throw new Fail('no-match', p);
            cursor = anchorIdx + 1;
          }
          const { o, n } = chunkON(chunk);
          if (o.length > 0) {
            let pos = -1;
            let tierUsed = 0;
            const tiers = strict ? [0] : [0, 1, 2];
            for (const tier of tiers) {
              const all = occurrences(curLines, o, tier).filter((q) => q >= cursor);
              if (all.length > 0) {
                pos = all[0]!;
                tierUsed = tier;
                break;
              }
            }
            if (pos < 0) throw new Fail('no-match', p);
            if (chunk.eof && pos + o.length !== curLines.length) throw new Fail('no-match', p);
            const rep = buildReplacement(n, curLines, pos, tierUsed, o);
            curLines = [...curLines.slice(0, pos), ...rep, ...curLines.slice(pos + o.length)];
            cursor = pos + rep.length;
          } else {
            const ins = chunk.eof ? curLines.length : cursor;
            const rep = n.map((e) => e.text);
            curLines = [...curLines.slice(0, ins), ...rep, ...curLines.slice(ins)];
            cursor = ins + rep.length;
          }
        }
        const out = modelText({ lines: curLines, br: mod.br, final: mod.final });
        if (mv !== null) {
          tree.now.set(mv, out);
          tree.now.set(p, null);
          tree.moves.push({ old: p, next: mv });
        } else {
          tree.now.set(p, out);
        }
      });
      i = m;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

/* ---- Sections 1, 2 and 10: invocation, output, order and atomicity ---- */

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSR(lines, strict);
    else edits = parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const changed = new Map<string, string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.set(p, was === null ? 'A' : now === null ? 'D' : 'M');
  }
  const rows: { key: string; text: string }[] = [];
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.get(mv.old);
    const wasNew = tree.original(mv.next);
    const nowNew = tree.now.get(mv.next);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      changed.delete(mv.old);
      changed.delete(mv.next);
      rows.push({ key: mv.next, text: `R ${mv.old} -> ${mv.next}` });
    }
  }
  for (const [p, k] of changed) rows.push({ key: p, text: `${k} ${p}` });
  rows.sort((a, b) => byteCmp(a.key, b.key));
  const outLines = rows.map((r) => r.text);
  if (!check) {
    const keys = [...tree.now.keys()].sort(byteCmp);
    for (const p of keys) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was !== now && now === null) rmSync(p, { force: true });
    }
    for (const p of keys) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was !== now && now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
