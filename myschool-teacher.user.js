// ==UserScript==
// @name         Моя школа — учитель: темы и ДЗ из КТП и Excel
// @namespace    tortik96.myschool.teacher
// @version      0.3.0
// @description  На странице «Уроки» журнала: проставить темы и домашние задания из КТП во все уроки разом или вставить их столбцами из Excel
// @match        https://edu.gosuslugi.ru/journal-app/page.lessons/*
// @grant        none
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js
// @homepageURL  https://github.com/TORTIK96/my-school-tamperm
// @updateURL    https://raw.githubusercontent.com/TORTIK96/my-school-tamperm/main/myschool-teacher.user.js
// @downloadURL  https://raw.githubusercontent.com/TORTIK96/my-school-tamperm/main/myschool-teacher.user.js
// ==/UserScript==

/*
 * Как устроено (по записи работы страницы):
 *  - уроки периода лежат в HTML: <tbody id="g{группа}_homework"> → <tr class="lessons-row" ldate lnum num pid canedit>
 *  - «протыкивание» темы из КТП = teacher.get_lesson_topic (сервер отдаёт тему плана и её pid)
 *    + teacher.save_lesson_topic с этой темой и pid — ровно это и повторяет скрипт, урок за уроком
 *  - тема из Excel = teacher.save_lesson_topic с текстом и пустым pid
 * Скрипт ничего не сохраняет без предпросмотра и подтверждения; уроки идут строго по порядку, по одному.
 */
(function () {
  'use strict';
  if (window.__msxTeacher) return;
  window.__msxTeacher = true;

  const DELAY_MS = 350; // пауза между уроками: не грузим сервер и повторяем темп «ручного» заполнения

  // ---------- данные страницы ----------
  function pageInfo() {
    const jt = window.JournalTeacher || {};
    let year = jt.year, lessonId = jt.lesson_id, cls = jt.cls, subject = '';
    // запасной путь: те же значения из вызова setJournalMark в коде страницы
    const m = document.documentElement.innerHTML.match(
      /JournalTeacher\.setJournalMark\s*\(\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")/);
    if (m) {
      const p = (s) => { try { return JSON.parse(s); } catch (_) { return ''; } };
      year = year || p(m[1]); lessonId = lessonId || p(m[2]); subject = p(m[3]); cls = cls || p(m[4]);
    }
    return {
      year: String(year || ''), lessonId: String(lessonId || ''), cls: String(cls || ''), subject,
      url: jt.url || '/journal-index-rpc-teacher-action',
    };
  }

  function groups() {
    return [...document.querySelectorAll('tbody[id$="_homework"]')]
      .map((tb) => {
        const id = (tb.id.match(/^g(\d+)_homework$/) || [])[1];
        if (id == null) return null;
        const box = document.getElementById('g' + id);
        return {
          grp: id,
          title: (box && box.getAttribute('xls_list_title')) || (id === '0' ? 'весь класс' : 'группа ' + id),
          visible: !box || getComputedStyle(box).display !== 'none',
          loadId: window.journal_load_ids && window.journal_load_ids[id] != null ? String(window.journal_load_ids[id]) : '0',
          hasPlan: !!(window.isSetPlanForGroup && window.isSetPlanForGroup[id]),
          tbody: tb,
        };
      })
      .filter(Boolean);
  }

  function lessons(g) {
    return [...g.tbody.querySelectorAll('tr.lessons-row')]
      .map((tr) => {
        const item = tr.querySelector('.tdTopic .tdTopicItem');
        return {
          tr,
          lnum: Number(tr.getAttribute('lnum')),
          date: tr.getAttribute('ldate') || '',
          num: tr.getAttribute('num') || '0',
          pid: tr.getAttribute('pid') || '',
          editable: tr.getAttribute('canedit') === '1' && !tr.classList.contains('backdate'),
          topic: item ? item.textContent.trim() : '',
          ht: false,
        };
      })
      .filter((l) => l.lnum > 0 && l.date)
      .map((l) => Object.assign(l, { ht: hasHT(l) }))
      .sort((a, b) => a.lnum - b.lnum);
  }

  // ---------- сервер ----------
  // так же, как window.theOnlyWayToGenerateUrlForMethodCall на странице
  function rpcUrl(info, method, params) {
    return info.url + '?method=' + method + '&' +
      Object.keys(params).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  }

  async function rpc(info, method, params, body) {
    const res = await fetch(rpcUrl(info, method, params), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'XMLHttpRequest', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: body ? Object.keys(body).map((k) => k + '=' + encodeURIComponent(body[k])).join('&') : '',
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    try { return JSON.parse(text); } catch (_) { throw new Error('ответ не JSON (сессия истекла?)'); }
  }

  function getPlanTopic(info, g, l) {
    return rpc(info, 'teacher.get_lesson_topic', {
      year: info.year, class: info.cls, grp: g.grp, lesson_id: info.lessonId, pid: l.pid, delta: 0, lesson_num: l.lnum,
    });
  }

  async function saveTopic(info, g, l, subject, pid) {
    const r = await rpc(info, 'teacher.save_lesson_topic', {
      lesson_id: info.lessonId, class: info.cls, grp: g.grp, lesson_num: l.lnum, date: l.date,
      load_id: g.loadId, num: l.num, pid: subject ? (pid || '') : '', files: '', resources: '',
    }, { subject });
    if (r && r.result === false) throw new Error(r.error || 'сервер отказал');
    if (!r || r.result !== true) throw new Error('неожиданный ответ сервера');
  }

  // ---------- домашнее задание ----------
  // уже есть ДЗ у урока — второй раз не добавляем (сервер создаёт новое задание при каждом сохранении)
  const hasHT = (l) => !!l.tr.querySelector('.tdHT .hometaskItem') || !!(l.tr.querySelector('.tdHT') || { textContent: '' }).textContent.trim();

  // срок сдачи — как в форме страницы: следующая дата урока группы после этого (ndate), пустая = «на каникулы»
  function dueDate(g, l) {
    const ds = (window.ndate && window.ndate[g.grp]) || [];
    let seen = false;
    for (const d of ds) {
      const s = String(d == null ? '' : d);
      if (s === l.date) { seen = true; continue; }
      if (seen) return s || null;
    }
    if (!seen) { const next = ds.map(String).filter((s) => s && s > l.date).sort()[0]; if (next) return next; }
    return null;
  }

  // та же проверка, что делает страница: при включённом ограничении нельзя задавать ДЗ на сегодня/прошлое
  function backdated(due) {
    if (!window.hometask_max_datetime || !due) return '';
    const [y, m, d] = due.split('-').map(Number);
    const dueT = new Date(y, m - 1, d).valueOf();
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf(), tomorrow = today + 864e5;
    if (dueT < tomorrow) return 'ДЗ задним числом запрещено';
    const cut = parseInt(window.hometask_max_datetime, 10);
    if (dueT === tomorrow && cut && now.valueOf() > cut * 1000) return 'ДЗ на завтра уже поздно';
    return '';
  }

  // ДЗ из ответа get_lesson_topic: 0 или объект {id: {task, minutes, files:{..}, resources:{..}}}
  function planHometasks(r) {
    if (!r || !r.hometasks || r.hometasks === '0') return [];
    return Object.values(r.hometasks).filter((t) => t && (String(t.task || '').trim() || (t.files && Object.keys(t.files).length)));
  }

  function htItem(due, task, minutes, files, resources) {
    return {
      date: due, task: String(task || '').trim() || (window.seefiles_txt || 'См. приложения'),
      collect_files: false,
      files: Object.values(files || {}).map((f) => ({ fid: String(f.fid), url: f.url, filename: f.filename })),
      minutes: Number(minutes) > 0 ? String(Number(minutes)) : false,
      resource: Object.keys(resources || {}), resourceData: [], send_email: false,
    };
  }

  async function saveHT(info, g, l, items) {
    const r = await rpc(info, 'teacher.save_lesson_hometask', {
      lesson_id: info.lessonId, class: info.cls, grp: g.grp, lesson_num: l.lnum, date: l.date,
      ht: JSON.stringify(items), delete_files: 'false', load_id: g.loadId, num: l.num,
    });
    if (!r || !Array.isArray(r.result) || r.result.length !== items.length) throw new Error('ДЗ: ' + ((r && r.error) || 'неожиданный ответ сервера'));
  }

  function paintHT(l, items) {
    const td = l.tr.querySelector('.tdHT');
    if (!td) return;
    for (const it of items) {
      const s = document.createElement('span');
      s.className = 'hometaskItem';
      s.textContent = it.task + ' (' + (it.date ? 'на ' + ddmm(it.date) : 'на каникулы') + ')';
      td.append(s, ' ');
    }
  }

  // показать сохранённую тему в таблице, не перезагружая страницу
  function paintRow(l, subject, pid) {
    const td = l.tr.querySelector('.tdTopic');
    if (!td) return;
    td.innerHTML = '';
    const s = document.createElement('span');
    s.className = 'tdTopicItem';
    s.textContent = subject;
    td.append(s);
    if (pid) l.tr.setAttribute('pid', pid);
    l.topic = subject; l.pid = pid || l.pid;
  }

  // ---------- интерфейс ----------
  const css = `
  #msxt-btn{position:fixed;right:20px;bottom:20px;z-index:99998;font:700 14px/1 Arial,sans-serif;color:#fff;background:#E25628;border:0;border-radius:999px;padding:13px 20px;box-shadow:0 6px 18px rgba(27,36,72,.3);cursor:pointer}
  #msxt-btn:hover{background:#c9461c}
  #msxt{position:fixed;inset:0;z-index:99999;background:rgba(27,36,72,.45);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:4vh 12px;font:14px/1.45 Arial,sans-serif;color:#1B2448}
  #msxt .box{background:#FAF6EE;border-radius:18px;max-width:880px;width:100%;padding:22px 24px;box-shadow:0 20px 50px rgba(0,0,0,.3)}
  #msxt h2{margin:0 0 4px;font-size:21px}
  #msxt .sub{color:#5b6280;margin-bottom:14px}
  #msxt .tabs{display:flex;gap:6px;margin:0 0 14px}
  #msxt .tabs button{border:0;border-radius:999px;padding:8px 16px;font:700 13px Arial;background:#fff;color:#1B2448;cursor:pointer}
  #msxt .tabs button[aria-pressed=true]{background:#1B2448;color:#fff}
  #msxt .row{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;margin:8px 0}
  #msxt label{display:inline-flex;gap:6px;align-items:center}
  #msxt select,#msxt input[type=number],#msxt textarea{font:14px Arial;border:1px solid #d9d2c3;border-radius:10px;padding:7px 9px;background:#fff;color:#1B2448}
  #msxt textarea{width:100%;min-height:150px;box-sizing:border-box;resize:vertical}
  #msxt .act{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
  #msxt .act button{border:0;border-radius:999px;padding:10px 18px;font:700 14px Arial;cursor:pointer}
  #msxt .go{background:#E25628;color:#fff}
  #msxt .go:disabled{opacity:.45;cursor:default}
  #msxt .ghost{background:#fff;color:#1B2448}
  #msxt .note{background:#fff;border-radius:12px;padding:10px 12px;margin:10px 0;color:#3d4462}
  #msxt .warn{background:#FFF0C7;color:#6b4a00}
  #msxt table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;margin-top:10px}
  #msxt th,#msxt td{text-align:left;padding:6px 9px;border-bottom:1px solid #eee6d6;vertical-align:top}
  #msxt th{background:#f1ebde;font-size:12px;text-transform:uppercase;letter-spacing:.03em}
  #msxt td.n{white-space:nowrap;color:#5b6280}
  #msxt .old{color:#8a8fa3;text-decoration:line-through}
  #msxt .st{white-space:nowrap;font-weight:700}
  #msxt .ok{color:#1f8a4c}#msxt .bad{color:#c4372a}#msxt .skip{color:#8a8fa3}
  #msxt .drop{border:2px dashed #d9d2c3;border-radius:12px;padding:14px;margin:0 0 10px;background:#fff;cursor:pointer;color:#3d4462}
  #msxt .drop.on{border-color:#E25628;background:#FFF3EC}
  #msxt tr.sec td{background:#f1ebde;font-size:13px}
  #msxt a.fx{font-size:12px;color:#8a8fa3;margin-left:6px}
  #msxt a.fx:hover{color:#E25628}
  #msxt .bar{height:8px;background:#eee6d6;border-radius:99px;overflow:hidden;margin-top:12px}
  #msxt .bar i{display:block;height:100%;width:0;background:#E25628;transition:width .2s}
  `;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) e.append(c.nodeType ? c : String(c));
    return e;
  }
  const ddmm = (d) => d.slice(8, 10) + '.' + d.slice(5, 7);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let running = false, stopFlag = false;

  function open() {
    if (document.getElementById('msxt')) return;
    const info = pageInfo();
    const gs = groups();
    if (!gs.length || !info.lessonId) {
      alert('Не нашёл на странице таблицу уроков. Откройте журнал → «Уроки» нужного класса и предмета.');
      return;
    }
    let g = gs.find((x) => x.visible) || gs[0];
    let mode = g.hasPlan ? 'plan' : 'excel';

    const root = h('div', { id: 'msxt', onclick: (e) => { if (e.target === root && !running) close(); } });
    const box = h('div', { class: 'box', role: 'dialog', 'aria-label': 'Темы уроков' });
    root.append(box);
    document.body.append(root);

    function close() { root.remove(); }

    function render() {
      const ls = lessons(g);
      box.replaceChildren(
        h('h2', {}, 'Темы уроков'),
        h('div', { class: 'sub' }, `${info.subject || 'Предмет'} · ${info.cls} класс · ${ls.length} уроков в этом периоде`),
        gs.length > 1 ? h('div', { class: 'row' }, h('label', {}, 'Группа:',
          h('select', { onchange: (e) => { g = gs[e.target.value]; mode = g.hasPlan ? mode : 'excel'; render(); } },
            gs.map((x, i) => h('option', { value: i, selected: x === g }, x.title + (x.hasPlan ? '' : ' (нет КТП)')))))) : null,
        h('div', { class: 'tabs' },
          h('button', { 'aria-pressed': String(mode === 'plan'), disabled: !g.hasPlan, title: g.hasPlan ? '' : 'для этой группы КТП не загружен',
            onclick: () => { mode = 'plan'; render(); } }, 'Из КТП'),
          h('button', { 'aria-pressed': String(mode === 'excel'), onclick: () => { mode = 'excel'; render(); } }, 'Из файла / Excel')),
        mode === 'plan' ? planView(ls) : excelView(ls));
    }

    // ----- режим «Из КТП»: то же, что «протыкать» каждый урок, но автоматически -----
    function planView(ls) {
      let withHT = true;
      let onlyEmpty = true;
      const needs = (l) => !l.topic || (withHT && !l.ht && !!(l.pid || !l.topic));
      const firstNeed = ls.find((l) => l.editable && needs(l));
      let from = firstNeed ? firstNeed.lnum : (ls[0] ? ls[0].lnum : 1);
      let limit = 0;
      const table = h('div', {});
      const goBtn = h('button', { class: 'go' }, 'Проставить');
      const bar = h('i', {});

      function selected() {
        let xs = ls.filter((l) => l.editable && l.lnum >= from && (!onlyEmpty || needs(l)));
        if (limit > 0) xs = xs.slice(0, limit);
        return xs;
      }
      function drawTable() {
        const xs = selected();
        goBtn.disabled = running || !xs.length;
        goBtn.textContent = running ? 'Идёт…' : `Проставить (${xs.length})`;
        table.replaceChildren(h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '№'), h('th', {}, 'Дата'), h('th', {}, 'Тема сейчас → из КТП'), withHT ? h('th', {}, 'ДЗ из КТП') : null, h('th', {}, ''))),
          h('tbody', {}, xs.map((l) => h('tr', { 'data-l': l.lnum },
            h('td', { class: 'n' }, l.lnum + (l.num !== '0' ? ' (2-й)' : '')),
            h('td', { class: 'n' }, ddmm(l.date)),
            h('td', { class: 'tt' }, l.topic ? h('span', { class: onlyEmpty ? '' : 'old' }, l.topic) : h('span', { class: 'skip' }, 'пусто')),
            withHT ? h('td', { class: 'hw' }, l.ht ? h('span', { class: 'skip' }, 'уже задано') : '') : null,
            h('td', { class: 'st' }, ''))))));
      }

      goBtn.onclick = async () => {
        const xs = selected();
        if (!xs.length) return;
        if (!confirm(`Проставить ${withHT ? 'темы и ДЗ' : 'темы'} из КТП в ${xs.length} уроков (${ddmm(xs[0].date)}–${ddmm(xs[xs.length - 1].date)})?\nВсё сразу сохранится в журнал.`)) return;
        running = true; stopFlag = false; drawTable();
        const tr = (l) => table.querySelector(`tr[data-l="${l.lnum}"]`);
        let done = 0, fail = 0, hwDone = 0, prevPid = null;
        for (let i = 0; i < xs.length; i++) {
          const l = xs[i], row = tr(l), st = row.querySelector('.st'), tt = row.querySelector('.tt'), hw = row.querySelector('.hw');
          if (stopFlag) { st.textContent = 'остановлено'; st.className = 'st skip'; continue; }
          st.textContent = '…';
          try {
            // тема вписана вручную без привязки к плану — ДЗ из КТП к ней не подобрать
            const manualTopic = onlyEmpty && l.topic && !l.pid;
            if (manualTopic) { if (hw) hw.replaceChildren(h('span', { class: 'skip' }, 'тема не из КТП')); st.textContent = 'пропущено'; st.className = 'st skip'; continue; }
            const r = await getPlanTopic(info, g, l);
            if (!r || (r.error && r.error !== '')) throw new Error((r && r.error) || 'нет ответа');
            const topic = r.topic != null ? unescape(String(r.topic)).trim() : '';
            if (!r.pid || !topic) { st.textContent = 'нет темы в КТП'; st.className = 'st skip'; stopFlag = true; continue; }
            // защита: сервер вернул тот же пункт плана, что и предыдущему уроку, — значит, логика не та, останавливаемся
            if (prevPid != null && String(r.pid) === String(prevPid)) throw new Error('КТП вернул ту же тему, что и прошлому уроку — остановлено');
            prevPid = r.pid;
            const notes = [];
            if (!(onlyEmpty && l.topic)) {
              await saveTopic(info, g, l, topic, String(r.pid));
              paintRow(l, topic, String(r.pid));
              tt.replaceChildren(document.createTextNode(topic));
              notes.push('тема ✓'); done++;
            }
            if (withHT && !l.ht) {
              const tasks = planHometasks(r);
              const due = dueDate(g, l);
              const bad = backdated(due);
              if (!tasks.length) hw.replaceChildren(h('span', { class: 'skip' }, 'в КТП нет'));
              else if (bad) hw.replaceChildren(h('span', { class: 'skip' }, bad));
              else {
                const items = tasks.map((t) => htItem(due, t.task, t.minutes, t.files, t.resources));
                await saveHT(info, g, l, items);
                paintHT(l, items); l.ht = true;
                hw.replaceChildren(document.createTextNode(items.map((it) => it.task).join('; ') + ' — ' + (due ? 'на ' + ddmm(due) : 'на каникулы')));
                notes.push('ДЗ ✓'); hwDone++;
              }
            }
            st.textContent = notes.length ? notes.join(', ') : 'нечего добавить'; st.className = notes.length ? 'st ok' : 'st skip';
          } catch (e) {
            st.textContent = '✗ ' + e.message; st.className = 'st bad'; fail++; stopFlag = true;
          }
          bar.style.width = Math.round(((i + 1) / xs.length) * 100) + '%';
          await sleep(DELAY_MS);
        }
        running = false;
        goBtn.disabled = true; goBtn.textContent = `Готово: тем ${done}` + (withHT ? `, ДЗ ${hwDone}` : '') + (fail ? `, ошибок: ${fail}` : '');
        stopBtn.textContent = 'Закрыть'; stopBtn.onclick = close;
      };
      const stopBtn = h('button', { class: 'ghost', onclick: () => { if (running) stopFlag = true; else close(); } }, 'Отмена');

      const wrap = h('div', {},
        h('div', { class: 'note' }, 'Делает то же, что ручное «протыкивание»: по очереди открывает каждый урок, берёт из календарно-тематического плана тему и домашнее задание (как кнопка «Домашнее задание по плану») и сохраняет. Срок ДЗ — следующий урок этой группы. Уроки идут строго по порядку; при первой ошибке скрипт останавливается.'),
        h('div', { class: 'row' },
          h('label', {}, 'С урока №', h('input', { type: 'number', min: 1, value: from, style: 'width:80px', oninput: (e) => { from = Number(e.target.value) || 1; drawTable(); } })),
          h('label', {}, h('input', { type: 'checkbox', checked: withHT, onchange: (e) => { withHT = e.target.checked; drawTable(); } }), 'и домашнее задание'),
          h('label', { title: 'выключите, чтобы перезаписать уже заполненные темы темами из КТП' }, h('input', { type: 'checkbox', checked: onlyEmpty, onchange: (e) => { onlyEmpty = e.target.checked; drawTable(); } }), 'только незаполненное'),
          h('label', { title: '0 — все' }, 'не больше', h('input', { type: 'number', min: 0, value: limit, style: 'width:70px', oninput: (e) => { limit = Math.max(0, Number(e.target.value) || 0); drawTable(); } }), 'уроков')),
        h('div', { class: 'note warn' }, 'Первый раз попробуйте на 1–2 уроках (поле «не больше») и проверьте результат в журнале. Если у урока ДЗ уже есть, второе не добавляется.'),
        table, h('div', { class: 'bar' }, bar), h('div', { class: 'act' }, stopBtn, goBtn));
      drawTable();
      return wrap;
    }

    // ----- режим «Из Excel»: файл КТП с компьютера или вставка из Excel -----
    function excelView(ls) {
      let grid = [];          // таблица как есть: строки × ячейки (строки)
      let srcName = '';
      let cols = null;        // {header, topic, hours, hw, section}
      let flip = new Set();   // строки, где учитель вручную поменял «тема ↔ раздел»
      let from = (ls.find((l) => l.editable && !l.topic) || ls[0] || { lnum: 1 }).lnum;
      let startItem = 0;      // 0 = авто: столько тем пропустить, сколько уроков до «С урока №»
      let keepFilled = true, hwLast = true, withSection = false;
      const area = h('div', {});
      const table = h('div', {});
      const goBtn = h('button', { class: 'go' }, 'Записать');
      const bar = h('i', {});

      // ---------- разбор таблицы ----------
      const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
      const hoursOf = (v) => { const m = norm(v).match(/\d+(?:[.,]\d+)?/); return m ? Math.min(20, Math.max(0, Math.round(parseFloat(m[0].replace(',', '.'))))) : NaN; };
      const isSectionText = (t) => /^(раздел|модуль|глава|блок|часть)(\s|\d|[.:№IVX]|$)/i.test(t);
      const isTrash = (t) => !t || /^(итого|всего|резерв(ное)? время$)/i.test(t) || /^\d+([.,]\d+)?$/.test(t);

      function guessCols(g) {
        const width = Math.max(0, ...g.map((r) => r.length));
        const has = (re) => (r) => r.findIndex((c) => re.test(norm(c)));
        // строка заголовков — первая из первых 20, где есть «тема»/«наименование»
        let header = -1;
        for (let i = 0; i < Math.min(20, g.length); i++) if (g[i].some((c) => /(^|\s)(тема|темы|наименование|содержание)/i.test(norm(c)))) { header = i; break; }
        const c = { header, topic: -1, hours: -1, hw: -1, section: -1 };
        if (header >= 0) {
          const hr = g[header];
          c.topic = has(/(^|\s)(тема|темы)\b.*(урок|занят)|^тема|наименование.*(тем|урок)/i)(hr);
          if (c.topic < 0) c.topic = has(/тем|наименование|содержание/i)(hr);
          c.hours = has(/час|кол.?во|количество/i)(hr);
          c.hw = has(/домашн|д\/з|^дз\b|задани/i)(hr);
          c.section = has(/раздел|модуль|блок|глава/i)(hr);
          if (c.section === c.topic) c.section = -1;
          if (c.hw === c.topic) c.hw = -1;
        }
        if (c.topic < 0) {
          // без заголовков: тема — столбец с самым длинным текстом, ДЗ — следующий текстовый, часы — числовой столбец с небольшими числами
          const stat = [...Array(width)].map((_, j) => {
            const vals = g.map((r) => norm(r[j])).filter(Boolean);
            const nums = vals.filter((v) => /^\d{1,2}([.,]\d)?(\s*ч\.?)?$/.test(v));
            return { j, text: vals.filter((v) => !/^\d/.test(v) || v.length > 6).reduce((s, v) => s + v.length, 0), nums: nums.length, n: vals.length };
          });
          const texts = stat.filter((x) => x.text > 0).sort((a, b) => b.text - a.text);
          c.topic = texts[0] ? texts[0].j : 0;
          const after = stat.filter((x) => x.j > c.topic && x.text > 0 && x.nums < x.n / 2);
          c.hw = after[0] ? after[0].j : -1;
          const hcol = stat.find((x) => x.j > c.topic && x.n && x.nums >= x.n * 0.6 && x.j !== c.hw);
          c.hours = hcol ? hcol.j : -1;
        }
        return c;
      }

      // строки КТП: {row, kind: 'topic'|'section', text, hours, hw, section}
      function entries() {
        if (!cols || cols.topic < 0) return [];
        const out = [];
        let section = '';
        const anyHours = cols.hours >= 0 && grid.some((r, i) => i > cols.header && hoursOf(r[cols.hours]) > 0);
        for (let i = cols.header + 1; i < grid.length; i++) {
          const r = grid[i];
          if (cols.section >= 0 && norm(r[cols.section])) section = norm(r[cols.section]);
          let text = norm(r[cols.topic]);
          // раздел может стоять в объединённой ячейке левее темы
          if (!text) {
            const other = r.map(norm).filter((v, j) => v && j !== cols.hours && j !== cols.hw && !/^\d+([.,]\d+)?$/.test(v));
            if (other.length === 1 && cols.section < 0) out.push({ row: i, kind: flip.has(i) ? 'topic' : 'section', text: other[0], hours: NaN, hw: '' });
            continue;
          }
          if (isTrash(text)) continue;
          const hours = cols.hours >= 0 ? hoursOf(r[cols.hours]) : NaN;
          let kind = 'topic';
          if (cols.section < 0 && (isSectionText(text) || (anyHours && !(hours > 0)))) kind = 'section';
          if (flip.has(i)) kind = kind === 'topic' ? 'section' : 'topic';
          out.push({ row: i, kind, text, hours, hw: cols.hw >= 0 ? norm(r[cols.hw]) : '', section });
        }
        // раздел из строки-заголовка действует до следующего раздела
        let cur = '';
        for (const e of out) { if (e.kind === 'section') cur = e.text; else if (!e.section) e.section = cur; }
        return out;
      }

      // одна строка КТП на N часов = N уроков подряд с одной темой
      function items() {
        const res = [];
        for (const e of entries()) {
          if (e.kind !== 'topic') continue;
          const n = cols.hours >= 0 && e.hours > 0 ? e.hours : 1;
          for (let k = 0; k < n; k++) {
            res.push({
              e, part: n > 1 ? `${k + 1}/${n}` : '',
              topic: withSection && e.section ? `${e.section.replace(/[.:\s]+$/, '')}. ${e.text}` : e.text,
              hw: e.hw && (!hwLast || k === n - 1) ? e.hw : '',
            });
          }
        }
        return res;
      }

      const autoStart = () => ls.filter((l) => l.lnum < from).length + 1;
      function plan() {
        const its = items();
        const s0 = (startItem || autoStart()) - 1;
        const target = ls.filter((l) => l.editable && l.lnum >= from && !(keepFilled && l.topic));
        return target.map((l, i) => its[s0 + i] && Object.assign({ l, due: dueDate(g, l) }, its[s0 + i])).filter(Boolean);
      }

      // ---------- загрузка ----------
      function loadGrid(rows, name) {
        grid = rows.map((r) => (r || []).map(norm));
        while (grid.length && !grid[grid.length - 1].some(Boolean)) grid.pop();
        srcName = name; cols = guessCols(grid); flip = new Set();
        draw();
      }
      function needXLSX() {
        if (typeof XLSX !== 'undefined') return Promise.resolve(XLSX); // eslint-disable-line no-undef
        return new Promise((ok, bad) => {
          const sc = document.createElement('script');
          sc.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
          sc.onload = () => (window.XLSX ? ok(window.XLSX) : bad(new Error('нет XLSX')));
          sc.onerror = () => bad(new Error('не загрузилась библиотека чтения Excel'));
          document.head.append(sc);
        });
      }
      async function readFile(f) {
        try {
          const buf = await f.arrayBuffer();
          const X = await needXLSX();
          let wb;
          if (/\.(csv|txt)$/i.test(f.name)) {
            // CSV из Excel обычно в windows-1251
            let text;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { text = new TextDecoder('windows-1251').decode(buf); }
            wb = X.read(text.replace(/^﻿/, ''), { type: 'string', raw: true });
          } else wb = X.read(buf, { type: 'array' });
          // лист с темами: первый, где есть «тема», иначе первый
          let ws = wb.Sheets[wb.SheetNames[0]];
          for (const n of wb.SheetNames) {
            const rows = X.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: false, defval: '' });
            if (rows.slice(0, 20).some((r) => r.some((c) => /тема/i.test(String(c))))) { ws = wb.Sheets[n]; break; }
          }
          loadGrid(X.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false }), f.name);
        } catch (e) { alert('Не получилось прочитать файл: ' + e.message); }
      }

      // ---------- отрисовка ----------
      function colSelect(key, label, optional) {
        const width = Math.max(0, ...grid.map((r) => r.length));
        const name = (j) => {
          const head = cols.header >= 0 ? norm(grid[cols.header][j]) : '';
          const sample = grid.slice(cols.header + 1).map((r) => norm(r[j])).find(Boolean) || '';
          return `${String.fromCharCode(65 + (j % 26))}: ${(head || sample).slice(0, 28)}`;
        };
        return h('label', {}, label, h('select', { onchange: (e) => { cols[key] = Number(e.target.value); flip = new Set(); draw(); } },
          optional ? h('option', { value: -1, selected: cols[key] < 0 }, '— нет —') : null,
          [...Array(width)].map((_, j) => h('option', { value: j, selected: cols[key] === j }, name(j)))));
      }

      function draw() {
        const ps = plan();
        const its = items();
        const es = entries();
        const nSec = es.filter((e) => e.kind === 'section').length;
        const anyHW = its.some((x) => x.hw);
        goBtn.disabled = running || !ps.length;
        goBtn.textContent = running ? 'Идёт…' : `Записать (${ps.length})`;

        area.replaceChildren(
          grid.length && cols ? h('div', {},
            h('div', { class: 'note' }, `«${srcName}»: тем ${es.length - nSec}${nSec ? `, разделов ${nSec}` : ''} → ${its.length} уроков` + (cols.hours >= 0 ? ' (с учётом часов)' : '')),
            h('div', { class: 'row' }, colSelect('topic', 'Тема:', false), colSelect('hours', 'Часы:', true), colSelect('hw', 'ДЗ:', true), colSelect('section', 'Раздел:', true)),
            h('div', { class: 'row' },
              h('label', {}, 'С урока №', h('input', { type: 'number', min: 1, value: from, style: 'width:70px', onchange: (e) => { from = Number(e.target.value) || 1; draw(); } })),
              h('label', { title: 'какую строку КТП записать в этот урок; по умолчанию — по порядку уроков в периоде' }, 'взять тему КТП №',
                h('input', { type: 'number', min: 1, value: startItem || autoStart(), style: 'width:70px', onchange: (e) => { startItem = Math.max(1, Number(e.target.value) || 1); draw(); } })),
              h('label', {}, h('input', { type: 'checkbox', checked: keepFilled, onchange: (e) => { keepFilled = e.target.checked; draw(); } }), 'не трогать заполненные уроки')),
            h('div', { class: 'row' },
              cols.hours >= 0 ? h('label', { title: 'тема на 2 часа идёт на 2 урока; ДЗ — только на последний из них' }, h('input', { type: 'checkbox', checked: hwLast, onchange: (e) => { hwLast = e.target.checked; draw(); } }), 'ДЗ многочасовой темы — на последний урок') : null,
              h('label', {}, h('input', { type: 'checkbox', checked: withSection, onchange: (e) => { withSection = e.target.checked; draw(); } }), 'писать раздел перед темой'))) : null);

        if (!ps.length) { table.replaceChildren(grid.length ? h('div', { class: 'note warn' }, 'Нет уроков для записи: проверьте «С урока №», «взять тему КТП №» и столбец с темой.') : ''); return; }
        const extra = its.length - ((startItem || autoStart()) - 1) - ps.length;
        // предпросмотр: уроки по порядку, перед темой — строка раздела, если он сменился
        const body = [];
        let lastSec = null;
        for (const x of ps) {
          if (x.e.section && x.e.section !== lastSec && !withSection) {
            const secRow = es.find((e) => e.kind === 'section' && e.text === x.e.section);
            body.push(h('tr', { class: 'sec' }, h('td', { colspan: anyHW ? 5 : 4 },
              h('b', {}, x.e.section), ' ',
              secRow ? h('a', { href: '#', class: 'fx', title: 'это не раздел, а тема урока', onclick: (ev) => { ev.preventDefault(); flip.has(secRow.row) ? flip.delete(secRow.row) : flip.add(secRow.row); draw(); } }, 'это тема') : null)));
          }
          lastSec = x.e.section;
          body.push(h('tr', { 'data-l': x.l.lnum },
            h('td', { class: 'n' }, x.l.lnum + (x.l.num !== '0' ? ' (2-й)' : '')),
            h('td', { class: 'n' }, ddmm(x.l.date)),
            h('td', {}, x.l.topic ? [h('span', { class: 'old' }, x.l.topic), h('br')] : null, x.topic,
              x.part ? h('span', { class: 'skip' }, ` · ${x.part}`) : null, ' ',
              !x.part || x.part.startsWith('1/') ? h('a', { href: '#', class: 'fx', title: 'это заголовок раздела, а не тема урока', onclick: (ev) => { ev.preventDefault(); flip.has(x.e.row) ? flip.delete(x.e.row) : flip.add(x.e.row); draw(); } }, 'это раздел') : null),
            anyHW ? h('td', { class: 'hw' }, !x.hw ? '' : x.l.ht ? h('span', { class: 'skip' }, 'уже задано') : [x.hw, h('br'), h('span', { class: 'skip' }, x.due ? 'на ' + ddmm(x.due) : 'на каникулы')]) : null,
            h('td', { class: 'st' }, '')));
        }
        table.replaceChildren(
          extra > 0 ? h('div', { class: 'note warn' }, `Ещё ${extra} уроков КТП не поместились в этот период — их запишете, открыв следующую четверть/полугодие (поле «взять тему КТП №»).`) : null,
          h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, '№'), h('th', {}, 'Дата'), h('th', {}, 'Тема'), anyHW ? h('th', {}, 'ДЗ') : null, h('th', {}, ''))), h('tbody', {}, body)));
      }

      goBtn.onclick = async () => {
        const ps = plan();
        if (!ps.length) return;
        const nHW = ps.filter((x) => x.hw && !x.l.ht).length;
        if (!confirm(`Записать ${ps.length} тем${nHW ? ` и ${nHW} ДЗ` : ''} в уроки ${ddmm(ps[0].l.date)}–${ddmm(ps[ps.length - 1].l.date)}?\nВсё сразу сохранится в журнал.`)) return;
        running = true; stopFlag = false; goBtn.disabled = true; goBtn.textContent = 'Идёт…';
        area.querySelectorAll('input,select').forEach((x) => { x.disabled = true; });
        table.querySelectorAll('a.fx').forEach((x) => x.remove());
        let done = 0, fail = 0, hwDone = 0;
        for (let i = 0; i < ps.length; i++) {
          const { l, topic, hw, due } = ps[i];
          const row = table.querySelector(`tr[data-l="${l.lnum}"]`), st = row.querySelector('.st'), hwc = row.querySelector('.hw');
          if (stopFlag) { st.textContent = 'остановлено'; st.className = 'st skip'; continue; }
          st.textContent = '…';
          try {
            await saveTopic(info, g, l, topic, '');
            paintRow(l, topic, '');
            done++;
            let note = 'тема ✓';
            if (hw && !l.ht) {
              const bad = backdated(due);
              if (bad) hwc.replaceChildren(h('span', { class: 'skip' }, bad));
              else {
                const its = [htItem(due, hw, 0, null, null)];
                await saveHT(info, g, l, its);
                paintHT(l, its); l.ht = true; hwDone++; note += ', ДЗ ✓';
              }
            }
            st.textContent = note; st.className = 'st ok';
          } catch (e) {
            st.textContent = '✗ ' + e.message; st.className = 'st bad'; fail++; stopFlag = true;
          }
          bar.style.width = Math.round(((i + 1) / ps.length) * 100) + '%';
          await sleep(DELAY_MS);
        }
        running = false;
        goBtn.disabled = true; goBtn.textContent = `Готово: тем ${done}` + (hwDone ? `, ДЗ ${hwDone}` : '') + (fail ? `, ошибок: ${fail}` : '');
        stopBtn.textContent = 'Закрыть'; stopBtn.onclick = close;
      };
      const stopBtn = h('button', { class: 'ghost', onclick: () => { if (running) stopFlag = true; else close(); } }, 'Отмена');

      const file = h('input', { type: 'file', accept: '.xls,.xlsx,.ods,.csv', style: 'display:none', onchange: (e) => { if (e.target.files[0]) readFile(e.target.files[0]); e.target.value = ''; } });
      const ta = h('textarea', { placeholder: '…или выделите в Excel строки КТП (можно вместе с заголовком, столбцы «Тема», «Часы», «Домашнее задание»), скопируйте и вставьте сюда.',
        style: 'min-height:90px',
        oninput: (e) => { const t = e.target.value.replace(/\r/g, ''); if (!t.trim()) { grid = []; cols = null; draw(); return; }
          loadGrid(t.split('\n').map((line) => line.split('\t').map((c) => c.replace(/^"([\s\S]*)"$/, '$1'))), 'вставка'); } });
      const drop = h('div', { class: 'drop', onclick: () => file.click(),
        ondragover: (e) => { e.preventDefault(); drop.classList.add('on'); }, ondragleave: () => drop.classList.remove('on'),
        ondrop: (e) => { e.preventDefault(); drop.classList.remove('on'); if (e.dataTransfer.files[0]) readFile(e.dataTransfer.files[0]); } },
        h('b', {}, 'Выбрать файл КТП'), ' (.xls, .xlsx, .csv) или перетащить сюда — файл никуда не загружается, читается прямо здесь', file);
      const wrap = h('div', {}, drop, ta, area,
        h('div', { class: 'note' }, 'Строки КТП ложатся в уроки по порядку. Тема на 2 часа — на 2 урока подряд; строки разделов пропускаются (если скрипт ошибся — «это раздел» / «это тема»). Срок ДЗ — следующий урок группы; если ДЗ у урока уже есть, второе не добавляется.'),
        table, h('div', { class: 'bar' }, bar), h('div', { class: 'act' }, stopBtn, goBtn));
      draw();
      return wrap;
    }

    render();
  }

  function mount() {
    if (!document.querySelector('tbody[id$="_homework"] tr.lessons-row')) return;
    if (document.getElementById('msxt-btn')) return;
    if (!document.getElementById('msxt-css')) document.head.append(h('style', { id: 'msxt-css' }, css));
    document.body.append(h('button', { id: 'msxt-btn', onclick: open, title: 'Темы уроков из КТП или Excel' }, 'Темы уроков'));
  }
  mount();
  new MutationObserver(() => mount()).observe(document.body, { childList: true, subtree: true });
})();
