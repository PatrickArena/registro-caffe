/* Il Registro del Caffe' — interfaccia.
 *
 * Legge solo da window.Registro e non tiene nessuno stato dei dati: qui dentro
 * ci sono lo stato dell'interazione (foglio aperto, riga in conferma) e il
 * disegno. Tutto il resto sta in store.js.
 */
(function () {
  "use strict";

  const store = window.Registro;

  // L'anteprima condivisibile e' generata dagli stessi file dell'app
  // (tools/make-preview.py), cosi' non puo' divergere. Le due sole cose che
  // laggiu' non hanno senso sono il service worker e il suggerimento
  // d'installazione, che parlerebbero della pagina sbagliata.
  const PREVIEW = window.REGISTRO_PREVIEW === true;

  let snap = store.snapshot();
  let editing = false;
  let confirmingId = null;
  let round = { payer: null, drinkers: [] };
  let bumped = [];
  let toastTimer = null;
  let lastSignature = "";

  const $ = id => document.getElementById(id);

  /* ── Formattazione ────────────────────────────────────── */

  function signed(n) {
    if (n > 0) return "+" + n;
    if (n < 0) return "−" + Math.abs(n);   // meno tipografico, non un trattino
    return "0";
  }

  function initials(name) {
    const parts = name.trim().split(/\s+/);
    const s = parts.length > 1 ? parts[0][0] + parts[1][0] : name.trim().slice(0, 2);
    return s.toUpperCase();
  }

  // Compleanni da config.js: { "Nome": "GG/MM" }. Confronto sulla data locale.
  function birthdayOf(name) {
    return ((window.REGISTRO_CONFIG || {}).birthdays || {})[name] || "";
  }

  function hasBirthday(name) { return Boolean(birthdayOf(name)); }

  function isBirthday(name) {
    const m = /^(\d{1,2})\/(\d{1,2})$/.exec(String(birthdayOf(name)).trim());
    if (!m) return false;
    const d = new Date();
    return Number(m[1]) === d.getDate() && Number(m[2]) === d.getMonth() + 1;
  }

  function drawBirthday() {
    const who = snap.roster.filter(p => isBirthday(p.name)).map(p => p.name);
    $("bday").innerHTML = who.length === 0 ? "" :
      '<div class="bday"><span class="cake" aria-hidden="true">🎂</span>' +
      '<p><b>Oggi è il compleanno di ' + esc(list(who)) + '!</b>' +
      '<small>Tanti auguri dal registro.</small></p></div>';
  }

  function cls(n) { return n > 0 ? "pos" : n < 0 ? "neg" : "zero"; }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function clock(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function list(names) {
    if (names.length === 0) return "";
    if (names.length === 1) return names[0];
    return names.slice(0, -1).join(", ") + " e " + names[names.length - 1];
  }

  // "caffè" e' invariabile: un caffè, due caffè. Niente plurale da gestire.
  function cups(n) { return n + " caffè"; }

  /* ── Disegno ──────────────────────────────────────────── */

  function drawStatus() {
    const el = $("status");
    const s = snap.status;
    let dot = "", text = "";

    if (s.mode === "local") {
      dot = ""; text = "Locale";
    } else if (!s.online) {
      dot = "off"; text = s.pending ? "Offline · " + s.pending : "Offline";
    } else if (s.pending) {
      dot = "wait"; text = "In coda · " + s.pending;
    } else {
      dot = "ok"; text = "Condiviso";
    }

    el.innerHTML = '<span class="dot ' + dot + '"></span>' + esc(text);
    el.setAttribute("aria-label", "Stato: " + text + (s.mode === "sync" ? ". Toccare per aggiornare." : ""));
  }

  function drawTurn() {
    const el = $("turn");
    const roster = snap.roster;

    if (roster.length === 0) {
      el.className = "turn is-even";
      el.innerHTML = '<span class="eyebrow">Registro vuoto</span>' +
        '<p class="turn-name">Nessuno, per ora.</p>' +
        '<p class="turn-note">Aggiungi chi prende il caffè con te e il conto parte da zero.</p>';
      return;
    }

    const low = roster[0].tokens;                        // roster e' ordinato per saldo
    const tied = roster.filter(p => p.tokens === low).map(p => p.name);

    if (roster.every(p => p.tokens === 0)) {
      el.className = "turn is-even";
      el.innerHTML = '<span class="eyebrow">Prossimo giro</span>' +
        '<p class="turn-name">Il conto è in pari.</p>' +
        '<p class="turn-note">Offre chi vuole — poi il registro tiene il segno.</p>';
      return;
    }

    el.className = "turn";
    const who = tied.length > 2 ? tied.slice(0, 2).join(", ") : list(tied);
    const more = tied.length > 2 ? " Pari merito con altri " + (tied.length - 2) + "." : "";
    el.innerHTML = '<span class="eyebrow">Tocca a</span>' +
      '<p class="turn-name">' + esc(who) + '</p>' +
      '<p class="turn-note">Saldo <b>' + signed(low) + '</b> — ' +
      (low < 0 ? "ha ricevuto più di quanto ha offerto." : "è il saldo più basso del registro.") +
      esc(more) + '</p>';
  }

  function drawRows() {
    const el = $("rows");
    let html = "";

    if (snap.roster.length === 0) {
      html += '<div class="empty">' +
        '<span class="eyebrow">Nessun nome</span>' +
        '<p>Scrivi qui sotto il primo nome. Chiunque può aggiungere o togliere una persona.</p>' +
        '</div>';
    }

    snap.roster.forEach(p => {
      if (confirmingId === p.id) {
        html += '<div class="row confirming">' +
          '<div class="confirm-text"><b>Eliminare ' + esc(p.name) + '?</b>' +
          (p.tokens !== 0
            ? '<small>Ha un saldo di ' + signed(p.tokens) + ': il registro non tornerà in pari.</small>'
            : '<small>Il saldo è a zero, non resta nulla in sospeso.</small>') +
          '</div>' +
          '<button class="mini" type="button" data-cancel-kill="1">No</button>' +
          '<button class="mini danger" type="button" data-kill="' + p.id + '">Elimina</button>' +
          '</div>';
        return;
      }
      const c = cls(p.tokens);
      // Nome e stato sulla stessa riga: lo stato a destra, accanto al saldo, per
      // tenere la riga bassa e il nome grande. Con nove persone in elenco la
      // seconda riga sotto il nome costava due nomi visibili.
      html += '<div class="row ' + c + '">' +
        '<span class="pip" aria-hidden="true">' + esc(initials(p.name)) + '</span>' +
        '<span class="row-name' + (isBirthday(p.name) ? ' has-cake' : !hasBirthday(p.name) ? ' no-bday' : '') + '">' + esc(p.name) + '</span>' +
        (isBirthday(p.name) ? '<span class="cake" title="Oggi compie gli anni" aria-label="Oggi compie gli anni">🎂</span>'
          : !hasBirthday(p.name) ? '<span class="nobday" title="Compleanno non segnato" aria-label="Compleanno non segnato"></span>' : "") +
        '<span class="row-state">' +
          (p.tokens > 0 ? "in credito" : p.tokens < 0 ? "in debito" : "in pari") +
        '</span>' +
        '<span class="tally ' + c + (bumped.indexOf(p.id) > -1 ? " bump" : "") + '">' + signed(p.tokens) + '</span>' +
        (editing
          ? '<button class="kill" type="button" data-ask-kill="' + p.id + '" aria-label="Elimina ' + esc(p.name) + '">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg></button>'
          : "") +
        '</div>';
    });

    el.innerHTML = html;
    $("count").textContent = snap.roster.length;
    $("editToggle").hidden = snap.roster.length === 0;
    $("editToggle").textContent = editing ? "Fatto" : "Modifica";
    $("openRound").disabled = snap.roster.length < 2;
  }

  function drawFlag() {
    const d = snap.drift;
    $("flag").innerHTML = (d === 0 || snap.roster.length === 0) ? "" :
      '<p class="flag">Il registro è sbilanciato di <b>' + signed(d) + '</b>. ' +
      'Succede quando si elimina qualcuno con un saldo aperto.</p>';
  }

  function drawLog() {
    const items = snap.log;
    $("logWrap").hidden = items.length === 0;
    // "Annulla" su ogni giro, non solo sull'ultimo: un errore lo si nota anche
    // tre caffè dopo, e cosi' non conta quale sia davvero il piu' recente
    // quando due telefoni hanno registrato quasi nello stesso momento.
    $("log").innerHTML = items.map(e =>
      '<div class="log-item">' +
        '<span class="log-when">' + clock(e.at) + '</span>' +
        '<span class="log-what"><b>' + esc(e.payerName) + '</b> ha offerto ' +
          '<span>a ' + esc(list(e.drinkerNames)) + '</span> ' +
          '<span>(' + esc(cups(e.cups)) + ')</span></span>' +
        '<button class="undo" type="button" data-undo="' + e.id + '" ' +
          'aria-label="Annulla il giro offerto da ' + esc(e.payerName) + '">Annulla</button>' +
      '</div>'
    ).join("");
  }

  function drawPanel() {
    const el = $("panel");
    if (snap.status.mode === "local") {
      el.innerHTML = '<div class="panel">' +
        '<span class="eyebrow">Solo su questo dispositivo</span>' +
        '<p>Questo registro non esce da qui: i colleghi che aprono lo stesso ' +
        'indirizzo partono da un conto vuoto e separato. Per condividerlo, ' +
        'vedi <code style="display:inline">README.md</code>.</p>' +
        '</div>';
      return;
    }
    el.innerHTML = '<div class="panel">' +
      '<span class="eyebrow">Stanza condivisa</span>' +
      '<code>' + esc(snap.room) + '</code>' +
      '<p style="margin-bottom:.75rem">Chi apre questo link vede e modifica lo stesso registro.</p>' +
      '<button class="mini" type="button" id="shareBtn">Passa il link ai colleghi</button>' +
      '</div>';
  }

  function drawCredits() {
    $("credits").textContent = snap.status.mode === "local"
      ? "I conti restano su questo dispositivo. Nessun account, nessun server."
      : "Registro condiviso. Chiunque abbia il link può leggerlo e modificarlo.";
  }

  // La versione la dichiara la cache del service worker, non un numero scritto
  // a mano: cosi' in fondo alla pagina compare la versione che il dispositivo
  // ha davvero installato, che e' l'unica cosa che interessa sapere quando ci
  // si chiede se l'aggiornamento e' arrivato.
  function drawVersion() {
    const el = $("build");
    const pezzi = [];
    const mostra = v => {
      if (v) pezzi.push(v);
      if (snap.status.mode === "sync" && snap.room) pezzi.push("stanza " + snap.room);
      el.textContent = pezzi.join(" · ");
    };
    if (!window.caches) { mostra(""); return; }
    caches.keys()
      .then(nomi => {
        const hit = nomi.map(n => /^registro-shell-(v\d+)$/.exec(n)).find(Boolean);
        mostra(hit ? hit[1] : "");
      })
      .catch(() => mostra(""));
  }

  function draw() {
    // Il polling chiama qui ogni pochi secondi: se non e' cambiato niente non
    // si ridisegna, altrimenti l'interfaccia sfarfalla senza motivo.
    const sig = JSON.stringify([snap.roster, snap.log, snap.drift, snap.status, editing, confirmingId, bumped]);
    if (sig === lastSignature) return;
    lastSignature = sig;

    drawStatus();
    drawBirthday();
    drawTurn();
    drawRows();
    drawFlag();
    drawLog();
    drawPanel();
    drawCredits();
    bumped = [];
  }

  /* ── Avviso temporaneo ────────────────────────────────── */

  function showToast(text, undoId) {
    const t = $("toast");
    $("toastText").textContent = text;
    const btn = $("toastUndo");
    if (undoId) { btn.dataset.undo = undoId; btn.hidden = false; }
    else { delete btn.dataset.undo; btn.hidden = true; }
    t.classList.add("open");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  function hideToast() {
    clearTimeout(toastTimer);
    $("toast").classList.remove("open");
  }

  /* ── Foglio del nuovo giro ────────────────────────────── */

  function openSheet() {
    round = { payer: null, drinkers: [] };
    drawSheet();
    $("sheet").classList.add("open");
    $("sheet").setAttribute("aria-hidden", "false");
    $("backdrop").classList.add("open");
    hideToast();
  }

  function closeSheet() {
    $("sheet").classList.remove("open");
    $("sheet").setAttribute("aria-hidden", "true");
    $("backdrop").classList.remove("open");
  }

  function isOpen() { return $("sheet").classList.contains("open"); }

  function nameById(id) {
    const p = snap.roster.find(x => x.id === id);
    return p ? p.name : "";
  }

  function drawSheet() {
    $("payerChips").innerHTML = snap.roster.map(p =>
      '<button class="chip" type="button" aria-pressed="' + (round.payer === p.id) +
      '" data-payer="' + p.id + '">' + esc(p.name) + (isBirthday(p.name) ? " 🎂" : "") +
      ' <span class="n">' + signed(p.tokens) + '</span></button>'
    ).join("");

    $("drinkerChips").innerHTML = snap.roster.map(p => {
      const isPayer = round.payer === p.id;
      return '<button class="chip" type="button" aria-pressed="' + (round.drinkers.indexOf(p.id) > -1) +
        '" data-drinker="' + p.id + '"' + (isPayer ? " disabled" : "") + '>' +
        esc(p.name) + (isPayer ? ' <span class="n">offre</span>' : "") + '</button>';
    }).join("");

    const prev = $("preview");
    if (!round.payer) {
      prev.innerHTML = '<span class="idle">Scegli chi paga.</span>';
    } else if (round.drinkers.length === 0) {
      prev.innerHTML = '<span class="idle">E per chi?</span>';
    } else {
      prev.innerHTML = '<span class="p">' + esc(nameById(round.payer)) + " +" + round.drinkers.length + '</span>' +
        round.drinkers.map(id => '<span class="m">' + esc(nameById(id)) + " −1</span>").join("");
    }
    $("confirmRound").disabled = !round.payer || round.drinkers.length === 0;
  }

  function registerRound() {
    const payerName = nameById(round.payer);
    const n = round.drinkers.length;
    bumped = [round.payer].concat(round.drinkers);
    const id = store.addRound(round.payer, round.drinkers);
    closeSheet();
    if (id) showToast(payerName + " ha offerto " + cups(n) + ".", id);
  }

  /* ── Condivisione ─────────────────────────────────────── */

  function shareLink() {
    const url = snap.shareLink;
    if (navigator.share) {
      navigator.share({ title: "Il Registro del Caffè", text: "Il conto dei caffè:", url: url })
        .catch(() => { /* l'utente ha chiuso il foglio di condivisione */ });
      return;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url)
        .then(() => showToast("Link copiato."))
        .catch(() => showToast(url));
      return;
    }
    showToast(url);
  }

  /* ── Suggerimento d'installazione su iPhone ───────────── */

  function drawInstallTip() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone = navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    let dismissed = false;
    try { dismissed = localStorage.getItem("registro-caffe.tip") === "off"; } catch (e) {}

    if (!isIOS || standalone || dismissed) return;

    $("tipWrap").innerHTML = '<div class="tip">' +
      '<p>Per averlo come app: <b>Condividi</b> in fondo a Safari, poi ' +
      '<b>Aggiungi alla schermata Home</b>.</p>' +
      '<button class="close" type="button" id="tipClose" aria-label="Chiudi il suggerimento">×</button>' +
      '</div>';
  }

  /* ── Eventi ───────────────────────────────────────────── */

  document.addEventListener("click", ev => {
    const t = ev.target.closest("button");
    if (!t) return;

    if (t.id === "editToggle") { editing = !editing; confirmingId = null; draw(); return; }
    if (t.id === "openRound") { openSheet(); return; }
    if (t.id === "cancelRound") { closeSheet(); return; }
    if (t.id === "confirmRound") { registerRound(); return; }
    if (t.id === "status") { store.refresh(); return; }
    if (t.id === "shareBtn") { shareLink(); return; }
    if (t.id === "tipClose") {
      try { localStorage.setItem("registro-caffe.tip", "off"); } catch (e) {}
      $("tipWrap").innerHTML = "";
      return;
    }

    if (t.dataset.askKill) { confirmingId = t.dataset.askKill; draw(); return; }
    if (t.dataset.cancelKill) { confirmingId = null; draw(); return; }
    if (t.dataset.kill) {
      const name = nameById(t.dataset.kill);
      confirmingId = null;
      editing = snap.roster.length > 1;
      store.removePerson(t.dataset.kill);
      showToast(name + " non è più nel registro.");
      return;
    }
    if (t.dataset.undo) {
      bumped = [];
      store.undoRound(t.dataset.undo);
      hideToast();
      return;
    }

    if (t.dataset.payer) {
      round.payer = round.payer === t.dataset.payer ? null : t.dataset.payer;
      round.drinkers = round.drinkers.filter(id => id !== round.payer);
      drawSheet();
      return;
    }
    if (t.dataset.drinker) {
      const id = t.dataset.drinker;
      const i = round.drinkers.indexOf(id);
      if (i > -1) round.drinkers.splice(i, 1); else round.drinkers.push(id);
      drawSheet();
      return;
    }
  });

  $("addForm").addEventListener("submit", ev => {
    ev.preventDefault();
    const input = $("nameInput");
    const res = store.addPerson(input.value);
    if (res.ok) {
      input.value = "";
      $("addBtn").disabled = true;
      $("hint").textContent = "";
      input.focus();
    } else if (res.reason === "duplicato") {
      $("hint").textContent = res.name + " è già nel registro.";
    } else if (res.reason === "lungo") {
      $("hint").textContent = "Nome troppo lungo: massimo 24 caratteri.";
    }
  });

  $("nameInput").addEventListener("input", () => {
    $("addBtn").disabled = $("nameInput").value.trim() === "";
    $("hint").textContent = "";
  });

  $("backdrop").addEventListener("click", closeSheet);

  document.addEventListener("keydown", ev => {
    if (ev.key !== "Escape") return;
    if (isOpen()) { closeSheet(); return; }
    if (confirmingId) { confirmingId = null; draw(); }
  });

  /* ── Avvio ────────────────────────────────────────────── */

  store.onChange(next => {
    snap = next;
    // Se qualcuno e' stato eliminato altrove, non lasciarlo scelto nel foglio.
    const alive = snap.roster.map(p => p.id);
    if (round.payer && alive.indexOf(round.payer) === -1) round.payer = null;
    round.drinkers = round.drinkers.filter(id => alive.indexOf(id) > -1);
    draw();
    if (isOpen()) drawSheet();
  });

  snap = store.init();
  draw();
  drawVersion();
  if (!PREVIEW) drawInstallTip();

  if (!PREVIEW && "serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js")
        // Alla prima visita la cache non esiste ancora quando disegno il piede:
        // appena il service worker prende il controllo, la versione si scrive.
        .then(() => navigator.serviceWorker.ready).then(drawVersion)
        .catch(() => { /* offline non disponibile, l'app funziona comunque */ });
    });
  }
})();
