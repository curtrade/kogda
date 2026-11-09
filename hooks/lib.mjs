// Общая часть хуков К-О-Г-Д-А: учёт файлов, которые агент изменил в сессии,
// и запуск проверок только по этим файлам.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';

const JS = /\.(c|m)?(j|t)sx?$/;
const TS = /\.(c|m)?tsx?$/;
const PY = /\.py$/;
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g');
const REASON_LIMIT = 9000;
const KEEP_SESSIONS_MS = 30 * 24 * 3600 * 1000;

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function stateBase() {
  return process.env.KOGDA_STATE_DIR || join(homedir(), '.cache', 'claude-kogda');
}

function sessionDir(sessionId) {
  return join(stateBase(), String(sessionId || 'unknown').replace(/[^\w.-]/g, '_'));
}

// Учёт сессий, в которых давно не было правок, больше не нужен.
export function pruneOldSessions(now = Date.now()) {
  const base = stateBase();
  if (!existsSync(base)) return;
  for (const name of readdirSync(base)) {
    const dir = join(base, name);
    if (now - statSync(dir).mtimeMs > KEEP_SESSIONS_MS)
      rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitRoot(dir) {
  const res = git(dir, ['rev-parse', '--show-toplevel']);
  if (res.status !== 0) return null;
  return realpathSync(res.stdout.trim());
}

function readLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

// --- учёт правок ---

export function recordEdit(sessionId, filePath) {
  if (!filePath) return;
  let real;
  try {
    real = realpathSync(filePath);
  } catch {
    return;
  }
  const root = gitRoot(dirname(real));
  if (!root) return;
  const rel = relative(root, real);
  if (rel.startsWith('..')) return;
  if (git(root, ['check-ignore', '-q', '--', rel]).status === 0) return;

  const dir = sessionDir(sessionId);
  mkdirSync(dir, { recursive: true });
  const key = createHash('sha1').update(root).digest('hex').slice(0, 16);
  writeFileSync(join(dir, `${key}.root`), root);
  // Дописывание, а не перезапись: параллельные субагенты не затрут правки друг друга.
  appendFileSync(join(dir, `${key}.edits`), rel + '\n');
  const now = new Date();
  utimesSync(dir, now, now);
}

export function pendingRepos(sessionId) {
  const dir = sessionDir(sessionId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.root'))
    .map((name) => {
      const base = join(dir, name.slice(0, -'.root'.length));
      const at = (ext) => base + ext;
      return {
        root: readFileSync(at('.root'), 'utf8'),
        edits: readLines(at('.edits')),
        files: readLines(at('.files')),
        fail: existsSync(at('.fail')) ? readFileSync(at('.fail'), 'utf8') : null,
        notified: existsSync(at('.notified')),
        takeEdits(files) {
          writeFileSync(at('.files'), files.join('\n') + '\n');
          rmSync(at('.edits'), { force: true });
        },
        setFail(text) {
          writeFileSync(at('.fail'), text);
          rmSync(at('.notified'), { force: true });
        },
        clearFail() {
          rmSync(at('.fail'), { force: true });
          rmSync(at('.notified'), { force: true });
        },
        markNotified() {
          writeFileSync(at('.notified'), '');
        },
      };
    });
}

// Файлы из списка, которые ещё отличаются от HEAD: закоммиченные и удалённые выпадают.
export function stillChanged(root, files) {
  if (!files.length) return [];
  const res = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...files]);
  if (res.status !== 0) return [];
  const entries = res.stdout.split('\0').filter(Boolean);
  const changed = new Set();
  for (let i = 0; i < entries.length; i++) {
    const status = entries[i].slice(0, 2);
    changed.add(entries[i].slice(3));
    if (status[0] === 'R' || status[0] === 'C') i++;
  }
  return files.filter((f) => changed.has(f) && existsSync(join(root, f)));
}

// --- запуск проверок ---

function run(cmd, args, cwd, timeoutSec) {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  return {
    code: res.status,
    timedOut: res.error?.code === 'ETIMEDOUT',
    output: `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(ANSI, '').trim(),
  };
}

function tail(text, lines) {
  const cut = text.split('\n').slice(-lines).join('\n');
  return cut.length > 4000 ? '…' + cut.slice(-4000) : cut;
}

function bin(dir, name) {
  const path = join(dir, 'node_modules', '.bin', name);
  return existsSync(path) ? path : null;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Ближайшая папка от файла вверх до корня репозитория, для которой match(dir) вернул значение.
function nearest(root, rel, match) {
  let dir = dirname(join(root, rel));
  for (;;) {
    const found = match(dir);
    if (found) return { dir, found };
    if (dir === root || !dir.startsWith(root)) return null;
    dir = dirname(dir);
  }
}

function groupBy(root, files, match) {
  const groups = new Map();
  for (const rel of files) {
    const hit = nearest(root, rel, match);
    if (!hit) continue;
    if (!groups.has(hit.dir)) groups.set(hit.dir, { found: hit.found, files: [] });
    groups.get(hit.dir).files.push(relative(hit.dir, join(root, rel)));
  }
  return groups;
}

function tscErrors(output) {
  const blocks = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^(.+?)\(\d+,\d+\): error TS\d+:/);
    if (m) blocks.push({ file: m[1], text: line });
    else if (/^\s/.test(line) && blocks.length) blocks.at(-1).text += '\n' + line;
  }
  return blocks;
}

function checkTsc(dir, files, report) {
  const ts = files.filter((f) => TS.test(f));
  const tsc = bin(dir, 'tsc');
  if (!ts.length || !tsc || !existsSync(join(dir, 'tsconfig.json'))) return;
  const res = run(tsc, ['--noEmit', '-p', 'tsconfig.json', '--pretty', 'false'], dir, 300);
  if (res.code === 0) return;
  const errors = tscErrors(res.output);
  if (!errors.length) {
    const why = res.timedOut ? 'таймаут' : `код ${res.code}`;
    report.warn(`tsc не отработал (${why}), типы не проверены`);
    return;
  }
  // Ошибки в файлах, которые агент не трогал, — старый долг проекта, ход ими не блокируем.
  const mine = errors.filter((e) =>
    ts.includes(isAbsolute(e.file) ? relative(dir, e.file) : e.file),
  );
  if (mine.length) report.fail('tsc', mine.map((e) => e.text).join('\n'));
}

function checkEslint(dir, files, report) {
  const js = files.filter((f) => JS.test(f));
  const eslint = bin(dir, 'eslint');
  if (!js.length || !eslint) return;
  const version = readJson(join(dir, 'node_modules', 'eslint', 'package.json'))?.version ?? '0';
  const flags = Number.parseInt(version, 10) >= 9 ? ['--no-warn-ignored'] : [];
  const res = run(eslint, [...flags, ...js], dir, 180);
  if (res.code === 0) return;
  if (res.code === 1) report.fail('eslint', tail(res.output, 60));
  else report.warn(`eslint не отработал (${res.timedOut ? 'таймаут' : `код ${res.code}`})`);
}

function checkVitest(dir, files, report) {
  const js = files.filter((f) => JS.test(f));
  const vitest = bin(dir, 'vitest');
  if (!js.length || !vitest) return;
  const res = run(vitest, ['related', '--run', '--passWithNoTests', ...js], dir, 600);
  if (res.timedOut) report.warn('vitest не уложился в 10 минут, тесты не проверены');
  else if (res.code !== 0) report.fail('vitest', tail(res.output, 80));
}

function venvPython(dir) {
  for (const venv of ['.venv', 'venv']) {
    const python = join(dir, venv, 'bin', 'python');
    const lib = join(dir, venv, 'lib');
    if (!existsSync(python) || !existsSync(lib)) continue;
    const hasPytest = readdirSync(lib).some((py) =>
      existsSync(join(lib, py, 'site-packages', 'pytest')),
    );
    if (hasPytest) return python;
  }
  return null;
}

function pythonRunner(dir) {
  if (readJson(join(dir, 'package.json'))?.scripts?.['test:py']) return { npm: true };
  const python = venvPython(dir);
  return python ? { python } : null;
}

function checkPython(root, files, report) {
  const py = files.filter((f) => PY.test(f));
  for (const [dir, { found }] of groupBy(root, py, pythonRunner)) {
    const res = found.npm
      ? run('npm', ['run', '-s', 'test:py'], dir, 600)
      : run(found.python, ['-m', 'pytest', '-q'], dir, 600);
    const where = relative(root, dir) || '.';
    if (res.timedOut) report.warn(`pytest в ${where} не уложился в 10 минут`);
    else if (res.code !== 0 && res.code !== 5)
      report.fail(`pytest (${where})`, tail(res.output, 60));
  }
}

export function runChecks(root, files) {
  const failures = [];
  const warnings = [];
  const report = (where) => ({
    fail: (name, output) => failures.push({ name: where ? `${name} (${where})` : name, output }),
    warn: (text) => warnings.push(where ? `${where}: ${text}` : text),
  });

  const custom = join(root, '.claude', 'kogda-checks.sh');
  if (existsSync(custom)) {
    const res = run('bash', [custom, ...files], root, 900);
    if (res.code !== 0) report('').fail('.claude/kogda-checks.sh', tail(res.output, 80));
    return { failures, warnings };
  }

  const packages = groupBy(root, files, (dir) => existsSync(join(dir, 'package.json')));
  for (const [dir, group] of packages) {
    const r = report(relative(root, dir));
    checkTsc(dir, group.files, r);
    checkEslint(dir, group.files, r);
    checkVitest(dir, group.files, r);
  }
  checkPython(root, files, report(''));
  return { failures, warnings };
}

export function formatReason(results) {
  const head =
    'К-О-Г-Д-А, автотесты: проверки по файлам, которые ты изменил в этой сессии, не прошли. ' +
    'Если причина в твоих правках, исправь её. Если падение не связано с задачей ' +
    '(старая ошибка, нет базы или сети, сломано окружение), не чини чужой код: ' +
    'коротко скажи пользователю, что упало и почему, и заверши ход.';
  const body = results
    .map(({ root, files, failures }) => {
      const parts = failures.map((f) => `### ${f.name}\n${f.output}`);
      return `## ${root}\nФайлы: ${files.join(', ')}\n\n${parts.join('\n\n')}`;
    })
    .join('\n\n');
  const text = `${head}\n\n${body}`;
  return text.length > REASON_LIMIT ? text.slice(0, REASON_LIMIT) + '\n…(обрезано)' : text;
}
