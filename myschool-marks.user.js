// ==UserScript==
// @name         Моя школа — оценки, расписание, задания
// @namespace    tortik96.myschool
// @version      0.9.0
// @description  Удобный дневник поверх Госуслуг «Моя школа»: оценки со средним и средневзвешенным баллом, расписание, домашние задания
// @match        https://www.gosuslugi.ru/*
// @grant        none
// @run-at       document-idle
// @homepageURL  https://github.com/TORTIK96/my-school-tamperm
// @updateURL    https://raw.githubusercontent.com/TORTIK96/my-school-tamperm/main/myschool-marks.user.js
// @downloadURL  https://raw.githubusercontent.com/TORTIK96/my-school-tamperm/main/myschool-marks.user.js
// ==/UserScript==

(function () {
  'use strict';
  if (window.msxOpen) { window.msxOpen(); return; } // повторный запуск (закладка) — просто открыть окно

  // ---------- настройки и хранилище ----------
  const API = '/api/myschool';
  const LS_TYPES = 'msx_types_v1';   // id оценки -> тип работы (помечает сам ученик)
  const LS_W = 'msx_weights_v2';     // веса: общие + свои для отдельных предметов
  const TYPES = [
    { code: 'u', short: '',  name: 'Ответ на уроке' },
    { code: 's', short: 'С', name: 'Самостоятельная' },
    { code: 'k', short: 'К', name: 'Контрольная' },
  ];
  const DEFAULT_W = { u: 1, s: 1, k: 1 }; // пока веса не заданы, взвешенное = обычному среднему
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) || d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* нет места */ } };
  let types = load(LS_TYPES, {});
  // у каждого учителя свои типы и веса, поэтому веса можно задать отдельно для предмета
  const W = load(LS_W, null) || { global: Object.assign({}, DEFAULT_W, load('msx_weights_v1', {})), bySubject: {} };
  if (!W.bySubject) W.bySubject = {};
  const saveW = () => save(LS_W, W);
  const weightsFor = (subj) => Object.assign({}, DEFAULT_W, W.global, W.bySubject[subj] || {});
  const subjOf = (m) => m.subject_name || 'Без предмета';
  const openW = new Set(); // предметы, у которых раскрыта панель весов

  // ---------- API (работает через cookie текущей сессии Госуслуг) ----------
  async function api(path, body) {
    const url = API + path + (path.includes('?') ? '&' : '?') + '_=' + Math.random();
    const r = await fetch(url, {
      method: body ? 'POST' : 'GET',
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 401 || r.status === 403) throw new Error('Сессия истекла. Войдите в Госуслуги заново и обновите страницу.');
    if (!r.ok) throw new Error(`Сервер ответил ${r.status} на ${path}. Попробуйте позже.`);
    return r.json();
  }

  // ---------- недели: интервалы витрины = «номер недели + год» ----------
  const DAY = 864e5;
  const toD = (s) => new Date(s + 'T00:00:00');
  const pad = (n) => String(n).padStart(2, '0');
  // локальная дата YYYY-MM-DD (toISOString сдвигает на UTC и после полуночи даёт вчерашний день)
  const isoD = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monday = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; };
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
    const y = t.getUTCFullYear(), jan4 = new Date(Date.UTC(y, 0, 4));
    return [1 + Math.round(((t - jan4) / DAY - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7), y];
  }
  function jan1Week(d) { // вариант «первая неделя содержит 1 января»
    const start = (y) => monday(new Date(y, 0, 1));
    let y = d.getFullYear(); const m = monday(d);
    if (m >= start(y + 1)) y++;
    return [1 + Math.round((m - start(y)) / (7 * DAY)), y];
  }
  // Формат нумерации на стыке годов точно не известен, поэтому шлём все варианты,
  // лишние интервалы просто вернутся пустыми.
  function intervalIds(from, to) {
    const ids = new Set();
    for (let d = monday(from); d <= to; d = new Date(d.getTime() + 7 * DAY)) {
      for (const probe of [d, new Date(d.getTime() + 6 * DAY)]) {
        for (const [w, y] of [isoWeek(probe), jan1Week(probe)]) {
          ids.add(`${w}${y}`);
          if (w < 10) ids.add(`0${w}${y}`);
        }
      }
    }
    return [...ids];
  }

  // ---------- загрузка ----------
  async function loadContext() {
    const auth = await api('/v2/auth/student?role=student');
    const students = (Array.isArray(auth) ? auth : [auth]).filter((s) => s && s.student_id);
    if (!students.length) throw new Error('Профиль ученика не найден. Откройте «Моя школа» под ролью ученика.');
    const cy = await api('/v1/current_year');
    return { students, year: String(cy.current_year) };
  }

  async function loadPeriods(st, year) {
    const res = await api('/v1/datamart', [{ interval_id: year, obj_type: 'student_classes', student_id: st.student_id }]);
    const cls = ((res && res[0] && res[0].data) || [])[0];
    if (!cls || !cls.periods) throw new Error('Не удалось получить четверти класса. Обновите страницу и попробуйте снова.');
    const ps = cls.periods.map((p) => ({
      name: `${p.period_num} ${p.period_type_descrioption || p.period_type_code}`,
      from: p.period_start_date, to: p.period_end_date, type: p.period_type_code || 'other',
      // основной учебный период класса (четверть, триместр или полугодие) — по флагу period_is_study,
      // а не по названию: у разных школ своя система
      quarter: p.period_is_study === true || (p.period_is_study == null && p.period_type_code === 'quarter'),
    }));
    ps.sort((a, b) => (a.quarter === b.quarter ? a.from.localeCompare(b.from) : a.quarter ? -1 : 1));
    ps.push({ type: 'year', name: 'Весь год', from: ps.reduce((m, p) => (p.from < m ? p.from : m), ps[0].from),
      to: ps.reduce((m, p) => (p.to > m ? p.to : m), ps[0].to), quarter: false });
    ps.school = cls.short_name || null; // название школы для шапки
    // Флаг period_is_study витрина отдаёт ненадёжно: у 11 класса четверти помечены основными,
    // хотя в журнале школы 10–11 классы учатся по полугодиям. Поэтому для старших классов
    // по умолчанию открываем полугодия (выбор ученика всё равно важнее, см. defaultPeriod).
    ps.preferType = Number(cls.class_num) >= 10 && ps.some((p) => p.type === 'halfyear') ? 'halfyear' : null;
    return ps;
  }

  function defaultPeriod(ps) {
    const today = isoD(new Date());
    // если ученик сам выбирал вид периода (например, полугодия в 10–11 классе) — открываем его
    const pref = load('msx_period_type', null) || ps.preferType;
    const byPref = pref ? ps.filter((p) => p.type === pref) : [];
    const q = byPref.length ? byPref : ps.filter((p) => p.quarter);
    return q.find((p) => p.from <= today && today <= p.to) || q.filter((p) => p.from <= today).pop() || ps[0];
  }

  // Все данные витрины приходят «по неделям»: interval_id = номер недели + год.
  // Кэш по (тип, неделя), чтобы вкладки не перекачивали одно и то же.
  const cache = new Map();
  const keyOf = (type, x) => (type === 'student_lessons' ? x.lesson_id || x.id : x.id || x.marks_id || x.homeworks_id);
  async function fetchObjs(studentId, types, ids) {
    const need = [];
    for (const t of types) for (const i of ids) if (!cache.has(`${studentId}|${t}|${i}`)) need.push({ interval_id: i, obj_type: t, student_id: studentId });
    for (let k = 0; k < need.length; k += 10) {
      const part = need.slice(k, k + 10);
      const res = await api('/v1/datamart', part);
      for (const q of part) cache.set(`${studentId}|${q.obj_type}|${q.interval_id}`, []);
      for (const w of res || []) {
        const key = `${studentId}|${w.obj_type}|${w.interval_id}`;
        cache.set(key, (cache.get(key) || []).concat(w.data || []));
      }
    }
    const out = {};
    for (const t of types) {
      const m = new Map(); // одна и та же запись приходит в нескольких неделях — склеиваем по ID
      for (const i of ids) for (const x of cache.get(`${studentId}|${t}|${i}`) || []) m.set(keyOf(t, x), x);
      out[t] = [...m.values()];
    }
    return out;
  }

  async function fetchMarks(studentId, period) {
    const from = toD(period.from);
    // оценки попадают в неделю внесения, а не урока, поэтому смотрим ещё 3 недели после конца периода
    const to = new Date(Math.min(Date.now(), toD(period.to).getTime() + 21 * DAY));
    const r = await fetchObjs(studentId, ['student_marks', 'student_lessons'], intervalIds(from, to));
    const marks = r.student_marks.filter((m) => m.mark_date >= period.from && m.mark_date <= period.to);
    return { marks, lessons: r.student_lessons };
  }

  // урок для оценки: сначала по ID, иначе по предмету и дате (доп. столбцы имеют свой ID)
  function lessonFor(m, ls) {
    ls = ls || [];
    const exact = ls.find((l) => l.lesson_id === m.lesson_id);
    if (exact) return { lesson: exact, exact: true };
    const same = ls.filter((l) => l.subject_name === m.subject_name && String(l.start_datetime || '').slice(0, 10) === m.mark_date);
    return same.length ? { lesson: same[0], exact: false, count: same.length } : null;
  }

  // ---------- расчёт ----------
  const markType = (m) => types[m.id] || 'u';
  // по спецификации вес — строка и может быть с запятой, например "1,8"
  const apiWeight = (m) => { const w = parseFloat(String(m.weight ?? '').replace(',', '.')); return w > 0 ? w : null; };
  const markWeight = (m) => apiWeight(m) || weightsFor(subjOf(m))[markType(m)] || 1;
  const markValues = (m) => [m.mark_value1, m.mark_value2].map((x) => parseInt(x, 10)).filter((v) => v >= 1 && v <= 5);

  function summarize(marks) {
    const bySubj = new Map();
    for (const m of marks) {
      const s = subjOf(m);
      if (!bySubj.has(s)) bySubj.set(s, []);
      bySubj.get(s).push(m);
    }
    return [...bySubj.entries()].sort((a, b) => a[0].localeCompare(b[0], 'ru')).map(([subject, ms]) => {
      ms.sort((a, b) => a.mark_date.localeCompare(b.mark_date) || String(a.id).localeCompare(String(b.id)));
      let sum = 0, n = 0, wsum = 0, wtot = 0, ksum = 0, kn = 0;
      for (const m of ms) {
        const w = markWeight(m);
        for (const v of markValues(m)) { // двойная оценка 4/5 считается как две
          sum += v; n++; wsum += v * w; wtot += w;
          if (markType(m) === 'k') { ksum += v; kn++; }
        }
      }
      return { subject, marks: ms, avg: n ? sum / n : null, wavg: wtot ? wsum / wtot : null, kavg: kn ? ksum / kn : null };
    });
  }

  // ---------- интерфейс ----------
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) e.setAttribute(k, v);
    }
    for (const c of kids.flat(Infinity)) if (c != null) e.append(c.nodeType ? c : String(c));
    return e;
  }
  // 5 вместо 5,00 и 4,5 вместо 4,50
  const fmt = (x) => (x == null ? '—' : String(Math.round(x * 100) / 100).replace('.', ','));
  const grade = (x) => (x == null ? 'none' : x >= 4.5 ? 'g5' : x >= 3.5 ? 'g4' : x >= 2.5 ? 'g3' : 'g2');
  const ddmm = (s) => s.slice(8, 10) + '.' + s.slice(5, 7);
  const SEG = { u: 'Обычная', s: 'Самостоят.', k: 'Контрольная' }; // короткие подписи, чтобы влезли в одну строку
  const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const longDate = (s) => { const d = toD(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${WEEKDAYS[d.getDay()]}`; };
  const stamp = (s) => { if (!s) return null; const [d, t] = String(s).split(' '); return `${ddmm(d)} в ${String(t || '').slice(0, 5)}`; };

  // Цвета школы (синий, оранжевый, жёлтый), мягкие «мультяшные» формы без рамок
  const CSS = `
  #msx-btn{position:fixed;right:16px;bottom:16px;z-index:2147483000;border:0;border-radius:999px;padding:12px 20px;
    background:#E25628;color:#fff;font:800 15px 'Noto Sans','Segoe UI',Roboto,Arial,sans-serif;cursor:pointer;
    box-shadow:inset 0 -4px 0 rgba(0,0,0,.18),0 6px 16px rgba(226,86,40,.35)}
  #msx-root{--paper:#FAF6EE;--card:#FFFFFF;--ink:#1B2448;--muted:#6B7190;--line:rgba(90,96,125,.16);--soft:#F1EBDD;
    --orange:#E25628;--yellow:#F0B028;--g5:#34B36A;--g4:#9BD04C;--g3:#F5BE3C;--g2:#EE5A4C;
    position:fixed;inset:0;z-index:2147483001;color:var(--ink);overflow:auto;
    font:15px/1.4 'Noto Sans','Segoe UI',Roboto,Arial,sans-serif;
    background:
      radial-gradient(circle at -40px -40px,rgba(240,176,40,.28) 0 180px,transparent 181px),
      radial-gradient(circle at calc(100% + 60px) 120px,rgba(226,86,40,.16) 0 220px,transparent 221px),
      radial-gradient(circle at 12% calc(100% + 80px),rgba(240,176,40,.16) 0 240px,transparent 241px),
      var(--paper);
    background-attachment:fixed;
    padding:env(safe-area-inset-top,0) 0 env(safe-area-inset-bottom,0)}
  #msx-root[data-theme="dark"]{--paper:#141B38;--card:#1E2750;--ink:#FAF6EE;--muted:#AEB5D3;--line:rgba(250,246,238,.12);--soft:#28325F}
  #msx-root *{box-sizing:border-box}
  #msx-root button:focus-visible,#msx-root select:focus-visible,#msx-root input:focus-visible,#msx-btn:focus-visible{outline:3px solid var(--yellow,#F0B028);outline-offset:2px}
  .msx-wrap{max-width:1400px;margin:0 auto;padding:22px 20px 40px}
  .msx-top{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:10px}
  .msx-title{margin-right:auto}
  .msx-school{display:inline-block;background:var(--orange);color:#fff;font-weight:800;font-size:13px;padding:4px 12px;border-radius:999px;margin-bottom:8px}
  .msx-top h2{margin:0;font-size:42px;line-height:1;font-weight:900;color:var(--ink)}
  .msx-top select,.msx-top button,.msx-inp{font:700 14px 'Noto Sans',Arial,sans-serif;color:var(--ink);background:var(--card);border:0;border-radius:999px;padding:9px 16px;
    box-shadow:inset 0 -3px 0 var(--line),0 2px 8px rgba(27,36,72,.08)}
  .msx-top button{cursor:pointer}
  .msx-top button:active{transform:translateY(1px)}
  .msx-info{color:var(--muted);font-size:13px;margin:0 0 14px}
  .msx-head,.msx-row{display:grid;grid-template-columns:minmax(0,1fr) 120px 120px}
  .msx-head{padding:0 18px 8px;font-size:12px;font-weight:800;color:var(--muted)}
  .msx-head>span+span{text-align:center}
  .msx-head .sh{display:none}
  .msx-row{grid-template-areas:"subj avg wavg" "marks avg wavg";row-gap:10px;align-items:center;
    padding:14px 0 14px 18px;margin-bottom:12px;background:var(--card);border-radius:24px;box-shadow:0 4px 0 var(--line),0 8px 22px rgba(27,36,72,.06)}
  .msx-subj{grid-area:subj;display:flex;gap:10px;align-items:center;font-weight:900;font-size:17px}
  .msx-marks{grid-area:marks;display:flex;flex-wrap:wrap;gap:8px;padding-right:12px}
  .msx-m,.msx-avg b{position:relative;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;
    border:0;border-radius:16px;background:var(--c);color:var(--on);font:inherit;box-shadow:inset 0 -4px 0 rgba(0,0,0,.14)}
  .msx-m{min-width:46px;height:52px;padding:0 7px 3px;cursor:pointer}
  .msx-m b{font-size:21px;line-height:1;font-weight:900}
  .msx-m small{font-size:10px;font-weight:700;opacity:.8;margin-top:2px}
  .msx-m:hover{transform:translateY(-2px)}
  .msx-m i{position:absolute;top:-7px;right:-7px;min-width:20px;height:20px;padding:0 5px;border-radius:999px;
    background:var(--ink);color:var(--paper);font:800 11px/20px Arial,sans-serif;font-style:normal;text-align:center;box-shadow:0 0 0 2px var(--card)}
  .msx-m.msx-cm::after{content:'';position:absolute;top:5px;left:5px;width:7px;height:7px;border-radius:50%;background:var(--on);opacity:.75}
  .msx-m[aria-expanded="true"]{box-shadow:inset 0 -4px 0 rgba(0,0,0,.14),0 0 0 3px var(--card),0 0 0 6px var(--ink)}
  .g5{--c:var(--g5);--on:#fff}.g4{--c:var(--g4);--on:#17310A}.g3{--c:var(--g3);--on:#3A2600}.g2{--c:var(--g2);--on:#fff}.none{--c:var(--soft);--on:var(--muted)}
  .msx-avg{align-self:stretch;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;border-left:1px solid var(--line)}
  .msx-avg.plain{grid-area:avg}.msx-avg.wt{grid-area:wavg}
  .msx-avg b{min-width:70px;height:56px;padding:0 12px 3px;font-size:22px;font-weight:900;border-radius:18px}
  .msx-kr{font-size:11px;font-weight:700;color:var(--muted)}
  .msx-wbtn{font:700 12px 'Noto Sans',Arial,sans-serif;color:var(--muted);background:var(--soft);border:0;border-radius:999px;padding:4px 12px;cursor:pointer}
  .msx-wpanel{grid-column:1/-1;margin-right:18px;padding:10px 14px;background:var(--soft);border-radius:18px}
  .msx-wpanel label,.msx-set label{display:inline-flex;gap:6px;align-items:center;margin:4px 14px 4px 0;font-size:13px}
  .msx-inp{width:74px;padding:6px 10px}
  .msx-set{margin-top:22px;padding:16px 18px;background:var(--card);border-radius:24px;box-shadow:0 4px 0 var(--line)}
  .msx-err{color:var(--g2);font-weight:800}
  .msx-appinfo{margin:28px 0 0;text-align:center;font-size:12px;color:var(--muted)}
  .msx-sess{display:block;margin-top:6px}
  .msx-pop{position:fixed;z-index:2147483002;width:330px;max-width:calc(100vw - 16px);background:var(--card);color:var(--ink);
    border-radius:24px;padding:16px 18px;box-shadow:0 5px 0 var(--line),0 18px 40px rgba(27,36,72,.28)}
  .msx-pop-h{display:flex;gap:12px;align-items:center;margin-bottom:12px}
  .msx-pop-h .msx-m{cursor:default;height:56px;min-width:56px}
  .msx-pop-h .msx-m:hover{transform:none}
  .msx-pop-h div{font-weight:900;line-height:1.2}.msx-pop-h small{display:block;font-weight:500;color:var(--muted)}
  .msx-pop dl{margin:0 0 12px;display:grid;grid-template-columns:auto 1fr;gap:5px 12px;font-size:13px}
  .msx-pop dt{color:var(--muted)}.msx-pop dd{margin:0;font-weight:600}
  .msx-note{font-size:13px;background:var(--soft);padding:8px 12px;border-radius:14px;margin:0 0 12px}
  .msx-seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;background:var(--soft);padding:4px;border-radius:999px}
  .msx-seg button{font:700 12px 'Noto Sans',Arial,sans-serif;padding:8px 4px;border-radius:999px;border:0;background:transparent;color:var(--ink);cursor:pointer}
  .msx-seg button[aria-pressed="true"]{background:var(--ink);color:var(--paper)}
  .msx-x{position:absolute;top:10px;right:12px;width:30px;height:30px;border:0;border-radius:50%;background:var(--soft);color:var(--muted);font-size:18px;cursor:pointer;line-height:1}
  @media (max-width:560px){.msx-wrap{padding:16px 12px 32px}.msx-top h2{font-size:34px}
    .msx-head,.msx-row{grid-template-columns:minmax(0,1fr) 66px 66px}
    .msx-head{padding:0 12px 6px}.msx-head .lg{display:none}.msx-head .sh{display:inline}
    .msx-row{grid-template-areas:"subj avg wavg" "marks marks marks";padding:12px 0 14px 12px;border-radius:20px}
    .msx-marks{padding-right:12px}.msx-avg{border-left:1px solid var(--line)}
    .msx-avg b{min-width:52px;height:44px;font-size:18px;padding:0 8px 3px;border-radius:14px}.msx-kr{font-size:10px}
    .msx-wpanel{margin-right:12px}
    .msx-pop{left:8px!important;right:8px;bottom:8px;top:auto!important;width:auto;border-radius:26px}}
  @media (prefers-reduced-motion:no-preference){.msx-m{transition:transform .12s}.msx-m:active{transform:scale(.92)}}
  .msx-tabs{display:inline-flex;gap:4px;background:var(--card);padding:5px;border-radius:999px;margin:4px 0 18px;box-shadow:0 3px 0 var(--line),0 6px 16px rgba(27,36,72,.06)}
  .msx-tabs button{border:0;background:transparent;color:var(--muted);font:800 14px 'Noto Sans',Arial,sans-serif;padding:9px 20px;border-radius:999px;cursor:pointer}
  .msx-tabs button[aria-current="page"]{background:var(--orange);color:#fff;box-shadow:inset 0 -3px 0 rgba(0,0,0,.15)}
  .msx-weeknav{display:flex;align-items:center;gap:6px}
  .msx-weeknav span{font-weight:800;min-width:150px;text-align:center}
  .msx-day{background:var(--card);border-radius:24px;padding:14px 18px 6px;margin-bottom:12px;box-shadow:0 4px 0 var(--line),0 8px 22px rgba(27,36,72,.06)}
  .msx-day h3{margin:0 0 4px;font-size:17px;font-weight:900;display:flex;gap:8px;align-items:center}
  .msx-pill{font-size:12px;font-weight:800;padding:2px 10px;border-radius:999px;background:var(--yellow);color:#3A2600}
  .msx-lesson{display:grid;grid-template-columns:60px minmax(0,1fr) auto;gap:12px;align-items:start;padding:10px 0;border-top:1px solid var(--line)}
  .msx-day h3+.msx-lesson{border-top:0}
  .msx-ltime b{display:block;font-size:15px;font-weight:900}.msx-ltime small{color:var(--muted);font-size:12px}
  .msx-lesson.now .msx-ltime b{color:var(--orange)}
  .msx-lsub{font-weight:800}
  .msx-abs.ok{background:var(--yellow);color:#3A2600}
  .ab{--c:#DCE9FF;--on:#2B5DB8}.ap{--c:#FFF0C7;--on:#8A5A00}.an{--c:#FFDCD7;--on:#C4372A}.ao{--c:var(--soft);--on:var(--muted)}
  #msx-root[data-theme="dark"] .ab{--c:rgba(120,165,255,.22);--on:#A9C6FF}
  #msx-root[data-theme="dark"] .ap{--c:rgba(240,176,40,.22);--on:#F5CF73}
  #msx-root[data-theme="dark"] .an{--c:rgba(238,90,76,.25);--on:#FF9D93}
  .msx-m.msx-a{box-shadow:inset 0 0 0 2px var(--on)}
  .msx-m.msx-a[aria-expanded="true"]{box-shadow:inset 0 0 0 2px var(--on),0 0 0 3px var(--card),0 0 0 6px var(--ink)}
  .msx-abs.ab,.msx-abs.ap,.msx-abs.an,.msx-abs.ao{background:var(--c);color:var(--on)}
  .msx-legend{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:12px;color:var(--muted);margin:-6px 0 14px}
  .msx-legend span{display:inline-flex;align-items:center;gap:6px}
  .msx-legend i{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:7px;background:var(--c);color:var(--on);font:900 11px Arial;font-style:normal}
  .msx-legend button{font:700 12px 'Noto Sans',Arial,sans-serif;color:var(--muted);background:var(--soft);border:0;border-radius:999px;padding:3px 12px;cursor:pointer}
  .msx-lteach{font-size:12px;color:var(--muted)}
  .msx-lhw{margin-top:6px;font-size:13px;background:var(--soft);padding:7px 11px;border-radius:14px;white-space:pre-line;overflow-wrap:anywhere}
  .msx-abs{display:inline-block;font-size:11px;font-weight:800;background:var(--g2);color:#fff;padding:1px 8px;border-radius:999px;margin-left:6px;vertical-align:1px}
  .msx-lmarks{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;max-width:150px}
  .msx-lmarks .msx-m{min-width:40px;height:42px}.msx-lmarks .msx-m small{display:none}
  .msx-empty{color:var(--muted);font-size:13px;padding:6px 0 12px}
  .msx-hw{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:start;padding:10px 0;border-top:1px solid var(--line)}
  .msx-day h3+.msx-hw{border-top:0}
  .msx-chk{width:28px;height:28px;border-radius:10px;border:2px solid var(--line);background:transparent;color:#fff;font:900 15px Arial;cursor:pointer;padding:0}
  .msx-chk[aria-pressed="true"]{background:var(--g5);border-color:var(--g5)}
  .msx-hw.done .msx-hwtext{text-decoration:line-through;opacity:.5}
  .msx-hwtext{white-space:pre-line;overflow-wrap:anywhere;font-size:14px}
  .msx-hwmeta{font-size:12px;color:var(--muted);margin-top:2px}
  .msx-more{display:block;margin:6px auto 0;font:800 14px 'Noto Sans',Arial,sans-serif;color:var(--ink);background:var(--card);border:0;border-radius:999px;padding:10px 20px;cursor:pointer;box-shadow:0 3px 0 var(--line)}
  @media (max-width:560px){
    .msx-tabs{position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:3;display:flex;margin:0;box-shadow:0 6px 22px rgba(27,36,72,.28)}
    .msx-tabs button{flex:1;padding:12px 4px}
    .msx-wrap{padding-bottom:100px}
    .msx-weeknav span{min-width:0}
    .msx-day{padding:12px 14px 4px;border-radius:20px}
    .msx-lesson{grid-template-columns:50px minmax(0,1fr) auto;gap:10px}
    .msx-lmarks{max-width:96px}}
  `;

  let root, ctx, student, periods, period, data, pop = null;
  const APP = !!window.MSX_APP; // внутри Android-приложения
  const TABS = [['marks', 'Оценки'], ['schedule', 'Расписание'], ['hw', 'Задания']];
  let tab = load('msx_tab', 'marks');
  if (!TABS.some(([k]) => k === tab)) tab = 'marks';
  let weekStart = monday(new Date());
  let hwDays = 14;
  let rerender = null; // как перерисовать текущую вкладку после смены типа оценки
  const LS_DONE = 'msx_done_v1';
  const done = load(LS_DONE, {});

  // тема: сохранённый выбор, иначе как в системе
  const LS_THEME = 'msx_theme';
  let theme = load(LS_THEME, null) || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const themeLabel = () => (theme === 'dark' ? '☀' : '☾');
  const themeAria = () => (theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему');
  function toggleTheme(e) {
    theme = theme === 'dark' ? 'light' : 'dark';
    save(LS_THEME, theme);
    root.setAttribute('data-theme', theme);
    e.currentTarget.textContent = themeLabel();
    e.currentTarget.setAttribute('aria-label', themeAria());
    if (window.MsxAndroid && MsxAndroid.setTheme) MsxAndroid.setTheme(theme);
  }

  function injectStyle() {
    if (document.getElementById('msx-style')) return;
    document.head.append(h('style', { id: 'msx-style' }, CSS));
  }

  const teacherShort = (l) => (l && l.lastname ? `${l.lastname} ${l.firstname ? l.firstname[0] + '.' : ''} ${l.patronymic ? l.patronymic[0] + '.' : ''}`.trim() : '');
  const hhmm = (s) => String(s || '').slice(11, 16);
  // У части заданий витрина не присылает предмет. Восстанавливаем его по коду предмета из ID урока
  // (второй сегмент: 360300-<код>-...), коды запоминаем из уроков и оценок.
  const subjCodes = new Map(Object.entries(load('msx_subjects_v1', {})));
  const codeOf = (lessonId) => String(lessonId || '').split('-')[1];
  function learnSubjects(list) {
    let changed = false;
    for (const x of list || []) {
      const c = codeOf(x.lesson_id), n = x.subject_name;
      if (c && n && subjCodes.get(c) !== n) { subjCodes.set(c, n); changed = true; }
    }
    if (changed) save('msx_subjects_v1', Object.fromEntries(subjCodes));
  }
  const hwSubject = (x) => x.subject_name || subjCodes.get(codeOf(x.ready_lesson_id || x.issue_lesson_id)) || 'Предмет не указан';
  // Пропуски как в бумажном журнале: Б — болезнь, П — уважительная, Н — неуважительная, О — опоздание.
  // В витрине видели код 'allowded' («По уважительной причине»); остальное распознаём по тексту причины.
  function absInfo(l) {
    if (!l || !l.type_code) return null;
    const code = String(l.type_code).toLowerCase();
    const text = `${l.type_description || ''} ${l.skipping_description || ''}`.toLowerCase();
    if (/болез|болен|бол\./.test(text) || /ill|sick|disease/.test(code)) return { letter: 'Б', name: 'по болезни', cls: 'ab' };
    if (/опозд/.test(text) || /late/.test(code)) return { letter: 'О', name: 'опоздание', cls: 'ao' };
    if (/неуваж|без уваж/.test(text) || /notallow|unexcus|disallow/.test(code)) return { letter: 'Н', name: 'без уважительной причины', cls: 'an' };
    if (/уваж/.test(text) || /allow|excus/.test(code)) return { letter: 'П', name: 'по уважительной причине', cls: 'ap' };
    return { letter: 'Н', name: l.type_description || 'пропуск', cls: 'an' };
  }
  let showAbs = load('msx_show_abs', true);

  const noHw = (x) => !x || !String(x.description || '').trim() || /^без задани/i.test(String(x.description).trim());

  function renderShell(body, controls) {
    closePop();
    const title = TABS.find(([k]) => k === tab)[1];
    const top = h('div', { class: 'msx-top' },
      h('div', { class: 'msx-title' }, h('div', { class: 'msx-school' }, (ctx && ctx.school) || 'Моя школа'), h('h2', {}, title)));
    if (ctx && ctx.students.length > 1) {
      top.append(h('select', { 'aria-label': 'Ученик', onchange: async (e) => {
        student = ctx.students[e.target.value]; periods = null; data = null; await openPanel(); } },
      ctx.students.map((s, i) => h('option', { value: i, selected: s === student ? '' : null }, s.student_first_name || `Ученик ${i + 1}`))));
    }
    top.append(...(controls || []),
      h('button', { onclick: toggleTheme, 'aria-label': themeAria(), title: themeAria() }, themeLabel()),
      h('button', { onclick: refresh }, 'Обновить'),
      h('button', { onclick: closePanel }, APP ? 'Сайт' : 'Закрыть'));
    const nav = h('nav', { class: 'msx-tabs', 'aria-label': 'Разделы' }, TABS.map(([k, n]) =>
      h('button', { 'aria-current': k === tab ? 'page' : null, onclick: () => showTab(k) }, n)));
    // в приложении внизу — версии и ручная проверка обновлений
    const appInfo = APP && window.MsxAndroid && MsxAndroid.appVersion
      ? h('p', { class: 'msx-appinfo' }, `Приложение ${MsxAndroid.appVersion()} · интерфейс ${window.MSX_SCRIPT_VERSION || '?'} `,
        h('button', { class: 'msx-wbtn', onclick: () => MsxAndroid.checkUpdate() }, 'Проверить обновления'),
        // эксперимент с продлением сессии: когда был вход и жива ли сессия
        MsxAndroid.sessionInfo ? h('span', { class: 'msx-sess' }, MsxAndroid.sessionInfo() || '') : null)
      : null;
    root.replaceChildren(h('div', { class: 'msx-wrap' }, top, nav, body, appInfo));
  }

  function renderMessage(text, isError) {
    renderShell(h('p', { class: isError ? 'msx-err' : 'msx-info' }, text));
  }

  function showTab(k) {
    tab = k; save('msx_tab', k);
    if (k === 'marks') return data ? renderTable() : reload();
    if (k === 'schedule') return loadWeek();
    return loadHw();
  }

  function refresh() { cache.clear(); data = null; showTab(tab); }

  function weightInputs(obj, onSet) {
    return TYPES.map((t) => h('label', {}, t.name, h('input', {
      class: 'msx-inp', type: 'number', min: '0.1', max: '10', step: '0.1', value: obj[t.code],
      onchange: (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); onSet(t.code, v > 0 ? v : 1); },
    })));
  }

  function markTile(m, lessons, reopenId, reopenRef) {
    const t = TYPES.find((x) => x.code === markType(m));
    const b = h('button', {
      class: `msx-m ${grade(parseInt(m.mark_value1, 10))}${m.comment ? ' msx-cm' : ''}`,
      'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-label': `${m.subject_name}: ${m.mark_value1}, ${ddmm(m.mark_date)}, ${t.name}${m.comment ? ', есть комментарий' : ''}`,
      onclick: (e) => { e.stopPropagation(); openPop(m, b, lessons); },
    }, h('b', {}, m.mark_value2 ? `${m.mark_value1}/${m.mark_value2}` : (m.mark_value1 ?? '?')),
    h('small', {}, ddmm(m.mark_date)), t.short ? h('i', {}, t.short) : null);
    if (reopenId && m.id === reopenId) reopenRef.push(m, b, lessons);
    return b;
  }

  // ---------- меню оценки ----------
  function closePop() {
    if (!pop) return;
    pop.el.remove();
    if (pop.anchor && pop.anchor.isConnected) { pop.anchor.setAttribute('aria-expanded', 'false'); pop.anchor.focus(); }
    pop = null;
  }

  // витрина отдаёт расписание не за все недели, поэтому «нет урока» не всегда значит, что оценка лишняя
  function noLessonText(m, ls) {
    const first = (ls || []).reduce((mn, l) => { const d = String(l.start_datetime || '').slice(0, 10); return d && (!mn || d < mn) ? d : mn; }, null);
    return !first || m.mark_date < first ? 'расписание за эту дату не пришло' : 'урок не найден в расписании';
  }

  function openPop(m, anchor, lessons) {
    const same = pop && pop.id === m.id;
    closePop();
    if (same) return;
    const t = TYPES.find((x) => x.code === markType(m));
    const lf = lessonFor(m, lessons);
    const l = lf && lf.lesson;
    const teacher = l ? [l.lastname, l.firstname, l.patronymic].filter(Boolean).join(' ') : null;
    const time = l && l.start_datetime ? `${hhmm(l.start_datetime)}–${hhmm(l.end_datetime)}` : null;
    const sysType = m.work_type_description && m.work_type_code !== 'Ordinary' ? m.work_type_description : null;
    const rows = [
      ['Урок', l ? (time || '—') + (lf.exact ? '' : ' (доп. столбец)') : noLessonText(m, lessons)],
      ['Тема', l && l.theme],
      ['Учитель', teacher],
      ['Работа', m.work_name || sysType],
      ['Вес', apiWeight(m) ? `${m.weight} (из журнала)` : `${markWeight(m)} (ваша настройка)`],
      ['Внесена', stamp(m.create_datetime)],
      ['Исправлена', m.correction_date ? stamp(m.correction_date) : null],
    ].filter(([, v]) => v);
    const el = h('div', { class: 'msx-pop', role: 'dialog', 'aria-label': 'Оценка' },
      h('button', { class: 'msx-x', 'aria-label': 'Закрыть', onclick: closePop }, '×'),
      h('div', { class: 'msx-pop-h' },
        h('span', { class: `msx-m ${grade(parseInt(m.mark_value1, 10))}` },
          h('b', {}, m.mark_value2 ? `${m.mark_value1}/${m.mark_value2}` : (m.mark_value1 ?? '?'))),
        h('div', {}, m.subject_name, h('small', {}, longDate(m.mark_date)))),
      h('dl', {}, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      m.comment ? h('p', { class: 'msx-note' }, 'Комментарий учителя: ', m.comment)
        : h('p', { class: 'msx-info' }, 'Комментария к оценке нет.'),
      h('div', { class: 'msx-info', style: 'margin:0 0 6px' }, 'Тип работы для расчёта:'),
      h('div', { class: 'msx-seg', role: 'group', 'aria-label': 'Тип работы' }, TYPES.map((x) => h('button', {
        'aria-pressed': x.code === t.code ? 'true' : 'false',
        onclick: (e) => {
          e.stopPropagation(); // иначе клик «всплывёт» и закроет только что перерисованное меню
          if (x.code === 'u') delete types[m.id]; else types[m.id] = x.code;
          save(LS_TYPES, types);
          if (rerender) rerender(m.id);
        },
      }, SEG[x.code]))));
    placePop(el, anchor, m.id);
    el.querySelector('.msx-seg button[aria-pressed="true"]').focus();
  }

  function placePop(el, anchor, id) {
    root.append(el);
    // рядом с плиткой на широком экране, снизу листом на телефоне (это делает CSS)
    if (window.innerWidth > 560) {
      const r = anchor.getBoundingClientRect(), pw = el.offsetWidth, ph = el.offsetHeight;
      const x = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), window.innerWidth - pw - 8);
      let y = r.bottom + 8;
      if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 8);
      el.style.left = x + 'px'; el.style.top = y + 'px';
    }
    anchor.setAttribute('aria-expanded', 'true');
    pop = { el, anchor, id };
  }

  // плитка пропуска: буква вместо оценки, в средний балл не входит
  function absTile(l) {
    const a = absInfo(l), d = String(l.start_datetime).slice(0, 10);
    const b = h('button', {
      class: `msx-m msx-a ${a.cls}`, 'aria-haspopup': 'dialog', 'aria-expanded': 'false',
      'aria-label': `${l.subject_name}: пропуск ${a.name}, ${ddmm(d)}`,
      onclick: (e) => { e.stopPropagation(); openAbsPop(l, b); },
    }, h('b', {}, a.letter), h('small', {}, ddmm(d)));
    return b;
  }

  function openAbsPop(l, anchor) {
    const id = 'abs:' + l.lesson_id;
    const same = pop && pop.id === id;
    closePop();
    if (same) return;
    const a = absInfo(l), d = String(l.start_datetime).slice(0, 10);
    const rows = [
      ['Урок', `${hhmm(l.start_datetime)}–${hhmm(l.end_datetime)}`],
      ['Учитель', [l.lastname, l.firstname, l.patronymic].filter(Boolean).join(' ')],
      ['Отметка', l.type_description || a.name],
      ['Причина', l.skipping_description],
      ['Внесена', stamp(l.skip_date) || null],
    ].filter(([, v]) => v);
    const el = h('div', { class: 'msx-pop', role: 'dialog', 'aria-label': 'Пропуск' },
      h('button', { class: 'msx-x', 'aria-label': 'Закрыть', onclick: closePop }, '×'),
      h('div', { class: 'msx-pop-h' },
        h('span', { class: `msx-m msx-a ${a.cls}` }, h('b', {}, a.letter)),
        h('div', {}, `${l.subject_name}: пропуск ${a.name}`, h('small', {}, longDate(d)))),
      h('dl', {}, rows.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      h('p', { class: 'msx-info', style: 'margin:0' }, 'Пропуски в средний балл не входят.'));
    placePop(el, anchor, id);
    el.querySelector('.msx-x').focus();
  }

  // пропуски за период из уроков, по предметам
  function absencesBySubject(lessons, from, to) {
    const seen = new Set(), by = new Map();
    for (const l of lessons || []) {
      const d = String(l.start_datetime || '').slice(0, 10);
      if (!l.type_code || d < from || d > to || seen.has(l.lesson_id)) continue;
      seen.add(l.lesson_id);
      if (!by.has(l.subject_name)) by.set(l.subject_name, []);
      by.get(l.subject_name).push(l);
    }
    return by;
  }

  // ---------- вкладка «Оценки» ----------
  function marksControls() {
    return periods ? [h('select', { 'aria-label': 'Период', onchange: async (e) => { period = periods[e.target.value]; save('msx_period_type', period.type); data = null; await reload(); } },
      periods.map((p, i) => h('option', { value: i, selected: p === period ? '' : null }, p.name)))] : [];
  }

  function renderTable(reopenId) {
    rerender = renderTable;
    const rows = summarize(data.marks);
    const abs = absencesBySubject(data.lessons, period.from, period.to);
    const absTotal = [...abs.values()].reduce((n, xs) => n + xs.length, 0);
    if (showAbs) for (const subj of abs.keys()) if (!rows.some((r) => r.subject === subj)) rows.push({ subject: subj, marks: [], avg: null, wavg: null, kavg: null });
    rows.sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
    const body = h('div', {});
    body.append(h('p', { class: 'msx-info' },
      `${period.name}: ${data.marks.length} оценок${absTotal ? `, пропусков: ${absTotal}` : ''}. Нажмите на оценку, чтобы увидеть подробности и указать тип работы.`));
    if (absTotal) body.append(h('div', { class: 'msx-legend' },
      [['ab', 'Б', 'болезнь'], ['ap', 'П', 'уважительная'], ['an', 'Н', 'неуважительная'], ['ao', 'О', 'опоздание']]
        .map(([c, l, n]) => h('span', { class: c }, h('i', {}, l), n)),
      h('button', { onclick: () => { showAbs = !showAbs; save('msx_show_abs', showAbs); renderTable(); } },
        showAbs ? 'Скрыть пропуски' : 'Показать пропуски')));
    if (!rows.length) body.append(h('p', {}, 'За этот период оценок нет. Выберите другой период выше.'));
    else body.append(h('div', { class: 'msx-head', 'aria-hidden': 'true' },
      h('span', {}, 'Предмет и оценки'),
      h('span', {}, h('span', { class: 'lg' }, 'Средний'), h('span', { class: 'sh' }, 'Сред.')),
      h('span', {}, h('span', { class: 'lg' }, 'Средневзвешенный'), h('span', { class: 'sh' }, 'Взвеш.'))));
    const reopen = [];
    for (const r of rows) {
      const w = weightsFor(r.subject);
      const own = !!W.bySubject[r.subject];
      const weighted = Object.values(w).some((x) => x !== 1);
      const open = openW.has(r.subject);
      const row = h('div', { class: 'msx-row' },
        h('div', { class: 'msx-subj' }, r.subject,
          h('button', { class: 'msx-wbtn', 'aria-expanded': open ? 'true' : 'false',
            onclick: () => { open ? openW.delete(r.subject) : openW.add(r.subject); renderTable(); } },
          own ? 'Веса: свои' : 'Веса')),
        h('div', { class: 'msx-marks' }, [
          ...r.marks.map((m) => ({ d: m.mark_date, el: markTile(m, data.lessons, reopenId, reopen) })),
          ...(showAbs ? (abs.get(r.subject) || []).map((l) => ({ d: String(l.start_datetime).slice(0, 10), el: absTile(l) })) : []),
        ].sort((a, b) => a.d.localeCompare(b.d)).map((x) => x.el)),
        h('div', { class: 'msx-avg plain', 'aria-label': 'Средний балл ' + fmt(r.avg) }, h('b', { class: grade(r.avg) }, fmt(r.avg)),
          r.kavg != null ? h('span', { class: 'msx-kr' }, 'по КР ' + fmt(r.kavg)) : null),
        h('div', { class: 'msx-avg wt', 'aria-label': 'Средневзвешенный балл ' + fmt(r.wavg),
          title: weighted ? 'С учётом весов' : 'Веса не заданы — совпадает со средним' }, h('b', { class: grade(r.wavg) }, fmt(r.wavg))));
      if (open) {
        row.append(h('div', { class: 'msx-wpanel' },
          weightInputs(w, (code, v) => { W.bySubject[r.subject] = Object.assign({}, w, { [code]: v }); saveW(); renderTable(); }),
          own ? h('button', { class: 'msx-wbtn', onclick: () => { delete W.bySubject[r.subject]; saveW(); renderTable(); } },
            'Сбросить к общим') : null));
      }
      body.append(row);
    }
    const anyWeighted = Object.values(W.global).some((x) => x !== 1) || Object.keys(W.bySubject).length > 0;
    body.append(h('div', { class: 'msx-set' },
      h('div', {}, h('b', {}, 'Общие веса'), ' — для предметов без своих весов. Узнайте их у учителя (журнал → «Задать типы») или в «Положении о текущем контроле».'),
      weightInputs(Object.assign({}, DEFAULT_W, W.global), (code, v) => { W.global[code] = v; saveW(); renderTable(); }),
      anyWeighted ? null : h('p', { class: 'msx-info', style: 'margin:6px 0 0' }, 'Пока все веса равны 1, поэтому взвешенный балл совпадает с обычным средним. Так же считает и сам журнал, если учитель не задал веса.')));
    renderShell(body, marksControls());
    if (reopen.length) openPop(...reopen);
  }

  async function reload() {
    try {
      renderMessage('Загружаю оценки…');
      data = await fetchMarks(student.student_id, period);
      learnSubjects(data.lessons); learnSubjects(data.marks);
      if (tab === 'marks') renderTable();
    } catch (e) { renderMessage(e.message || String(e), true); }
  }

  // ---------- вкладка «Расписание» ----------
  const DAYNAMES = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
  const shortDate = (d) => `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  let lastWeek = null;

  function weekControls() {
    const sun = new Date(weekStart.getTime() + 6 * DAY);
    const go = (days) => { weekStart = new Date(weekStart.getTime() + days * DAY); loadWeek(); };
    return [h('div', { class: 'msx-weeknav' },
      h('button', { 'aria-label': 'Предыдущая неделя', onclick: () => go(-7) }, '‹'),
      h('span', {}, `${shortDate(weekStart)} – ${shortDate(sun)}`),
      h('button', { 'aria-label': 'Следующая неделя', onclick: () => go(7) }, '›'),
      h('button', { onclick: () => { weekStart = monday(new Date()); loadWeek(); } }, 'Сегодня'))];
  }

  async function loadWeek() {
    renderShell(h('p', { class: 'msx-info' }, 'Загружаю расписание…'), weekControls());
    try {
      const sid = student.student_id, now = new Date();
      const mon = weekStart, sun = new Date(mon.getTime() + 6 * DAY);
      const les = await fetchObjs(sid, ['student_lessons'], intervalIds(mon, sun));
      // оценки попадают в неделю внесения, поэтому смотрим до 3 недель вперёд (но не в будущее)
      const mEnd = new Date(Math.max(mon.getTime(), Math.min(now.getTime(), sun.getTime() + 21 * DAY)));
      const mk = await fetchObjs(sid, ['student_marks'], intervalIds(mon, mEnd));
      // задания часто вносят заранее, поэтому берём недели вокруг
      const hEnd = new Date(Math.max(sun.getTime(), now.getTime()) + 7 * DAY);
      const hw = await fetchObjs(sid, ['student_homeworks_materials'], intervalIds(new Date(mon.getTime() - 14 * DAY), hEnd));
      learnSubjects(les.student_lessons); learnSubjects(mk.student_marks);
      lastWeek = { lessons: les.student_lessons, marks: mk.student_marks, hws: hw.student_homeworks_materials };
      if (tab === 'schedule') renderWeek();
    } catch (e) { renderShell(h('p', { class: 'msx-err' }, e.message || String(e)), weekControls()); }
  }

  function renderWeek(reopenId) {
    rerender = renderWeek;
    const { lessons, marks, hws } = lastWeek;
    const mon = weekStart, today = isoD(new Date()), nowStr = `${today} ${new Date().toTimeString().slice(0, 5)}`;
    const days = [];
    for (let i = 0; i < 7; i++) days.push(isoD(new Date(mon.getTime() + i * DAY)));
    const inWeek = (d) => d >= days[0] && d <= days[6];
    const wl = lessons.filter((l) => inWeek(String(l.start_datetime || '').slice(0, 10)))
      .sort((a, b) => String(a.start_datetime).localeCompare(String(b.start_datetime)));
    const byId = new Map(wl.map((l) => [l.lesson_id, l]));
    const firstOf = (subj, date) => wl.find((l) => l.subject_name === subj && String(l.start_datetime).slice(0, 10) === date);
    // оценки и задания к урокам: сначала по ID, иначе к первому уроку этого предмета в тот день
    const lm = new Map(), lh = new Map(), dayHw = new Map();
    const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
    for (const m of marks.filter((m) => inWeek(m.mark_date))) {
      const l = byId.get(m.lesson_id) || firstOf(m.subject_name, m.mark_date);
      if (l) push(lm, l.lesson_id, m);
    }
    for (const x of hws.filter((x) => inWeek(x.plan_ready_date) && !noHw(x))) {
      const l = byId.get(x.ready_lesson_id) || firstOf(hwSubject(x), x.plan_ready_date);
      if (l) push(lh, l.lesson_id, x); else push(dayHw, x.plan_ready_date, x);
    }
    const body = h('div', {});
    const reopen = [];
    days.forEach((d, i) => {
      const dl = wl.filter((l) => String(l.start_datetime).slice(0, 10) === d);
      if (i >= 5 && !dl.length && !dayHw.has(d)) return; // пустые выходные не показываем
      const card = h('section', { class: 'msx-day', 'aria-label': `${DAYNAMES[i]}, ${longDate(d)}` },
        h('h3', {}, `${DAYNAMES[i]}, ${shortDate(toD(d))}`, d === today ? h('span', { class: 'msx-pill' }, 'сегодня') : null));
      if (!dl.length) card.append(h('div', { class: 'msx-empty' }, 'Уроков нет'));
      for (const l of dl) {
        const now = d === today && `${d} ${hhmm(l.start_datetime)}` <= nowStr && nowStr < `${d} ${hhmm(l.end_datetime)}`;
        const ai = absInfo(l);
        const abs = ai ? `${ai.letter} · ${ai.name}` : null;
        const absCls = ai ? `msx-abs ${ai.cls}` : '';
        card.append(h('div', { class: `msx-lesson${now ? ' now' : ''}` },
          h('div', { class: 'msx-ltime' }, h('b', {}, hhmm(l.start_datetime)), h('small', {}, hhmm(l.end_datetime))),
          h('div', {},
            h('div', { class: 'msx-lsub' }, l.subject_name, abs ? h('span', { class: absCls }, abs) : null),
            h('div', { class: 'msx-lteach' }, [teacherShort(l), l.room && l.room !== '-' ? `каб. ${l.room}` : null, l.theme].filter(Boolean).join(' · ')),
            (lh.get(l.lesson_id) || []).map((x) => h('div', { class: 'msx-lhw' }, '📘 ', x.description))),
          h('div', { class: 'msx-lmarks' }, (lm.get(l.lesson_id) || []).map((m) => markTile(m, lessons, reopenId, reopen)))));
      }
      for (const x of dayHw.get(d) || []) card.append(h('div', { class: 'msx-lhw' }, `📘 ${hwSubject(x)}: `, x.description));
      body.append(card);
    });
    if (!wl.length) body.prepend(h('p', { class: 'msx-info' }, 'На эту неделю расписание не пришло. Витрина обычно отдаёт только ближайшие недели.'));
    renderShell(body, weekControls());
    if (reopen.length) openPop(...reopen);
  }

  // ---------- вкладка «Задания» ----------
  async function loadHw() {
    renderMessage('Загружаю задания…');
    try {
      const now = new Date();
      const r = await fetchObjs(student.student_id, ['student_homeworks_materials', 'student_lessons'],
        intervalIds(new Date(now.getTime() - 21 * DAY), new Date(now.getTime() + 7 * DAY)));
      learnSubjects(r.student_lessons);
      renderHw(r.student_homeworks_materials);
    } catch (e) { renderMessage(e.message || String(e), true); }
  }

  function renderHw(list) {
    rerender = null;
    const now = new Date(), today = isoD(now), until = isoD(new Date(now.getTime() + hwDays * DAY));
    const items = list.filter((x) => x.plan_ready_date >= today && x.plan_ready_date <= until && !noHw(x))
      .sort((a, b) => a.plan_ready_date.localeCompare(b.plan_ready_date) || hwSubject(a).localeCompare(hwSubject(b), 'ru'));
    const body = h('div', {}, h('p', { class: 'msx-info' },
      `Что задано на ${hwDays} дней вперёд. Отмечайте сделанное галочкой — это видно только вам.`));
    if (!items.length) body.append(h('p', {}, 'Заданий на эти дни нет.'));
    const groups = new Map();
    for (const x of items) { if (!groups.has(x.plan_ready_date)) groups.set(x.plan_ready_date, []); groups.get(x.plan_ready_date).push(x); }
    for (const [d, xs] of groups) {
      const dt = toD(d), wd = (dt.getDay() + 6) % 7;
      const card = h('section', { class: 'msx-day' },
        h('h3', {}, `${DAYNAMES[wd]}, ${shortDate(dt)}`, d === today ? h('span', { class: 'msx-pill' }, 'сегодня') : null,
          d === isoD(new Date(now.getTime() + DAY)) ? h('span', { class: 'msx-pill' }, 'завтра') : null));
      for (const x of xs) {
        const isDone = !!done[x.id];
        card.append(h('div', { class: `msx-hw${isDone ? ' done' : ''}` },
          h('button', { class: 'msx-chk', 'aria-pressed': isDone ? 'true' : 'false', 'aria-label': `Сделано: ${hwSubject(x)}`,
            onclick: () => { if (done[x.id]) delete done[x.id]; else done[x.id] = 1; save(LS_DONE, done); renderHw(list); } }, isDone ? '✓' : ''),
          h('div', {}, h('div', { class: 'msx-lsub' }, hwSubject(x)),
            h('div', { class: 'msx-hwtext' }, x.description),
            h('div', { class: 'msx-hwmeta' }, `задано ${ddmm(x.issue_date || d)}${x.materials && x.materials.length ? ' · есть материалы, откройте на сайте' : ''}`))));
      }
      body.append(card);
    }
    body.append(h('button', { class: 'msx-more', onclick: () => { hwDays += 7; renderHw(list); } }, 'Показать ещё неделю'));
    renderShell(body);
  }

  // ---------- открытие и закрытие ----------
  async function openPanel() {
    injectStyle();
    if (!root) {
      root = h('div', { id: 'msx-root', role: 'dialog', 'aria-label': 'Мой дневник', 'data-theme': theme,
        onclick: (e) => { if (pop && !pop.el.contains(e.target)) closePop(); } });
      document.body.append(root);
      if (window.MsxAndroid && MsxAndroid.setTheme) MsxAndroid.setTheme(theme);
    }
    root.style.display = '';
    try {
      if (!ctx) { renderMessage('Подключаюсь к «Моя школа»…'); ctx = await loadContext(); student = ctx.students[0]; }
      if (!periods) { const r = await loadPeriods(student, ctx.year); periods = r; ctx.school = r.school; period = defaultPeriod(periods); }
      await showTab(tab);
    } catch (e) { renderMessage(e.message || String(e), true); }
  }

  function closePanel() { closePop(); if (root) root.style.display = 'none'; }
  const panelOpen = () => !!root && root.style.display !== 'none';
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !panelOpen()) return;
    if (pop) closePop(); else closePanel();
  });
  // кнопка «назад» в приложении: true — обработали сами
  window.msxBack = () => {
    if (pop) { closePop(); return true; }
    if (APP && !panelOpen() && location.pathname.startsWith('/school')) { openPanel(); return true; }
    return false;
  };

  // Госуслуги — одностраничное приложение, поэтому следим за адресом сами
  let autoOpened = false;
  function syncButton() {
    const onSchool = location.pathname.startsWith('/school');
    let btn = document.getElementById('msx-btn');
    if (onSchool && !btn) {
      injectStyle();
      btn = h('button', { id: 'msx-btn', onclick: openPanel }, 'Мой дневник');
      document.body.append(btn);
    } else if (!onSchool && btn) { btn.remove(); closePanel(); }
    if (APP && onSchool && !autoOpened) { autoOpened = true; openPanel(); }
  }
  window.msxOpen = openPanel;
  syncButton();
  setInterval(syncButton, 1000);
})();
