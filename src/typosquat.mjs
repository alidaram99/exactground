// Near-duplicates of popular package names (typosquat / slopsquat look-alikes). No I/O after load.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizePypi } from './specs.mjs';

const load = (f) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../data/${f}`, import.meta.url)), 'utf8')).names;

let cache = null;
function lists() {
  if (!cache) {
    const npm = load('popular-npm.json');
    const pypi = load('popular-pypi.json').map(normalizePypi);
    cache = {
      npm: { names: npm, set: new Set(npm), rank: new Map(npm.map((n, i) => [n, i + 1])) },
      pypi: { names: pypi, set: new Set(pypi), rank: new Map(pypi.map((n, i) => [n, i + 1])) },
    };
  }
  return cache;
}

/** Popularity rank (1 = most downloaded) within the bundled top-3000 list, or null. */
export function popularRank(ecosystem, name) {
  return lists()[ecosystem].rank.get(ecosystem === 'pypi' ? normalizePypi(name) : name) ?? null;
}

/** Optimal-string-alignment distance with an early exit above `max`. */
export function editDistance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length][b.length];
}

const squash = (s) => s.replace(/[-_.]/g, '').replace(/0/g, 'o').replace(/1/g, 'l');
const AFFIXES = /^(?:js-|node-|py-|python-)|(?:-js|\.js|js|-node|-py|-python|-lib|-api|-sdk|-cli|-tools?|2|3)$/;

/**
 * The popular package this name imitates, or null. Popular names themselves never match.
 * Rules: separator/homoglyph-only differences, scope swaps (@evil/react), common affixes (react-js),
 * and edit distance 1 (names >= 5 chars) or 2 (names >= 10 chars).
 */
export function lookalikeOf(ecosystem, rawName) {
  const L = lists()[ecosystem];
  const name = ecosystem === 'pypi' ? normalizePypi(rawName) : String(rawName).toLowerCase();
  if (L.set.has(name)) return null;
  if (name.startsWith('@types/')) return null; // DefinitelyTyped mirrors real package names by design
  const bare = name.replace(/^@[^/]+\//, '');
  const sq = squash(name);
  let best = null;
  for (const pop of L.names) {
    if (pop === name) return null;
    const popBare = pop.replace(/^@[^/]+\//, '');
    let reason = null;
    if (sq === squash(pop) && sq.length >= 3) reason = 'differs only by separators or look-alike characters';
    else if (name.startsWith('@') && !pop.startsWith('@') && bare === pop && pop.length >= 4) reason = 'is a scoped copy of the unscoped name';
    else if (pop.startsWith('@') && name !== pop && bare === popBare && popBare.length >= 4 && !name.startsWith(pop.split('/')[0])) reason = 'uses a different scope for the same package name';
    else if (bare.replace(AFFIXES, '') === popBare && popBare.length >= 4 && bare !== popBare) reason = 'adds a common prefix/suffix to the name';
    else {
      const max = popBare.length >= 10 ? 2 : popBare.length >= 5 ? 1 : 0;
      if (max && bare[0] === popBare[0] || max === 2) {
        const dist = max ? editDistance(bare, popBare, max) : 99;
        if (dist <= max) reason = `is ${dist} edit${dist > 1 ? 's' : ''} away`;
      }
    }
    if (reason) {
      const rank = L.rank.get(pop);
      if (!best || rank < best.rank) best = { name: pop, rank, reason };
    }
  }
  return best;
}
