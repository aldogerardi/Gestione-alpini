const VER = "7.99";
const CACHE_NAME = "gestione-gruppo-v" + VER.replace(".", "-");
// I file principali hanno ?v=<versione> nel nome: così a ogni versione il telefono li scarica di nuovo
// e non può riusare una copia vecchia conservata dal browser (GitHub Pages la tiene fino a 10 minuti).
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./styles.css?v=" + VER,
  "./app.js?v=" + VER,
  "./firebase-config.js?v=" + VER,
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE_URLS.map(u => new Request(u, { cache: "reload" }))))
  );
  // Nessuno skipWaiting qui: il nuovo service worker resta "in attesa"
  // finché l'utente non conferma l'aggiornamento dal banner.
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  // Guide video: niente memoria locale (i video usano richieste parziali, e su iPhone devono arrivare direttamente dalla rete).
  const url = new URL(event.request.url);
  if (url.pathname.indexOf("/guide/") !== -1 || event.request.headers.has("range")) return;
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetchPromise = fetch(event.request).then(networkResponse => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === "GET") {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
