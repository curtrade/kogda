# logo-kit: исходники в PNG, JPG и WEBP — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Конвейер `logo-kit` принимает крупный план, сетку и сцены мокапов в PNG, JPG и WEBP.

**Architecture:** Новый модуль `src/sources.js` ищет `source/<имя>.<png|jpg|jpeg|webp>` без учёта регистра и падает, если файлов с одним именем несколько. `trace` и `board` берут исходники через него. Размер сцены мокапа измеряет Chrome, который уже открыт в `board`, методом `imageSize`, а не разбор заголовка PNG. Python не меняется: Pillow читает все три формата, трассировка из JPG и WEBP закрепляется тестами.

**Tech Stack:** Node 22 (ESM), Vitest 5, Playwright 1.46.1 + системный Chrome, Python 3.12 + Pillow, pytest.

Спека: `docs/superpowers/specs/2026-09-30-logo-kit-input-formats-design.md`.
Репозиторий: `~/nodejs/freelance/logo-kit` (ветка `main`, без удалённого репозитория).

**Проверено 30.09.2026 до плана:**
- `PIL.features.check('webp')` → `True`; значок из WEBP q80 — 4 контура, совпадение 99,65 %.
- Значок 1024 × 1024 из JPEG q95/85/70/50 — тот же результат, что из PNG: 4 контура, 99,8 %.
- Chrome, открывший картинку по `file://`, отдаёт `document.images[0].naturalWidth/Height`:
  640 × 360 для PNG, JPG и WEBP, 0 × 0 для битого файла.

**Коммиты:** на русском, префиксы `feat:` / `test:` / `docs:`, без строки `Co-Authored-By` (правило пользователя).

**Проверки после каждой задачи:** `npm test`, `npm run test:py`, `npm run lint`, `npx prettier --check src test`.

---

## Структура файлов

| Файл | Что меняется |
|---|---|
| `src/sources.js` | новый: `IMAGE_EXTS`, `isImageFile`, `findSource` |
| `src/render.js` | `openBrowser()` получает метод `imageSize(path)` |
| `src/brand.js` | сцена мокапа — только PNG, JPG или WEBP |
| `src/commands.js` | `trace` и `board` ищут исходники через `findSource`, размер сцены — `imageSize` |
| `src/cli.js`, `README.md` | формулировки про форматы |
| `test/sources.test.js` | новый |
| `test/render.test.js`, `test/brand.test.js`, `test/commands.test.js`, `test/helpers.js` | новые проверки |
| `vector/test_trace_logo.py` | трассировка из JPG и WEBP |
| `sos/docs/prompts/logo-portfolio.md` | «скачать в `grid.png`, `.jpg` или `.webp`» |

---

### Task 1: Поиск исходника

**Files:**
- Create: `src/sources.js`
- Test: `test/sources.test.js`

- [ ] **Step 1: Написать падающие тесты**

`test/sources.test.js`:
```js
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSource, isImageFile } from '../src/sources.js';
import { tmpDir } from './helpers.js';

async function folderWith(...names) {
  const dir = await tmpDir();
  for (const name of names) await writeFile(join(dir, name), '');
  return dir;
}

describe('findSource', () => {
  it.each(['chosen.png', 'chosen.jpg', 'chosen.jpeg', 'chosen.webp', 'chosen.JPG'])(
    'находит %s',
    async (name) => {
      const dir = await folderWith(name, 'grid.png');
      expect(await findSource(dir, 'chosen')).toBe(join(dir, name));
    },
  );

  it('похожие имена и чужие форматы не подходят', async () => {
    const dir = await folderWith('chosen-old.png', 'chosen.txt', 'chosen.gif', 'mychosen.png');
    expect(await findSource(dir, 'chosen')).toBeNull();
  });

  it('пустая папка и нет папки — null', async () => {
    const dir = await tmpDir();
    expect(await findSource(dir, 'chosen')).toBeNull();
    expect(await findSource(join(dir, 'нет'), 'chosen')).toBeNull();
  });

  it('несколько файлов с одним именем — ошибка со всеми именами', async () => {
    const dir = await folderWith('chosen.png', 'chosen.jpg');
    await expect(findSource(dir, 'chosen')).rejects.toThrow(
      'В source несколько файлов chosen: chosen.jpg, chosen.png — оставьте один',
    );
  });
});

it('isImageFile', () => {
  expect(isImageFile('mockups/cup.JPG')).toBe(true);
  expect(isImageFile('mockups/cup.webp')).toBe(true);
  expect(isImageFile('mockups/cup.gif')).toBe(false);
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `cd ~/nodejs/freelance/logo-kit && npx vitest run test/sources.test.js`
Expected: FAIL — `Cannot find module '../src/sources.js'`.

- [ ] **Step 3: Реализация**

`src/sources.js`:
```js
// Исходники бренда от нейросети: картинка может прийти в PNG, JPG или WEBP.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];

export function isImageFile(name) {
  const lower = name.toLowerCase();
  return IMAGE_EXTS.some((ext) => lower.endsWith(ext));
}

// Файл <name>.<png|jpg|jpeg|webp> в папке, регистр не важен. Нет файла — null; несколько файлов
// с одним именем — ошибка: иначе можно молча оттрассировать старую картинку вместо новой.
export async function findSource(folder, name) {
  let files;
  try {
    files = await readdir(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const wanted = IMAGE_EXTS.map((ext) => `${name}${ext}`.toLowerCase());
  const found = files.filter((file) => wanted.includes(file.toLowerCase())).sort();
  if (found.length > 1) {
    throw new Error(`В source несколько файлов ${name}: ${found.join(', ')} — оставьте один`);
  }
  return found.length ? join(folder, found[0]) : null;
}
```

- [ ] **Step 4: Тесты проходят, линтер чист**

Run: `npx vitest run test/sources.test.js && npx eslint . && npx prettier --check src test`
Expected: `9 passed`, без замечаний.

- [ ] **Step 5: Коммит**

```bash
git add src/sources.js test/sources.test.js
git commit -m "feat: поиск исходника в PNG, JPG или WEBP"
```

---

### Task 2: Размер картинки через Chrome

**Files:**
- Modify: `src/render.js` (метод `imageSize` в объекте, который возвращает `openBrowser`)
- Test: `test/render.test.js`

- [ ] **Step 1: Написать падающие тесты**

В `test/render.test.js`:
- импорт из `vitest` дополнить: `import { afterAll, beforeAll, describe, expect, it } from 'vitest';`;
- к импорту из `./helpers.js` добавить `makeBadge`: `import { makeBadge, tmpDir } from './helpers.js';`;
- добавить импорт `import { missingSetup } from '../src/vector.js';`;
- дописать в конец файла:
```js
describe.skipIf(!existsSync(CHROME) || missingSetup())('imageSize', () => {
  let browser;
  let dir;
  beforeAll(async () => {
    browser = await openBrowser();
    dir = await tmpDir();
  });
  afterAll(() => browser.close());

  it.each(['png', 'jpg', 'webp'])('размер картинки %s', async (ext) => {
    const file = join(dir, `badge.${ext}`);
    await makeBadge(file);
    expect(await browser.imageSize(file)).toEqual({ width: 600, height: 600 });
  });

  it('битый файл — ошибка', async () => {
    const file = join(dir, 'bad.jpg');
    await writeFile(file, 'not an image');
    await expect(browser.imageSize(file)).rejects.toThrow(
      `Не удалось открыть картинку ${file}: формат не поддерживается`,
    );
  });

  it('нет файла — ошибка', async () => {
    await expect(browser.imageSize(join(dir, 'нет.png'))).rejects.toThrow(
      'Не удалось открыть картинку',
    );
  });
});
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/render.test.js`
Expected: FAIL — `browser.imageSize is not a function` (5 тестов).

- [ ] **Step 3: Реализация**

В `src/render.js` в объекте, который возвращает `openBrowser()`, между методами `pdf` и `close` добавить:
```js
    // Настоящий размер картинки любого формата, который открывает Chrome (PNG, JPG, WEBP).
    async imageSize(imagePath) {
      try {
        await page.goto(pathToFileURL(imagePath).href);
      } catch (error) {
        throw new Error(`Не удалось открыть картинку ${imagePath}: ${error.message.split('\n')[0]}`, {
          cause: error,
        });
      }
      const size = await page.evaluate(() => {
        const img = document.images[0];
        return img ? { width: img.naturalWidth, height: img.naturalHeight } : null;
      });
      if (!size?.width || !size?.height) {
        throw new Error(`Не удалось открыть картинку ${imagePath}: формат не поддерживается`);
      }
      return size;
    },
```

- [ ] **Step 4: Тесты проходят, линтер чист**

Run: `npm run format && npx vitest run test/render.test.js && npx eslint .`
Expected: `8 passed`.

- [ ] **Step 5: Коммит**

```bash
git add src/render.js test/render.test.js
git commit -m "feat: размер картинки любого формата через Chrome"
```

---

### Task 3: Сцена мокапа — только PNG, JPG или WEBP

**Files:**
- Modify: `src/brand.js` (импорт и `checkMockups`)
- Test: `test/brand.test.js`

- [ ] **Step 1: Написать падающий тест**

В `test/brand.test.js` внутри `describe('validateBrand', …)` перед тестом `'расстояние между цветами'`:
```js
  it('сцена мокапа — только PNG, JPG или WEBP', () => {
    const withScene = (scene) => ({
      ...BRAND,
      mockups: [{ scene, box: [0, 0, 10, 10], logo: 'stacked-main' }],
    });
    expect(() => validateBrand(withScene('mockups/cup.gif'))).toThrow(
      'мокап 1: сцена — PNG, JPG или WEBP',
    );
    expect(() => validateBrand(withScene('mockups/cup.JPG'))).not.toThrow();
  });
```

- [ ] **Step 2: Запустить — должен упасть**

Run: `npx vitest run test/brand.test.js`
Expected: FAIL на новом тесте — `expected [Function] to throw an error`.

- [ ] **Step 3: Реализация**

В `src/brand.js`:
- после `import { FONTS } from './fonts.js';` добавить `import { isImageFile } from './sources.js';`;
- в `checkMockups` заменить
```js
    const layout = m.logo.split('-')[0];
```
на
```js
    if (!isImageFile(m.scene)) problems.push(`мокап ${i + 1}: сцена — PNG, JPG или WEBP`);
    const layout = m.logo.split('-')[0];
```

- [ ] **Step 4: Тесты проходят, линтер чист**

Run: `npx vitest run test/brand.test.js && npx eslint . && npx prettier --check src test`
Expected: все тесты `brand.test.js` зелёные.

- [ ] **Step 5: Коммит**

```bash
git add src/brand.js test/brand.test.js
git commit -m "feat: сцена мокапа в PNG, JPG или WEBP — проверка в brand.json"
```

---

### Task 4: trace и board берут исходники любого формата

**Files:**
- Modify: `src/commands.js` (импорты, `trace`, `renderMockups`, `board`)
- Modify: `test/helpers.js` (`brandDir` принимает имя файла крупного плана)
- Test: `test/commands.test.js`

- [ ] **Step 1: Хелпер папки бренда**

В `test/helpers.js` заменить
```js
// Папка бренда, как её готовит пользователь: brand.json и source/chosen.png.
export async function brandDir(brand = BRAND) {
  const dir = await tmpDir();
  await mkdir(join(dir, 'source'), { recursive: true });
  await writeFile(join(dir, 'brand.json'), JSON.stringify(brand));
  await makeBadge(join(dir, 'source', 'chosen.png'));
  return dir;
}
```
на
```js
// Папка бренда, как её готовит пользователь: brand.json и крупный план в source/.
export async function brandDir(brand = BRAND, chosen = 'chosen.png') {
  const dir = await tmpDir();
  await mkdir(join(dir, 'source'), { recursive: true });
  await writeFile(join(dir, 'brand.json'), JSON.stringify(brand));
  await makeBadge(join(dir, 'source', chosen));
  return dir;
}
```

- [ ] **Step 2: Написать падающие тесты**

В `test/commands.test.js`:
- импорт из `node:fs/promises` заменить на `import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';` (`copyFile` больше не нужен);
- импорт из `./helpers.js` заменить на `import { BRAND, brandDir, makeBadge, tmpDir } from './helpers.js';`;
- тест `'trace без chosen.png — подсказка'` заменить на:
```js
  it('trace без крупного плана — подсказка про форматы', async () => {
    const empty = await brandDir();
    await rm(join(empty, 'source', 'chosen.png'));
    await expect(trace(empty)).rejects.toThrow(
      'Нет source/chosen.png, .jpg или .webp — сохраните крупный план из нейросети',
    );
  });

  it('trace берёт крупный план в JPG', async () => {
    const metrics = await trace(await brandDir(BRAND, 'chosen.jpg'));
    expect(metrics.match).toBeGreaterThanOrEqual(0.97);
    expect(metrics.offPalette).toEqual([]);
  });

  it('два крупных плана — ошибка', async () => {
    const both = await brandDir();
    await makeBadge(join(both, 'source', 'chosen.webp'));
    await expect(trace(both)).rejects.toThrow('«chosen.png», «chosen.webp» — оставьте один');
  });
```
- в `describe.skipIf(missingSetup())('board', …)` заменить начало `beforeAll` —
```js
    dir = await brandDir();
    await copyFile(join(dir, 'source', 'chosen.png'), join(dir, 'source', 'grid.png'));
    const brand = JSON.parse(await readFile(join(dir, 'brand.json'), 'utf8'));
    brand.mockups = [
      { scene: 'source/chosen.png', box: [100, 100, 200, 120], logo: 'stacked-main' },
    ];
```
на
```js
    dir = await brandDir(BRAND, 'chosen.jpg');
    await makeBadge(join(dir, 'source', 'grid.webp'));
    await mkdir(join(dir, 'mockups'));
    await makeBadge(join(dir, 'mockups', 'scene.jpg'));
    const brand = JSON.parse(await readFile(join(dir, 'brand.json'), 'utf8'));
    brand.mockups = [
      { scene: 'mockups/scene.jpg', box: [100, 100, 200, 120], logo: 'stacked-main' },
    ];
```
- в тесте `'без сетки — предупреждение, доска всё равно собирается'` заменить `expect(warnings[0]).toContain('grid.png');` на `expect(warnings[0]).toContain('source/grid.*');`.

- [ ] **Step 3: Запустить — должен упасть**

Run: `npx vitest run test/commands.test.js`
Expected: FAIL — `trace` не находит `chosen.jpg` («Нет …/source/chosen.png — сохраните крупный план из ChatGPT»), `board` падает на JPEG-сцене («Файл не PNG»), старые тексты ошибок не совпадают.

- [ ] **Step 4: Реализация**

В `src/commands.js`:
- импорт `import { openBrowser, pngSize } from './render.js';` заменить на `import { openBrowser } from './render.js';`;
- после импорта из `./render.js` добавить `import { findSource } from './sources.js';`;
- в `trace` заменить
```js
  const src = join(dir, 'source', 'chosen.png');
  if (!(await exists(src))) throw new Error(`Нет ${src} — сохраните крупный план из ChatGPT`);
```
на
```js
  const src = await findSource(join(dir, 'source'), 'chosen');
  if (!src) {
    throw new Error('Нет source/chosen.png, .jpg или .webp — сохраните крупный план из нейросети');
  }
```
- в `renderMockups` заменить `const size = pngSize(await readFile(scene));` на `const size = await browser.imageSize(scene);`;
- в `board` заменить блок картинки «процесс»
```js
    const grid = join(dir, 'source', 'grid.png');
    if (await exists(grid)) {
      const processPage = join(boardDir, 'process.html');
      const chosen = url(join(dir, 'source', 'chosen.png'));
      const page = processHtml({ brand, grid: url(grid), chosen, vector: images.main });
```
на
```js
    const grid = await findSource(join(dir, 'source'), 'grid');
    const chosen = await findSource(join(dir, 'source'), 'chosen');
    if (grid && chosen) {
      const processPage = join(boardDir, 'process.html');
      const page = processHtml({
        brand,
        grid: url(grid),
        chosen: url(chosen),
        vector: images.main,
      });
```
и текст предупреждения `'нет source/grid.png — картинка «процесс» пропущена'` на
`'нет source/grid.* или source/chosen.* — картинка «процесс» пропущена'`.

- [ ] **Step 5: Все тесты проходят, линтер чист**

Run: `npm run format && npm test && npx eslint .`
Expected: все тесты зелёные; `readFile` и `exists` в `commands.js` по-прежнему используются (`readMark`, проверка `out/logo` в `board`), ESLint не ругается на неиспользуемые импорты.

- [ ] **Step 6: Коммит**

```bash
git add src/commands.js test/commands.test.js test/helpers.js
git commit -m "feat: trace и board берут исходники и сцены в PNG, JPG или WEBP"
```

---

### Task 5: Трассировка из JPG и WEBP в Python-тестах

**Files:**
- Test: `vector/test_trace_logo.py`

Код трассировки не меняется: Pillow читает все три формата. Тест закрепляет проверенное
поведение, поэтому проходит сразу.

- [ ] **Step 1: Добавить тест**

В конец `vector/test_trace_logo.py`:
```python
@pytest.mark.parametrize('ext, quality', [('jpg', 70), ('webp', 80)])
def test_lossy_formats_trace_like_png(tmp_path, ext, quality):
    png = tmp_path / 'chosen.png'
    badge(png)
    src = tmp_path / f'chosen.{ext}'
    Image.open(png).save(src, quality=quality)
    m = trace(str(src), str(tmp_path / 'mark.svg'), COLORS, PAPER)
    assert m['offPalette'] == []
    assert m['match'] >= 0.97
    assert m['paths'] <= 8
```

- [ ] **Step 2: Прогнать**

Run: `npm run test:py`
Expected: `15 passed` (было 13, плюс два случая параметризации).

- [ ] **Step 3: Коммит**

```bash
git add vector/test_trace_logo.py
git commit -m "test: трассировка крупного плана из JPG и WEBP"
```

---

### Task 6: Документы и сквозная проверка

**Files:**
- Modify: `src/cli.js` (строка подсказки `trace`), `README.md`
- Modify: `docs/prompts/logo-portfolio.md`

- [ ] **Step 1: Подсказка CLI**

В `src/cli.js` заменить строку
```
  logo-kit trace <папка бренда>   source/chosen.png → out/mark.svg по палитре из brand.json
```
на
```
  logo-kit trace <папка бренда>   source/chosen.(png|jpg|webp) → out/mark.svg по палитре из brand.json
```

- [ ] **Step 2: README**

В `README.md` заменить
```
      source/grid.png      сетка 2 × 2 из ChatGPT (для картинки «процесс»)
      source/chosen.png    крупный план выбранного варианта — его трассирует trace
      mockups/             мокапы из ChatGPT или пустые сцены для наложения
```
на
```
      source/grid.*        сетка 2 × 2 из нейросети (для картинки «процесс»)
      source/chosen.*      крупный план выбранного варианта — его трассирует trace
      mockups/             мокапы из нейросети или пустые сцены для наложения

Исходники и сцены мокапов — PNG, JPG (`.jpg`, `.jpeg`) или WEBP, регистр расширения не важен.
Два файла с одним именем (`chosen.png` и `chosen.jpg`) — ошибка: оставьте один.
```

- [ ] **Step 3: Файл промптов в sos**

В `docs/prompts/logo-portfolio.md`, раздел «Как работать в ChatGPT»:
- `2. Скачать сетку в \`~/nodejs/freelance/logo-kit/brands/<бренд>/source/grid.png\`.` →
  `2. Скачать сетку в \`~/nodejs/freelance/logo-kit/brands/<бренд>/source/\` под именем \`grid\` — в том формате, в каком отдала нейросеть: \`grid.png\`, \`grid.jpg\` или \`grid.webp\`.`
- `у бренда, подставив номер. Скачать результат в \`source/chosen.png\`.` →
  `у бренда, подставив номер. Скачать результат в \`source/\` под именем \`chosen\` (PNG, JPG или WEBP).`
- `5. Проверить \`chosen.png\` глазами:` → `5. Проверить крупный план глазами:`

- [ ] **Step 4: Все проверки**

Run:
```bash
cd ~/nodejs/freelance/logo-kit
npm test && npm run test:py && npm run lint && npx prettier --check .
```
Expected: всё зелёное.

- [ ] **Step 5: Сквозной прогон CLI на JPG и WEBP**

```bash
cd ~/nodejs/freelance/logo-kit
E2E=$(mktemp -d) && mkdir -p "$E2E/source"
E2E="$E2E" node -e '
const fs = require("fs");
fs.writeFileSync(process.env.E2E + "/brand.json", JSON.stringify({
  name: "Медная турка", descriptor: "кофейня",
  palette: { chocolate: "#3B2418", copper: "#B8673A", cream: "#F3E6D3" },
  font: "oswald", textColor: "chocolate", dark: "chocolate",
  layouts: ["stacked", "horizontal", "mark"], concept: true }));'
.venv/bin/python -c "
from PIL import Image, ImageDraw, ImageFilter
im = Image.new('RGB', (600, 600), 'white'); d = ImageDraw.Draw(im)
d.ellipse((90, 90, 510, 510), fill=(184, 103, 58)); d.ellipse((170, 170, 430, 430), fill=(243, 230, 211))
d.rectangle((270, 250, 330, 400), fill=(59, 36, 24))
im = im.filter(ImageFilter.GaussianBlur(1.0))
im.save('$E2E/source/chosen.jpg', quality=80); im.save('$E2E/source/grid.webp', quality=80)"
node src/cli.js all "$E2E"
```
Expected: `Контуров: …, совпадение: 9x.x %`, строки `Готово: …` для 9 версий, иконок, логобука, доски и `Готово: процесс`, без строк `Внимание`; код выхода 0.

- [ ] **Step 6: Коммиты**

```bash
cd ~/nodejs/freelance/logo-kit
git add src/cli.js README.md
git commit -m "docs: исходники в PNG, JPG или WEBP — подсказка CLI и README"
cd <корень репозитория>
git add docs/prompts/logo-portfolio.md
git commit -m "prompts: логотипы — сохранять сетку и крупный план в том формате, что отдала нейросеть"
```

---

## Отступления при выполнении

- **Task 1, по ревью качества:** `findSource` сравнивает имена без пробелов по краям (у
  пользователя сетка «Северного каркаса» называется ` grid.jpg`), путь возвращает как на диске;
  имена в ошибке «оставьте один» — в кавычках «». Тест Task 4 про два крупных плана ждёт
  `«chosen.png», «chosen.webp» — оставьте один` (исправлено выше).
- **Task 2, по ревью качества (`e38bce2`):** отсутствующий файл даёт короткое `Не удалось открыть
  картинку <путь>: файла нет` вместо шумного текста Playwright с путём в `%`-кодировке; в
  комментарии к `imageSize` — оговорка про CSS-пиксели у JPEG с EXIF-плотностью 2x.
- **Task 4, по ревью качества (`36f4459`):** `board` ищет сетку и крупный план до `mkdir` и запуска
  Chrome — ошибка «оставьте один» не оставляет доску наполовину перезаписанной; новый тест
  «две сетки — ошибка до отрисовки».
- **Task 5, по ревью качества (`975cd43`):** тест JPG/WEBP проверяет ещё рамку знака и то, что фон
  не обведён, — иначе он прошёл бы и при JPEG с качеством 10.
- **Финальное ревью:** README уточнён — терпимость к пробелам и правило «один файл на имя»
  действуют только в `source/`, размер сцены и `box` — в CSS-пикселях.

Итог: ветка `feat/input-formats`, 11 коммитов, 104 теста Vitest и 15 pytest.
