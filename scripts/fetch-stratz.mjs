// Скачивает из STRATZ по обычным рейтинговым играм:
//  1) пары героев (синергия и контрпики) → data/matchups-<ранг>.json
//  2) игры и победы каждого героя по дням за последние 30 дней (всего и на каждой позиции)
//     → data/daily-<ранг>.json; сайт сам складывает их за выбранный период
// Запуск: STRATZ_TOKEN=... node scripts/fetch-stratz.mjs
// Проверка токена и запроса на одном герое: node scripts/fetch-stratz.mjs --check
import { mkdir, writeFile } from "node:fs/promises";

const TOKEN = process.env.STRATZ_TOKEN;
if (!TOKEN) {
  console.error("Нет токена: задай переменную STRATZ_TOKEN (в GitHub: Settings → Secrets → Actions).");
  process.exit(1);
}

const API = "https://api.stratz.com/graphql";
const BRACKETS = {
  ALL: null,
  HERALD_GUARDIAN: ["HERALD_GUARDIAN"],
  CRUSADER_ARCHON: ["CRUSADER_ARCHON"],
  LEGEND_ANCIENT: ["LEGEND_ANCIENT"],
  DIVINE_IMMORTAL: ["DIVINE_IMMORTAL"],
};
// Ранги для статистики по дням (тип RankBracket в STRATZ)
const DAY_BRACKETS = {
  ALL: null,
  HERALD_GUARDIAN: ["HERALD", "GUARDIAN"],
  CRUSADER_ARCHON: ["CRUSADER", "ARCHON"],
  LEGEND_ANCIENT: ["LEGEND", "ANCIENT"],
  DIVINE_IMMORTAL: ["DIVINE", "IMMORTAL"],
};
const DAYS = 30;
const DAY_QUERY = `
query Daily($brackets: [RankBracket], $positions: [MatchPlayerPositionType]) {
  heroStats {
    winDay(take: ${DAYS}, bracketIds: $brackets, positionIds: $positions) {
      day
      heroId
      matchCount
      winCount
    }
  }
}`;

const QUERY = `
query Matchups($heroId: Short!, $brackets: [RankBracketBasicEnum]) {
  heroStats {
    heroVsHeroMatchup(heroId: $heroId, bracketBasicIds: $brackets, take: 200) {
      advantage {
        heroId
        with { heroId2 matchCount winCount }
        vs { heroId2 matchCount winCount }
      }
    }
  }
}`;

const CHECK = process.argv.includes("--check");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isBusy = (errors) =>
  errors.some((e) => {
    const code = String(e?.extensions?.code || "");
    return /BUSY|TIMEOUT|RATE/i.test(code) || /temporarily unavailable|capacity|try again|retry/i.test(String(e?.message || ""));
  });

async function gql(variables, query = QUERY) {
  const MAX = 8;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const wait = 5000 * attempt; // 5, 10, 15 … 40 секунд
    let res;
    try {
      res = await fetch(API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          "User-Agent": "STRATZ_API",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      console.warn(`Сеть: ${e.message}, жду ${wait / 1000} с…`);
      await sleep(wait);
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      console.warn(`STRATZ ответил ${res.status}, жду ${wait / 1000} с и пробую снова…`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`STRATZ вернул не JSON (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    if (json.errors) {
      if (isBusy(json.errors) && attempt < MAX) {
        console.warn(`STRATZ перегружен (попытка ${attempt}/${MAX}), жду ${wait / 1000} с…`);
        await sleep(wait);
        continue;
      }
      throw new Error("Ошибка запроса GraphQL: " + JSON.stringify(json.errors).slice(0, 1500));
    }
    return json.data;
  }
  throw new Error("STRATZ так и не ответил после нескольких попыток — попробуй позже.");
}

const pack = (arr) =>
  Object.fromEntries(
    (arr || [])
      .filter((x) => x && x.matchCount > 0 && x.heroId2)
      .map((x) => [x.heroId2, [x.matchCount, x.winCount]])
  );

const heroesRes = await fetch("https://api.opendota.com/api/heroes");
if (!heroesRes.ok) throw new Error("Не удалось получить список героев с OpenDota: HTTP " + heroesRes.status);
const heroIds = (await heroesRes.json()).map((h) => h.id).sort((a, b) => a - b);
console.log(`Героев: ${heroIds.length}`);

await mkdir("data", { recursive: true });
let saved = 0; // сколько файлов удалось обновить

for (const [key, brackets] of Object.entries(BRACKETS)) {
  const out = { updated: new Date().toISOString(), bracket: key, source: "STRATZ", heroes: {} };
  const ids = CHECK ? heroIds.slice(0, 1) : heroIds;
  let failed = 0;
  for (const id of ids) {
    const vars = { heroId: id };
    if (brackets) vars.brackets = brackets;
    let data;
    try {
      data = await gql(vars);
    } catch (e) {
      failed++;
      console.warn(`Герой ${id} (${key}) пропущен: ${e.message.slice(0, 200)}`);
      continue;
    }
    const adv = data?.heroStats?.heroVsHeroMatchup?.advantage?.[0];
    if (!adv) {
      console.warn(`Нет данных для героя ${id} (${key})`);
      continue;
    }
    out.heroes[id] = { w: pack(adv.with), v: pack(adv.vs) };
    await sleep(600); // не нагружаем STRATZ и не упираемся в лимиты бесплатного токена
  }
  if (CHECK) {
    const h = Object.values(out.heroes)[0];
    console.log("Запрос работает. Пример для героя", ids[0], ":");
    console.log("  с союзниками:", Object.entries(h?.w || {}).slice(0, 3));
    console.log("  против врагов:", Object.entries(h?.v || {}).slice(0, 3));
    break;
  }
  const got = Object.keys(out.heroes).length;
  if (got < ids.length * 0.5) {
    console.warn(`${key}: скачано только ${got} из ${ids.length} героев — файл не обновляю, оставляю прошлые данные`);
    continue;
  }
  await writeFile(`data/matchups-${key}.json`, JSON.stringify(out));
  saved++;
  console.log(`${key}: сохранено ${got} героев` + (failed ? ` (пропущено ${failed})` : ""));
}

// ---------- статистика по дням ----------
// Если этот запрос сломается, пары героев выше всё равно уже сохранены.
try {
  for (const [key, brackets] of Object.entries(DAY_BRACKETS)) {
    const rows = []; // [slot, day, heroId, matches, wins]; slot 0 — все позиции, 1..5 — позиция
    for (let slot = 0; slot <= 5; slot++) {
      const vars = {};
      if (brackets) vars.brackets = brackets;
      if (slot) vars.positions = [`POSITION_${slot}`];
      const data = await gql(vars, DAY_QUERY);
      for (const r of data?.heroStats?.winDay || []) {
        if (!r?.heroId || r.day == null) continue;
        // день может прийти числом (секунды или миллисекунды) или строкой с датой
        let day = Number(r.day);
        if (Number.isNaN(day)) day = Math.floor(Date.parse(r.day) / 1000);
        else if (day > 1e12) day = Math.floor(day / 1000);
        if (!Number.isNaN(day)) rows.push([slot, day, r.heroId, r.matchCount || 0, r.winCount || 0]);
      }
      await sleep(600);
    }
    const days = [...new Set(rows.map((r) => r[1]))].sort((a, b) => a - b);
    const di = new Map(days.map((d, i) => [d, i]));
    const heroes = {};
    for (const [slot, day, id, m, w] of rows) {
      const h = (heroes[id] ||= [[], [], [], [], [], []]);
      const cur = h[slot][di.get(day)] || [0, 0];
      h[slot][di.get(day)] = [cur[0] + m, cur[1] + w];
    }
    for (const id in heroes) heroes[id] = heroes[id].map((arr) => Array.from({ length: days.length }, (_, i) => arr[i] || 0));
    if (CHECK) {
      console.log(`По дням работает: ${days.length} дней, ${Object.keys(heroes).length} героев. Пример:`, Object.entries(heroes)[0]?.[1]?.[0]?.slice(-3));
      break;
    }
    saved++;
    await writeFile(`data/daily-${key}.json`, JSON.stringify({ updated: new Date().toISOString(), bracket: key, source: "STRATZ", days, heroes }));
    console.log(`По дням ${key}: ${days.length} дней, ${Object.keys(heroes).length} героев`);
  }
} catch (e) {
  console.error("ОШИБКА при загрузке статистики по дням (пары героев сохранены):", e.message);
}

if (!CHECK && saved === 0) {
  console.error("Не удалось обновить ни одного файла — STRATZ, скорее всего, перегружен. Запусти ещё раз позже.");
  process.exit(1);
}
console.log(`Готово, обновлено файлов: ${saved}`);
