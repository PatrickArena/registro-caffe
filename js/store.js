/* Il Registro del Caffe' — strato dati.
 *
 * Due modi, stessa logica:
 *
 *   locale  I dati stanno in localStorage, su questo dispositivo. Nessuna rete.
 *   sync    Gli stessi dati vivono su Supabase, condivisi da chi ha il codice
 *           stanza. Si attiva riempiendo js/config.js.
 *
 * Il registro e' un elenco di eventi, non di saldi: "Marco ha offerto a Luca e
 * Anna" e' un fatto, "Marco +2" e' una conseguenza che si ricalcola ogni volta.
 * Questo risolve gratis due problemi veri:
 *
 *   - due persone che registrano un giro insieme non si sovrascrivono, perche'
 *     due INSERT su righe diverse non entrano in conflitto;
 *   - l'annullamento e' un altro evento, quindi non serve ricostruire nulla.
 *
 * In modo sync lo stato visibile e' sempre: ultima fotografia dal server, piu'
 * gli eventi non ancora spediti. Cosi' l'app risponde subito anche offline e la
 * coda si svuota quando la rete torna.
 */
window.Registro = (function () {
  "use strict";

  const LS = {
    base: "registro-caffe.base",
    outbox: "registro-caffe.outbox",
    room: "registro-caffe.room",
    seeded: "registro-caffe.seeded"
  };

  const EMPTY = { people: [], rounds: [] };

  let base = clone(EMPTY);      // fotografia: locale in modo locale, remota in sync
  let outbox = [];              // eventi in attesa di spedizione (solo sync)
  let view = clone(EMPTY);      // base + outbox, cioe' cio' che si vede
  let room = "";
  let listeners = [];
  let pollTimer = null;
  let flushing = false;

  const status = {
    mode: "local",
    online: true,
    pending: 0,
    syncedAt: null,
    error: null
  };

  /* ── Utilita' ─────────────────────────────────────────── */

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // Ripiego per contesti non sicuri (http:// su IP di rete locale).
    const b = new Uint8Array(16);
    (window.crypto || {}).getRandomValues
      ? crypto.getRandomValues(b)
      : b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256); });
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function readLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  }

  function writeLS(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage pieno o negato */ }
  }

  function configured() {
    const c = window.REGISTRO_CONFIG || {};
    return Boolean(c.supabaseUrl && c.supabaseAnonKey);
  }

  /* ── Codice stanza ────────────────────────────────────── */
  // Sta nell'indirizzo come #r=CODICE per poterlo passare ai colleghi, e in
  // localStorage perche' l'app installata parte da start_url, senza frammento.

  const ALPHABET = "abcdefghijkmnopqrstuvwxyz23456789"; // senza l e 1, si confondono

  function newRoom() {
    const b = new Uint8Array(14);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
    else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
    return Array.from(b, x => ALPHABET[x % ALPHABET.length]).join("");
  }

  function resolveRoom() {
    const m = /(?:^|[#&])r=([a-z0-9]{6,40})/i.exec(location.hash || "");
    const stored = readLS(LS.room, "");
    if (m && m[1] !== stored) {
      room = m[1].toLowerCase();
      writeLS(LS.room, room);
      // Stanza nuova: la fotografia precedente non c'entra piu' niente.
      writeLS(LS.base, EMPTY);
      writeLS(LS.outbox, []);
      return;
    }
    // Senza codice nell'indirizzo e senza stanza già memorizzata si entra in
    // quella dichiarata in config.js: un ufficio ha un registro, non tanti.
    // Solo se manca anche quella si genera una stanza nuova, che e' il
    // comportamento giusto per un'installazione senza configurazione.
    const fallback = String((window.REGISTRO_CONFIG || {}).defaultRoom || "").toLowerCase();
    room = m ? m[1].toLowerCase() : (stored || fallback || newRoom());
    writeLS(LS.room, room);
  }

  function shareLink() {
    return location.origin + location.pathname + "#r=" + room;
  }

  /* ── Proiezione: eventi -> stato ──────────────────────── */

  function apply(state, ev) {
    if (ev.k === "person.add") {
      if (!state.people.some(p => p.id === ev.id)) {
        state.people.push({ id: ev.id, name: ev.name, createdAt: ev.at, deletedAt: null });
      }
    } else if (ev.k === "person.remove") {
      const p = state.people.find(x => x.id === ev.id);
      if (p) p.deletedAt = ev.at;
    } else if (ev.k === "round.add") {
      if (!state.rounds.some(r => r.id === ev.id)) {
        state.rounds.push({
          id: ev.id, payerId: ev.payerId, drinkerIds: ev.drinkerIds.slice(),
          createdAt: ev.at, undoneAt: null
        });
      }
    } else if (ev.k === "round.undo") {
      const r = state.rounds.find(x => x.id === ev.id);
      if (r) r.undoneAt = ev.at;
    }
    return state;
  }

  function recompute() {
    view = outbox.reduce(apply, clone(base));
    // Dal piu' recente. A parita' di istante decide l'id, non l'ordine di
    // arrivo: cosi' due telefoni della stessa stanza mostrano sempre la stessa
    // sequenza, anche se hanno gli orologi leggermente sfasati.
    view.rounds.sort((a, b) =>
      (b.createdAt - a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    status.pending = outbox.length;
    listeners.forEach(fn => fn(snapshot()));
  }

  /* ── Lettura pubblica ─────────────────────────────────── */

  function people() {
    return view.people.filter(p => !p.deletedAt);
  }

  function balances() {
    const map = Object.create(null);
    people().forEach(p => { map[p.id] = 0; });
    view.rounds.forEach(r => {
      if (r.undoneAt) return;
      // Chi paga guadagna un token per ogni caffe' offerto a qualcun altro;
      // il proprio caffe' si annulla da se', l'ha pagato e l'ha bevuto.
      //
      // Il credito si conta su tutti i riceventi del giro, anche su chi e'
      // stato poi eliminato: quei caffe' li ha pagati comunque, e togliergli
      // il credito perche' il debitore non c'e' piu' sarebbe riscrivere la
      // storia. Il debito scomparso rende il registro sbilanciato, ed e'
      // giusto che si veda: lo dice la nota sotto il registro.
      if (r.payerId in map) map[r.payerId] += r.drinkerIds.length;
      r.drinkerIds.forEach(id => { if (id in map) map[id] -= 1; });
    });
    return map;
  }

  function roster() {
    const bal = balances();
    return people()
      .map(p => ({ id: p.id, name: p.name, tokens: bal[p.id] || 0 }))
      .sort((a, b) => a.tokens - b.tokens || a.name.localeCompare(b.name, "it"));
  }

  function nameOf(id) {
    const p = view.people.find(x => x.id === id);
    return p ? p.name : "—";
  }

  function log(limit) {
    return view.rounds.filter(r => !r.undoneAt).slice(0, limit || 8).map(r => ({
      id: r.id,
      at: r.createdAt,
      payerName: nameOf(r.payerId),
      drinkerNames: r.drinkerIds.map(nameOf),
      cups: r.drinkerIds.length
    }));
  }

  function drift() {
    const bal = balances();
    return Object.keys(bal).reduce((t, k) => t + bal[k], 0);
  }

  function snapshot() {
    return {
      roster: roster(),
      log: log(10),
      drift: drift(),
      status: Object.assign({}, status),
      room: room,
      shareLink: shareLink()
    };
  }

  /* ── Scrittura pubblica ───────────────────────────────── */

  function commit(ev) {
    if (status.mode === "sync") {
      outbox.push(ev);
      writeLS(LS.outbox, outbox);
      recompute();
      flush();
    } else {
      apply(base, ev);
      writeLS(LS.base, base);
      recompute();
    }
  }

  function addPerson(rawName) {
    const name = String(rawName).trim().replace(/\s+/g, " ");
    if (!name) return { ok: false, reason: "vuoto" };
    if (name.length > 24) return { ok: false, reason: "lungo" };
    if (people().some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return { ok: false, reason: "duplicato", name: name };
    }
    commit({ k: "person.add", id: uuid(), name: name, at: Date.now() });
    return { ok: true, name: name };
  }

  function removePerson(id) {
    commit({ k: "person.remove", id: id, at: Date.now() });
  }

  function addRound(payerId, drinkerIds) {
    const clean = drinkerIds.filter(id => id !== payerId);
    if (!payerId || clean.length === 0) return null;
    const id = uuid();
    commit({ k: "round.add", id: id, payerId: payerId, drinkerIds: clean, at: Date.now() });
    return id;
  }

  function undoRound(id) {
    commit({ k: "round.undo", id: id, at: Date.now() });
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => { listeners = listeners.filter(f => f !== fn); };
  }

  /* ── Supabase (REST puro, nessuna libreria) ───────────── */

  function api(path, opts) {
    const cfg = window.REGISTRO_CONFIG;
    const o = opts || {};
    const key = cfg.supabaseAnonKey;
    const headers = {
      apikey: key,
      "Content-Type": "application/json"
    };
    // Le chiavi pubbliche nuove (sb_publishable_...) non sono JWT: passarle in
    // Authorization fa rispondere "invalid JWT". Le storiche (eyJ...) lo sono,
    // e li' il Bearer serve.
    if (key.slice(0, 3) === "eyJ") headers.Authorization = "Bearer " + key;
    if (o.prefer) headers.Prefer = o.prefer;
    return fetch(cfg.supabaseUrl.replace(/\/+$/, "") + "/rest/v1/" + path, {
      method: o.method || "GET",
      headers: headers,
      body: o.body ? JSON.stringify(o.body) : undefined,
      cache: "no-store"
    }).then(res => {
      if (res.ok) return res;
      return res.text().then(t => { throw new Error("Supabase " + res.status + ": " + t); });
    });
  }

  function send(ev) {
    // resolution=merge-duplicates rende ogni rispedizione innocua: se l'evento
    // era gia' arrivato prima che cadesse la rete, il secondo tentativo non
    // duplica niente.
    if (ev.k === "person.add") {
      return api("people", {
        method: "POST",
        prefer: "return=minimal,resolution=merge-duplicates",
        body: [{ id: ev.id, room: room, name: ev.name, created_at: new Date(ev.at).toISOString() }]
      });
    }
    if (ev.k === "person.remove") {
      return api("people?id=eq." + ev.id, {
        method: "PATCH", prefer: "return=minimal",
        body: { deleted_at: new Date(ev.at).toISOString() }
      });
    }
    if (ev.k === "round.add") {
      return api("rounds", {
        method: "POST",
        prefer: "return=minimal,resolution=merge-duplicates",
        body: [{
          id: ev.id, room: room, payer_id: ev.payerId,
          drinker_ids: ev.drinkerIds, created_at: new Date(ev.at).toISOString()
        }]
      });
    }
    if (ev.k === "round.undo") {
      return api("rounds?id=eq." + ev.id, {
        method: "PATCH", prefer: "return=minimal",
        body: { undone_at: new Date(ev.at).toISOString() }
      });
    }
    return Promise.resolve();
  }

  function flush() {
    if (flushing || status.mode !== "sync" || outbox.length === 0) return Promise.resolve();
    flushing = true;
    const step = () => {
      if (outbox.length === 0) return Promise.resolve();
      return send(outbox[0]).then(() => {
        outbox.shift();
        writeLS(LS.outbox, outbox);
        recompute();
        return step();
      });
    };
    return step()
      .then(() => { status.online = true; status.error = null; flushing = false; return pull(); })
      .catch(err => {
        status.online = false;
        status.error = String(err.message || err);
        flushing = false;
        recompute();
      });
  }

  function pull() {
    if (status.mode !== "sync") return Promise.resolve();
    const q = "room=eq." + encodeURIComponent(room);
    return Promise.all([
      api("people?" + q + "&select=id,name,created_at,deleted_at&order=created_at.asc").then(r => r.json()),
      api("rounds?" + q + "&select=id,payer_id,drinker_ids,created_at,undone_at&order=created_at.desc&limit=200").then(r => r.json())
    ]).then(([rp, rr]) => {
      base = {
        people: rp.map(p => ({
          id: p.id, name: p.name,
          createdAt: Date.parse(p.created_at),
          deletedAt: p.deleted_at ? Date.parse(p.deleted_at) : null
        })),
        rounds: rr.map(r => ({
          id: r.id, payerId: r.payer_id, drinkerIds: r.drinker_ids || [],
          createdAt: Date.parse(r.created_at),
          undoneAt: r.undone_at ? Date.parse(r.undone_at) : null
        }))
      };
      writeLS(LS.base, base);
      status.online = true;
      status.error = null;
      status.syncedAt = Date.now();
      recompute();
    }).catch(err => {
      status.online = false;
      status.error = String(err.message || err);
      recompute();
    });
  }

  // Primo avvio in modo sync con dati locali gia' presenti: li si spedisce,
  // invece di perderli. Una volta sola per stanza.
  function seedFromLocal() {
    const seeded = readLS(LS.seeded, {});
    if (seeded[room]) return;
    const local = readLS(LS.base, null);
    if (local && local.people && local.people.length) {
      local.people.forEach(p => {
        outbox.push({ k: "person.add", id: p.id, name: p.name, at: p.createdAt || Date.now() });
        if (p.deletedAt) outbox.push({ k: "person.remove", id: p.id, at: p.deletedAt });
      });
      (local.rounds || []).forEach(r => {
        outbox.push({ k: "round.add", id: r.id, payerId: r.payerId, drinkerIds: r.drinkerIds, at: r.createdAt });
        if (r.undoneAt) outbox.push({ k: "round.undo", id: r.id, at: r.undoneAt });
      });
      writeLS(LS.outbox, outbox);
    }
    seeded[room] = true;
    writeLS(LS.seeded, seeded);
  }

  /* ── Avvio ────────────────────────────────────────────── */

  function startPolling() {
    const secs = Math.max(2, Number((window.REGISTRO_CONFIG || {}).pollSeconds) || 5);
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      outbox.length ? flush() : pull();
    };
    clearInterval(pollTimer);
    pollTimer = setInterval(tick, secs * 1000);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") tick();
    });
    window.addEventListener("online", () => { status.online = true; tick(); });
    window.addEventListener("offline", () => { status.online = false; recompute(); });
  }

  function init() {
    resolveRoom();
    status.mode = configured() ? "sync" : "local";
    base = readLS(LS.base, clone(EMPTY));
    if (!base || !Array.isArray(base.people)) base = clone(EMPTY);
    if (!Array.isArray(base.rounds)) base.rounds = [];
    outbox = readLS(LS.outbox, []);
    if (!Array.isArray(outbox)) outbox = [];

    if (status.mode === "sync") {
      seedFromLocal();
      recompute();
      flush().then(pull);
      startPolling();
    } else {
      outbox = [];
      writeLS(LS.outbox, outbox);
      recompute();
    }
    return snapshot();
  }

  return {
    init: init,
    onChange: onChange,
    snapshot: snapshot,
    addPerson: addPerson,
    removePerson: removePerson,
    addRound: addRound,
    undoRound: undoRound,
    refresh: function () { return status.mode === "sync" ? (outbox.length ? flush() : pull()) : Promise.resolve(); },
    shareLink: shareLink
  };
})();
