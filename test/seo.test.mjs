import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// scripts/build-site.py writes the real docs/index.html and docs/sitemap.xml this repo
// publishes to GitHub Pages. This test runs the real generator (not a copy of its logic)
// so a future edit to the title/description there is caught here, not only in a manual
// audit — exactly the gap round 10 found: 72/198-char title/description had shipped
// silently because nothing checked them.
test('generated index.html has a title <=60 chars and a description <=160 chars', () => {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['scripts/build-site.py'], { cwd: ROOT, stdio: 'pipe' });
  const html = readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? '';
  const description = /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? '';
  assert.ok(title.length > 0 && title.length <= 60, `title is ${title.length} chars (max 60): ${title}`);
  assert.ok(description.length > 0 && description.length <= 160, `description is ${description.length} chars (max 160): ${description}`);
});

test('sitemap.xml lists only canonical HTML pages, not the llms.txt machine endpoint', () => {
  const sitemap = readFileSync(path.join(ROOT, 'docs', 'sitemap.xml'), 'utf8');
  assert.doesNotMatch(sitemap, /llms\.txt/, 'llms.txt is a machine endpoint; it belongs in llms.txt/robots.txt, not the XML sitemap');
});
