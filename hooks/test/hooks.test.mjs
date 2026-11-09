import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MARK = join(HERE, '..', 'mark-edit.mjs');
const GATE = join(HERE, '..', 'gate.mjs');

let tmp;
let stateDir;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'kogda-test-'));
  stateDir = join(tmp, 'state');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function makeRepo(files = {}) {
  const root = join(tmp, 'repo');
  mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  for (const [rel, content] of Object.entries({ 'README.md': '# t\n', ...files })) {
    write(join(root, rel), content);
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

// Исполняемый скрипт-заглушка: пишет аргументы и CI в лог и выходит с заданным кодом.
function fakeBin(dir, name, { exitCode = 0, stdout = '' } = {}) {
  const path = join(dir, 'node_modules', '.bin', name);
  write(
    path,
    `#!/bin/bash\necho "$PWD|CI=$CI|$*" >> "${join(tmp, name + '.log')}"\n` +
      `cat <<'OUT'\n${stdout}\nOUT\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
}

function calls(name) {
  const log = join(tmp, name + '.log');
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
}

function run(script, input) {
  const res = spawnSync('node', [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, KOGDA_STATE_DIR: stateDir, CI: '' },
  });
  return { code: res.status, stdout: res.stdout.trim(), stderr: res.stderr.trim() };
}

function edit(root, rel, content = 'changed\n', session = 's1') {
  write(join(root, rel), content);
  return run(MARK, {
    session_id: session,
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: join(root, rel) },
  });
}

function stop(session = 's1', extra = {}) {
  const res = run(GATE, { session_id: session, hook_event_name: 'Stop', ...extra });
  return { ...res, json: res.stdout ? JSON.parse(res.stdout) : null };
}

function override(root, body) {
  const path = join(root, '.claude', 'kogda-checks.sh');
  write(path, `#!/bin/bash\necho "$*" >> "${join(tmp, 'override.log')}"\n${body}\n`);
  chmodSync(path, 0o755);
}

// --- mark-edit ---

test('mark-edit: правка вне git-репозитория не создаёт ожидающих проверок', () => {
  const file = join(tmp, 'loose.ts');
  write(file, 'x\n');
  const res = run(MARK, { session_id: 's1', tool_name: 'Write', tool_input: { file_path: file } });
  assert.equal(res.code, 0);
  assert.equal(stop().stdout, '');
});

test('mark-edit: не падает на входе без file_path', () => {
  const res = run(MARK, { session_id: 's1', tool_name: 'Edit', tool_input: {} });
  assert.equal(res.code, 0);
});

test('mark-edit: не падает на битом JSON', () => {
  const res = spawnSync('node', [MARK], {
    input: 'not json',
    encoding: 'utf8',
    env: { ...process.env, KOGDA_STATE_DIR: stateDir },
  });
  assert.equal(res.status, 0);
});

// --- gate: общее поведение ---

test('gate: без правок агента ничего не запускает и не блокирует', () => {
  const root = makeRepo();
  override(root, 'exit 1');
  const res = stop();
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '');
  assert.deepEqual(calls('override'), []);
});

test('gate: красная проверка блокирует ход и передаёт агенту вывод и файлы', () => {
  const root = makeRepo({ 'src/a.js': 'a\n' });
  override(root, 'echo "boom in a.js"; exit 1');
  edit(root, 'src/a.js');
  const res = stop();
  assert.equal(res.code, 0);
  assert.equal(res.json.decision, 'block');
  assert.match(res.json.reason, /boom in a\.js/);
  assert.match(res.json.reason, /src\/a\.js/);
});

test('gate: зелёная проверка пропускает ход и снимает правки с учёта', () => {
  const root = makeRepo({ 'src/a.js': 'a\n' });
  override(root, 'exit 0');
  edit(root, 'src/a.js');
  assert.equal(stop().stdout, '');
  assert.equal(stop().stdout, '');
  assert.equal(calls('override').length, 1);
});

test('gate: после неудачи без новых правок не блокирует повторно, а один раз предупреждает пользователя', () => {
  const root = makeRepo({ 'src/a.js': 'a\n' });
  override(root, 'echo fail; exit 1');
  edit(root, 'src/a.js');
  assert.equal(stop().json.decision, 'block');

  const second = stop('s1', { stop_hook_active: true });
  assert.equal(second.json.decision, undefined);
  assert.match(second.json.systemMessage, /красн/i);

  assert.equal(stop().stdout, '');
  assert.equal(calls('override').length, 1);
});

test('gate: новая правка после неудачи запускает проверку снова', () => {
  const root = makeRepo({ 'src/a.js': 'a\n' });
  override(root, 'exit 1');
  edit(root, 'src/a.js');
  stop();
  edit(root, 'src/a.js', 'fixed\n');
  assert.equal(stop().json.decision, 'block');
  assert.equal(calls('override').length, 2);
});

test('gate: проверяет все правки сессии, кроме уже закоммиченных', () => {
  const root = makeRepo({ 'src/a.js': 'a\n', 'src/b.js': 'b\n' });
  override(root, 'exit 0');
  edit(root, 'src/a.js');
  stop();
  git(root, 'commit', '-qam', 'a');
  edit(root, 'src/b.js');
  stop();
  assert.deepEqual(calls('override'), ['src/a.js', 'src/b.js']);
});

test('gate: сессии не мешают друг другу', () => {
  const root = makeRepo({ 'src/a.js': 'a\n' });
  override(root, 'exit 1');
  edit(root, 'src/a.js', 'x\n', 'other');
  assert.equal(stop('s1').stdout, '');
  assert.equal(stop('other').json.decision, 'block');
});

// --- gate: автоопределение проверок для Node ---

function nodeRepo(prefix = '') {
  const pkg = prefix ? prefix + '/' : '';
  const root = makeRepo({
    [`${pkg}package.json`]: '{"name":"p"}\n',
    [`${pkg}tsconfig.json`]: '{}\n',
    [`${pkg}node_modules/eslint/package.json`]: '{"version":"9.1.0"}\n',
    [`${pkg}src/a.ts`]: 'a\n',
    [`${pkg}src/b.ts`]: 'b\n',
    [`${pkg}src/old.ts`]: 'old\n',
    '.gitignore': 'node_modules/\n',
  });
  return { root, pkgDir: prefix ? join(root, prefix) : root };
}

const TSC_OUT =
  'src/a.ts(1,1): error TS2322: Type string is not assignable to number.\n' +
  '  Details line for a.\n' +
  'src/old.ts(2,2): error TS2304: Cannot find name foo.';

test('auto: ошибки tsc учитываются только в изменённых файлах', () => {
  const { root, pkgDir } = nodeRepo();
  fakeBin(pkgDir, 'tsc', { exitCode: 2, stdout: TSC_OUT });

  edit(root, 'src/b.ts');
  assert.equal(stop().stdout, '');

  edit(root, 'src/a.ts');
  const res = stop();
  assert.equal(res.json.decision, 'block');
  assert.match(res.json.reason, /TS2322/);
  assert.match(res.json.reason, /Details line for a/);
  assert.doesNotMatch(res.json.reason, /TS2304/);
  assert.match(calls('tsc')[0], /--noEmit -p tsconfig\.json --pretty false/);
});

test('auto: падение самого tsc не блокирует, но предупреждает пользователя', () => {
  const { root, pkgDir } = nodeRepo();
  fakeBin(pkgDir, 'tsc', { exitCode: 139, stdout: 'Segmentation fault' });
  edit(root, 'src/a.ts');
  const res = stop();
  assert.equal(res.json.decision, undefined);
  assert.match(res.json.systemMessage, /tsc/);
});

test('auto: eslint получает только изменённые JS/TS-файлы, ошибки блокируют', () => {
  const { root, pkgDir } = nodeRepo();
  fakeBin(pkgDir, 'eslint', { exitCode: 1, stdout: 'src/a.ts\n  1:1  error  no-undef' });
  edit(root, 'src/a.ts');
  edit(root, 'docs/note.md');
  const res = stop();
  assert.equal(res.json.decision, 'block');
  assert.match(res.json.reason, /no-undef/);
  assert.match(calls('eslint')[0], /\|--no-warn-ignored src\/a\.ts$/);
});

test('auto: vitest запускает связанные тесты в режиме run', () => {
  const { root, pkgDir } = nodeRepo();
  fakeBin(pkgDir, 'vitest', { exitCode: 0 });
  edit(root, 'src/a.ts');
  assert.equal(stop().stdout, '');
  assert.match(calls('vitest')[0], /CI=1\|related --run --passWithNoTests src\/a\.ts$/);
});

test('auto: красные тесты vitest блокируют ход', () => {
  const { root, pkgDir } = nodeRepo();
  fakeBin(pkgDir, 'vitest', { exitCode: 1, stdout: 'FAIL src/a.test.ts > adds' });
  edit(root, 'src/a.ts');
  assert.match(stop().json.reason, /FAIL src\/a\.test\.ts/);
});

test('auto: проверки идут в ближайшей папке с package.json и с путями от неё', () => {
  const { root, pkgDir } = nodeRepo('app');
  fakeBin(pkgDir, 'eslint');
  edit(root, 'app/src/a.ts');
  stop();
  assert.equal(calls('eslint')[0], `${pkgDir}|CI=1|--no-warn-ignored src/a.ts`);
});

test('auto: правки только в .md не запускают JS-проверки', () => {
  const { root, pkgDir } = nodeRepo();
  fakeBin(pkgDir, 'eslint', { exitCode: 1 });
  edit(root, 'docs/note.md');
  assert.equal(stop().stdout, '');
  assert.deepEqual(calls('eslint'), []);
});

test('override: свой скрипт проекта заменяет автоопределение', () => {
  const { root, pkgDir } = nodeRepo();
  fakeBin(pkgDir, 'eslint', { exitCode: 1 });
  override(root, 'exit 0');
  edit(root, 'src/a.ts');
  assert.equal(stop().stdout, '');
  assert.deepEqual(calls('eslint'), []);
  assert.deepEqual(calls('override'), ['src/a.ts']);
});

// --- gate: Python ---

function pyRepo() {
  const root = makeRepo({ 'tool/x.py': 'x = 1\n', '.gitignore': '.venv/\n' });
  const py = join(root, '.venv', 'bin', 'python');
  write(join(root, '.venv', 'lib', 'python3.12', 'site-packages', 'pytest', '__init__.py'), '');
  return { root, py };
}

function fakePython(path, exitCode) {
  write(
    path,
    `#!/bin/bash\necho "$PWD|$*" >> "${join(tmp, 'python.log')}"\necho "pytest says"\nexit ${exitCode}\n`,
  );
  chmodSync(path, 0o755);
}

test('python: правка .py запускает pytest из .venv, красный блокирует', () => {
  const { root, py } = pyRepo();
  fakePython(py, 1);
  edit(root, 'tool/x.py');
  const res = stop();
  assert.equal(res.json.decision, 'block');
  assert.match(res.json.reason, /pytest says/);
  assert.equal(calls('python')[0], `${root}|-m pytest -q`);
});

test('python: pytest без найденных тестов (код 5) не блокирует', () => {
  const { root, py } = pyRepo();
  fakePython(py, 5);
  edit(root, 'tool/x.py');
  assert.equal(stop().stdout, '');
});

test('python: venv без pytest не запускается', () => {
  const { root, py } = pyRepo();
  rmSync(join(root, '.venv', 'lib'), { recursive: true });
  fakePython(py, 1);
  edit(root, 'tool/x.py');
  assert.equal(stop().stdout, '');
  assert.deepEqual(calls('python'), []);
});

test('python: скрипт test:py из package.json важнее прямого pytest', () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ scripts: { 'test:py': 'echo from-test-py && exit 1' } }),
    'vector/x.py': 'x = 1\n',
  });
  edit(root, 'vector/x.py');
  assert.match(stop().json.reason, /from-test-py/);
});

// --- служебные папки ---

test('gate: удаляет папки учёта сессий старше 30 дней и не трогает свежие', () => {
  const old = join(stateDir, 'old-session');
  const fresh = join(stateDir, 'fresh-session');
  write(join(old, 'x.root'), '/nowhere');
  write(join(fresh, 'x.root'), '/nowhere');
  const longAgo = new Date(Date.now() - 31 * 24 * 3600 * 1000);
  utimesSync(old, longAgo, longAgo);
  stop();
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true);
});
