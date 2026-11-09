// Stop: «А» из цикла К-О-Г-Д-А. Если в этом ходу агент менял файлы, прогоняет проверки
// по этим файлам и не даёт закончить ход, пока они красные.
import {
  formatReason,
  pendingRepos,
  pruneOldSessions,
  readInput,
  runChecks,
  stillChanged,
} from './lib.mjs';

function main() {
  const input = readInput() ?? {};
  pruneOldSessions();
  const blocked = [];
  const warnings = [];

  for (const repo of pendingRepos(input.session_id)) {
    if (!repo.edits.length) {
      // Агент закончил ход без новых правок после блокировки: второй раз не держим, а говорим пользователю.
      if (repo.fail && !repo.notified) {
        warnings.push(`проверки остались красными в ${repo.root}: ${repo.fail}`);
        repo.markNotified();
      }
      continue;
    }

    const files = stillChanged(repo.root, [...new Set([...repo.files, ...repo.edits])]);
    repo.takeEdits(files);
    if (!files.length) {
      repo.clearFail();
      continue;
    }

    const result = runChecks(repo.root, files);
    warnings.push(...result.warnings.map((w) => `${repo.root}: ${w}`));
    if (result.failures.length) {
      repo.setFail(result.failures.map((f) => f.name).join(', '));
      blocked.push({ root: repo.root, files, failures: result.failures });
    } else {
      repo.clearFail();
    }
  }

  const out = {};
  if (blocked.length) Object.assign(out, { decision: 'block', reason: formatReason(blocked) });
  if (warnings.length) out.systemMessage = `К-О-Г-Д-А: ${warnings.join('\n')}`;
  if (Object.keys(out).length) process.stdout.write(JSON.stringify(out));
}

try {
  main();
} catch (error) {
  process.stdout.write(
    JSON.stringify({ systemMessage: `К-О-Г-Д-А: хук проверок упал: ${error.message}` }),
  );
}
