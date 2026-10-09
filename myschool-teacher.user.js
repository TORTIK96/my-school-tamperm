// ==UserScript==
// @name         Моя школа — учитель: темы уроков из КТП и Excel
// @namespace    tortik96.myschool.teacher
// @version      0.1.0
// @description  На странице «Уроки» журнала: проставить темы из КТП во все уроки разом или вставить темы столбцом из Excel
// @match        https://edu.gosuslugi.ru/journal-app/page.lessons/*
// @grant        none
// @run-at       document-idle
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
        };
      })
      .filter((l) => l.lnum > 0 && l.date)
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
          h('button', { 'aria-pressed': String(mode === 'excel'), onclick: () => { mode = 'excel'; render(); } }, 'Из Excel')),
        mode === 'plan' ? planView(ls) : excelView(ls));
    }

    // ----- режим «Из КТП»: то же, что «протыкать» каждый урок, но автоматически -----
    function planView(ls) {
      const empty = ls.filter((l) => l.editable && !l.topic);
      let from = empty.length ? empty[0].lnum : (ls[0] ? ls[0].lnum : 1);
      let onlyEmpty = true;
      let limit = 0;
      const table = h('div', {});
      const goBtn = h('button', { class: 'go' }, 'Проставить');
      const bar = h('i', {});

      function selected() {
        let xs = ls.filter((l) => l.editable && l.lnum >= from && (!onlyEmpty || !l.topic));
        if (limit > 0) xs = xs.slice(0, limit);
        return xs;
      }
      function drawTable() {
        const xs = selected();
        goBtn.disabled = running || !xs.length;
        goBtn.textContent = running ? 'Идёт…' : `Проставить (${xs.length})`;
        table.replaceChildren(h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '№'), h('th', {}, 'Дата'), h('th', {}, 'Тема сейчас → из КТП'), h('th', {}, ''))),
          h('tbody', {}, xs.map((l) => h('tr', { 'data-l': l.lnum },
            h('td', { class: 'n' }, l.lnum + (l.num !== '0' ? ' (2-й)' : '')),
            h('td', { class: 'n' }, ddmm(l.date)),
            h('td', { class: 'tt' }, l.topic ? h('span', { class: 'old' }, l.topic) : h('span', { class: 'skip' }, 'пусто')),
            h('td', { class: 'st' }, ''))))));
      }

      goBtn.onclick = async () => {
        const xs = selected();
        if (!xs.length) return;
        if (!confirm(`Проставить темы из КТП в ${xs.length} уроков (${ddmm(xs[0].date)}–${ddmm(xs[xs.length - 1].date)})?\nТемы сразу сохранятся в журнал.`)) return;
        running = true; stopFlag = false; drawTable();
        const tr = (l) => table.querySelector(`tr[data-l="${l.lnum}"]`);
        let done = 0, fail = 0, prevPid = null;
        for (let i = 0; i < xs.length; i++) {
          const l = xs[i], row = tr(l), st = row.querySelector('.st'), tt = row.querySelector('.tt');
          if (stopFlag) { st.textContent = 'остановлено'; st.className = 'st skip'; continue; }
          st.textContent = '…';
          try {
            const r = await getPlanTopic(info, g, l);
            if (!r || (r.error && r.error !== '')) throw new Error((r && r.error) || 'нет ответа');
            const topic = r.topic != null ? unescape(String(r.topic)).trim() : '';
            if (!r.pid || !topic) { st.textContent = 'нет темы в КТП'; st.className = 'st skip'; stopFlag = true; continue; }
            // защита: сервер вернул тот же пункт плана, что и предыдущему уроку, — значит, логика не та, останавливаемся
            if (prevPid != null && String(r.pid) === String(prevPid)) throw new Error('КТП вернул ту же тему, что и прошлому уроку — остановлено');
            await saveTopic(info, g, l, topic, String(r.pid));
            prevPid = r.pid;
            paintRow(l, topic, String(r.pid));
            tt.replaceChildren(document.createTextNode(topic));
            st.textContent = '✓ сохранено'; st.className = 'st ok'; done++;
          } catch (e) {
            st.textContent = '✗ ' + e.message; st.className = 'st bad'; fail++; stopFlag = true;
          }
          bar.style.width = Math.round(((i + 1) / xs.length) * 100) + '%';
          await sleep(DELAY_MS);
        }
        running = false;
        goBtn.disabled = true; goBtn.textContent = `Готово: ${done}` + (fail ? `, ошибок: ${fail}` : '');
        stopBtn.textContent = 'Закрыть'; stopBtn.onclick = close;
      };
      const stopBtn = h('button', { class: 'ghost', onclick: () => { if (running) stopFlag = true; else close(); } }, 'Отмена');

      const wrap = h('div', {},
        h('div', { class: 'note' }, 'Делает то же, что ручное «протыкивание»: по очереди открывает каждый урок, берёт тему из календарно-тематического плана и сохраняет её. Уроки идут строго по порядку; при первой ошибке скрипт останавливается.'),
        h('div', { class: 'row' },
          h('label', {}, 'С урока №', h('input', { type: 'number', min: 1, value: from, style: 'width:80px', oninput: (e) => { from = Number(e.target.value) || 1; drawTable(); } })),
          h('label', {}, h('input', { type: 'checkbox', checked: onlyEmpty, onchange: (e) => { onlyEmpty = e.target.checked; drawTable(); } }), 'только пустые'),
          h('label', { title: '0 — все' }, 'не больше', h('input', { type: 'number', min: 0, value: limit, style: 'width:70px', oninput: (e) => { limit = Math.max(0, Number(e.target.value) || 0); drawTable(); } }), 'уроков')),
        h('div', { class: 'note warn' }, 'Первый раз попробуйте на 1–2 уроках (поле «не больше») и проверьте результат в журнале.'),
        table, h('div', { class: 'bar' }, bar), h('div', { class: 'act' }, stopBtn, goBtn));
      drawTable();
      return wrap;
    }

    // ----- режим «Из Excel»: вставить столбец тем, строка = урок -----
    function excelView(ls) {
      let text = '';
      let from = (ls.find((l) => l.editable && !l.topic) || ls[0] || { lnum: 1 }).lnum;
      let keepFilled = true;
      const table = h('div', {});
      const goBtn = h('button', { class: 'go' }, 'Записать');
      const bar = h('i', {});

      function topicsFrom(t) {
        // столбец из Excel: строки через перевод строки; если скопировано несколько столбцов — берём первый непустой
        return t.replace(/\r/g, '').split('\n').map((s) => s.split('\t').map((c) => c.trim()).find(Boolean) || '').filter((s, i, a) => s || i < a.length - 1);
      }
      function plan() {
        const ts = topicsFrom(text).filter(Boolean);
        const target = ls.filter((l) => l.editable && l.lnum >= from && !(keepFilled && l.topic));
        return target.map((l, i) => ({ l, topic: ts[i] })).filter((x) => x.topic);
      }
      function drawTable() {
        const ps = plan();
        const ts = topicsFrom(text).filter(Boolean);
        goBtn.disabled = running || !ps.length;
        goBtn.textContent = running ? 'Идёт…' : `Записать (${ps.length})`;
        const extra = ts.length - ps.length;
        table.replaceChildren(
          ts.length && extra > 0 ? h('div', { class: 'note warn' }, `Тем в списке ${ts.length}, а подходящих уроков ${ps.length}: последние ${extra} не поместятся в этот период.`) : null,
          ps.length ? h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, '№'), h('th', {}, 'Дата'), h('th', {}, 'Тема'), h('th', {}, ''))),
            h('tbody', {}, ps.map(({ l, topic }) => h('tr', { 'data-l': l.lnum },
              h('td', { class: 'n' }, l.lnum + (l.num !== '0' ? ' (2-й)' : '')),
              h('td', { class: 'n' }, ddmm(l.date)),
              h('td', {}, l.topic ? [h('span', { class: 'old' }, l.topic), h('br'), topic] : topic),
              h('td', { class: 'st' }, ''))))) : null);
      }

      goBtn.onclick = async () => {
        const ps = plan();
        if (!ps.length) return;
        if (!confirm(`Записать ${ps.length} тем в уроки ${ddmm(ps[0].l.date)}–${ddmm(ps[ps.length - 1].l.date)}?\nТемы сразу сохранятся в журнал.`)) return;
        running = true; stopFlag = false; drawTable();
        let done = 0, fail = 0;
        for (let i = 0; i < ps.length; i++) {
          const { l, topic } = ps[i];
          const st = table.querySelector(`tr[data-l="${l.lnum}"] .st`);
          if (stopFlag) { st.textContent = 'остановлено'; st.className = 'st skip'; continue; }
          st.textContent = '…';
          try {
            await saveTopic(info, g, l, topic, '');
            paintRow(l, topic, '');
            st.textContent = '✓'; st.className = 'st ok'; done++;
          } catch (e) {
            st.textContent = '✗ ' + e.message; st.className = 'st bad'; fail++; stopFlag = true;
          }
          bar.style.width = Math.round(((i + 1) / ps.length) * 100) + '%';
          await sleep(DELAY_MS);
        }
        running = false;
        goBtn.disabled = true; goBtn.textContent = `Готово: ${done}` + (fail ? `, ошибок: ${fail}` : '');
        stopBtn.textContent = 'Закрыть'; stopBtn.onclick = close;
      };
      const stopBtn = h('button', { class: 'ghost', onclick: () => { if (running) stopFlag = true; else close(); } }, 'Отмена');

      const ta = h('textarea', { placeholder: 'Выделите в Excel столбец с темами (по одной теме на урок), скопируйте и вставьте сюда.\nПустые строки пропускаются.',
        oninput: (e) => { text = e.target.value; drawTable(); } });
      const wrap = h('div', {},
        ta,
        h('div', { class: 'row' },
          h('label', {}, 'Начать с урока №', h('input', { type: 'number', min: 1, value: from, style: 'width:80px', oninput: (e) => { from = Number(e.target.value) || 1; drawTable(); } })),
          h('label', {}, h('input', { type: 'checkbox', checked: keepFilled, onchange: (e) => { keepFilled = e.target.checked; drawTable(); } }), 'не трогать уже заполненные')),
        h('div', { class: 'note' }, 'Темы ложатся по порядку: первая строка — в первый подходящий урок, вторая — в следующий и так далее. Сначала проверьте таблицу ниже.'),
        table, h('div', { class: 'bar' }, bar), h('div', { class: 'act' }, stopBtn, goBtn));
      drawTable();
      setTimeout(() => ta.focus(), 0);
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
