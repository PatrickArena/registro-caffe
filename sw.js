/* Il Registro del Caffe' — service worker.
 *
 * Compito unico: far partire l'app anche senza rete. Il guscio (HTML, CSS, JS,
 * icone) sta in cache; i dati non passano da qui, li gestisce store.js.
 *
 * Quando modifichi un file dell'app, alza VERSION: e' l'unica cosa che dice al
 * browser di buttare la cache vecchia.
 */
const VERSION = "v8";   // v8: compleanni inseriti dall'app, salvati nel database
const SHELL = "registro-shell-" + VERSION;
const FONTS = "registro-fonts-" + VERSION;

const SHELL_FILES = [
  "./",
  "./index.html",
  "./css/app.css",
  "./js/config.js",
  "./js/store.js",
  "./js/app.js",
  "./manifest.webmanifest",
  "./icons/favicon-32.png",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(SHELL)
      // addAll fallisce in blocco se un file manca: meglio uno per uno, cosi'
      // un'icona assente non impedisce l'installazione.
      .then(cache => Promise.all(SHELL_FILES.map(f => cache.add(f).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL && k !== FONTS).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // I font di Google sono immutabili: prima la cache, e la prima volta che
  // arrivano li si tiene da parte per le aperture offline.
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(FONTS).then(c => c.put(req, copy));
        return res;
      }).catch(() => hit))
    );
    return;
  }

  // Tutto il resto che non e' di questa origine (cioe' le chiamate a Supabase)
  // passa alla rete senza intercettazioni: i dati non vanno mai in cache.
  if (url.origin !== location.origin) return;

  // Navigazioni: rete se c'e', altrimenti il guscio in cache.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("./index.html").then(hit => hit || caches.match("./")))
    );
    return;
  }

  // Guscio: risponde la cache subito, e in sottofondo si aggiorna.
  event.respondWith(
    caches.match(req).then(hit => {
      const fresh = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => hit);
      return hit || fresh;
    })
  );
});
