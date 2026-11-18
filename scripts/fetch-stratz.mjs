// Скачивает из STRATZ по обычным рейтинговым играм:
//  1) пары героев (синергия и контрпики) → data/matchups-<ранг>.json
//  2) игры и победы каждого героя по дням за последние 30 дней (всего и на каждой позиции)
//     → data/daily-<ранг>.json; сайт сам складывает их за выбранный период
//  3) винрейт героев по длительности матча: до 25 мин / 25–40 / 40+ → data/time-<ранг>.json
//  4) исходы линий герой против героя → data/lane-<ранг>.json
//  + data/diagnostics.json — что скачалось, а что нет (и схема API, если запрос не подошёл)
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
const diag = { started: new Date().toISOString(), sections: {} };
const note = (name, info) => { diag.sections[name] = { ...(diag.sections[name] || {}), ...info }; };
// Ошибка в самом запросе (не та схема) — повторять бессмысленно, бросаем раздел целиком.
const isSchemaError = (e) => /Cannot query field|Unknown argument|Unknown type|GRAPHQL_VALIDATION|must have a selection|of required type|is not defined/i.test(String(e?.message || ""));

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
      if (isSchemaError(e)) throw e;
      failed++;
      note("matchups", { lastError: e.message.slice(0, 500) });
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
  note("matchups", { [key]: { heroes: got, failed } });
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
    note("daily", { [key]: { days: days.length, heroes: Object.keys(heroes).length } });
    await writeFile(`data/daily-${key}.json`, JSON.stringify({ updated: new Date().toISOString(), bracket: key, source: "STRATZ", days, heroes }));
    console.log(`По дням ${key}: ${days.length} дней, ${Object.keys(heroes).length} героев`);
  }
} catch (e) {
  console.error("ОШИБКА при загрузке статистики по дням (пары героев сохранены):", e.message);
  note("daily", { error: e.message.slice(0, 1500) });
}

// ---------- винрейт по длительности матча ----------
const TIME_QUERY = `
query Time($brackets: [RankBracketBasicEnum]) {
  heroStats {
    stats(bracketBasicIds: $brackets, groupByTime: true) {
      heroId
      time
      matchCount
      winCount
    }
  }
}`;
try {
  for (const [key, brackets] of Object.entries(BRACKETS)) {
    const vars = {};
    if (brackets) vars.brackets = brackets;
    const data = await gql(vars, TIME_QUERY);
    const rows = data?.heroStats?.stats || [];
    const times = rows.map((r) => Number(r?.time)).filter((t) => !Number.isNaN(t));
    const inSeconds = times.length && Math.max(...times) > 300; // если пришли секунды, а не минуты
    const heroes = {};
    for (const r of rows) {
      if (!r?.heroId || r.time == null) continue;
      const min = inSeconds ? Number(r.time) / 60 : Number(r.time);
      const ph = min < 25 ? "e" : min < 40 ? "m" : "l";
      const h = (heroes[r.heroId] ||= { e: [0, 0], m: [0, 0], l: [0, 0] });
      h[ph][0] += r.matchCount || 0;
      h[ph][1] += r.winCount || 0;
    }
    note("time", { [key]: { rows: rows.length, heroes: Object.keys(heroes).length, timeSample: [...new Set(times)].slice(0, 12) } });
    if (CHECK) { console.log("Время работает:", Object.entries(heroes)[0]); break; }
    if (Object.keys(heroes).length < 50) { console.warn(`Время ${key}: мало данных (${Object.keys(heroes).length} героев), не сохраняю`); continue; }
    await writeFile(`data/time-${key}.json`, JSON.stringify({ updated: new Date().toISOString(), bracket: key, source: "STRATZ", heroes }));
    saved++;
    console.log(`Время ${key}: ${Object.keys(heroes).length} героев`);
    await sleep(600);
  }
} catch (e) {
  console.error("ОШИБКА при загрузке винрейта по времени:", e.message);
  note("time", { error: e.message.slice(0, 1500) });
}

// ---------- исходы линий ----------
const LANE_QUERY = `
query Lane($heroId: Short!, $brackets: [RankBracketBasicEnum]) {
  heroStats {
    laneOutcome(heroId: $heroId, isWith: false, bracketBasicIds: $brackets) {
      heroId1
      heroId2
      matchCount
      winCount
      drawCount
      lossCount
    }
  }
}`;
try {
  for (const [key, brackets] of Object.entries(BRACKETS)) {
    const out = { updated: new Date().toISOString(), bracket: key, source: "STRATZ", heroes: {} };
    let failed = 0;
    for (const id of CHECK ? heroIds.slice(0, 1) : heroIds) {
      const vars = { heroId: id };
      if (brackets) vars.brackets = brackets;
      let data;
      try {
        data = await gql(vars, LANE_QUERY);
      } catch (e) {
        if (isSchemaError(e)) throw e;
        failed++;
        note("lane", { lastError: e.message.slice(0, 500) });
        continue;
      }
      const rows = data?.heroStats?.laneOutcome || [];
      const map = {};
      for (const r of rows) {
        // строка может прийти с героем в любой из двух колонок
        const other = r.heroId1 === id ? r.heroId2 : r.heroId1;
        if (!other || !r.matchCount) continue;
        const flip = r.heroId1 !== id;
        map[other] = flip ? [r.matchCount, r.lossCount || 0, r.drawCount || 0, r.winCount || 0] : [r.matchCount, r.winCount || 0, r.drawCount || 0, r.lossCount || 0];
      }
      out.heroes[id] = map;
      await sleep(600);
    }
    const got = Object.values(out.heroes).filter((m) => Object.keys(m).length).length;
    note("lane", { [key]: { heroes: got, failed } });
    if (CHECK) { console.log("Линии работают:", Object.entries(Object.values(out.heroes)[0] || {}).slice(0, 3)); break; }
    if (got < heroIds.length * 0.5) { console.warn(`Линии ${key}: только ${got} героев, не сохраняю`); continue; }
    await writeFile(`data/lane-${key}.json`, JSON.stringify(out));
    saved++;
    console.log(`Линии ${key}: ${got} героев` + (failed ? ` (пропущено ${failed})` : ""));
  }
} catch (e) {
  console.error("ОШИБКА при загрузке линий:", e.message);
  note("lane", { error: e.message.slice(0, 1500) });
}

// ---------- диагностика ----------
// Если какой-то раздел упал из-за схемы, сохраняем описание API, чтобы поправить запрос.
if (Object.values(diag.sections).some((x) => x.error)) {
  try {
    const t = (n) => `{ __type(name: "${n}") { name fields { name args { name type { kind name ofType { kind name ofType { kind name } } } } type { kind name ofType { kind name ofType { kind name } } } } } }`;
    const root = await gql({}, `{ __schema { queryType { fields { name type { name } } } } }`);
    const hsType = root?.__schema?.queryType?.fields?.find((f) => f.name === "heroStats")?.type?.name;
    if (hsType) {
      const hs = await gql({}, t(hsType));
      diag.heroStatsType = hs?.__type;
      const unwrap = (ty) => (ty?.name ? ty.name : ty?.ofType ? unwrap(ty.ofType) : null);
      diag.types = {};
      for (const f of hs?.__type?.fields || []) {
        if (!["stats", "laneOutcome", "winDay", "heroVsHeroMatchup"].includes(f.name)) continue;
        const tn = unwrap(f.type);
        if (tn) diag.types[tn] = (await gql({}, t(tn)))?.__type?.fields?.map((x) => x.name);
      }
    }
  } catch (e) {
    diag.introspectionError = e.message.slice(0, 500);
  }
}
diag.finished = new Date().toISOString();
if (!CHECK) await writeFile("data/diagnostics.json", JSON.stringify(diag, null, 2));
console.log("Диагностика:", JSON.stringify(diag.sections));

if (!CHECK && saved === 0) {
  console.error("Не удалось обновить ни одного файла — STRATZ, скорее всего, перегружен. Запусти ещё раз позже.");
  process.exit(1);
}
console.log(`Готово, обновлено файлов: ${saved}`);
