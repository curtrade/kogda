// PostToolUse (Edit|Write|NotebookEdit): запоминает файл, который агент только что изменил,
// чтобы gate.mjs проверил его в конце хода. Сессию не ломает ни при какой ошибке.
import { readInput, recordEdit } from './lib.mjs';

try {
  const input = readInput();
  const tool = input?.tool_input ?? {};
  recordEdit(input?.session_id, tool.file_path ?? tool.notebook_path);
} catch {
  // Учёт правок — вспомогательная функция, её сбой не должен мешать работе агента.
}
