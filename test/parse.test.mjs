import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, splitCommands, tokenize } from '../src/parse-command.mjs';
import { parseNpmSpec, parsePipRequirement, exactVersion, normalizePypi } from '../src/specs.mjs';

const pkgs = (cmd) => parseCommand(cmd).filter((i) => i.kind === 'package').map((i) => `${i.ecosystem}:${i.name}${i.spec ? '|' + i.spec : ''}`);

test('npm-family installs', () => {
  assert.deepEqual(pkgs('npm install react@18.2.0 lodash'), ['npm:react|18.2.0', 'npm:lodash']);
  assert.deepEqual(pkgs('npm i -D @types/node@^20 --save-exact'), ['npm:@types/node|^20']);
  assert.deepEqual(pkgs('pnpm add -w zod && yarn add left-pad'), ['npm:zod', 'npm:left-pad']);
  assert.deepEqual(pkgs('bun add hono; npx -y create-vite@latest my-app --template react'), ['npm:hono', 'npm:create-vite|latest']);
  assert.deepEqual(pkgs('npm install --registry https://r.example.com foo'), ['npm:foo']);
  assert.deepEqual(pkgs('npm i alias@npm:real-pkg@1.0.0'), ['npm:real-pkg|1.0.0']);
  assert.deepEqual(pkgs('pnpm dlx shadcn@latest init'), ['npm:shadcn|latest']);
});

test('npm args that are not registry packages are ignored', () => {
  assert.deepEqual(pkgs('npm install ./local-dir ../x.tgz file:../y github:user/repo user/repo git+https://x/y.git https://x/y.tgz'), []);
  assert.deepEqual(pkgs('npm run build && npm test && npm ci'), []);
});

test('bare installs become manifest intents', () => {
  const k = (cmd) => parseCommand(cmd).map((i) => `${i.kind}:${i.manager}`);
  assert.deepEqual(k('npm install'), ['manifest:npm']);
  assert.deepEqual(k('npm i --legacy-peer-deps'), ['manifest:npm']);
  assert.deepEqual(k('yarn'), ['manifest:yarn']);
  assert.deepEqual(k('pnpm install --frozen-lockfile'), ['manifest:pnpm']);
  assert.deepEqual(k('uv sync && poetry install'), ['manifest:uv', 'manifest:poetry']);
});

test('pip-family installs', () => {
  assert.deepEqual(pkgs('pip install requests==2.31.0 "flask[async]>=3" numpy'), ['pypi:requests|==2.31.0', 'pypi:flask|>=3', 'pypi:numpy']);
  assert.deepEqual(pkgs('python -m pip install -U Django_REST.framework'), ['pypi:django-rest-framework']);
  assert.deepEqual(pkgs('py -m pip install --target vendor six'), ['pypi:six']);
  assert.deepEqual(pkgs('uv add httpx && uv pip install rich && uv tool install ruff && uvx black --check .'), ['pypi:httpx', 'pypi:rich', 'pypi:ruff', 'pypi:black']);
  assert.deepEqual(pkgs('poetry add pendulum@^3 && pipx install pre-commit && pdm add attrs'), ['pypi:pendulum|@^3', 'pypi:pre-commit', 'pypi:attrs']);
  assert.deepEqual(pkgs('pip install -e . git+https://github.com/a/b.git ./wheel.whl https://x/y.tar.gz'), []);
});

test('requirements files and custom indexes', () => {
  const r = parseCommand('pip install -r requirements.txt --extra-index-url https://pypi.acme.dev/simple foo');
  assert.deepEqual(r.map((i) => i.kind), ['requirements', 'custom-index', 'package']);
  assert.equal(r[0].file, 'requirements.txt');
  assert.equal(parseCommand('pip install --requirement=req/dev.txt')[0].file, 'req/dev.txt');
});

test('shell wrappers, env prefixes, sudo and chains', () => {
  assert.deepEqual(pkgs(`bash -lc "npm install react && pip install requests"`), ['npm:react', 'pypi:requests']);
  assert.deepEqual(pkgs('CI=1 sudo pip3 install flask'), ['pypi:flask']);
  assert.deepEqual(pkgs('cd app && npm i zod || echo fail'), ['npm:zod']);
  assert.deepEqual(splitCommands('a && b; c | d\ne'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(tokenize(`pip install "a b" 'c'`), ['pip', 'install', 'a b', 'c']);
});

test('spec helpers', () => {
  assert.deepEqual(parseNpmSpec('@scope/pkg@1.2.3'), { name: '@scope/pkg', spec: '1.2.3' });
  assert.equal(parseNpmSpec('-D'), null);
  assert.deepEqual(parsePipRequirement('Requests[socks] >= 2.0 ; python_version > "3.8"'), { name: 'requests', spec: '>= 2.0' });
  assert.equal(parsePipRequirement('pkg @ https://x/y.whl'), null);
  assert.equal(exactVersion('npm', '1.2.3'), '1.2.3');
  assert.equal(exactVersion('npm', '^1.2.3'), null);
  assert.equal(exactVersion('pypi', '==2.31.0'), '2.31.0');
  assert.equal(exactVersion('pypi', '>=2'), null);
  assert.equal(normalizePypi('Typing_Extensions'), 'typing-extensions');
});
