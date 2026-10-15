/* NEXUS Hub controls: the buttons that change things in your other apps.
   Safety rules this file keeps:
   - Before the Hub's first change to an app (each time the Hub is opened), it saves a snapshot of that app's
     data in the Hub's own database (nxhub > nxhub_snapshots, last 5 per app). ⚙️ → Restore snapshot.
   - Every change shows a toast with Undo.
   - It writes in exactly the format each app writes itself, never bumps a database version and never
     deletes an app's data. (Un-ticking homework / un-saving a story is the app's own toggle.)
   - nortest is controlled through its own text remote (ntfy), so it works on any device. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const H = () => window.Hub;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const readJ = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const setJ = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const online = () => navigator.onLine !== false;

/* ---------- toast with Undo ---------- */
let tT;
function toast(msg, opts = {}) {
  const t = $('#toast'); if (!t) return;
  t.innerHTML = ''; const sp = document.createElement('span'); sp.textContent = msg; t.append(sp);
  if (opts.undo) {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'undo'; b.textContent = 'Undo';
    b.onclick = async () => { t.hidden = true; try { await opts.undo(); } catch (e) { toast("Couldn't undo: " + (e && e.message || e)); } };
    t.append(b);
  }
  t.hidden = false; clearTimeout(tT); tT = setTimeout(() => { t.hidden = true; }, opts.undo ? 8000 : (opts.ms || 2800));
}

/* ---------- which saved data belongs to which app ---------- */
const NO = new Set(['bible_search_index_v1', 'bible_esv_api_key_v1', 'bibley_votd_v1', 'nxnews_data_v1', 'nx_snap', 'nxhub_last', 'nxhub_wx', 'nxhub_news']);
const LS_APPS = {
  bibley:   { name: 'Bibley', match: k => /^(bible_|bibley_)/.test(k), reopen: '' },
  calendar: { name: 'NEXUS Calendar', match: k => k === 'nxcal_v1', reopen: '' },
  news:     { name: 'NEXUS News', match: k => /^nxnews_/.test(k), reopen: ' · reopen News if it\'s open' },
  weather:  { name: 'Ultimate Weather', match: k => /^nx_/.test(k), reopen: ' · reopen Weather if it\'s open' },
  apol:     { name: 'Apologetics101', match: k => /^a101\./.test(k), reopen: '' },
  hub:      { name: 'NEXUS Hub', match: k => /^nxhub_/.test(k), reopen: '' }
};
const APP_NAMES = { ...Object.fromEntries(Object.entries(LS_APPS).map(([k, v]) => [k, v.name])), nortest: 'nortest' };
// push subscriptions are never copied or changed (nxcal_push, nx_push)
const mine = (app, k) => LS_APPS[app].match(k) && !NO.has(k) && !/push/i.test(k);
function lsCapture(app) {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k != null && mine(app, k)) o[k] = localStorage.getItem(k); }
  return o;
}

/* ---------- nortest database (read existing only; never created or upgraded here) ---------- */
const NT_META = ['S', 'plays', 'hist', 'queue', 'qi', 'lastBackup'];
const isBlob = v => typeof Blob !== 'undefined' && v instanceof Blob;
async function ntDB() { return H().openExistingDB('nortest'); }
const idbReq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function ntCapture(withSongs) {
  const db = await ntDB(); if (!db) return null;
  try {
    const [pls, meta, songs] = await Promise.all([H().idbAll(db, 'playlists'), H().idbAll(db, 'meta'), withSongs ? H().idbAll(db, 'songs') : []]);
    const out = { playlists: pls, meta: meta.filter(r => r && NT_META.includes(r.k) && !isBlob(r.v)) };
    if (withSongs) out.songs = songs.map(s => { const o = {}; for (const [k, v] of Object.entries(s || {})) o[k] = isBlob(v) ? { _file: true, type: v.type || '', size: v.size || 0 } : v; return o; });
    return out;
  } finally { db.close(); }
}
async function ntPut(rec, delPls) {
  const db = await ntDB(); if (!db) throw new Error('Open nortest once on this phone first');
  try {
    await new Promise((res, rej) => {
      const t = db.transaction(['playlists', 'meta'], 'readwrite');
      (rec.playlists || []).forEach(p => t.objectStore('playlists').put(p));
      (rec.meta || []).forEach(m => t.objectStore('meta').put(m));
      (delPls || []).forEach(id => t.objectStore('playlists').delete(id)); // only playlists the Hub itself just added (Undo)
      t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  } finally { db.close(); }
}

/* ---------- snapshots (Hub-owned IndexedDB "nxhub", store "nxhub_snapshots") ---------- */
const KEEP = 5;
function hubDB() {
  return new Promise((res, rej) => {
    const q = indexedDB.open('nxhub', 1);
    q.onupgradeneeded = () => { if (!q.result.objectStoreNames.contains('nxhub_snapshots')) q.result.createObjectStore('nxhub_snapshots', { keyPath: 'id', autoIncrement: true }); };
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function snapList() {
  const db = await hubDB();
  try { return (await idbReq(db.transaction('nxhub_snapshots').objectStore('nxhub_snapshots').getAll())).sort((a, b) => b.at - a.at); } finally { db.close(); }
}
async function capture(app) { return app === 'nortest' ? { idb: await ntCapture(false) } : { ls: lsCapture(app) }; }
async function snapshot(app, label) {
  const data = await capture(app);
  const db = await hubDB();
  try {
    const st = () => db.transaction('nxhub_snapshots', 'readwrite').objectStore('nxhub_snapshots');
    await idbReq(st().add({ app, label, at: Date.now(), data }));
    const all = (await idbReq(st().getAll())).filter(s => s.app === app).sort((a, b) => b.at - a.at);
    for (const old of all.slice(KEEP)) await idbReq(st().delete(old.id));
  } finally { db.close(); }
}
const snapped = new Set();
async function ensureSnap(app, label) { if (snapped.has(app)) return; await snapshot(app, 'Before: ' + label); snapped.add(app); }

/* ---------- one change = snapshot (first time) + write + Undo ---------- */
async function change(app, label, fn, opts = {}) {
  try { await ensureSnap(app, label); } catch (e) { toast("Couldn't save a safety snapshot, so nothing was changed."); throw e; }
  const before = lsCapture(app);
  await fn();
  const after = lsCapture(app);
  const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(k => before[k] !== after[k]);
  const undo = async () => {
    const moved = touched.filter(k => localStorage.getItem(k) !== (after[k] ?? null));
    if (moved.length && !confirm(`${APP_NAMES[app]} changed again since then. Undo anyway?`)) return;
    touched.forEach(k => { if (before[k] == null) localStorage.removeItem(k); else localStorage.setItem(k, before[k]); });
    toast('Undone ↩︎'); opts.after ? opts.after() : H().refresh();
  };
  toast((opts.msg || label) + (LS_APPS[app] ? LS_APPS[app].reopen : ''), { undo });
  opts.after ? opts.after() : H().refresh();
  return { undo };
}

/* ================= nortest remote (its own text remote over ntfy) ================= */
const TOPIC = 'nortest-7013d8b424a21d78';
const NT = { st: null, at: 0, waiting: 0, asked: 0 };
const REP = { off: 'Off', all: 'All', one: 'One', once: 'Once' };
function parseStatus(txt) {
  txt = String(txt || '').trim();
  let m = txt.match(/^(.*) — (.*) \(([\d:]+)\/([\d:]+)\) (playing|paused), repeat:(\w+), shuffle:(on|off), vol:(\d+)/);
  if (m) return { title: m[1], artist: m[2], pos: m[3], dur: m[4], state: m[5], rep: m[6], shuf: m[7] === 'on', vol: +m[8] };
  m = txt.match(/^nothing playing, repeat:(\w+), shuffle:(on|off)/);
  if (m) return { state: 'idle', rep: m[1], shuf: m[2] === 'on' };
  return null;
}
async function ntSend(c) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try { const r = await fetch('https://ntfy.sh/' + TOPIC, { method: 'POST', body: c, signal: ac.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); }
  finally { clearTimeout(t); }
}
function showNT() {
  const s = NT.st, T = $('#npTitle'), U = $('#npSub'), I = $('#npIc'); if (!T) return;
  if (NT.waiting && !s) { T.textContent = 'Now playing'; U.textContent = 'Asking the player…'; }
  if (s) {
    if (s.state === 'idle') { T.textContent = 'Nothing playing'; U.textContent = 'Tap ⏯ to start your music'; I.textContent = '⏹'; }
    else { T.textContent = s.title; U.textContent = `${s.artist && s.artist !== 'Unknown Artist' ? s.artist + ' · ' : ''}${s.state === 'playing' ? 'Playing' : 'Paused'} ${s.pos}/${s.dur}${s.vol != null ? ' · 🔊 ' + s.vol + '%' : ''}`; I.textContent = s.state === 'playing' ? '▶️' : '⏸'; }
    const p = $('#ntPlay'); if (p) p.textContent = s.state === 'playing' ? '⏸' : '▶️';
    const sh = $('#ntShuf'); if (sh) { sh.setAttribute('aria-pressed', String(!!s.shuf)); sh.textContent = '🔀 ' + (s.shuf ? 'On' : 'Off'); }
    const rp = $('#ntRep'); if (rp) { rp.setAttribute('aria-pressed', String(s.rep !== 'off')); rp.textContent = '🔁 ' + (REP[s.rep] || 'Repeat'); }
    if (NT.waiting) U.textContent += ' · updating…';
  }
  if (!NT.waiting && NT.at && Date.now() - NT.at > 5 * 60e3 && s) U.textContent += ' · ' + H().ago(NT.at);
}
let es = null;
function ntListen() {
  if (es || !online() || !('EventSource' in window)) return;
  try {
    es = new EventSource('https://ntfy.sh/' + TOPIC + '-status/sse');
    es.onmessage = e => { try { const m = JSON.parse(e.data); if (m.event && m.event !== 'message') return; const st = parseStatus(m.message); if (st) { NT.st = st; NT.at = (m.time || Date.now() / 1000) * 1000; NT.waiting = 0; showNT(); } } catch {} };
    es.onerror = () => {};
  } catch { es = null; }
}
function ntStop() { try { es && es.close(); } catch {} es = null; }
async function ntLast() {
  if (!online()) return;
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('https://ntfy.sh/' + TOPIC + '-status/json?poll=1&since=6h', { signal: ac.signal, cache: 'no-store' });
    const lines = (await r.text()).trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(m => m && m.event === 'message');
    const m = lines[lines.length - 1];
    if (m && (!NT.at || m.time * 1000 > NT.at)) { const st = parseStatus(m.message); if (st) { NT.st = st; NT.at = m.time * 1000; showNT(); } }
  } catch {} finally { clearTimeout(t); }
}
function ntAsk(force) {
  if (!online()) { const U = $('#npSub'); if (U && !NT.st) U.textContent = "You're offline. The remote needs internet."; return; }
  if (!force && Date.now() - NT.asked < 30000) return;
  NT.asked = Date.now(); NT.waiting = Date.now(); showNT(); ntListen();
  ntSend('status').catch(() => {});
  const w = NT.waiting;
  setTimeout(() => { if (NT.waiting === w) { NT.waiting = 0; showNT(); const U = $('#npSub'); if (U) U.textContent = (NT.st ? U.textContent + ' · ' : '') + 'Player not answering. Open nortest on any device.'; } }, 7000);
}
async function ntCmd(c, label) {
  if (!online()) return toast("You're offline. The remote needs internet.");
  try { await ntSend(c); } catch { return toast("Couldn't reach the remote. Check your internet."); }
  toast(label || '🎵 Sent');
  setTimeout(() => ntAsk(true), 900);
}
const ntToggle = () => { const s = NT.st; if (s && s.state === 'playing') { NT.st.state = 'paused'; showNT(); return ntCmd('pause', '⏸ Paused'); } if (s && s.state === 'paused') { NT.st.state = 'playing'; showNT(); } return ntCmd('play', '▶️ Play'); };
function ntVol(d) {
  const s = NT.st;
  if (!s || s.vol == null) { ntAsk(true); return toast('Checking the volume… tap again in a sec'); }
  const v = Math.max(0, Math.min(100, Math.round((s.vol + d) / 10) * 10)); s.vol = v; showNT();
  return ntCmd('vol ' + v, '🔊 Volume ' + v + '%');
}
document.addEventListener('visibilitychange', () => { if (document.hidden) ntStop(); else if ($('#np')) { ntListen(); ntLast(); } });
addEventListener('online', () => { if ($('#np')) { ntListen(); ntAsk(); } });

/* ================= Bibley ================= */
const bookKey = i => i === 18 ? 'Psalms' : i === 21 ? 'Song of Solomon' : H().BOOKS[i][0]; // Bibley's own chapter keys
async function bibDone() {
  const p = readJ('bibley_plan_v1', null);
  if (!p || !H().PLAN_DAYS[p.id]) return toast('Pick a reading plan in Bibley first (🔥 Plans)');
  const days = H().PLAN_DAYS[p.id](), done = p.done || {};
  const idx = days.findIndex((_, i) => !done[i]);
  if (idx < 0) return toast('Plan complete 🎉');
  const d = today();
  await change('bibley', `Day ${idx + 1} marked read`, () => {
    // same as Bibley's own "Mark read" (completeDay): plan day, chapters read, streak day
    const P = readJ('bibley_plan_v1', p); P.done = P.done || {}; P.done[idx] = d; setJ('bibley_plan_v1', P);
    const rm = readJ('bibley_read_v1', {}); days[idx].forEach(([b, c]) => { const k = bookKey(b) + '-' + c; if (!rm[k]) rm[k] = d; }); setJ('bibley_read_v1', rm);
    const a = readJ('bibley_activity_v1', []); if (!a.includes(d)) { a.push(d); a.sort(); setJ('bibley_activity_v1', a.slice(-800)); }
  }, { msg: `✓ Day ${idx + 1} read · 🔥 streak updated` });
}
const VERS = { web: 'WEB', kjv: 'KJV' };
async function votd() {
  const ref = H().votdRef(), d = today(), store = readJ('bibley_votd_v1', {}) || {};
  const ver = localStorage.getItem('bible_version_a_v1') || 'web';
  const hit = store[d + '|' + ver] || Object.keys(store).filter(k => k.startsWith(d + '|')).map(k => store[k])[0];
  if (hit && hit.text) return { ref: hit.ref || ref, text: hit.text, ver: String(hit.version || ver).toUpperCase() };
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch('https://bible-api.com/' + encodeURIComponent(ref) + '?translation=web', { signal: ac.signal });
    const j = await r.json(); const text = String(j.text || '').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('empty'); return { ref, text, ver: 'WEB' };
  } finally { clearTimeout(t); }
}
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; }
  catch { try { const ta = document.createElement('textarea'); ta.value = t; ta.style.cssText = 'position:fixed;opacity:0'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok; } catch { return false; } }
}
async function votdAct(share) {
  let v; try { v = await votd(); } catch { return toast(online() ? "Couldn't load today's verse" : "You're offline. Open Bibley once today to save the verse."); }
  const txt = `"${v.text}" — ${v.ref} (${v.ver})`;
  if (share && navigator.share) { try { await navigator.share({ title: 'Verse of the day', text: txt }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
  toast(await copyText(txt) ? '📋 Verse copied' : "Couldn't copy");
}

/* ================= Calendar ================= */
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + (m || 0); };
const fromMin = m => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const calLoad = () => { const v = readJ('nxcal_v1', null); return v && Array.isArray(v.events) ? v : { events: [], done: {}, settings: { holidays: true, weekStart: 0, view: 'month' } }; };
async function calAdd(f) {
  const title = f.querySelector('#calTitle').value.trim(), cat = f.querySelector('#calCat').value, date = f.querySelector('#calDate').value, time = f.querySelector('#calTime').value;
  if (!title) { f.querySelector('#calTitle').focus(); return toast('Give it a title'); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return toast('Pick a date');
  H().hubSet('calCat', cat);
  const now = Date.now(), st = /^\d{2}:\d{2}$/.test(time) ? time : null;
  // exactly the shape NEXUS Calendar's own editor saves (cleanEvent)
  const ev = { id: uid(), title: title.slice(0, 120), cat, date, allDay: !st, start: st, end: st ? fromMin(Math.min(toMin(st) + 60, 23 * 60 + 59)) : null, repeat: 'none', notes: '', ex: [], rem: [], created: now, updated: now };
  const E = { homework: '📚', test: '📝', school: '🏫', sports: '🏀', church: '⛪', hangout: '🎉', other: '📌' };
  await change('calendar', 'Added: ' + ev.title, () => { const DB = calLoad(); DB.events.push(ev); setJ('nxcal_v1', DB); }, { msg: `${E[cat] || '📌'} Added: ${ev.title}` });
}
async function hwToggle(id, key) {
  const DB0 = calLoad(), k = id + '@' + key, was = !!(DB0.done && DB0.done[k]);
  const t = (DB0.events.find(e => e.id === id) || {}).title || 'Homework';
  await change('calendar', (was ? 'Not done: ' : 'Done: ') + t, () => {
    const DB = calLoad(); DB.done = DB.done || {};
    if (DB.done[k]) delete DB.done[k]; else DB.done[k] = Date.now(); // the Calendar's own tick
    setJ('nxcal_v1', DB);
  }, { msg: was ? '⬜ Marked not done' : '✅ Nice, done!' });
}

/* ================= News ================= */
function newsCat(cat) {
  H().hubSet('newsCat', cat);
  const S = H().S; if (S.news && S.news.cats) { S.news.cat = cat; S.news.heads = S.news.cats[cat] || []; H().renderCard('news'); }
}
async function newsUnsave(id) {
  const list = readJ('nxnews_saved_v1', []); const it = Array.isArray(list) && list.find(s => s.id === id);
  if (!it) return H().refresh();
  await change('news', 'Removed from Saved', () => { setJ('nxnews_saved_v1', readJ('nxnews_saved_v1', []).filter(s => s.id !== id).slice(0, 300)); }, { msg: '🔖 Removed from Saved' });
}

/* ================= Weather ================= */
const STATES = { Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA', Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL', Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA', Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN', Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK', Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC', 'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT', Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI', Wyoming: 'WY', 'District of Columbia': 'DC' };
let wxItems = [];
async function wxSearch(q) {
  const box = $('#wxRes'); if (!box || !q) return;
  if (!online()) return toast("You're offline");
  box.hidden = false; box.innerHTML = '<div class="hint">Searching…</div>';
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);
  try {
    // the same lookups Ultimate Weather's own search uses
    if (/^\d{5}$/.test(q)) {
      const d = await (await fetch('https://api.zippopotam.us/us/' + q, { signal: ac.signal })).json();
      wxItems = (d.places || []).map(p => ({ lat: +p.latitude, lon: +p.longitude, name: `${p['place name']}, ${p['state abbreviation']}`, sub: 'ZIP ' + q }));
    } else {
      const d = await (await fetch('https://geocoding-api.open-meteo.com/v1/search?count=8&language=en&format=json&name=' + encodeURIComponent(q), { signal: ac.signal })).json();
      wxItems = (d.results || []).map(r => ({ lat: r.latitude, lon: r.longitude, name: r.country_code === 'US' && r.admin1 ? `${r.name}, ${STATES[r.admin1] || r.admin1}` : `${r.name}, ${r.country || ''}`, sub: [r.admin2, r.admin1, r.country].filter(Boolean).join(', ') }));
    }
  } catch { wxItems = []; } finally { clearTimeout(t); }
  box.innerHTML = wxItems.length ? wxItems.map((it, i) => `<button type="button" class="wxi" data-act="wx-pick" data-i="${i}"><b>📍 ${esc(it.name)}</b><span>${esc(it.sub)}</span></button>`).join('') : '<div class="hint">No places found</div>';
}
async function wxSet(it) {
  const loc = { lat: +(+it.lat).toFixed(4), lon: +(+it.lon).toFixed(4), name: it.name }; // Ultimate Weather's own nx_last shape
  await change('weather', 'Weather city: ' + loc.name, () => setJ('nx_last', loc), { msg: '📍 Weather now shows ' + loc.name.split(',')[0] });
}
async function wxUnit(u) {
  if (readJ('nx_unit', 'F') === u) return;
  await change('weather', 'Units: °' + u, () => setJ('nx_unit', u), { msg: 'Units: °' + u });
}

/* ================= card manager + settings sheet ================= */
function sheet(title, html, bind) {
  closeSheet();
  const w = document.createElement('div'); w.id = 'sheetWrap'; w.className = 'sheet-wrap';
  w.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><div class="sh-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">✕</button></div><div class="sh-body">${html}</div></div>`;
  w.addEventListener('click', e => { if (e.target === w || e.target.closest('[data-close]')) closeSheet(); });
  document.body.append(w); document.body.classList.add('locked');
  bind && bind(w.querySelector('.sh-body'));
}
function closeSheet() { const w = $('#sheetWrap'); if (w) w.remove(); document.body.classList.remove('locked'); }
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

function cardsHtml() {
  const L = H().layout();
  return L.order.map((k, i) => `<div class="mrow"><img src="${H().APPS[k].icon}" alt="" width="32" height="32"><b>${esc(H().APPS[k].name)}</b>
    <button type="button" class="mini" data-mv="${k}" data-d="-1" aria-label="Move ${esc(H().APPS[k].name)} up" ${i === 0 ? 'disabled' : ''}>↑</button>
    <button type="button" class="mini" data-mv="${k}" data-d="1" aria-label="Move ${esc(H().APPS[k].name)} down" ${i === L.order.length - 1 ? 'disabled' : ''}>↓</button>
    <button type="button" class="mini sw ${L.hidden.includes(k) ? '' : 'on'}" data-hide="${k}" aria-pressed="${!L.hidden.includes(k)}">${L.hidden.includes(k) ? 'Hidden' : 'Shown'}</button></div>`).join('');
}
async function snapsHtml() {
  let list = []; try { list = await snapList(); } catch {}
  if (!list.length) return '<div class="hint">No snapshots yet. The Hub saves one before it first changes an app.</div>';
  return list.map(s => `<div class="mrow"><div class="grow"><b>${esc(APP_NAMES[s.app] || s.app)}</b><span>${esc(s.label)} · ${new Date(s.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span></div><button type="button" class="mini" data-snap="${s.id}">Restore</button></div>`).join('');
}
async function openSettings(focus) {
  sheet('Hub settings', `
    <div class="sec">Cards · order and show/hide</div><div id="mgr">${cardsHtml()}</div>
    <div class="sec">Back up everything</div>
    <p class="hint">One file with Bibley, Calendar, News, Weather, Apologetics and Hub data, plus nortest's library list, playlists, play counts and settings (not the song files; use nortest → Backup for those). Notification sign-ups aren't included.</p>
    <div class="ctl"><button type="button" class="cbtn pri" data-x="backup" id="bkAll">💾 Back up everything</button><label class="cbtn" for="rsFile">📂 Restore from file</label><input id="rsFile" type="file" accept=".json,application/json" hidden></div>
    <div id="rsPrev"></div>
    <div class="sec">Restore a snapshot</div><div id="snaps"><div class="hint">Loading…</div></div>
    <p class="hint">Changes made here show right away in Calendar. Other apps that are already open may need to be closed and reopened to show a change.</p>`, async b => {
    b.addEventListener('click', async e => {
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.mv) { const L = H().layout(), i = L.order.indexOf(t.dataset.mv), j = i + (+t.dataset.d); if (j < 0 || j >= L.order.length) return; [L.order[i], L.order[j]] = [L.order[j], L.order[i]]; H().hubSet('layout', L); b.querySelector('#mgr').innerHTML = cardsHtml(); H().refresh(); }
      else if (t.dataset.hide) { const L = H().layout(), k = t.dataset.hide; L.hidden = L.hidden.includes(k) ? L.hidden.filter(x => x !== k) : [...L.hidden, k]; H().hubSet('layout', L); b.querySelector('#mgr').innerHTML = cardsHtml(); H().refresh(); }
      else if (t.dataset.x === 'backup') backupAll(t);
      else if (t.dataset.snap) restoreSnap(+t.dataset.snap);
      else if (t.dataset.x === 'restore') doRestore(b);
    });
    b.querySelector('#rsFile').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; if (f) previewRestore(f, b); e.target.value = ''; });
    b.querySelector('#snaps').innerHTML = await snapsHtml();
    if (focus === 'backup') b.querySelector('#bkAll').scrollIntoView({ block: 'center' });
  });
}

/* ---------- back up everything ---------- */
async function buildBackup() {
  const apps = {};
  for (const app of Object.keys(LS_APPS)) { const ls = lsCapture(app); if (Object.keys(ls).length) apps[app] = { ls }; }
  try { const lib = await ntCapture(true); if (lib) apps.nortest = { library: lib }; } catch (e) { console.warn('nortest backup', e && e.message); }
  return { app: 'NEXUS Hub', kind: 'nexus-all-apps-backup', v: 1, exported: new Date().toISOString(), apps };
}
async function backupAll(btn) {
  btn.disabled = true; btn.textContent = 'Packing…';
  try {
    const data = await buildBackup(); const txt = JSON.stringify(data);
    const name = `NEXUS-backup-${today()}.json`, blob = new Blob([txt], { type: 'application/json' });
    const file = typeof File !== 'undefined' ? new File([blob], name, { type: 'application/json' }) : null;
    H().hubSet('lastBackupAll', Date.now());
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    toast(`💾 Saved ${name} (${H().fmtBytes(blob.size)}) · ${Object.keys(data.apps).length} apps`, { ms: 4000 });
    window.__lastBackup = data;
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      const sh = document.createElement('button'); sh.type = 'button'; sh.className = 'cbtn'; sh.textContent = '↗️ Share backup file';
      sh.onclick = () => navigator.share({ files: [file], title: 'NEXUS backup' }).catch(() => {});
      btn.after(sh);
    }
  } catch (e) { toast("Couldn't make the backup: " + (e && e.message)); }
  finally { btn.disabled = false; btn.textContent = '💾 Back up everything'; }
}
/* ---------- restore with preview ---------- */
let pending = null;
const cnt = (raw, f) => { try { return f(JSON.parse(raw)); } catch { return '?'; } };
function describe(app, d) {
  const ls = (d && d.ls) || {};
  if (app === 'bibley') return `${cnt(ls.bible_highlights_v2 || '{}', o => Object.keys(o || {}).length)} highlights · ${cnt(ls.bibley_notes_v1 || '{}', o => Object.keys(o || {}).length)} notes · ${ls.bibley_plan_v1 ? 'reading plan' : 'no plan'} · ${cnt(ls.bibley_activity_v1 || '[]', o => (o || []).length)} reading days`;
  if (app === 'calendar') return `${cnt(ls.nxcal_v1 || '{}', o => (o.events || []).length)} events`;
  if (app === 'news') return `${cnt(ls.nxnews_saved_v1 || '[]', o => (o || []).length)} saved stories`;
  if (app === 'weather') return `city: ${cnt(ls.nx_last || 'null', o => (o && o.name) || 'not set')} · ${cnt(ls.nx_saved || '[]', o => (o || []).length)} saved spots`;
  if (app === 'apol') return `${cnt(ls['a101.lastRead'] || 'null', o => o ? 'last read: ' + (o.title || o.slug) : 'no reading yet')}`;
  if (app === 'hub') return 'card order + Hub settings';
  if (app === 'nortest') { const L = d.library || {}; return `${(L.playlists || []).length} playlists · play counts · settings (song list of ${(L.songs || []).length} kept for reference; song files aren't in this file)`; }
  return Object.keys(ls).length + ' items';
}
function nowDescribe(app) { return app === 'nortest' ? '' : describe(app, { ls: lsCapture(app) }); }
async function previewRestore(file, b) {
  const box = b.querySelector('#rsPrev'); let data;
  try { data = JSON.parse(await file.text()); } catch { box.innerHTML = '<div class="note">That file isn\'t a NEXUS backup.</div>'; return; }
  if (!data || data.kind !== 'nexus-all-apps-backup' || !data.apps) { box.innerHTML = '<div class="note">That file isn\'t a NEXUS Hub "Back up everything" file.</div>'; return; }
  pending = data;
  const apps = Object.keys(data.apps).filter(k => APP_NAMES[k]);
  box.innerHTML = `<div class="prev"><b>Backup from ${esc(new Date(data.exported).toLocaleString())}</b><p class="hint">Tick what to bring back. Each app gets a snapshot first, so you can undo.</p>
    ${apps.map(k => `<label class="pick"><input type="checkbox" data-app="${k}" checked><div><b>${esc(APP_NAMES[k])}</b><span>Backup: ${esc(describe(k, data.apps[k]))}</span>${k !== 'nortest' ? `<span class="dim">Now: ${esc(nowDescribe(k))}</span>` : ''}</div></label>`).join('')}
    <p class="hint">Restoring replaces those apps' saved items with the backup's. Nothing else is removed.</p>
    <button type="button" class="cbtn pri" data-x="restore">Restore selected</button></div>`;
}
async function doRestore(b) {
  if (!pending) return;
  const apps = [...b.querySelectorAll('#rsPrev input[data-app]:checked')].map(i => i.dataset.app);
  if (!apps.length) return toast('Tick at least one app');
  const undos = [], done = [], skipped = [];
  for (const app of apps) {
    const d = pending.apps[app];
    try {
      if (app === 'nortest') { const u = await ntRestore(d.library || {}, 'Restore from backup'); if (u) { undos.push(u); done.push(app); } else skipped.push(app); continue; }
      await snapshot(app, 'Before restore from backup'); snapped.add(app);
      const before = lsCapture(app), ks = Object.keys(d.ls || {}).filter(k => mine(app, k));
      ks.forEach(k => localStorage.setItem(k, d.ls[k]));
      undos.push(async () => ks.forEach(k => { if (before[k] == null) localStorage.removeItem(k); else localStorage.setItem(k, before[k]); }));
      done.push(app);
    } catch (e) { console.warn('restore', app, e && e.message); skipped.push(app); }
  }
  pending = null; b.querySelector('#rsPrev').innerHTML = '';
  b.querySelector('#snaps').innerHTML = await snapsHtml();
  H().refresh();
  toast(`Restored ${done.map(a => APP_NAMES[a]).join(', ') || 'nothing'}${skipped.length ? ' · skipped ' + skipped.map(a => APP_NAMES[a]).join(', ') + ' (open it once first)' : ''} · reopen apps that are open`, { undo: async () => { for (const u of undos.reverse()) await u(); toast('Restore undone ↩︎'); H().refresh(); } });
}
// nortest: settings, play counts and playlists (only songs already on this phone). Never the song list itself.
async function ntRestore(lib, label) {
  const db = await ntDB(); if (!db) return null;
  let have; try { have = new Set((await H().idbAll(db, 'songs')).map(s => s.id)); } finally { db.close(); }
  const before = await ntCapture(false);
  await snapshot('nortest', 'Before: ' + label); snapped.add('nortest');
  const meta = []; const bm = Object.fromEntries((before.meta || []).map(r => [r.k, r.v]));
  for (const r of (lib.meta || [])) {
    if (!r || isBlob(r.v)) continue;
    if (r.k === 'S' && r.v && typeof r.v === 'object') meta.push({ k: 'S', v: { ...(bm.S || {}), ...r.v } });
    else if (r.k === 'plays' && r.v && typeof r.v === 'object') { const p = { ...(bm.plays || {}) }; for (const [id, n] of Object.entries(r.v)) p[id] = Math.max(+p[id] || 0, +n || 0); meta.push({ k: 'plays', v: p }); }
    else if (r.k === 'lastBackup' && !bm.lastBackup) meta.push(r);
  }
  const prevIds = new Set((before.playlists || []).map(p => p.id));
  const pls = (lib.playlists || []).filter(p => p && p.id != null).map(p => ({ ...p, songs: (p.songs || []).filter(id => have.has(id)) }));
  await ntPut({ playlists: pls, meta });
  const added = pls.filter(p => !prevIds.has(p.id)).map(p => p.id);
  return async () => { await ntPut({ playlists: (before.playlists || []).filter(p => pls.some(x => x.id === p.id)), meta: (before.meta || []).filter(r => meta.some(m => m.k === r.k)) }, added); };
}
async function restoreSnap(id) {
  const s = (await snapList()).find(x => x.id === id); if (!s) return;
  if (!confirm(`Put ${APP_NAMES[s.app] || s.app} back to how it was (${s.label}, ${new Date(s.at).toLocaleString()})?`)) return;
  let undo;
  if (s.app === 'nortest') { undo = await ntRestore(s.data.idb || {}, 'Restore snapshot'); if (!undo) return toast('Open nortest once first'); }
  else {
    await snapshot(s.app, 'Before restoring a snapshot'); snapped.add(s.app);
    const before = lsCapture(s.app), ls = (s.data && s.data.ls) || {}, ks = Object.keys(ls).filter(k => mine(s.app, k));
    ks.forEach(k => localStorage.setItem(k, ls[k]));
    undo = async () => ks.forEach(k => { if (before[k] == null) localStorage.removeItem(k); else localStorage.setItem(k, before[k]); });
  }
  closeSheet(); H().refresh();
  toast(`${APP_NAMES[s.app]} restored ↩︎${LS_APPS[s.app] ? LS_APPS[s.app].reopen : ''}`, { undo: async () => { await undo(); toast('Undone ↩︎'); H().refresh(); } });
}

/* ================= wiring ================= */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const a = b.dataset.act;
  const run = p => Promise.resolve(p).catch(err => { console.warn('hub control', a, err && err.message); toast("That didn't work: " + (err && err.message || 'unknown error')); });
  if (a === 'nt') run(ntCmd(b.dataset.c, { prev: '⏮ Previous', next: '⏭ Next', shuffle: '🔀 Shuffle toggled', repeat: '🔁 Repeat changed' }[b.dataset.c]));
  else if (a === 'nt-toggle') run(ntToggle());
  else if (a === 'nt-vol') run(ntVol(+b.dataset.d));
  else if (a === 'nt-ask') ntAsk(true);
  else if (a === 'bib-done') { b.disabled = true; run(bibDone()); }
  else if (a === 'votd-copy') run(votdAct(false));
  else if (a === 'votd-share') run(votdAct(true));
  else if (a === 'hw') run(hwToggle(b.dataset.id, b.dataset.key));
  else if (a === 'news-cat') newsCat(b.dataset.cat);
  else if (a === 'news-unsave') run(newsUnsave(b.dataset.id));
  else if (a === 'wx-pick') { const it = wxItems[+b.dataset.i]; if (it) run(wxSet(it)); }
  else if (a === 'wx-spot') { const it = ((H().S.weather || {}).savedSpots || [])[+b.dataset.i]; if (it) run(wxSet(it)); }
  else if (a === 'wx-unit') run(wxUnit(b.dataset.u));
  else if (a === 'qa-event') quickEvent();
  else if (a === 'settings') openSettings();
  else if (a === 'qa-backup') openSettings('backup');
});
document.addEventListener('submit', e => {
  if (e.target.id === 'calForm') { e.preventDefault(); calAdd(e.target).catch(err => toast("Couldn't add: " + (err && err.message))); }
  else if (e.target.id === 'wxForm') { e.preventDefault(); wxSearch(e.target.querySelector('#wxQ').value.trim()); }
});
document.addEventListener('change', e => { if (e.target.id === 'calCat') { const l = e.target.form && e.target.form.querySelector('#calDate'); if (l) l.previousElementSibling.textContent = e.target.value === 'homework' ? 'Due' : 'Date'; } });
function quickEvent() {
  const c = document.getElementById('card-calendar');
  if (!c) return toast('The Calendar card is hidden. ⚙️ → Cards to show it.');
  const d = c.querySelector('#calAdd'); if (d) d.open = true;
  c.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => { const i = c.querySelector('#calTitle'); if (i) i.focus({ preventScroll: true }); }, 350);
}

window.HubCtl = {
  toast,
  mounted(S) {
    // quick actions bar state
    const qr = document.querySelector('[data-act="bib-done"].qa-btn');
    const b = S.bibley; if (qr) qr.disabled = !(b && b.plan && !b.plan.finished);
    if ($('#np')) { showNT(); ntListen(); if (!NT.at) ntLast(); ntAsk(); }
    else ntStop();
  },
  _t: { parseStatus, buildBackup, snapList, lsCapture, NT, bookKey }
};
})();
