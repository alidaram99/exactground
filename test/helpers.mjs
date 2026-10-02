// Offline fake registries for tests.

const DAY = 86_400_000;
export const NOW = Date.parse('2026-10-03T00:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

const NPM = {
  react: { versions: ['18.2.0', '19.0.0'], latest: '19.0.0', created: iso(4000), downloads: 50_000_000 },
  lodash: { versions: ['4.17.21'], latest: '4.17.21', created: iso(5000), downloads: 60_000_000 },
  typescript: { versions: ['5.9.2'], latest: '5.9.2', created: iso(4000), downloads: 90_000_000 },
  expresss: { versions: ['1.0.0'], latest: '1.0.0', created: iso(10), downloads: 12 },
  'old-expresss': { versions: ['1.0.0'], latest: '1.0.0', created: iso(3000), downloads: 9000 },
  'tiny-new-lib': { versions: ['0.1.0'], latest: '0.1.0', created: iso(3), downloads: 40 },
  reacct: { versions: ['0.0.1-security'], latest: '0.0.1-security', created: iso(2000), downloads: 50 },
  'left-pad': { versions: ['1.3.0'], latest: '1.3.0', created: iso(4000), downloads: 2_000_000, deprecated: 'use String.prototype.padStart()' },
};
const PYPI = {
  requests: { versions: ['2.31.0', '2.32.3'], latest: '2.32.3', created: iso(5000) },
  numpy: { versions: ['1.26.4', '2.1.0'], latest: '2.1.0', created: iso(6000) },
  flask: { versions: ['3.0.0'], latest: '3.0.0', created: iso(5000) },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** fetch replacement; `calls` records every URL. `down` = true simulates a network failure. */
export function fakeFetch({ down = false } = {}) {
  const calls = [];
  const f = async (url) => {
    calls.push(String(url));
    if (down) throw new TypeError('fetch failed');
    const u = new URL(url);
    if (u.host === 'registry.npmjs.org') {
      const name = decodeURIComponent(u.pathname.slice(1)).replace('%2f', '/');
      const p = NPM[name];
      if (!p) return json({ error: 'Not found' }, 404);
      return json({
        name,
        'dist-tags': { latest: p.latest },
        versions: Object.fromEntries(p.versions.map((v) => [v, v === p.latest && p.deprecated ? { deprecated: p.deprecated } : {}])),
        time: { created: p.created },
      });
    }
    if (u.host === 'api.npmjs.org') {
      const name = u.pathname.split('/last-week/')[1];
      const p = NPM[name];
      return p ? json({ downloads: p.downloads }) : json({ error: 'not found' }, 404);
    }
    if (u.host === 'pypi.org') {
      const name = u.pathname.split('/')[2];
      const p = PYPI[name];
      if (!p) return json({ message: 'Not Found' }, 404);
      return json({
        info: { version: p.latest, summary: 'x' },
        releases: Object.fromEntries(p.versions.map((v, i) => [v, [{ upload_time_iso_8601: i === 0 ? p.created : iso(10) }]])),
      });
    }
    return json({}, 404);
  };
  f.calls = calls;
  return f;
}
