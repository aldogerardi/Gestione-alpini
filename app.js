// ===================== Gestione Gruppo =====================
const APP_VERSION = "9.10";
const APP_CREDIT = "Created from Claude AI x Alpini Bottonaga";

// ---------- Firebase: utenti dispositivo e sincronizzazione ----------
const FIRESTORE_COLLECTION = "gestioneGruppo";
const FIRESTORE_DOC = "stato";
const USERS = ["capogruppo", "pc_capogruppo", "segretario", "pc_segretario", "security", "pc_security"];
let currentUser = localStorage.getItem("gestione_gruppo_user") || null;
let currentRole = localStorage.getItem("gestione_gruppo_role") || null;
let loginAppenaEffettuato = false;
let firestoreUnsubscribe = null;

function defaultUtenti() {
  const ruoloPerId = {
    security: "admin", pc_security: "admin",
    capogruppo: "direttivo", pc_capogruppo: "direttivo",
    segretario: "direttivo", pc_segretario: "direttivo"
  };
  return USERS.map(u => ({ id: u, label: u, password: "", ruolo: ruoloPerId[u] || "direttivo" }))
    .concat([{ id: "socio", label: "Soci", password: "alpino", ruolo: "socio" }]);
}

function userLabel(u) {
  if (!u) return "-";
  if (u.startsWith("socio:")) {
    const sc = (state.socios || []).find(x => x.id === u.slice(6));
    return sc ? "👤 " + `${sc.cognome || ""} ${sc.nome || ""}`.trim() : "👤 (socio non trovato)";
  }
  const utente = (state.settings.utenti || []).find(x => x.id === u);
  const nomeVisibile = utente ? utente.label : u;
  return u.startsWith("pc_") ? "💻 " + nomeVisibile.replace(/^pc_/, "") : "📱 " + nomeVisibile;
}

// ---------- Accesso personale (nome e cognome + password) ----------
// Le password NON stanno nello stato principale: ogni socio ha un documento separato "pwd_<id>"
// con solo un hash PBKDF2 + sale. Finché il documento non esiste, la password è la data di nascita (ggmmaaaa).
let proponiCambioPassword = false;
const LOGIN_FALLITI_KEY = "gestione_gruppo_login_falliti";
const PWD_ITERAZIONI = 100000;

function normalizzaNomePerLogin(str) {
  return (str || "").toString().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
}

function passwordInizialeSocio(s) {
  const v = ((s && s.dataNascita) || "").trim();
  let g, me, a, m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) { g = m[1]; me = m[2]; a = m[3]; }
  else {
    m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    a = m[1]; me = m[2]; g = m[3];
  }
  const gi = parseInt(g, 10), mi = parseInt(me, 10), ai = parseInt(a, 10);
  if (ai < 1900 || mi < 1 || mi > 12 || gi < 1 || gi > 31) return null;
  return String(gi).padStart(2, "0") + String(mi).padStart(2, "0") + a;
}

function socioIdoneoApp(s) { return !!(s && !s.andatoAvanti && s.carica !== "Amici"); }
function socioPuoAccedere(s) { return !!(s && s.accessoApp && socioIdoneoApp(s) && passwordInizialeSocio(s)); }
function ruoloPersonale(s) { return s && (s.accessoLivello === "admin" || s.accessoLivello === "direttivo") ? s.accessoLivello : "socio"; }
function trovaSociPerNome(testo) {
  const k = normalizzaNomePerLogin(testo);
  if (!k) return [];
  return (state.socios || []).filter(s => normalizzaNomePerLogin(`${s.cognome || ""} ${s.nome || ""}`) === k);
}
function socioCorrente() {
  return currentUser && currentUser.startsWith("socio:") ? (state.socios || []).find(x => x.id === currentUser.slice(6)) : null;
}

function bytesToB64(bytes) { let s = ""; bytes.forEach(b => { s += String.fromCharCode(b); }); return btoa(s); }
function b64ToBytes(b64) { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

async function derivaHashPassword(password, saltBytes, iter) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: iter }, key, 256);
  return bytesToB64(new Uint8Array(bits));
}

function conTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);
}

async function leggiRecordPassword(socioId) {
  const snap = await conTimeout(db.collection(FIRESTORE_COLLECTION).doc("pwd_" + socioId).get(), 10000);
  return snap.exists ? snap.data() : null;
}

async function verificaPasswordSocio(s, digitata) {
  const rec = await leggiRecordPassword(s.id);
  if (rec) {
    const h = await derivaHashPassword(digitata, b64ToBytes(rec.s), rec.i || PWD_ITERAZIONI);
    return { ok: h === rec.h, primoAccesso: false };
  }
  const iniz = passwordInizialeSocio(s);
  const soloCifre = /^[\d\s\/\-.]+$/.test(digitata);
  return { ok: !!iniz && soloCifre && digitata.replace(/\D/g, "") === iniz, primoAccesso: true };
}

async function salvaNuovaPassword(socioId, nuova) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const h = await derivaHashPassword(nuova, salt, PWD_ITERAZIONI);
  await conTimeout(db.collection(FIRESTORE_COLLECTION).doc("pwd_" + socioId).set({ h, s: bytesToB64(salt), i: PWD_ITERAZIONI, t: new Date().toISOString() }), 10000);
}

async function reimpostaPasswordSocioDoc(socioId) {
  await conTimeout(db.collection(FIRESTORE_COLLECTION).doc("pwd_" + socioId).delete(), 10000);
}

function loginBloccatoPer() {
  try {
    const o = JSON.parse(localStorage.getItem(LOGIN_FALLITI_KEY) || "{}");
    const sec = Math.ceil(((o.until || 0) - Date.now()) / 1000);
    return sec > 0 ? sec : 0;
  } catch (e) { return 0; }
}
function registraTentativoFallito() {
  let o = {};
  try { o = JSON.parse(localStorage.getItem(LOGIN_FALLITI_KEY) || "{}"); } catch (e) { o = {}; }
  o.n = (o.n || 0) + 1;
  if (o.n >= 5) o.until = Date.now() + Math.min(15 * 60 * 1000, 30000 * Math.pow(2, o.n - 5));
  localStorage.setItem(LOGIN_FALLITI_KEY, JSON.stringify(o));
}
function azzeraTentativiFalliti() { localStorage.removeItem(LOGIN_FALLITI_KEY); }

async function tentaLoginPersonale(nomeTesto, password) {
  if (!window.db) return { errore: "Accesso personale non disponibile: Firebase non è configurato su questo dispositivo." };
  if (!(window.crypto && crypto.subtle)) return { errore: "Questo browser non supporta l'accesso sicuro: aggiornalo o usa il profilo condiviso." };
  const attesa = loginBloccatoPer();
  if (attesa > 0) return { errore: `Troppi tentativi: riprova tra ${attesa} secondi.` };
  const tutti = trovaSociPerNome(nomeTesto);
  let esito = null;
  try {
    for (const s of tutti.filter(socioPuoAccedere)) {
      const r = await verificaPasswordSocio(s, password);
      if (r.ok) { esito = { socio: s, primoAccesso: r.primoAccesso }; break; }
    }
  } catch (err) {
    console.error(err);
    return { errore: "Impossibile verificare la password: controlla la connessione e riprova." };
  }
  if (!esito) {
    registraTentativoFallito();
    scriviLog([{ ev: tutti.length ? "⚠️ Tentativo di accesso con password errata" : "⚠️ Tentativo di accesso con nome non riconosciuto" }],
      tutti.length === 1 ? "socio:" + tutti[0].id : "");
    return { errore: "Nome o password non corretti. Se non riesci ad entrare, rivolgiti al Direttivo." };
  }
  azzeraTentativiFalliti();
  return esito;
}

// Allinea ruolo/validità dell'accesso personale con l'Anagrafica. Ritorna true se ha avviato un ricaricamento.
function riallineaAccessoPersonale() {
  if (!currentUser || !currentUser.startsWith("socio:")) return false;
  if (!state.socios || !state.socios.length) return false;
  const s = state.socios.find(x => x.id === currentUser.slice(6));
  if (!s || !socioPuoAccedere(s)) {
    localStorage.removeItem("gestione_gruppo_user");
    localStorage.removeItem("gestione_gruppo_role");
    alert("Il tuo accesso all'app non è più attivo. Rivolgiti al Direttivo.");
    location.reload();
    return true;
  }
  const ruolo = ruoloPersonale(s);
  if (ruolo !== currentRole) {
    currentRole = ruolo;
    localStorage.setItem("gestione_gruppo_role", ruolo);
    location.reload();
    return true;
  }
  return false;
}

function showLoginScreen(onDone) {
  const utenti = (state.settings.utenti && state.settings.utenti.length) ? state.settings.utenti : defaultUtenti();
  const html = `
    <div id="login-screen" style="position:fixed; inset:0; background:#1a6b3c; z-index:9999; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:20px; overflow-y:auto;">
      <div id="login-step-scelta" style="width:100%; max-width:320px;">
        <div style="color:#fff; font-size:1.3rem; font-weight:800; margin-bottom:12px; text-align:center;">Accedi</div>
        <input type="text" id="lp-nome" placeholder="Cognome e nome" autocomplete="username" autocapitalize="words" style="width:100%; padding:11px; border-radius:8px; border:none; margin-bottom:10px; box-sizing:border-box; font-size:1rem;">
        <input type="password" id="lp-pass" placeholder="Password" autocomplete="current-password" style="width:100%; padding:11px; border-radius:8px; border:none; margin-bottom:8px; box-sizing:border-box; font-size:1rem;">
        <div style="color:#cfe9d8; font-size:0.76rem; text-align:center; margin-bottom:8px;">Primo accesso: la password è la tua data di nascita a 8 cifre (ggmmaaaa)</div>
        <div id="lp-errore" style="color:#ffdddd; font-size:0.85rem; margin-bottom:8px; text-align:center; min-height:1.1em;"></div>
        <button type="button" class="btn block" id="lp-entra" style="background:#fff; color:#1a6b3c; font-weight:700; margin-bottom:16px;">Entra</button>
        <button type="button" class="btn secondary block" id="lp-profili-btn" style="background:transparent; border:1px solid #fff; color:#fff;">Accesso con profilo condiviso</button>
        <div id="login-profili" style="display:none; flex-direction:column; gap:10px; margin-top:12px;">
          ${utenti.map(u => `<button type="button" class="btn block login-btn" data-user="${u.id}" style="background:#fff; color:#1a6b3c; font-weight:700;">${userLabel(u.id)}</button>`).join("")}
        </div>
      </div>
      <div id="login-step-password" style="display:none; width:100%; max-width:320px;">
        <div id="login-password-label" style="color:#fff; font-size:1.1rem; font-weight:800; margin-bottom:10px; text-align:center;"></div>
        <input type="password" id="login-password-input" style="width:100%; padding:10px; border-radius:8px; border:none; margin-bottom:10px; box-sizing:border-box;" placeholder="Password">
        <div id="login-password-error" style="color:#ffdddd; font-size:0.85rem; margin-bottom:8px; text-align:center; min-height:1.1em;"></div>
        <button type="button" class="btn block" id="login-password-ok" style="background:#fff; color:#1a6b3c; font-weight:700; margin-bottom:8px;">Entra</button>
        <button type="button" class="btn secondary block" id="login-password-back" style="background:transparent; border:1px solid #fff; color:#fff;">Indietro</button>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("afterbegin", html);

  let utenteScelto = null;

  function entra(u) {
    currentUser = u.id;
    currentRole = u.ruolo || "admin";
    localStorage.setItem("gestione_gruppo_user", currentUser);
    localStorage.setItem("gestione_gruppo_role", currentRole);
    loginAppenaEffettuato = true;
    document.getElementById("login-screen").remove();
    onDone();
  }

  function entraPersonale(socio, primoAccesso) {
    currentUser = "socio:" + socio.id;
    currentRole = ruoloPersonale(socio);
    localStorage.setItem("gestione_gruppo_user", currentUser);
    localStorage.setItem("gestione_gruppo_role", currentRole);
    loginAppenaEffettuato = true;
    proponiCambioPassword = !!primoAccesso;
    document.getElementById("login-screen").remove();
    onDone();
  }

  const lpEntra = async () => {
    const nome = document.getElementById("lp-nome").value;
    const pass = document.getElementById("lp-pass").value;
    const errEl = document.getElementById("lp-errore");
    const btn = document.getElementById("lp-entra");
    if (!nome.trim() || !pass) { errEl.textContent = "Inserisci cognome e nome e la password."; return; }
    errEl.textContent = "";
    btn.disabled = true; btn.textContent = "Verifica in corso...";
    const r = await tentaLoginPersonale(nome, pass);
    btn.disabled = false; btn.textContent = "Entra";
    if (r.errore) { errEl.textContent = r.errore; return; }
    entraPersonale(r.socio, r.primoAccesso);
  };
  document.getElementById("lp-entra").addEventListener("click", lpEntra);
  ["lp-nome", "lp-pass"].forEach(id => document.getElementById(id).addEventListener("keydown", e => { if (e.key === "Enter") lpEntra(); }));
  document.getElementById("lp-profili-btn").addEventListener("click", () => {
    const box = document.getElementById("login-profili");
    box.style.display = box.style.display === "none" ? "flex" : "none";
  });

  document.querySelectorAll(".login-btn").forEach(b => {
    b.addEventListener("click", () => {
      const u = utenti.find(x => x.id === b.dataset.user);
      if (!u) return;
      if (!u.password) { entra(u); return; }
      utenteScelto = u;
      document.getElementById("login-step-scelta").style.display = "none";
      document.getElementById("login-step-password").style.display = "block";
      document.getElementById("login-password-label").textContent = userLabel(u.id);
      document.getElementById("login-password-input").value = "";
      document.getElementById("login-password-error").textContent = "";
      document.getElementById("login-password-input").focus();
    });
  });

  document.getElementById("login-password-back").addEventListener("click", () => {
    document.getElementById("login-step-password").style.display = "none";
    document.getElementById("login-step-scelta").style.display = "block";
  });

  const provaPassword = () => {
    const val = document.getElementById("login-password-input").value;
    if (utenteScelto && val === utenteScelto.password) {
      entra(utenteScelto);
    } else {
      document.getElementById("login-password-error").textContent = "Password errata";
      if (utenteScelto) scriviLog([{ ev: "⚠️ Tentativo di accesso con password errata" }], utenteScelto.id);
    }
  };
  document.getElementById("login-password-ok").addEventListener("click", provaPassword);
  document.getElementById("login-password-input").addEventListener("keydown", e => {
    if (e.key === "Enter") provaPassword();
  });
}

function uploadDocumento(file, path) {
  if (!window.storage) return Promise.reject(new Error("Firebase Storage non configurato"));
  const ref = storage.ref().child(path);
  return ref.put(file).then(snap => snap.ref.getDownloadURL());
}

function applyStateFields(source) {
  state.socios = source.socios || [];
  state.gruppoInfo = Object.assign(state.gruppoInfo, source.gruppoInfo || {});
  state.settings = Object.assign(state.settings, source.settings || {});
  state.consiglio = Object.assign(state.consiglio, source.consiglio || {});
  state.pagamentiBollino = source.pagamentiBollino || [];
  state.bolliniIniziali = source.bolliniIniziali || {};
  state.iniziativeStorico = source.iniziativeStorico || [];
  state.meta = Object.assign(state.meta, source.meta || {});
  state.sponsor = source.sponsor || [];
  state.ringraziamenti = source.ringraziamenti || [];
  state.oreAlpine = source.oreAlpine || {};
  state.cene = source.cene || [];
  state.bacheca = source.bacheca || [];
  state.adunate = source.adunate || [];
  state.prenotazioni = source.prenotazioni || [];
  state.verbali = source.verbali || [];
  state.archivioBui = source.archivioBui || [];
  state.campagneBeneficenza = source.campagneBeneficenza || [];
  state.canzoni = source.canzoni || [];
  state.manuali = source.manuali || [];
  state.casoncellata = source.casoncellata || [];
  state.casoReparti = source.casoReparti || [];
}

const SYNC_STATO = { ok: null, quando: null, errore: "", ricevuto: null, daCache: false };

function syncToFirebase() {
  if (!window.db) return Promise.resolve(false);
  const clean = JSON.parse(JSON.stringify(state));
  const kb = Math.round(JSON.stringify(clean).length / 1024);
  return db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).set(clean).then(() => {
    SYNC_STATO.ok = true; SYNC_STATO.quando = new Date().toISOString(); SYNC_STATO.errore = "";
    return true;
  }).catch(err => {
    SYNC_STATO.ok = false; SYNC_STATO.quando = new Date().toISOString();
    SYNC_STATO.errore = String((err && (err.code || err.message)) || "errore");
    console.error("Errore salvataggio su Firebase", err);
    const troppo = kb > 1000 || /size|exceeds|invalid-argument/i.test(String((err && (err.message || err.code)) || ""));
    toast(troppo ? "⚠️ Dati troppo grandi per Firebase: non salvati online" : "⚠️ Salvato solo in locale, controlla la connessione");
    return false;
  });
}

function initFirebaseSync() {
  if (!window.db) return;
  const ref = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
  firestoreUnsubscribe = ref.onSnapshot(snap => {
    if (!snap.exists) {
      // Primo avvio in assoluto: nessun dato ancora su Firebase, carichiamo quello locale.
      const clean = JSON.parse(JSON.stringify(state));
      ref.set(clean).catch(err => console.error("Errore inizializzazione Firebase", err));
      return;
    }
    applyStateFields(snap.data());
    SYNC_STATO.ricevuto = new Date().toISOString();
    SYNC_STATO.daCache = !!(snap.metadata && snap.metadata.fromCache);
    logAggiornaBaseline();
    if (riallineaAccessoPersonale()) return;
    localStorage.setItem("gestione_gruppo_data", JSON.stringify(state));
    updateTopbar();
    renderSection();
    controllaPallinoCena();
  }, err => console.error("Errore sincronizzazione Firestore", err));
}

const CARICHE = ["Capogruppo","Capogruppo Onorario","Vice Capogruppo","Tesoriere","Vice Tesoriere","Segretario","Vice Segretario","Consigliere","Socio Alpino","Simpatizzante","Amici"];
const INCARICHI_FESTE = ["","Cucina","Lavapiatti","Bar","Patatine","Tagliata","Griglia","Formaggio fuso","Pulizie tavoli","Distribuzione"];

const LETTERHEAD_HTML = `
  <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; border-bottom:2px solid #1a6b3c; padding-bottom:8px; margin-bottom:14px;">
    <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABdCAMAAABaQJ4IAAADAFBMVEX//////8z//5n//2b//zP/////zP//zMz/zJn/zGb/zDP/zAD/mf//mcz/mZn/mWb/mTP/mQD/Zv//Zsz/Zpn/Zmb/ZjP/ZgD/M///M8z/M5n/M2b/MzP/MwD/AP//AMz/AJn/AGb/ADP/AADM///M/8zM/5nM/2bM/zPM/wDMzP/MzMzMzJnMzGbMzDPMzADMmf/MmczMmZnMmWbMmTPMmQDMZv/MZszMZpnMZmbMZjPMZgDMM//MM8zMM5nMM2bMMzPMMwDMAP/MAMzMAJnMAGbMADPMAACZ//+Z/8yZ/5mZ/2aZ/zOZ/wCZzP+ZzMyZzJmZzGaZzDOZzACZmf+ZmcyZmZmZmWaZmTOZmQCZZv+ZZsyZZpmZZmaZZjOZZgCZM/+ZM8yZM5mZM2aZMzOZMwCZAP+ZAMyZAJmZAGaZADOZAABm//9m/8xm/5lm/2Zm/zNm/wBmzP9mzMxmzJlmzGZmzDNmzABmmf9mmcxmmZlmmWZmmTNmmQBmZv9mZsxmZplmZmZmZjNmZgBmM/9mM8xmM5lmM2ZmMzNmMwBmAP9mAMxmAJlmAGZmADNmAAAz//8z/8wz/5kz/2Yz/zMz/wAzzP8zzMwzzJkzzGYzzDMzzAAzmf8zmcwzmZkzmWYzmTMzmQAzZv8zZswzZpkzZmYzZjMzZgAzM/8zM8wzM5kzM2YzMzMzMwAzAP8zAMwzAJkzAGYzADMzAAAA//8A/8wA/5kA/2YA/zMA/wAAzP8AzMwAzJkAzGYAzDMAzAAAmf8AmcwAmZkAmWYAmTMAmQAAZv8AZswAZpkAZmYAZjMAZgAAM/8AM8wAM5kAM2YAMzMAMwAAAP8AAMwAAJkAAGYAADMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADQDhbgAAAABnRSTlP//////wCzv6S/AAAAAWJLR0QAiAUdSAAAAAxjbVBQSkNtcDA3MTIAAAADSABzvAAAC3BJREFUaEPFmj126zgShanAxxsRk4GS6Y0QyUAb6QiY4OFtRJMAibiRVqQl9XcLkq0fUqI8fWye57bapoT6uXXrVtHd2w9f3Q+e70qpbz9nwJBrKfnHDPCVq5S3HzIg1TLmUiv5/5EU5FoTAcjC3w8YEDiarxIN/99vAO4Hvmpo9fftBtSSfSX97lT/32yAL3vOr2P6oJ/vNSCS/oj/p/B/ewpIfST6Y0gqwO/HAGcPSn+pZfMDBnB28ZwNB/1ICkId66D4f1bgt5Yhbpeg+HP5yw78TVVQ6pHzm/9X538PEfnxWBMlMI6lNYCL6zsiUPb7mhI5IAyf9fd/l6ELGUUDsyR/ptVpdVXwPEa5P+YRBfBPRMDBJwWvEnlVWiH4WSMouzGFUVe4D8BXMEAx009dd7pW2SIhdTNxuYrjEc8JgJs4/2UDHGImh/Php+9O7Z0A30cB9hnrFhCUops+CfCrTIiQSTent/8lFcRhexODRNzLBvCNO8FlKkQvVQE6drDj+uCDHy4DIY0DGi7aHKeB/Fp7YpAKhThO5ugFAxyfb8eHlI589Dj25TMaygLHfTb6t7d44CfrhPgmDmW8Nu71bphrXnEeSKKa1VOAYvmEYgm4WQ8XRJN0z4rEjMdDLftpkC4HYbXDvN8lcFC4Us7OXYSgA57GCyffOBjhpZ/sjQOmSWKpAUPdcnxCzQArffKI+yWnXPw5CwxaRFuB4Sj3lsl6IWuNJ8ZJAMqmZRjwlXP6TYxwT8kl55Siyx4yCPFsAD+SAU1wESEpH6lfoo/ZM/4vNCDWHveL2MQcAtYhkPOU8uZMBTXssC3bLW++7rnPYxDfFZV5sl4SAWHN/W7Mbwak5AaiEdOvlM+0EIhKBnecNhJ5Dm78z8sH/i+KQC59T7KNbrl2nOyjBbeOHwggQ7jfAKrMY6WjJuwds/lfhoGS1pISMJ15L6QBP87iheryfMEOEBUjp69hL8Lk5KPV62z+FxmQUueJOYdGLg7JOQQXf99w8oDi4C4spBpEwDo/wT+nEfDLICyhwy+qGyNIqSKMCVGh/yAhi8G7lUh1IYwez1f5SPcnI9P892nPExDS+KzbWipbFnjl+tt+2OGwZcWETxnfCZncL8PD+D/jAT5PYDP4iYIa3der1J8hMHCrdg6knTLgnXSgNMP/l0Y9igAfZ/0Mv9E+MYho8nXgPyEYUpTPB1pvzT7B2Bnjn/n/sAz9WNEz+AOmT9d95D95MIinW49S3/ytQVR9IV02yHuDHkSAT1FZa6BNEQEQ/Iz3AqQHAM7Kbiw91agcCC/wYtuEzF3zBsBjsLioT8nPFxV/9xLbSJDD53E8jivJJiNgQ++TNMwbYHDDg837u5t3vSmUsNn03htXj2EN/OpB1WCGPM7Ag25ovlc/DJ+qYzYKkJSOO9L6ISIiAW5lDrG4nYRuUzEbAdUdM0cXa3P/knVvDCn0QakhvmrpmIFkjCgbBpnvwydL5gxghpDWcIj6R9m333HWiSlK7YiaIjBAzDLjWQBmU6D0xw41ObpHzut8tk5G0QdrBLkEaiB4ESg4fkoEMxFo8k6C+on/SrMacCnH/X7csALwqW4ScyNUGK9E8rQt0wZEYxR6Wrgqv7tiWNW423ESc0mB97IT9ErnoeICGVIJX4yA8YlYOD6sfxGQD2mkOSETx9qhvfQG3+0imdD1ZQN0usTk5gH6IQC3YUTa43IpYVxRMS4i35AG5971ZQO00BOZzrO/CNj5EP8sijnQ37pqg5sJIxsIHqjxD8OmMSAdazzO93kUbr3zyEOS7hCosbMpxQ0UQU9fMFZ43g6nDHCH8l7jdkN7D7MRWA+O8+kCFBvDcZdRLkYK9Q9BsIgUv4oBog8P4boNg9OXw2nvXRhCDdvYMbgEm51+S6hTjNa/0eZfwgB8IhLoz+G/y4Lr+ppowAQg0YPAYukF/+RW/+pczOxQEBNaDX6pCgbeKGZhGprxnpXfdotGUA8u5RcKuK6Aa1gxneQtTMT5piL3T1rhtCYUerTUm4df6TQX+QEOSL21AfRY9vSOrlt7KMmZklZH+kIKtNSt/IcwTgZgiF38rfE0EwA9+4N9IU1exd+FxGg0axMCBjxWQ9ODib13gNBX/mPw+7DEFgKVAzCAjmMPH1zvwKxkWKJmeNkTPxIgOn82FUyJUokIdAAJcMMKqf2RCQaSLGJC7moEIAvauxCmVc/wVJzrmU5QRFShDQcy6vUUiMGKbx0ATAX2UXVHvUF2aNMEwnESCznARgbCgEVaHRZ+LUVG3EAgzVjJeTkCsptW2sV0UgH0dedWLri6cuQ8Ig+V/7YKUeOHKlxAh45aDrCTohBknFDITU/1yLUgofwLMwhE1F/UIEthawn/FjsEGiAQ4B5NSsRGHQEqlgY37UwY5H6bVF/kAZv5pe9dlhC7FKNnSnSs3dqQ0iSw9PIA8ZsMFHGBRw3Qp23Ga72ACKLn4BcDeY39H3y7YSNVZi+QEaq/mNjcO3S8ZihjfKIVsraRaYqQynF+NzYxHSu+RxUXIiyiAjZAIax7PjK4teLs3BAGNDfBLwmmYQuGaGdg7H+d3A+DNFBhdaDl4N6ispiIgrqXju9h9HPl9ZoryPAQVPM2/5vgZ/ysAwVPsCgDiWAWEp04KO9K3gH+cW9Px5YbYNSR/jekLuG0oH2+3tlyF+UFMzo0j+40vdrSLhK2yU3VbzsCrY/GPdtUG+cXRsAyR3kBvT754c/LNpDcrvG9bin/VZrJrRa2Oq5ZES37Bj+yzyKxAbWOC8uQrbo+yxwHfm64NIDXoQeghnp9MYe0pySKgf3LXa9Bvi1JbFckEOh3TwNgPKAlL41tC87w474Jspza2aLgtHWFKoNeHs0Ei38Bmqq9Nk7QIrSdWHK+DNCtWoBoFX09BzQcUNkmsM5h1RAK77Xalw3cUWQMt9k8ZsMBG+oF/qsZ8TGh/qL6wnC3gTAw0vSVfwZuoG2bqrYBZRQzh7ut+herM7ohValW0H4z8YBmakNi7L9zK/qf302oIBYjYvYDCcBN/vjlBLy/eBooVDgGaLAXho2jV0TpIcmxMj5+mHc2pXtjmYK005YBCr6XIDn2+GWQJrO2rCQkOxN8QiZMyDioSxhkImx1sSj/J0HCOzzPgoTgewN6DiDFijBHk2PvvfZxdjpITCtftsFRhUQBA/0BOKoTPsd/uwMQYvQGRuvIwvW17t5XomBObLSW0xYhrDzbOnYcD7nnmRjjkfVn/YsgQHYtPd/K0Mb6YLr+4lp17PrQPRSo0K5yh5D/owcFhvV6gO3gLUCg+m382Kr/uQy5aUa0tb5jqry8NGZq9FJ1a/upUlU02k90Eo5qDkxbbNKEoLSIKl45/qwJpST8eLWMYCme3Zojg9qfxIaYVpUGHJSCMu7ZDgIPAqXH0mIqLdUWB/8DA3phkod03oyCDN8SvOMB4rFumNI2pq39LYAKANvoU/REPZbjxuWpv5uOc6Xpd+r8akd6NM1wRMFR19IWVHq1YYBwBwhTLZC2zQ6G0rAeTeNZVvg3EfqYjl1NOp3tRuc2Tn/uB7GGxKMifbjUr9BPBbZOhxiQEmyZFzW+GPmp/QBqW0GQFUgSdL7hmguhi9OeXehGWGs8w1KgSQPbSD59LDBr39V+gHzvS2TS4TgTZ3aSHhKihzQOkg1NJ0pJL85tFr6I+2tbbhcUVvR69mfPRRWE9pyO+NNmWgGO5Zi7oCzx8vDgmeCStExsSJBg7bOhaJY/J9VhgtAufhlJf0PCgmcij82Y3hGR6/zbqMaqT08MTOXoogeGtQFPT1CXOPnwnscPrQQ5hjMVnbRw06NpA1ZMHL3GedN2PH90q3mteP3ZDG7vqZS1zh7L9R9EfTkSzw3goyUVDQr2bJbv/4TrJ5MXGfBl9xa88W9DY6tDquo0fAAAAABJRU5ErkJggg==" style="height:70px;">
    <div style="flex:1; text-align:center; color:#1a6b3c;">
      <div style="font-weight:800; font-style:italic; font-size:1.5rem; line-height:1.15;">GRUPPO ALPINI<br>BOTTONAGA</div>
      <div style="font-style:italic; font-size:0.82rem; margin-top:2px;">Via Corsica, 327 – 25125 Brescia&nbsp;&nbsp;&nbsp;Tel. 0303544982 / 030222612</div>
      <div style="font-style:italic; font-size:0.7rem; font-weight:700;">SEZ. BRESCIA</div>
    </div>
    <img src="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD//gBQRmlsZSB3cml0dGVuIHdpdGggQ29tcHVQaWMoUikgLSBQaG90b2RleCBDb3Jwb3JhdGlvbiAoaHR0cDovL3d3dy5waG90b2RleC5jb20p/9sAhAAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQyAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCABmAGYDAREAAhEBAxEB/8QAqAAAAgIDAQAAAAAAAAAAAAAABQYEBwACAwEQAAEDAgUBBQQGBAoLAAAAAAECAwQFEQAGEiExQQcTUWFxFBUigSMyM0KRsVKCkqEWFyQ1U2JjcrLRNnN0k6Kks9LT4fABAAMBAQEAAAAAAAAAAAAAAAADBAIBBREAAgIBAgMFBwQCAwEAAAAAAQIAAxESIQQxURMyQWHRFCJxgZGhwTNSsfAF4SNCYvH/2gAMAwEAAhEDEQA/AL/wQmYITw8YIQBUs0wYEn2BhLs+pW2hxE61j+8eEDzURhTWqpwNz0ES9yqdI3PQf3aRA1myqHUt+HRWFcIbR7S/bzUbIB9AcZ/5m8dP3mMXtvsv3PpPV5Jjy0FNUq1XqCVW1odlFDahzbSgAWwGgHvEmcPDBu+xPznI9mmUiCPdP/MOf92M+yU9Jz2Kj9s6jKBiIHu6v1mGUgAJMgPI24+FYPTwtjXY47rETvs+nuMRPC5mylHU43DrbCeSyPZn/wBkkoV+IwZtXz+07m9P/Q+hhGkZlp1YdVHZcWzMR9pDkJ7t5Hqk8jzFxjSWqxwOcZXcj7Dn0hrDY2ZghMwQmYITVagkEk2A3JJ4wQieupyszyvZadOECl30mWlYD8q2xDIPCORr6228cTFjYcKcDr4n4eslLtadKnC9fE/Dy8/pGKl0eDRYgjQI6GWr3Nt1LPipR3UfM4cqKgwoj0RUGFEnnjG5uV7PzXWswVl6k5QbZCIx0yag+LoSeLJ6c+pNjYW3xG1zu+ir6yB77LXKU8hzMJUOn5ppPtsitVpqoMiOS0gItpWN73sNrbY3WtqAmw5ja0urybGzAf8AGRMXS2nUQ2G5qYa5D7LgVYH6MtqTY7pUlZPjtbphXtRI5b4iPbW05xviOdAmT50VbtR7jvO8KUdyw80LWHIdAPPXjFVbMy7/AMGV0szLl8fQj+Z0rFBg1ptAlIUl1s3ZkNK0Osq8UqG4/Lyx10VxvNWVK/eguJU59DmM0+vOJeYeVoi1IDSFq6IdHCVnoeFeRwtWZDpffzi1dqyFs5dfWNCTh8o8ZtghMvghFKaV5pqb1NbUtFHiLKJziVW9pc2Pcg86R949fq+OENmxtPgOfn5esmObmKjujn5np6/SVnMUuY9VM5xQEpp9RZRFSmwHco2sB4W0ceJxAx1E3DwIxPMbLFrx4EY+X9Eu+JNZmRWJDa092+gLb35BF8eoGBAI8Z7SsGAI8YvdoNaNEylLdaWUyHx3DJSdwpXJHoLnCeJs7OsmT8Zb2dJPWV9Jy+ugP0pirwKhLoSYwW6iGVEe0HdSlhNr246bAeBGJDUUKhgSshNJqKiwErjw6xlyWikrmz2aJXXXoTzSiKVKQsFknqCTe25Bt489cP4fRkhG26SjhezyRW2R06Se9lKVIYZZdh0ZSGYvsaBeQCGtvhvqueBud8bNOQAQOWPGNNGRjA6ePKF6FTFUCJIEgxmmlL16kPuqA2sbl1Rt8jbDK1CDHrG1J2a4O3zP5kKo9pGWKcVINREhxJsURklzf1G378Yfiql2Ji7OMpTbOYIjZ4Gc33KTAy2uXDcATJXKeCEoQTybA+dt77bYUvEdsdKrkecSnF+0HSiZHnD1GlSKRUhQag648lSVLp8pw3LrYAu2o/pp8eqd+hw+vKnQ3ylFZNbdm3yP96RmBvh0ogPMdQegwG2YWn3hMdEaKDwFq+8fJIBV8sKsbSNuZ2ETc5VcLzOw/vlOMqkyKbk12l0RGuQmOWmipQTqUrZSyT1Nyr1wNWVr0pznGQrUUr542/v3ixTOyilHLzSKgysVUsnW4h9WlKze2wNiBt62xOnBJoGrnJU/x9fZgN3pyaybX5GVKU2pxuJWqM8oxFl0KQtBIIBI48Pl544KLDWoJww5QHDWmpd8MvKS42WMwZhrkOoZsVFbjQTdqHHNwte3xHfi9jz0tsL40KrLGDW+HhNLRda4a7GByELV2DmiPXEVShTGZDBa7t6BKcKW7j7ybdfwwyxbNWtPpG2rcH11nI6RJjZjh0bNsvMFZkw1z1slkQaWkuBJuLlazZOra3JP4YlFypYXcjPlIhctdptcjPQesIN54zVmYOKoVKYhQk31TZSrpbA5JUbJ28gcb9out7gwOsYOKuu/TXA6mLVTk08IVJn1CXmJ4FSVPrXaK2q33UagpyxI4KRhDso3JLfxJ3ZBu5L/AMSPlzIdSzW8md8MamKXbvlICCtI50IG3lfj1xirhWtOrkIung3uOo7CXTQcvU3LsQxqbHDSVG61k6lrPionn8serXUtYwontVUpUNKCe5hpSqrTFIYWG5jK0vxXSPs3U7pPoeD5E47YpZducLa9a4HPw+M3oVUTWKSxNDfdLWkh1s8tuJJStPyUCMCNqXM7U4dQ0FoAqeeHVndmkxghHh3zu6vmEBP7R8cY71p8vzFj3rifBf5P+o0DDpRMwQnhwQgau5kgUFDaZCluyXzpYisp1uuq8EpH58YW9ipz5xVty1jfn0lXV6pZnzbMNMYVoWd10+Gu6WU/27t7X8tx6HbEFjWWnSPoPyZ5lzXXnQD8h+TIFOp+WaNLUw6tquVRtJJaU+hmI2oHjWojWR/ntjCV1of3N9BMJXShwfeb6CdnJ1bzW8YkVp+TJjqH8mjhlUBoHjbcKsP0idwfDHS9luy/jE7rtuOEGSPDbTG/LvZjGiymqnW1olTRZXcNNJQwhXoB8VvkPLFFXCKp1PzlVPAqp1vuftLCbQG0JQkAJSLAAWAGLZfNjgnYn5gplWlVyO/Hcc7hBFko1eKeo2BuFbnkH8EWK5baTWpYze6dpIo2qmZqqdNdUAiW0ioN+Gs/A7b9YJP62BPdsYdd/WFZ0Wsp5Hf1nuTFplxKlUkkKTOqLziFjcKQkhCSD1Fk/ngoOoFuphwx1KW6kxoGHymeXvghFjOubWcrUfvk6HJj10R2lcE9VHyH+Q64RxF4qXPjJuK4gUJnxPKVZHnyGYyqnX5TjD0q61LbV/LZTZHwoT/Qtee1+l8QByBqs2J+p9BPNVyo12nBP1Pw6CEoNNr2YKa4zApbVMoiUXbiIeWypd7WWshJU7cfI4Yq2WLsML05RiJbavurhemcfXrJeTcpP11DprMpw06HJVHTTwSASnoo7EAXFhybb2x2iguM2ch4TvDcObBmw7A4xLPptIgUeKmNT4rUZkG+lsWufEnknzOL1RUGFE9NK1QYQYk64xqbmXGCE9vghNVb4ISuu1GRLpjNNqkNJ75KnI6iCUjSoJVuRvyj88RcWdADTzuPbQFcfCGOzUj+AFM8fpP+orDOE/REdwP6CxuvimVwBOzM2xJehwYEypyWR9MiIgENG1wFKUQAT4bnywtrQDgDMS1wU6VGT5Sh8zVSpzs0SZVRQ4zLbdsllYv3IBulNtxtt6nfrjxrndrMnwngcRZY1pLc49ZQydFnsGoVmJKLx+2Zntg9+bH4m1kggG45vxziyilSNTjfznocNw6sNTg58/xDYqHv2JJy7lqnvxGmlBp6Yt7SiPfqjQslSrXsL24vthwbXlKxiUB+0BrqGMczCsbMtEotfYykhlcdxKUpQvSkNlRTcAm99R8SNz6432yK4q8ZsXVpYKPGERmaIc1nLvdP+1Bjv+8sNGnwve9/ljfar2nZ+M3269r2XjBNZ7QoNHzKijORXnfibS8+lQCWis7XHXocYs4lUfTiLt4tEs7MiFswZkZy61HcegzZQeUUgRGtZTYX33wy2zQM4J+EbdaKgDgn4QNA7S6XPqiacIFSYfKVLIfZCbBKCs3F78A9MJXilZtJBiE45GfRgg+cNP5liM0+mzUtSXkVHT7M201qWq6CsXF9tgcONqgA9ZQblADdYq9qMgysnQXu5dZK5iT3bqdK0/AvkYl479MHzkf+ROaR8fwYdychEOLUqakBCYVRebQgbBKFELQAOgsv88P4cYBXoTKOG90FOhMLVirxqNBMl8qJJ0NtoF1urPCUjqT/AO+MMdwgyY2yxa1yYk5SzXEjZZZiR4UqXVytzvI7LRV3zpUdThc+rpJ5VfbE1NwFYwMmR8PeBWFAy3Tz6/Cbyey9utKVUKvUJCanIWXH/Z9PdpvwhIIvYCwv1tjjcErnU53MH4BbTqc+8YTGQmZMCHT6nOdmwoavom1MIQrSLWSVgXttva18N9n90KTsI32UFQrnIEaIkCLT46WIcZqOynhtpASn8Bh4UKNpUFUDA5Sq67QxX+1WqRErW3IRAS9GcQrSUOpSjSfS5x59teviCPKeVdV2vFMvjjaaZZra6j2k+3VBssSI9MW1LChay2xZZHl1xyqwtfqPgN5yi3XxJZtsDeL5mrq9JzDJdpNSffqj6XmpLLJU20EKJAJ+ZB9MJ1alc4O5iNRZXYqSSdj4bSyGc8xofZ3Drkg95IW2Gktat3Hk7EeXBJ8sX+0AUhzznojilXhxYef5nLK+WZSIE+uVnU7Wak0sm6QVMoKSAkDxtb9wximo6S78zOUUkKbH7zQK+irS6JSqc9SZ6hTVILWqlKKVpS2UWWO935B2I4xg6mVQV5eUUS5RV0n3fKZnGLUKrlqg0plC2ZWlx9bQYU3pSiyBdu6in6+25647cpdFXE7xCmxFTG/P6f8A2OKD7tz06k/CzVowWnw75rZXzKCn9k+GHj3bPj+JV3LvJvxFkUuq5wzdUzLKmKREfXGCwbLWgbKbb8Aoi61cnYX6YQUe2w55CTdnZdawbZR/cessaPEZhxm48dpLTDaQlDaBZKQOgGLQAOQl4UABQNpEquYKTRA0alOZjd6To7w21W5/MYy9ipjUcTNlyV41HGZJlVKFCiGXKlMsRxa7riwlO/G58cdLADJM0zqo1E7Tuh1DraXG1pUhQCkqSbgg8EY7kGaimXsoxc1SK0usxUVFTfs7qVS02AFgRp6H4RhBNQfXneSlqFsL6t+U0qtBysqVIrUuamN7wZMZTyZIQhwKFjY8aiE84HqqzrO2YPVTqNhOM7QvSGaPSWE5egvtao7dzGU6FOBJNyVDne/78MQIo7NYysIg7NfCLrmSMorYcpK5bgTEWqWpj2v4mQpIBJHITYDCPZ6iNGeW8n9mpxozy35yXl/JOXIcqLWKU++/puppwSi4hVwUnyPJxuqlAQynPzm6eHrBDqSfnG9QCRxiiVxcpQFSzdVajbUzEQmnsn+sDrdt8ygfq4QnvOT029ZOnvWs3gNvyZKzHTHp1OS7CITUIbgkxCeO8SD8J8lAlJ9casUsuRzE3chZcrzHKS6PU2KtTWZ0e4Q6N0K2UhQ2UlXgQbg+mNKwZciarcOoYQgeMbm5TubJVOrueajGnzmI8eBAcYZLy9IU+Rfb0J3/ALuPNuKPaQx5D7zx+IZLLmVjsBt8Z7UKt737DwpatT0dxqM6Ot0rFv8Ah04Gctws09mvgs+IxLQon8xU7/Zmv8AxendHwnp19wSnqZOy7CruYvftIcnrVOcLJRH7zSApVxe4tfbHm1tWrPrXO/SePU1SvZ2i536fGcZ0SVE7M4PtMdyO29WS7HacvdDZQbDfje58+euBlIoUHrBlZeHGoc22hjMTdQZ7S6pVqZu/S4zMlTVvtG9IStP7JOGWAi4uvhiMtDDiGsX/AKgTpAqEarZ0zXPhrC479FUtChz9mjY+Y4OO1sGucjp6TqOH4ixh+30jp2d7ZCo/+pP+JWKOG/SWWcH+iv8AfGEcxVY0ymExkhye+oMxGf03VcfIfWPkDhlj6V25xttmhduZ5TtRKW3R6WxDQsuFAKluHlxajqUo+pJOO1poULO116FC9IRIvjcZFWoNP5aqT1YiNOO0yQdVQjt7ltX9OhPXYfEByN+RhBBRtY5Hn6+smYGptY5Hn6+sZGZTUuKiRFdQ624gLbWk3SoEbEEdMOBBGRKAQRkRPy72fxoTcx2usw6nNkvl0uqZuEg9Bq8yTiarhwuS+CZHTwirkuASTB0ns3mmFXKfEmRWoFQfbfZbKFfQlKrkbdLbbeAxk8KcMqnYzB4I6XRSADCdKoedYL8ND+YYTkFhSAtlMUAqbTa6Qbc2Fr42tdwIy+3wm66uIUjLjA8pMytliTQJ9afefbdTUJRfQGwQUC6jY35PxY1TSa2YnxMZRQamZs5yZmdsryM0UyLFjSGmFMyUvFTiSQQARbbrvguqNigZhxNBuUKDjE7RsuvM5yqVaW60tiXGQwGdJ1Apte/QjbHRVi0vnnOrSVtazqIDpPZ45R6vWn48llMSfFdYZa0nU1rIO/QgcbeWFJw2h2YHYxNXB9nYzA7HaGqU2zkzJkZipym9MJvStxCTZRKjYJHJJuAByThqDsqwCY6sCirSx5TKPAlz6h79qrKmXikohxFKv7M2eSrp3iuvgLDxwIpY62+UK1LN2j8/AdP9xjAw0SibY7CaFN8EN4rvUmpZefclUBCX4Tiit6lKUEgE8qZV90nnSfhO9rYQUZDmvl09JMUao5r5dPSFKRmGnVkLRGfIktbOxXU6Hmj1CkHcevGNpYr8ucYlqvyO8LBQIwyNmXGCEy4wQmXGCGZ5qAxzIhmBavmeDTXRDb1zKksfRwow1OK8z0SPNVsYe1VOOZ6RNlyoccz0kWn0WdOns1WvrbW+0dUaE0bsxSR9a/31/wBbgb2xha2J1WfLymVrZjrs+Q6f7jIBbD5RNsEJmCEzBCarKUpJPQX2F8EIrvN5aze8tKVpVPiqtrRqYlMEeoCx8xbCCK7T5/eTEVXHzHyImJpuaKaLQKtGqLA4bqTZS4B4d4jn1IwabV7pz8YaLl7rZHn6zqxWMwJUlErK7vO6401labeiyk/L9+OiyzO6/edD2+KfcfmTDVp9v9Haj/vY/wD5cb1t+3+PWa7Rv2H7eshOVbMrxKI2WQ1/aTJzYSN+bN6j/wDdcLLWHkv3me0tPJPuJyVRsw1P+dq4mMyeY9LQWyfV1V1fhbHNDt3m+k52drd9sfD1nWG5lrLUpukxO6bmPm5aZQp55Z/SWQCr5q2xodlWdI8Z1eypOhdifrGROHR82wTszBCA/9k=" style="height:60px;">
  </div>
`;

const WA_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.13 2 11.22c0 2.09.86 4.01 2.29 5.58L3 22l5.48-1.43a10.6 10.6 0 0 0 3.52.6c5.52 0 10-4.13 10-9.22C22 6.13 17.52 2 12 2zm.02 16.68c-1.1 0-2.18-.24-3.15-.7l-.23-.11-3.25.85.87-3.13-.15-.24a7.9 7.9 0 0 1-1.26-4.33c0-4.35 3.74-7.88 8.34-7.88 4.6 0 8.34 3.53 8.34 7.88 0 4.35-3.74 7.66-8.51 7.66z"/></svg>`;

const RUOLI_CONSIGLIO = ["Capogruppo","Vice Capogruppo","Tesoriere","Segretario","Consigliere"];
const FASCIA_LABEL = { pranzo: "Pranzo", cena: "Cena", giornata: "Giornata intera" };
const FASCIA_ORDER = ["pranzo", "cena", "giornata"];

const PLACEHOLDER_SECTIONS = {
  "conv-casoncellata": { title: "Casoncellata", icon: "🥟", desc: "Disponibilità dei soci per la Casoncellata." },
  "presenza-adunata": { title: "Presenza Adunata", icon: "🎖️", desc: "Registro presenze soci alle adunate." },
  "cassa": { title: "Cassa", icon: "💰", desc: "Qui gestirai entrate e uscite del gruppo." }
};

// ---------- State ----------
let state = {
  socios: [],
  gruppoInfo: {
    denominazione: "",
    matricola: "",
    via: "",
    citta: "",
    prov: "",
    email: "",
    codiceFiscale: "",
    instagram: "",
    facebook: ""
  },
  settings: {
    appName: "Gestione Gruppo",
    logo: "icon-192.png",
    quotaBollino: 15,
    quotaNazionale: 19,
    testoPreghiera: "",
    testoCanto: "",
    testoAuguriCompleanno: "Tanti auguri di buon compleanno da tutto il Gruppo Alpini! 🎂🥂",
    regolamentoSede: "",
    moduloSedeUrl: "",
    moduloSedeNome: "",
    utenti: defaultUtenti()
  },
  consiglio: {
    membriIds: [],
    dataInizioMandato: "",
    storico: []
  },
  pagamentiBollino: [],
  bolliniIniziali: {},
  iniziativeStorico: [],
  sponsor: [],
  ringraziamenti: [],
  oreAlpine: {},
  cene: [],
  bacheca: [],
  adunate: [],
  prenotazioni: [],
  verbali: [],
  archivioBui: [],
  campagneBeneficenza: [],
  canzoni: [],
  manuali: [],
  casoncellata: [],
  casoReparti: [],
  meta: { ultimaModifica: null, ultimoImport: null }
};
let bollinoAnno = new Date().getFullYear();
let editingBollinoRecord = null;
let bollinoAmiciAnno = new Date().getFullYear();
let editingBollinoAmiciRecord = null;
let currentIniziativaId = null;
let selectedOreIniziativaId = null;
let currentSection = "home";
let editingId = null;
let pendingPrivacyFoto = undefined;
let pendingPrivacyFotoNome = "";
let pendingPrivacyFotoFile = null;
let pendingHaccpFoto = undefined;
let pendingHaccpFotoNome = "";
let pendingHaccpFotoFile = null;

function renderPrivacyChip(dataUrl, nome) {
  if (!dataUrl) return `<span class="card-sub">Nessuno</span>`;
  const isPdf = (nome || "").toLowerCase().endsWith(".pdf") || dataUrl.startsWith("data:application/pdf");
  const icon = isPdf ? "📄" : "📷";
  return `<span class="badge" data-view-privacy-doc style="padding:6px 8px; display:inline-flex; align-items:center; gap:5px; font-size:0.82rem; cursor:pointer; max-width:110px;"><span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${icon} ${esc(nome || "documento")}</span><span data-remove-privacy-doc style="cursor:pointer; font-weight:900; flex-shrink:0;">✕</span></span>`;
}
let searchTerm = "";
let filterCarica = "";

// ---------- Storage ----------
function loadState() {
  try {
    const raw = localStorage.getItem("gestione_gruppo_data");
    if (raw) {
      applyStateFields(JSON.parse(raw));
    }
  } catch (e) { console.error("Errore caricamento dati", e); }
}
function saveState() {
  state.meta = state.meta || {};
  state.meta.ultimaModifica = new Date().toISOString();
  state.meta.ultimaModificaDa = currentUser || "";
  localStorage.setItem("gestione_gruppo_data", JSON.stringify(state));
  try { registraModificheNelLog(); } catch (e) { console.warn("Log non registrato", e); }
  return syncToFirebase();
}

// ---------- Log attività ----------
// Ogni evento viene aggiunto (mai sovrascritto) in un documento mensile separato
// "log_AAAA-MM" nella stessa collection di Firebase, così non tocca lo stato principale.
const LOG_CAMPI_NOMI = {
  privacyFoto: "file privacy", privacyFotoNome: "file privacy", haccpFoto: "file HACCP", haccpFotoNome: "file HACCP",
  allegatoUrl: "allegato", allegatoNome: "allegato", allegatoThumbUrl: "allegato",
  andatoAvanti: "andato avanti", andatoAvantiData: "data andato avanti", dataNascita: "data di nascita",
  codiceFiscale: "codice fiscale", utenti: "utenti/password", moduloSedeUrl: "modulo sede", moduloSedeNome: "modulo sede",
  testoPreghiera: "testo preghiera", testoCanto: "testo canto", testoAuguriCompleanno: "testo auguri",
  quotaBollino: "quota bollino", quotaNazionale: "quota nazionale", appName: "nome app", incaricoFeste: "incarico feste",
  tagliaVestiario: "taglia vestiario", brigataAlpina: "brigata alpina", aggiornatoDaSocio: "scheda aggiornata dal socio", aperta: "richiesta aperta", sabato: "data del sabato", aggiornato: "aggiornato", daSocio: "ordine del socio", audioUrl: "file audio", audioNome: "file audio", audioBytes: "file audio", categoria: "categoria", testo: "testo", visibilita: "chi lo vede", accessoApp: "accesso app", accessoLivello: "livello accesso", chiaviSede: "chiavi sede", dataIscrizione: "data iscrizione", haccpDataCorso: "data corso HACCP", haccpDataScadenza: "scadenza HACCP"
};

function nomeSocioPerLog(id) {
  const s = (state.socios || []).find(x => x.id === id);
  return s ? `${s.cognome || ""} ${s.nome || ""}`.trim() : "socio";
}

const LOG_TRACK = [
  { id: "socios", nome: "Anagrafica", get: st => st.socios, label: s => `${s.cognome || ""} ${s.nome || ""}`.trim() },
  { id: "sponsor", nome: "Sponsor", get: st => st.sponsor, label: s => s.nome },
  { id: "ringraziamenti", nome: "Ringraziamenti", get: st => st.ringraziamenti, label: r => `${r.cognome || ""} ${r.nome || ""}`.trim() },
  { id: "iniziative", nome: "Attività", get: st => st.iniziativeStorico, label: i => i.nome },
  { id: "cene", nome: "Cena", get: st => st.cene, label: c => c.titolo },
  { id: "bacheca", nome: "Bacheca", get: st => st.bacheca, label: a => a.titolo },
  { id: "adunate", nome: "Adunata", get: st => st.adunate, label: a => a.titolo },
  { id: "prenotazioni", nome: "Prenotaz. Sede", get: st => st.prenotazioni, label: p => `${p.data || ""} ${FASCIA_LABEL[p.fascia] || p.fascia || ""} ${p.nome || ""}`.trim() },
  { id: "verbali", nome: "Verbali Consiglio", get: st => st.verbali, label: v => v.titolo },
  { id: "archivioBui", nome: "Archivio BUI", get: st => st.archivioBui, label: v => v.titolo },
  { id: "canzoni", nome: "Canzoni", get: st => st.canzoni, label: c => c.titolo },
  { id: "manuali", nome: "Manuali", get: st => st.manuali, label: m => m.titolo },
  { id: "casoncellata", nome: "Casoncellata", get: st => st.casoncellata, label: e => "Casoncellata " + String(e.sabato || "").slice(0, 4) },
  { id: "bollino", nome: "Bollino", get: st => st.pagamentiBollino, label: p => `${nomeSocioPerLog(p.socioId)} ${p.anno || ""}`.trim() },
  { id: "convocazioni", nome: "Consiglio (convocazione)", get: st => (st.consiglio || {}).storico, label: c => c.data || "" },
  { id: "gruppoInfo", nome: "Home (dati del Gruppo)", obj: true, get: st => st.gruppoInfo },
  { id: "settings", nome: "Impostazioni", obj: true, get: st => st.settings },
  { id: "consiglio", nome: "Consiglio", obj: true, get: st => Object.assign({}, st.consiglio, { storico: undefined }) },
  { id: "bolliniIniziali", nome: "Bollini iniziali", obj: true, get: st => st.bolliniIniziali, chiave: k => `anno ${k}` },
  { id: "oreAlpine", nome: "Ore Alpine", obj: true, get: st => st.oreAlpine, chiave: k => {
    const i = (state.iniziativeStorico || []).find(x => x.id === k);
    return i ? i.nome : "attività";
  } }
];

let logBaseline = null;
let logComeSistema = false;
function logSnapshotStato() {
  const snap = {};
  LOG_TRACK.forEach(t => {
    const v = t.get(state);
    snap[t.id] = JSON.parse(JSON.stringify(v === undefined ? (t.obj ? {} : []) : v));
  });
  return snap;
}
function logAggiornaBaseline() { try { logBaseline = logSnapshotStato(); } catch (e) { logBaseline = null; } }

// Come JSON.stringify, ma con i campi sempre nello stesso ordine e senza badare ai campi vuoti:
// due schede con gli stessi dati risultano uguali anche se i campi sono in ordine diverso o se uno è
// "mancante" in una e "vuoto" nell'altra (succede quando l'app aggiunge un campo nuovo).
function valoreVuoto(v) { return v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0); }
function jsonStabile(v) {
  return JSON.stringify(valoreVuoto(v) ? null : v, (k, val) => (val && typeof val === "object" && !Array.isArray(val))
    ? Object.keys(val).sort().reduce((o, key) => { if (!valoreVuoto(val[key]) && !(key === "accessoLivello" && val[key] === "socio")) o[key] = val[key]; return o; }, {}) : val);
}

function logCampiCambiati(a, b) {
  const nomi = new Set();
  new Set([...Object.keys(a || {}), ...Object.keys(b || {})]).forEach(k => {
    const dv = v => (k === "accessoLivello" && v === "socio") ? null : v;   // "socio" è il livello di partenza: come non impostato
    if (jsonStabile(dv((a || {})[k])) !== jsonStabile(dv((b || {})[k]))) nomi.add(LOG_CAMPI_NOMI[k] || k);
  });
  const lista = Array.from(nomi);
  return lista.length > 6 ? lista.slice(0, 6).join(", ") + "…" : lista.join(", ");
}

function logCalcolaEventi(prev, curr) {
  const eventi = [];
  LOG_TRACK.forEach(t => {
    const p = prev[t.id], n = curr[t.id];
    if (t.obj) {
      const chiavi = new Set([...Object.keys(p || {}), ...Object.keys(n || {})]);
      const cambiate = Array.from(chiavi).filter(k => jsonStabile((p || {})[k]) !== jsonStabile((n || {})[k]));
      if (!cambiate.length) return;
      const nomiCampi = t.chiave
        ? cambiate.slice(0, 5).map(t.chiave).join(", ")
        : cambiate.slice(0, 6).map(k => LOG_CAMPI_NOMI[k] || k).filter((v, i, arr) => arr.indexOf(v) === i).join(", ");
      eventi.push(`✏️ Modificato ${t.nome} (${nomiCampi}${cambiate.length > 6 ? "…" : ""})`);
      return;
    }
    // Le voci si abbinano per identificativo e, tra quelle con lo stesso identificativo, per posizione:
    // due schede con lo stesso id non si scambiano tra loro.
    const conChiave = arr => { const cont = {}; return (arr || []).map(x => { const k = String(x && x.id); cont[k] = (cont[k] || 0) + 1; return [k + "#" + cont[k], x]; }); };
    const pc = conChiave(p), nc = conChiave(n);
    const pm = new Map(pc), nm = new Map(nc);
    const aggiunti = nc.filter(([k]) => !pm.has(k)).map(([, x]) => x);
    const rimossi = pc.filter(([k]) => !nm.has(k)).map(([, x]) => x);
    const vecchia = new Map();
    const modificati = nc.filter(([k, x]) => pm.has(k) && jsonStabile(pm.get(k)) !== jsonStabile(x)).map(([k, x]) => { vecchia.set(x, pm.get(k)); return x; });
    const gruppo = (lista, icona, verbo, prep, fmt) => {
      if (!lista.length) return;
      if (lista.length > 5) eventi.push(`${icona} ${verbo} ${lista.length} elementi ${prep} ${t.nome}`);
      else lista.forEach(x => eventi.push(fmt(x)));
    };
    gruppo(aggiunti, "➕", "Aggiunti", "in", x => `➕ Aggiunto in ${t.nome}: ${t.label(x) || "(senza nome)"}`);
    gruppo(modificati, "✏️", "Modificati", "in", x => {
      const campi = logCampiCambiati(vecchia.get(x), x);
      return `✏️ Modificato in ${t.nome}: ${t.label(x) || "(senza nome)"}${campi ? " (" + campi + ")" : ""}`;
    });
    gruppo(rimossi, "🗑️", "Eliminati", "da", x => `🗑️ Eliminato da ${t.nome}: ${t.label(x) || "(senza nome)"}`);
  });
  return eventi;
}

function registraModificheNelLog() {
  const corrente = logSnapshotStato();
  if (logBaseline) {
    const eventi = logCalcolaEventi(logBaseline, corrente);
    if (eventi.length) scriviLog(eventi.map(ev => ({ ev })), logComeSistema ? "__sistema__" : undefined);
  }
  logBaseline = corrente;
}

function scriviLog(voci, utenteForzato) {
  if (!voci || !voci.length) return;
  const ora = new Date();
  const uid_ = utenteForzato !== undefined ? utenteForzato : (currentUser || "");
  const nomeUtente = utenteForzato === "__pubblico__" ? "🌐 Link pubblico"
    : utenteForzato === "__sistema__" ? "🤖 Sistema (pulizia automatica)"
    : (uid_ ? userLabel(uid_) : "—");
  const voci2 = voci.map((v, i) => ({ id: uid(), t: ora.toISOString(), s: i, u: uid_, n: v.n || nomeUtente, ev: v.ev }));
  if (window.db && window.firebase && firebase.firestore) {
    const docId = "log_" + ora.getFullYear() + "-" + String(ora.getMonth() + 1).padStart(2, "0");
    db.collection(FIRESTORE_COLLECTION).doc(docId)
      .set({ eventi: firebase.firestore.FieldValue.arrayUnion(...voci2) }, { merge: true })
      .catch(err => console.warn("Log non salvato su Firebase", err));
  } else {
    try {
      const k = "gestione_gruppo_log_locale";
      const arr = JSON.parse(localStorage.getItem(k) || "[]").concat(voci2).slice(-300);
      localStorage.setItem(k, JSON.stringify(arr));
    } catch (e) { /* ignora */ }
  }
}

// Sistema, browser e modalità (app installata o nel browser): niente altro del dispositivo.
function infoDispositivo() {
  const ua = navigator.userAgent || "";
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const sistema = ios ? "iPhone/iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "Mac" : /Linux|X11/.test(ua) ? "Linux" : "sistema sconosciuto";
  const browser = /SamsungBrowser/.test(ua) ? "Samsung Internet" : /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox|FxiOS/.test(ua) ? "Firefox" : /CriOS|Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "browser sconosciuto";
  const installata = (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  return `${sistema}, ${browser}, ${installata ? "app installata" : "nel browser"}`;
}

function logAccesso(nuovoLogin) {
  const kTs = "gestione_gruppo_ultimo_log_accesso";
  const kVer = "gestione_gruppo_ultima_versione";
  const ultimo = parseInt(localStorage.getItem(kTs) || "0", 10);
  const verPrec = localStorage.getItem(kVer);
  localStorage.setItem(kVer, APP_VERSION);
  const info = infoDispositivo();
  // Aggiornamento: la versione è cambiata. Una versione precedente alla 8.01 non salvava il numero,
  // ma lasciava l'orario dell'ultima apertura: da quello si riconosce un telefono già usato.
  if (verPrec ? verPrec !== APP_VERSION : ultimo > 0) {
    scriviLog([{ ev: `🔄 App aggiornata: ${verPrec ? "v" + verPrec : "versione precedente"} → v${APP_VERSION} · ${info}` }]);
  }
  const adesso = Date.now();
  if (!nuovoLogin && adesso - ultimo < 10 * 60 * 1000) return; // evita rumore: max 1 apertura ogni 10 minuti
  localStorage.setItem(kTs, String(adesso));
  scriviLog([{ ev: `${nuovoLogin ? "🔑 Accesso (login)" : "🔑 Apertura app"} · v${APP_VERSION} · ${info}` }]);
}

// Errori imprevisti dell'app: al massimo 3 per apertura, senza ripetizioni, solo il messaggio (nessun dato dei soci).
const ERR_LOG = { n: 0, visti: new Set() };
function registraErrore(msg) {
  try {
    if (!currentUser || navigator.onLine === false) return;
    const testo = String(msg || "errore").replace(/^Uncaught\s+/i, "").replace(/\s+/g, " ").trim().slice(0, 140);
    if (!testo || /^Script error\.?$/i.test(testo) || /ResizeObserver/i.test(testo)) return;
    const chiave = testo + "|" + currentSection;
    if (ERR_LOG.n >= 3 || ERR_LOG.visti.has(chiave)) return;
    ERR_LOG.visti.add(chiave); ERR_LOG.n++;
    scriviLog([{ ev: `⚠️ Errore nell'app (v${APP_VERSION}, sezione ${currentSection || "-"}, ${infoDispositivo()}): ${testo}` }]);
  } catch (e) { /* un errore nel registro degli errori non deve causarne altri */ }
}
window.addEventListener("error", e => registraErrore(e.message || (e.error && e.error.message)));
window.addEventListener("unhandledrejection", e => registraErrore(e.reason && (e.reason.message || e.reason)));

// ---------- Utils ----------
let _uidContatore = 0;
function uid() { return Date.now().toString(36) + (++_uidContatore).toString(36) + Math.random().toString(36).slice(2,7); }
function esc(s) { return (s || "").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function toast(msg) {
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}
function fmtDate(d) {
  if (!d) return "";
  const parts = d.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return d;
}

// ---------- Rendering shell ----------
function updateTopbar() {
  document.getElementById("app-title").textContent = state.settings.appName;
  document.getElementById("app-logo").src = state.settings.logo;
  document.getElementById("app-version").textContent = "v" + APP_VERSION;
  document.getElementById("app-build-date").textContent = APP_CREDIT;
}

function setActiveNav() {
  let sulBar = false;
  document.querySelectorAll(".nav-btn").forEach(b => {
    const on = b.dataset.section === currentSection;
    b.classList.toggle("active", on);
    if (on) sulBar = true;
  });
  const menuBtn = document.getElementById("menu-btn");
  if (menuBtn) menuBtn.classList.toggle("active", !sulBar);
}

function renderSection() {
  setActiveNav();
  segnaSezioneVista();
  aggiornaPallini();
  const content = document.getElementById("app-content");
  if (currentSection === "home") {
    content.innerHTML = renderHome();
    attachHomeEvents();
  } else if (currentSection === "anagrafica") {
    content.innerHTML = renderAnagrafica();
    attachAnagraficaEvents();
  } else if (currentSection === "conv-consiglio") {
    content.innerHTML = renderConvConsiglio();
    attachConvConsiglioEvents();
  } else if (currentSection === "bollino") {
    content.innerHTML = renderBollino();
    attachBollinoEvents();
  } else if (currentSection === "bollino-amici") {
    content.innerHTML = renderBollinoAmici();
    attachBollinoAmiciEvents();
  } else if (currentSection === "ringraziamenti") {
    content.innerHTML = renderRingraziamenti();
    attachRingraziamentiEvents();
  } else if (currentSection === "sponsor") {
    content.innerHTML = renderSponsor();
    attachSponsorEvents();
  } else if (currentSection === "iniziative") {
    content.innerHTML = renderIniziative();
    attachIniziativeEvents();
  } else if (currentSection === "ore-alpine") {
    content.innerHTML = renderOreAlpine();
    attachOreAlpineEvents();
  } else if (currentSection === "report") {
    content.innerHTML = renderReport1();
    attachReport1Events();
  } else if (currentSection === "report2") {
    content.innerHTML = renderReport2();
    attachReport2Events();
  } else if (currentSection === "cena") {
    content.innerHTML = renderCena();
    attachCenaEvents();
  } else if (currentSection === "libretto") {
    content.innerHTML = renderLibretto();
  } else if (currentSection === "bacheca") {
    content.innerHTML = renderBacheca();
    attachBachecaEvents();
  } else if (currentSection === "presenza-adunata") {
    content.innerHTML = renderPresenzaAdunata();
    attachPresenzaAdunataEvents();
  } else if (currentSection === "prenotazioni") {
    content.innerHTML = renderPrenotazioni();
    attachPrenotazioniEvents();
  } else if (currentSection === "canzoni") {
    content.innerHTML = renderCanzoni();
    attachCanzoniEvents();
  } else if (currentSection === "manuali") {
    content.innerHTML = renderManuali();
    attachManualiEvents();
  } else if (currentSection === "conv-casoncellata") {
    content.innerHTML = renderCasoncellata();
    attachCasoncellataEvents();
  } else if (currentSection === "beneficenza") {
    content.innerHTML = renderBeneficenza();
    attachBeneficenzaEvents();
  } else if (currentSection === "archivio-bui") {
    content.innerHTML = puoVedereArchivioBui() ? renderArchivioBui() : `<div class="card-sub">Sezione riservata.</div>`;
    if (puoVedereArchivioBui()) attachArchivioBuiEvents();
  } else if (currentSection === "verbali") {
    content.innerHTML = renderVerbali();
    attachVerbaliEvents();
  } else if (currentSection === "log") {
    content.innerHTML = renderLog();
    attachLogEvents();
  } else {
    const s = PLACEHOLDER_SECTIONS[currentSection];
    content.innerHTML = `
      <div class="section-title">${s.icon} ${s.title}</div>
      <div class="placeholder-box">
        <div class="icon">${s.icon}</div>
        <div><strong>Sezione in costruzione</strong></div>
        <div style="margin-top:6px; font-size:0.85rem;">${esc(s.desc)}</div>
      </div>
    `;
  }
}

// ---------- Anagrafica ----------
function estraiGiornoMese(str) {
  const m = (str || "").match(/(\d{1,2})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{2,4})/);
  if (!m) return null;
  return { giorno: parseInt(m[1], 10), mese: parseInt(m[2], 10) };
}

function puoInviareAuguri() { return currentRole === "admin" || isCapogruppo(); }

function renderNotizieDelGiorno() {
  const oggi = new Date();
  const g = oggi.getDate(), m = oggi.getMonth() + 1;

  const compleanni = state.socios.filter(s => {
    if (s.andatoAvanti) return false;
    const d = estraiGiornoMese(s.dataNascita);
    return d && d.giorno === g && d.mese === m;
  });
  const anniversari = state.socios.filter(s => {
    if (!s.andatoAvanti) return false;
    const d = estraiGiornoMese(s.andatoAvantiData);
    return d && d.giorno === g && d.mese === m;
  });

  if (compleanni.length === 0 && anniversari.length === 0) return "";

  // Il tasto WhatsApp per gli auguri lo vedono solo l'Admin e il Capogruppo: così non partono messaggi doppi o "per conto di altri".
  const puoAuguri = puoInviareAuguri();
  const nomiCompleanni = compleanni.map(s => `
    <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0;">
      <span>${esc(s.cognome)} ${esc(s.nome)}</span>
      ${puoAuguri ? `<button type="button" class="btn" data-wa-auguri="${s.id}" style="background:#25D366; color:#fff; padding:4px 10px; font-size:0.78rem; flex-shrink:0;">${WA_ICON}</button>` : ""}
    </div>`).join("");
  const nomiAnniversari = anniversari.map(s => `${esc(s.cognome)} ${esc(s.nome)}`).join(", ");

  return `
    <div class="card color-green" style="margin-bottom:14px;">
      <div style="font-weight:800; margin-bottom:8px;">📅 Oggi</div>
      ${compleanni.length ? `<div style="padding:2px 0;">🎂 <strong>Compleanno:</strong></div>${nomiCompleanni}` : ""}
      ${anniversari.length ? `<div style="padding:4px 0;">💔 <strong>Anniversario:</strong> ${nomiAnniversari}</div>` : ""}
    </div>
  `;
}

function linkSicuro(u) {
  // toglie i caratteri invisibili che a volte si portano dietro i link copiati dalle app
  let v = String(u || "").replace(/[\u200B-\u200F\u202A-\u202E\u2060\uFEFF\u00A0]/g, " ").trim();
  if (!v) return "";
  if (/^(javascript|data|vbscript):/i.test(v)) return "";
  const m = v.match(/https?:\/\/[^\s<>"']+/i);          // un indirizzo vero dentro al testo
  if (m) v = m[0];
  else {
    const d = v.match(/(?:[\w-]+\.)+[a-z]{2,}(?:\/[^\s<>"']*)?/i);   // oppure uno senza https://
    if (!d) return "";
    v = "https://" + d[0];
  }
  v = v.replace(/[.,;:!?)\]]+$/, "");
  return /^https?:\/\/[^\s\/]+\.[^\s\/]+/i.test(v) ? v : "";
}

const LINK_ANA = "https://www.ana.it";

// Loghi di Instagram e Facebook (forme vettoriali, senza immagini esterne).
const LOGO_INSTAGRAM = '<svg class="logo-social" viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="igSfumato" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FEDA75"/><stop offset=".25" stop-color="#FA7E1E"/><stop offset=".5" stop-color="#D62976"/><stop offset=".75" stop-color="#962FBF"/><stop offset="1" stop-color="#4F5BD5"/></linearGradient></defs><rect width="24" height="24" rx="6.2" fill="url(#igSfumato)"/><rect x="4.6" y="4.6" width="14.8" height="14.8" rx="4.4" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="12" cy="12" r="3.6" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="16.6" cy="7.4" r="1" fill="#fff"/></svg>';
const LOGO_FACEBOOK = '<svg class="logo-social" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1877F2"/><path fill="#fff" d="M16.671 15.469l.532-3.469h-3.328v-2.25c0-.949.465-1.875 1.956-1.875h1.513V4.922s-1.373-.234-2.686-.234c-2.741 0-4.533 1.662-4.533 4.669V12H7.078v3.469h3.047v8.385a12.1 12.1 0 0 0 3.75 0v-8.385h2.796z"/></svg>';

// Tre tasti sulla stessa riga: Instagram, Facebook (se i link sono salvati) e il logo dell'app che porta al sito dell'ANA.
// Sui telefoni stretti il logo sta sopra il nome (vedi .social-riga in styles.css), così le scritte non escono mai dai tasti.
function tastiSocial(g, conTesto) {
  const tasto = (href, icona, nome, titolo) => `<a href="${esc(href)}" target="_blank" rel="noopener" class="btn" title="${esc(titolo)}">${icona}<span>${nome}</span></a>`;
  const tasti = [];
  const ig = linkSicuro(g.instagram), fb = linkSicuro(g.facebook);
  if (ig) tasti.push(tasto(ig, LOGO_INSTAGRAM, "Instagram", "Pagina Instagram del Gruppo"));
  if (fb) tasti.push(tasto(fb, LOGO_FACEBOOK, "Facebook", "Pagina Facebook del Gruppo"));
  tasti.push(tasto(LINK_ANA, '<img class="logo" src="icon-192.png" alt="">', "ANA", "Sito dell'Associazione Nazionale Alpini"));
  // link non riconosciuti: ai soci restano visibili come testo (come nella 7.35); nel modulo c'è l'avviso rosso
  const testo = (icona, nome, raw) => {
    const t = String(raw || "").trim();
    return (conTesto && t && !linkSicuro(raw)) ? `<div class="card-sub" style="margin-bottom:8px;">${icona} ${nome}: ${esc(t)}</div>` : "";
  };
  return `<div class="social-riga">${tasti.join("")}</div>` + testo("📷", "Instagram", g.instagram) + testo("📘", "Facebook", g.facebook);
}

function renderHome() {
  const g = state.gruppoInfo || {};
  const capogruppo = state.socios.find(s => s.carica === "Capogruppo");
  const nomeCapogruppo = capogruppo ? `${capogruppo.cognome} ${capogruppo.nome}` : "Nessun Capogruppo impostato in Anagrafica";
  const soloLettura = currentRole === "socio";

  if (soloLettura) {
    return `
      <div class="section-title">🏠 Home</div>
      ${renderNotizieDelGiorno()}
      <div class="card color-green">
        <div style="font-weight:800; margin-bottom:10px;">Dati del Gruppo</div>
        <div class="form-group"><label>Denominazione</label><div class="card-sub">${esc(g.denominazione) || "-"}</div></div>
        <div class="form-group"><label>Via</label><div class="card-sub">${esc(g.via) || "-"}</div></div>
        <div class="form-group"><label>Città</label><div class="card-sub">${esc(g.citta) || "-"}${g.prov ? " (" + esc(g.prov) + ")" : ""}</div></div>
        <div class="form-group"><label>Capogruppo</label><div class="card-sub">${esc(nomeCapogruppo)}</div></div>
        ${tastiSocial(g, true) ? `
        <div style="font-weight:800; margin:16px 0 10px;">Social</div>
        ${tastiSocial(g, true)}
        ` : ""}
      </div>
    `;
  }

  return `
    <div class="section-title">🏠 Home</div>
    ${renderNotizieDelGiorno()}
    <div class="card color-green">
      <div style="font-weight:800; margin-bottom:10px;">Dati del Gruppo</div>
      <div class="form-group"><label>Denominazione</label><input type="text" id="home-denominazione" value="${esc(g.denominazione)}" placeholder="Es. Gruppo Alpini Bottonaga"></div>
      <div class="form-group"><label>Matricola</label><input type="text" id="home-matricola" value="${esc(g.matricola)}"></div>
      <div class="form-group"><label>Via</label><input type="text" id="home-via" value="${esc(g.via)}"></div>
      <div class="two-col">
        <div class="form-group"><label>Città</label><input type="text" id="home-citta" value="${esc(g.citta)}"></div>
        <div class="form-group"><label>Prov.</label><input type="text" id="home-prov" value="${esc(g.prov)}" maxlength="2" style="text-transform:uppercase"></div>
      </div>
      <div class="form-group"><label>Indirizzo email</label><input type="email" id="home-email" value="${esc(g.email)}"></div>
      <div class="form-group"><label>Codice fiscale</label><input type="text" id="home-cf" value="${esc(g.codiceFiscale)}"></div>
      <div class="form-group">
        <label>Capogruppo</label>
        <div class="card-sub" style="font-size:0.95rem; padding:8px 0;">${esc(nomeCapogruppo)}</div>
        <div style="font-size:0.75rem; color:#888;">Preso automaticamente da Anagrafica (socio con carica "Capogruppo")</div>
      </div>
      <div style="font-weight:800; margin:16px 0 10px;">Social</div>
      ${tastiSocial(g)}
      <div class="form-group"><label>📷 Instagram (link)</label><input type="text" id="home-instagram" value="${esc(g.instagram)}" placeholder="https://instagram.com/...">${g.instagram && !linkSicuro(g.instagram) ? `<div class="card-sub" style="color:#b33; margin-top:4px;">Link non riconosciuto: incolla l'indirizzo completo, che inizia con https://</div>` : ""}</div>
      <div class="form-group"><label>📘 Facebook (link)</label><input type="text" id="home-facebook" value="${esc(g.facebook)}" placeholder="https://facebook.com/...">${g.facebook && !linkSicuro(g.facebook) ? `<div class="card-sub" style="color:#b33; margin-top:4px;">Link non riconosciuto: incolla l'indirizzo completo, che inizia con https://</div>` : ""}</div>
      <button type="button" class="btn block" id="home-save-btn" style="margin-top:6px;">💾 Salva</button>
    </div>
  `;
}

function attachHomeEvents() {
  document.querySelectorAll("[data-wa-auguri]").forEach(btn => {
    btn.addEventListener("click", () => inviaAuguriWhatsapp(btn.dataset.waAuguri));
  });
  const saveBtn = document.getElementById("home-save-btn");
  if (!saveBtn) return; // vista sola lettura (socio): niente altro da agganciare
  saveBtn.addEventListener("click", () => {
    state.gruppoInfo = {
      denominazione: document.getElementById("home-denominazione").value.trim(),
      matricola: document.getElementById("home-matricola").value.trim(),
      via: document.getElementById("home-via").value.trim(),
      citta: document.getElementById("home-citta").value.trim(),
      prov: document.getElementById("home-prov").value.trim().toUpperCase(),
      email: document.getElementById("home-email").value.trim(),
      codiceFiscale: document.getElementById("home-cf").value.trim(),
      instagram: document.getElementById("home-instagram").value.trim(),
      facebook: document.getElementById("home-facebook").value.trim()
    };
    saveState();
    toast("Dati del gruppo salvati");
    renderSection();
  });
}

function pulisciNumeroWhatsapp(numero) {
  let cifre = (numero || "").replace(/\D/g, "");
  if (!cifre) return null;
  if (cifre.startsWith("39")) return cifre;
  if (cifre.startsWith("0039")) return cifre.slice(2);
  return "39" + cifre;
}

function inviaAuguriWhatsapp(socioId) {
  if (!puoInviareAuguri()) return;   // anche forzando la chiamata, solo Admin e Capogruppo
  const s = state.socios.find(x => x.id === socioId);
  if (!s) return;
  const template = state.settings.testoAuguriCompleanno || "Tanti auguri di buon compleanno! 🎂";
  const testo = template.replace(/\{nome\}/gi, `${s.cognome} ${s.nome}`.trim());
  const numero = pulisciNumeroWhatsapp(s.cellulare);
  const url = numero
    ? `https://wa.me/${numero}?text=${encodeURIComponent(testo)}`
    : `https://wa.me/?text=${encodeURIComponent(testo)}`;
  window.open(url, "_blank");
}

function renderAnagrafica() {
  const avviso = avvisoSchedeDoppie();
  return (avviso || "") + renderAnagraficaBase();
}

function renderAnagraficaBase() {
  let list = state.socios.slice();
  if (searchTerm) {
    const q = searchTerm.toLowerCase();
    list = list.filter(s => (s.cognome + " " + s.nome).toLowerCase().includes(q));
  }
  if (filterCarica) list = list.filter(s => s.carica === filterCarica);
  list.sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));

  const cariche_opts = CARICHE.map(c => `<option value="${c}" ${filterCarica===c?"selected":""}>${c}</option>`).join("");

  let cardsHtml;
  if (list.length === 0) {
    cardsHtml = `<div class="empty-state"><div class="icon">👤</div>Nessun socio trovato.</div>`;
  } else {
    cardsHtml = list.map(s => {
      const badges = [];
      if (s.andatoAvanti) {
        if (s.carica) badges.push(`<span class="badge">${esc(s.carica)}</span>`);
      } else {
        if (s.carica) badges.push(`<span class="badge">${esc(s.carica)}</span>`);
        if (state.consiglio.membriIds.includes(s.id)) badges.push(`<span class="badge badge-icon" title="Membro del Consiglio Direttivo" style="background:#dbe9ff; border-color:#8fb4e8;">🏛️</span>`);
        if (s.incaricoFeste) badges.push(`<span class="badge">🎉 ${esc(s.incaricoFeste)}</span>`);
        if (s.sms) badges.push(`<span class="badge badge-icon" title="SMS">📩</span>`);
        if (s.whatsapp) badges.push(`<span class="badge whatsapp badge-icon" title="WhatsApp">${WA_ICON}</span>`);
        if (s.chiaviSede) badges.push(`<span class="badge badge-icon" title="Ha le chiavi della sede">🔑</span>`);
        if (!s.privacy) badges.push(`<span class="badge badge-icon badge-warning" title="Privacy non firmata">🔒❗</span>`);
        if (s.haccp) {
          if (s.haccpFoto) {
            badges.push(`<span class="badge badge-icon" data-view-haccp="${esc(s.haccpFoto)}" title="Certificazione HACCP - attestato caricato, tocca per vederlo" style="background:#d7f0dd; border-color:#7ec98f; cursor:pointer;">📎✅</span>`);
          } else {
            badges.push(`<span class="badge badge-icon badge-warning" title="Certificazione HACCP - attestato NON caricato">📎❗</span>`);
          }
        }
        if (s.alfiere) badges.push(`<span class="badge badge-icon" title="Alfiere">🏅</span>`);
        if (s.email && s.email.trim()) badges.push(`<span class="badge badge-icon" title="Email presente">@</span>`);
        const annoCorrente = new Date().getFullYear();
        const bollinoOk = state.pagamentiBollino.find(r => r.socioId === s.id && r.anno === annoCorrente && r.pagato);
        if (!bollinoOk) badges.push(`<span class="badge badge-icon badge-warning" title="Bollino ${annoCorrente} non pagato">🎫❗</span>`);
      }
      return `
        <div class="card color-green">
          <div class="card-row">
            <div class="card-info-col">
              <div class="card-name">${esc(s.cognome)} ${esc(s.nome)}${s.andatoAvanti ? ` <span title="Andato avanti${s.andatoAvantiData ? " - " + esc(s.andatoAvantiData) : ""}">💔</span>` : ""}</div>
              <div class="card-sub">${esc(s.cellulare || "")}${s.cellulare && s.telefono ? " · " : ""}${esc(s.telefono || "")}${s.dataIscrizione ? " · dal " + fmtDate(s.dataIscrizione) : ""}</div>
            </div>
            <div class="card-actions">
              <button data-edit="${s.id}">✏️</button>
              <button data-del="${s.id}">🗑️</button>
            </div>
          </div>
          <div class="badge-row">${badges.join("")}</div>
          ${chipAggiornatoDalSocio(s)}
        </div>`;
    }).join("");
  }

  return `
    <div class="section-title">👤 Anagrafica <span style="font-size:0.8rem; font-weight:600; color:#666;">(${state.socios.length})</span></div>
    <div class="search-bar">
      <input type="text" id="search-input" placeholder="Cerca per nome..." value="${esc(searchTerm)}">
      <select id="filter-carica">
        <option value="">Tutte le cariche</option>
        ${cariche_opts}
      </select>
    </div>
    <div id="anagrafica-list">${cardsHtml}</div>
    <button class="fab" id="add-socio-btn">+</button>
  `;
}

function attachAnagraficaEvents() {
  document.getElementById("search-input").addEventListener("input", e => {
    searchTerm = e.target.value; renderSection();
    document.getElementById("search-input").focus();
    document.getElementById("search-input").setSelectionRange(searchTerm.length, searchTerm.length);
  });
  document.getElementById("filter-carica").addEventListener("change", e => {
    filterCarica = e.target.value; renderSection();
  });
  document.getElementById("add-socio-btn").addEventListener("click", () => openSocioForm(null));
  document.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => openSocioForm(b.dataset.edit)));
  document.querySelectorAll("[data-del]").forEach(b => b.addEventListener("click", () => deleteSocio(b.dataset.del)));
  document.querySelectorAll("[data-view-haccp]").forEach(b => b.addEventListener("click", e => {
    e.stopPropagation();
    window.open(b.dataset.viewHaccp, "_blank");
  }));
}

function deleteSocio(id) {
  const s = state.socios.find(x => x.id === id);
  if (!s) return;
  if (state.socios.filter(x => x.id === id).length > 1) {
    alert(`La scheda di ${s.cognome} ${s.nome} è doppia (stesso identificativo di un'altra): eliminarla cancellerebbe tutte le copie.\n\n${currentRole === "admin" ? "Usa Impostazioni > Controllo dati per tenerne una sola." : "Avvisa l'Admin: la sistema da Impostazioni > Controllo dati."}`);
    return;
  }
  if (confirm(`Eliminare ${s.cognome} ${s.nome}?`)) {
    state.socios = state.socios.filter(x => x.id !== id);
    saveState();
    renderSection();
    toast("Socio eliminato");
  }
}

function updateVisibilitaSimpatizzante() {
  const carica = document.getElementById("f-carica");
  if (!carica) return;
  const isSimp = carica.value === "Simpatizzante" || carica.value === "Amici";
  document.querySelectorAll(".hide-if-simp").forEach(el => { el.style.display = isSimp ? "none" : ""; });
}

function openSocioForm(id) {
  editingId = id;
  const s = id ? state.socios.find(x => x.id === id) : {
    cognome:"", nome:"", dataNascita:"", luogoNascita:"", provinciaNascita:"", codiceFiscale:"", matricola:"", indirizzo:"", paese:"", provincia:"", cap:"",
    telefono:"", cellulare:"", sms:false, whatsapp:false, chiaviSede:false, privacy:false, haccp:false, haccpDataCorso:"", haccpDataScadenza:"", email:"",
    dataIscrizione:"", carica:"", grado:"", reparto:"", brigataAlpina:"", anniNaja:"", alfiere:false,
    incaricoFeste:"", note:"", andatoAvanti:false, andatoAvantiData:""
  };

  const cariche_opts = CARICHE.map(c => `<option value="${c}" ${s.carica===c?"selected":""}>${c}</option>`).join("");
  const incarichi_opts = INCARICHI_FESTE.map(i => `<option value="${i}" ${s.incaricoFeste===i?"selected":""}>${i || "Nessuno"}</option>`).join("");

  const html = `
    <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:10px; margin-bottom:14px;">
      <div class="modal-title" style="margin-bottom:0;">${id ? "Modifica socio" : "Nuovo socio"}</div>
      <div class="hide-if-simp" style="width:110px; flex-shrink:0;">
        <label style="font-size:0.65rem; font-weight:700; margin-bottom:4px; display:block; color:#444;">Matricola</label>
        <input type="text" id="f-matricola" value="${esc(s.matricola)}" style="width:100%; padding:7px 8px; font-size:0.85rem; border:2px solid var(--ink); border-radius:10px;">
      </div>
    </div>
    <form id="socio-form">
      <div class="two-col">
        <div class="form-group"><label>Cognome *</label><input type="text" id="f-cognome" value="${esc(s.cognome)}" required></div>
        <div class="form-group"><label>Nome *</label><input type="text" id="f-nome" value="${esc(s.nome)}" required></div>
      </div>
      <div class="two-col">
        <div class="form-group" style="flex:0.85;"><label>Data di nascita</label><input type="text" id="f-dataNascita" placeholder="gg-mm-aaaa" value="${esc(s.dataNascita)}"></div>
        <div class="form-group" style="flex:1.3;"><label>Codice fiscale</label><input type="text" id="f-cf" value="${esc(s.codiceFiscale)}" style="text-transform:uppercase"></div>
      </div>
      <div class="two-col hide-if-simp">
        <div class="form-group"><label>Luogo di nascita</label><input type="text" id="f-luogoNascita" value="${esc(s.luogoNascita)}"></div>
        <div class="form-group" style="flex:0.6;"><label>Prov. nascita</label><input type="text" id="f-provinciaNascita" value="${esc(s.provinciaNascita)}" maxlength="2" style="text-transform:uppercase" placeholder="es. I"></div>
      </div>
      <div class="form-group"><label>Residenza - Indirizzo</label><input type="text" id="f-indirizzo" value="${esc(s.indirizzo)}"></div>
      <div class="two-col">
        <div class="form-group" style="flex:1.6;"><label>Paese</label><input type="text" id="f-paese" value="${esc(s.paese)}"></div>
        <div class="form-group" style="flex:0.7;"><label>Provincia</label><input type="text" id="f-provincia" value="${esc(s.provincia)}" maxlength="2" style="text-transform:uppercase" placeholder="es. BS"></div>
        <div class="form-group" style="flex:0.9;"><label>CAP</label><input type="text" id="f-cap" value="${esc(s.cap)}" maxlength="5" inputmode="numeric" placeholder="es. 25100"></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Telefono</label><input type="tel" id="f-telefono" value="${esc(s.telefono)}"></div>
        <div class="form-group"><label>Cellulare</label><input type="tel" id="f-cellulare" value="${esc(s.cellulare)}"></div>
      </div>
      <div class="checkbox-row" style="margin-bottom:10px; gap:26px;">
        <label><input type="checkbox" id="f-sms" ${s.sms?"checked":""}> SMS</label>
        <label><input type="checkbox" id="f-whatsapp" ${s.whatsapp?"checked":""}> WhatsApp</label>
      </div>
      <div class="checkbox-row" style="margin-bottom:14px; gap:26px;">
        <label><input type="checkbox" id="f-chiavi-sede" ${s.chiaviSede?"checked":""}> 🔑 Chiavi sede</label>
        <label class="hide-if-simp"><input type="checkbox" id="f-alfiere" ${s.alfiere?"checked":""}> 🎖️ Alfiere</label>
      </div>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:12px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;"><input type="checkbox" id="f-privacy" ${s.privacy?"checked":""}> 🔒 Privacy</label>
        <div id="privacy-doc-chip">${renderPrivacyChip(s.privacyFoto, s.privacyFotoNome)}</div>
        <div style="margin-left:auto; display:flex; align-items:center; gap:6px;">
          <input type="file" id="f-privacy-foto" accept="image/*,application/pdf" style="display:none;">
          <button type="button" class="btn secondary" id="privacy-doc-btn" style="padding:6px 14px; font-size:0.78rem;">📎 Allega</button>
        </div>
      </div>
      <div style="display:flex; align-items:center; gap:10px; margin-bottom:14px; flex-wrap:wrap;">
        <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;"><input type="checkbox" id="f-haccp" ${s.haccp?"checked":""}> 🍽️ HACCP</label>
        <div id="haccp-doc-chip">${renderPrivacyChip(s.haccpFoto, s.haccpFotoNome)}</div>
        <div style="margin-left:auto; display:flex; align-items:center; gap:6px;">
          <input type="file" id="f-haccp-foto" accept="image/*,application/pdf" style="display:none;">
          <button type="button" class="btn secondary" id="haccp-doc-btn" style="padding:6px 14px; font-size:0.78rem;">📎 Allega</button>
        </div>
      </div>
      <div class="two-col" style="margin-bottom:24px;">
        <div class="form-group"><label style="font-size:0.8rem;">Data corso HACCP</label><input type="text" id="f-haccp-data-corso" placeholder="gg-mm-aaaa" value="${esc(s.haccpDataCorso)}"></div>
        <div class="form-group"><label style="font-size:0.8rem;">Scadenza rinnovo</label><input type="text" id="f-haccp-data-scadenza" placeholder="gg-mm-aaaa" value="${esc(s.haccpDataScadenza)}"></div>
      </div>
      <div class="form-group"><label>Email</label><input type="email" id="f-email" value="${esc(s.email)}"></div>
      <div class="two-col">
        <div class="form-group"><label>Data iscrizione al gruppo</label><input type="text" id="f-dataIscrizione" placeholder="gg-mm-aaaa" value="${esc(s.dataIscrizione)}"></div>
        <div class="form-group"><label>Carica/ruolo</label>
          <select id="f-carica"><option value="">-- nessuna --</option>${cariche_opts}</select>
        </div>
      </div>
      <div class="two-col hide-if-simp">
        <div class="form-group"><label>Anni di naja</label><input type="text" id="f-naja" value="${esc(s.anniNaja)}"></div>
        <div class="form-group"><label>Grado</label><input type="text" id="f-grado" value="${esc(s.grado)}"></div>
      </div>
      <div class="form-group hide-if-simp"><label>Brigata Alpina</label><input type="text" id="f-brigata" value="${esc(s.brigataAlpina)}"></div>
      <div class="form-group hide-if-simp"><label>Reparto</label><input type="text" id="f-reparto" value="${esc(s.reparto)}"></div>
      <div class="two-col" style="margin-bottom:14px;">
        <div class="form-group"><label>Incarico feste</label><select id="f-incarico">${incarichi_opts}</select></div>
        <div class="form-group"><label>Taglia vestiario</label><input type="text" id="f-taglia" list="lista-taglie" value="${esc(s.tagliaVestiario)}" placeholder="Es. L, XL, 52...">
          <datalist id="lista-taglie">${TAGLIE_SUGGERITE.map(t => `<option value="${t}"></option>`).join("")}</datalist></div>
      </div>
      <div class="form-group" style="display:flex; align-items:center; gap:14px;">
        <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;"><input type="checkbox" id="f-andato-avanti" ${s.andatoAvanti ? "checked" : ""}> 💔 Andato avanti</label>
        <div id="f-andato-avanti-data-wrap" style="flex:1; ${s.andatoAvanti ? "" : "display:none;"}">
          <input type="text" id="f-andato-avanti-data" placeholder="Data gg-mm-aaaa" value="${esc(s.andatoAvantiData)}" style="width:100%;">
        </div>
      </div>
      <div class="form-group" id="f-accesso-box" style="border:1px dashed #999; padding:10px; border-radius:8px;${s.carica === "Amici" ? " display:none;" : ""}">
        <label style="font-weight:800;">📲 Accesso all'app</label>
        <label style="display:flex; align-items:center; gap:6px; margin-top:4px;"><input type="checkbox" id="f-accesso-app" ${s.accessoApp ? "checked" : ""}> Abilitato (cognome e nome + password)</label>
        <div class="card-sub" style="margin-top:4px;">${passwordInizialeSocio(s) ? "La prima volta la password è la data di nascita (ggmmaaaa)." : "⚠️ Per poter accedere serve una data di nascita valida con anno a 4 cifre (gg-mm-aaaa)."}</div>
        ${currentRole === "admin" ? `
        <div class="form-group" style="margin-top:8px;"><label>Livello di accesso</label>
          <select id="f-accesso-livello">
            <option value="socio" ${(s.accessoLivello || "socio") === "socio" ? "selected" : ""}>Socio (consultazione)</option>
            <option value="direttivo" ${s.accessoLivello === "direttivo" ? "selected" : ""}>Direttivo</option>
            <option value="admin" ${s.accessoLivello === "admin" ? "selected" : ""}>Admin</option>
          </select>
        </div>
        ${id ? `<button type="button" class="btn secondary" id="f-reset-password" style="font-size:0.82rem;">↺ Reimposta password (torna alla data di nascita)</button>` : ""}` : ""}
      </div>
      <div class="form-group"><label>Note</label><textarea id="f-note">${esc(s.note)}</textarea></div>
      ${id ? `
      <details class="bollino-details">
        <summary>🎫 Storico Bollino</summary>
        ${bollinoStoricoHtml(id)}
      </details>` : ""}
      <div class="modal-actions">
        <button type="button" class="btn secondary" id="cancel-btn">Annulla</button>
        <button type="submit" class="btn">Salva</button>
      </div>
    </form>
  `;
  showModal(html);
  pendingPrivacyFoto = s.privacyFoto || "";
  pendingPrivacyFotoNome = s.privacyFotoNome || "";
  pendingPrivacyFotoFile = null;
  pendingHaccpFoto = s.haccpFoto || "";
  pendingHaccpFotoNome = s.haccpFotoNome || "";
  pendingHaccpFotoFile = null;
  updateVisibilitaSimpatizzante();
  document.getElementById("f-carica").addEventListener("change", updateVisibilitaSimpatizzante);
  document.getElementById("f-carica").addEventListener("change", e => {
    const box = document.getElementById("f-accesso-box");
    if (box) box.style.display = e.target.value === "Amici" ? "none" : "";
  });
  document.getElementById("f-andato-avanti").addEventListener("change", e => {
    document.getElementById("f-andato-avanti-data-wrap").style.display = e.target.checked ? "" : "none";
  });
  const resetPwdBtn = document.getElementById("f-reset-password");
  if (resetPwdBtn) resetPwdBtn.addEventListener("click", async () => {
    const sc = state.socios.find(x => x.id === id);
    if (!sc) return;
    if (!window.db) { alert("Firebase non configurato: impossibile reimpostare la password."); return; }
    if (!confirm(`Reimpostare la password di ${sc.cognome} ${sc.nome}? Da ora dovrà usare di nuovo la data di nascita.`)) return;
    try {
      await reimpostaPasswordSocioDoc(id);
      scriviLog([{ ev: `🔑 Password reimpostata: ${sc.cognome} ${sc.nome}` }]);
      toast("Password reimpostata: torna alla data di nascita");
    } catch (e) {
      console.error(e);
      alert("Non sono riuscito a reimpostare la password: controlla la connessione e riprova.");
    }
  });

  document.getElementById("privacy-doc-btn").addEventListener("click", () => {
    document.getElementById("f-privacy-foto").click();
  });
  document.getElementById("f-privacy-foto").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    pendingPrivacyFotoFile = file;
    pendingPrivacyFotoNome = file.name;
    pendingPrivacyFoto = URL.createObjectURL(file);
    refreshPrivacyChip();
  });
  refreshPrivacyChip();

  document.getElementById("haccp-doc-btn").addEventListener("click", () => {
    document.getElementById("f-haccp-foto").click();
  });
  document.getElementById("f-haccp-foto").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    pendingHaccpFotoFile = file;
    pendingHaccpFotoNome = file.name;
    pendingHaccpFoto = URL.createObjectURL(file);
    refreshHaccpChip();
  });
  refreshHaccpChip();

  document.getElementById("cancel-btn").addEventListener("click", closeModal);
  document.getElementById("socio-form").addEventListener("submit", e => {
    e.preventDefault();
    saveSocio();
  });
}

function refreshPrivacyChip() {
  const container = document.getElementById("privacy-doc-chip");
  container.innerHTML = renderPrivacyChip(pendingPrivacyFoto, pendingPrivacyFotoNome);
  const chip = container.querySelector("[data-view-privacy-doc]");
  if (chip) {
    chip.addEventListener("click", ev => {
      if (ev.target.closest("[data-remove-privacy-doc]")) return;
      if (pendingPrivacyFoto) window.open(pendingPrivacyFoto, "_blank");
    });
  }
  const removeBtn = container.querySelector("[data-remove-privacy-doc]");
  if (removeBtn) {
    removeBtn.addEventListener("click", ev => {
      ev.stopPropagation();
      pendingPrivacyFoto = "";
      pendingPrivacyFotoNome = "";
      pendingPrivacyFotoFile = "REMOVE";
      refreshPrivacyChip();
    });
  }
}

function refreshHaccpChip() {
  const container = document.getElementById("haccp-doc-chip");
  container.innerHTML = renderPrivacyChip(pendingHaccpFoto, pendingHaccpFotoNome);
  const chip = container.querySelector("[data-view-privacy-doc]");
  if (chip) {
    chip.addEventListener("click", ev => {
      if (ev.target.closest("[data-remove-privacy-doc]")) return;
      if (pendingHaccpFoto) window.open(pendingHaccpFoto, "_blank");
    });
  }
  const removeBtn2 = container.querySelector("[data-remove-privacy-doc]");
  if (removeBtn2) {
    removeBtn2.addEventListener("click", ev => {
      ev.stopPropagation();
      pendingHaccpFoto = "";
      pendingHaccpFotoNome = "";
      pendingHaccpFotoFile = "REMOVE";
      refreshHaccpChip();
    });
  }
}

let salvataggioSocioInCorso = false;
async function saveSocio() {
  if (salvataggioSocioInCorso) return;       // un secondo tocco su "Salva" durante il caricamento di un allegato non crea un doppione
  salvataggioSocioInCorso = true;
  try { return await saveSocioInterno(); } finally { salvataggioSocioInCorso = false; }
}

async function saveSocioInterno() {
  const data = {
    cognome: document.getElementById("f-cognome").value.trim(),
    nome: document.getElementById("f-nome").value.trim(),
    dataNascita: document.getElementById("f-dataNascita").value.trim(),
    luogoNascita: document.getElementById("f-luogoNascita").value.trim(),
    provinciaNascita: document.getElementById("f-provinciaNascita").value.trim().toUpperCase(),
    codiceFiscale: document.getElementById("f-cf").value.trim().toUpperCase(),
    matricola: document.getElementById("f-matricola").value.trim(),
    indirizzo: document.getElementById("f-indirizzo").value.trim(),
    paese: document.getElementById("f-paese").value.trim(),
    provincia: document.getElementById("f-provincia").value.trim().toUpperCase(),
    cap: document.getElementById("f-cap").value.trim(),
    telefono: document.getElementById("f-telefono").value.trim(),
    cellulare: document.getElementById("f-cellulare").value.trim(),
    sms: document.getElementById("f-sms").checked,
    whatsapp: document.getElementById("f-whatsapp").checked,
    chiaviSede: document.getElementById("f-chiavi-sede").checked,
    privacy: document.getElementById("f-privacy").checked,
    haccp: document.getElementById("f-haccp").checked,
    haccpDataCorso: document.getElementById("f-haccp-data-corso").value.trim(),
    haccpDataScadenza: document.getElementById("f-haccp-data-scadenza").value.trim(),
    email: document.getElementById("f-email").value.trim(),
    tagliaVestiario: document.getElementById("f-taglia").value.trim(),
    dataIscrizione: document.getElementById("f-dataIscrizione").value.trim(),
    carica: document.getElementById("f-carica").value,
    alfiere: document.getElementById("f-alfiere").checked,
    grado: document.getElementById("f-grado").value.trim(),
    reparto: document.getElementById("f-reparto").value.trim(),
    brigataAlpina: document.getElementById("f-brigata").value.trim(),
    anniNaja: document.getElementById("f-naja").value.trim(),
    incaricoFeste: document.getElementById("f-incarico").value,
    andatoAvanti: document.getElementById("f-andato-avanti").checked,
    andatoAvantiData: document.getElementById("f-andato-avanti-data").value.trim(),
    note: document.getElementById("f-note").value.trim(),
  };
  if (!data.cognome || !data.nome) { alert("Cognome e nome sono obbligatori"); return; }
  const accessoEl = document.getElementById("f-accesso-app");
  if (accessoEl) data.accessoApp = accessoEl.checked;
  const livelloEl = document.getElementById("f-accesso-livello");
  if (livelloEl) data.accessoLivello = livelloEl.value;
  if (data.carica === "Amici") data.accessoApp = false;   // gli Amici non possono usare l'app

  const socioId = editingId || uid();
  const existing = editingId ? state.socios.find(x => x.id === editingId) : null;

  try {
    if (pendingPrivacyFotoFile === "REMOVE") {
      data.privacyFoto = "";
      data.privacyFotoNome = "";
    } else if (pendingPrivacyFotoFile) {
      if (window.storage) {
        toast("Caricamento documento privacy...");
        data.privacyFoto = await uploadDocumento(pendingPrivacyFotoFile, `documenti/privacy/${socioId}`);
      } else {
        data.privacyFoto = pendingPrivacyFoto || "";
      }
      data.privacyFotoNome = pendingPrivacyFotoNome || "";
    } else {
      data.privacyFoto = existing ? (existing.privacyFoto || "") : "";
      data.privacyFotoNome = existing ? (existing.privacyFotoNome || "") : "";
    }

    if (pendingHaccpFotoFile === "REMOVE") {
      data.haccpFoto = "";
      data.haccpFotoNome = "";
    } else if (pendingHaccpFotoFile) {
      if (window.storage) {
        toast("Caricamento certificato HACCP...");
        data.haccpFoto = await uploadDocumento(pendingHaccpFotoFile, `documenti/haccp/${socioId}`);
      } else {
        data.haccpFoto = pendingHaccpFoto || "";
      }
      data.haccpFotoNome = pendingHaccpFotoNome || "";
    } else {
      data.haccpFoto = existing ? (existing.haccpFoto || "") : "";
      data.haccpFotoNome = existing ? (existing.haccpFotoNome || "") : "";
    }
  } catch (err) {
    console.error(err);
    alert("Errore nel caricamento dei documenti su Firebase. Il socio non è stato salvato, riprova.");
    return;
  }

  data.id = socioId;
  if (editingId) {
    const idx = state.socios.findIndex(x => x.id === editingId);
    state.socios[idx] = Object.assign(state.socios[idx], data);
  } else {
    state.socios.push(data);
  }
  saveState();
  closeModal();
  renderSection();
  toast("Socio salvato");
}

function bollinoStoricoHtml(socioId) {
  const recs = state.pagamentiBollino.filter(r => r.socioId === socioId).sort((a,b) => b.anno - a.anno);
  if (recs.length === 0) {
    return `<div class="card-sub">Nessun bollino registrato per questo socio.</div>`;
  }
  const rows = recs.map(r => `
    <tr>
      <td>${r.anno}</td>
      <td>${r.pagato ? "✅" : "❌"}</td>
      <td>${r.pagato && r.importo ? r.importo + "€" : "-"}</td>
      <td>${r.pagato && r.data ? fmtDate(r.data) : "-"}</td>
    </tr>`).join("");
  return `
    <table class="bollino-table">
      <thead><tr><th>Anno</th><th>Pagato</th><th>Importo</th><th>Data</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------- Ringraziamenti ----------
let editingRingraziamentoId = null;

function renderRingraziamenti() {
  const list = state.ringraziamenti.slice().sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));

  let listHtml;
  if (list.length === 0) {
    listHtml = `<div class="empty-state"><div class="icon">🙏</div>Nessun nominativo in elenco.</div>`;
  } else {
    listHtml = list.map(r => {
      const badges = [];
      if (r.cartolina) badges.push(`<span class="badge badge-icon" title="Cartolina">✉️ Cartolina</span>`);
      if (r.casoncelli) badges.push(`<span class="badge badge-icon" title="Casoncelli">🥟 Casoncelli</span>`);
      return `
      <div class="card color-purple">
        <div class="card-row">
          <div>
            <div class="card-name">${esc(r.cognome)} ${esc(r.nome)}</div>
            <div class="card-sub">${[r.indirizzo, r.cap].filter(Boolean).map(esc).join(", ") || "indirizzo non inserito"}</div>
            <div class="card-sub">${esc(r.citta || "")}${r.citta && r.provincia ? " (" + esc(r.provincia) + ")" : (r.provincia ? esc(r.provincia) : "")}</div>
          </div>
          <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
            <div class="badge-row" style="justify-content:flex-end; margin-top:0;">${badges.join("")}</div>
            <div class="card-actions">
              <button data-edit-ringraziamento="${r.id}">✏️</button>
              <button data-del-ringraziamento="${r.id}">🗑️</button>
            </div>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  return `
    <div class="section-title">🙏 Ringraziamenti <span style="font-size:0.8rem; font-weight:600; color:#666;">(${list.length})</span></div>

    <div class="card color-blue">
      <div style="font-weight:800; margin-bottom:10px;">🖨️ Report</div>
      <div class="card-sub" style="margin-bottom:10px;">Vedi l'anteprima di chi ha la spunta corrispondente, poi stampa o invia.</div>
      <div class="modal-actions">
        <button type="button" class="btn secondary" id="anteprima-cartolina-btn">✉️ Report Cartolina</button>
        <button type="button" class="btn secondary" id="anteprima-casoncelli-btn">🥟 Report Casoncelli</button>
      </div>
    </div>

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">Elenco</div>
    ${listHtml}
    <button class="fab" id="add-ringraziamento-btn">+</button>
  `;
}

function openRingraziamentoForm(id) {
  editingRingraziamentoId = id;
  const r = id ? state.ringraziamenti.find(x => x.id === id) : { nome:"", cognome:"", indirizzo:"", citta:"", provincia:"", cap:"", telefono:"", cellulare:"", email:"", cartolina:false, casoncelli:false };
  const html = `
    <div class="modal-title">${id ? "Modifica nominativo" : "Nuovo nominativo"}</div>
    <form id="ringraziamento-form">
      <div class="two-col">
        <div class="form-group"><label>Cognome *</label><input type="text" id="r-cognome" value="${esc(r.cognome)}" required></div>
        <div class="form-group"><label>Nome</label><input type="text" id="r-nome" value="${esc(r.nome)}"></div>
      </div>
      <div class="form-group"><label>Indirizzo</label><input type="text" id="r-indirizzo" value="${esc(r.indirizzo)}"></div>
      <div class="two-col">
        <div class="form-group" style="flex:1.4;"><label>Città</label><input type="text" id="r-citta" value="${esc(r.citta)}"></div>
        <div class="form-group" style="flex:0.6;"><label>Provincia</label><input type="text" id="r-provincia" value="${esc(r.provincia)}" maxlength="2" style="text-transform:uppercase" placeholder="es. BS"></div>
        <div class="form-group" style="flex:0.8;"><label>CAP</label><input type="text" id="r-cap" value="${esc(r.cap)}" maxlength="5" inputmode="numeric" placeholder="es. 25100"></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Telefono</label><input type="tel" id="r-telefono" value="${esc(r.telefono)}"></div>
        <div class="form-group"><label>Cellulare</label><input type="tel" id="r-cellulare" value="${esc(r.cellulare)}"></div>
      </div>
      <div class="form-group"><label>Email</label><input type="email" id="r-email" value="${esc(r.email)}"></div>
      <div class="checkbox-row" style="margin-bottom:14px;">
        <label><input type="checkbox" id="r-cartolina" ${r.cartolina?"checked":""}> ✉️ Cartolina</label>
        <label><input type="checkbox" id="r-casoncelli" ${r.casoncelli?"checked":""}> 🥟 Casoncelli</label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn secondary" id="ringraziamento-cancel-btn">Annulla</button>
        <button type="submit" class="btn">Salva</button>
      </div>
    </form>
  `;
  showModal(html);
  document.getElementById("ringraziamento-cancel-btn").addEventListener("click", closeModal);
  document.getElementById("ringraziamento-form").addEventListener("submit", e => {
    e.preventDefault();
    saveRingraziamento();
  });
}

function saveRingraziamento() {
  const data = {
    cognome: document.getElementById("r-cognome").value.trim(),
    nome: document.getElementById("r-nome").value.trim(),
    indirizzo: document.getElementById("r-indirizzo").value.trim(),
    citta: document.getElementById("r-citta").value.trim(),
    provincia: document.getElementById("r-provincia").value.trim().toUpperCase(),
    cap: document.getElementById("r-cap").value.trim(),
    telefono: document.getElementById("r-telefono").value.trim(),
    cellulare: document.getElementById("r-cellulare").value.trim(),
    email: document.getElementById("r-email").value.trim(),
    cartolina: document.getElementById("r-cartolina").checked,
    casoncelli: document.getElementById("r-casoncelli").checked,
  };
  if (!data.cognome) { alert("Il cognome è obbligatorio"); return; }
  if (editingRingraziamentoId) {
    const idx = state.ringraziamenti.findIndex(x => x.id === editingRingraziamentoId);
    state.ringraziamenti[idx] = Object.assign(state.ringraziamenti[idx], data);
  } else {
    data.id = uid();
    state.ringraziamenti.push(data);
  }
  saveState();
  closeModal();
  renderSection();
  toast("Nominativo salvato");
}

function apriAnteprimaReportRingraziamenti(tipo) {
  const list = state.ringraziamenti.filter(r => r[tipo]).sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));
  if (list.length === 0) {
    alert(`Nessun nominativo con la spunta "${tipo === "cartolina" ? "Cartolina" : "Casoncelli"}".`);
    return;
  }
  const titolo = tipo === "cartolina" ? "Report Cartolina" : "Report Casoncelli";
  const righeHtml = list.map(r => `
    <tr>
      <td style="padding:6px; border-bottom:1px solid #ddd;">${esc(r.cognome)} ${esc(r.nome)}</td>
      <td style="padding:6px; border-bottom:1px solid #ddd;">${[r.indirizzo, r.cap].filter(Boolean).map(esc).join(", ")}</td>
      <td style="padding:6px; border-bottom:1px solid #ddd;">${[r.citta, r.provincia].filter(Boolean).map(esc).join(" ")}</td>
      <td style="padding:6px; border-bottom:1px solid #ddd;">${esc(r.telefono || "")}${r.telefono && r.cellulare ? " / " : ""}${esc(r.cellulare || "")}</td>
    </tr>`).join("");

  const html = `
    <div class="modal-title">🖨️ Anteprima — ${titolo}</div>
    <div class="card-sub" style="margin-bottom:12px;">${list.length} nominativi — generato il ${fmtDateTime(new Date().toISOString())}</div>
    <div style="max-height:50vh; overflow-y:auto; border:2px solid var(--ink); border-radius:10px; margin-bottom:16px;">
      <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
        <thead><tr style="background:#f7f3e8;">
          <th style="text-align:left; padding:6px;">Cognome Nome</th>
          <th style="text-align:left; padding:6px;">Indirizzo</th>
          <th style="text-align:left; padding:6px;">Città</th>
          <th style="text-align:left; padding:6px;">Telefono</th>
        </tr></thead>
        <tbody>${righeHtml}</tbody>
      </table>
    </div>
    <button type="button" class="btn block" id="anteprima-stampa-btn" style="margin-bottom:10px;">🖨️ Stampa</button>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="anteprima-email-btn">✉️ Email</button>
      <button type="button" class="btn" id="anteprima-wa-btn" style="background:#25D366; color:#fff;">${WA_ICON} WhatsApp</button>
    </div>
    <button type="button" class="btn secondary block" id="anteprima-close-btn" style="margin-top:14px;">Chiudi</button>
  `;
  showModal(html);

  document.getElementById("anteprima-stampa-btn").addEventListener("click", () => {
    const area = document.getElementById("print-area");
    area.innerHTML = `
      <h2>${titolo} — ${esc(state.settings.appName)}</h2>
      <p>Generato il ${fmtDateTime(new Date().toISOString())} — ${list.length} nominativi</p>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr>
          <th style="text-align:left; border-bottom:2px solid #000; padding:6px;">Cognome Nome</th>
          <th style="text-align:left; border-bottom:2px solid #000; padding:6px;">Indirizzo</th>
          <th style="text-align:left; border-bottom:2px solid #000; padding:6px;">Città</th>
          <th style="text-align:left; border-bottom:2px solid #000; padding:6px;">Telefono</th>
        </tr></thead>
        <tbody>${righeHtml}</tbody>
      </table>
    `;
    window.print();
  });

  const testoPiano = () => {
    let t = `📋 ${titolo}\n${list.length} nominativi\n\n`;
    list.forEach(r => {
      t += `${r.cognome} ${r.nome} — ${[r.indirizzo, r.cap].filter(Boolean).join(", ")} — ${[r.citta, r.provincia].filter(Boolean).join(" ")}`;
      if (r.telefono || r.cellulare) t += ` — ${r.telefono || r.cellulare}`;
      t += "\n";
    });
    return t;
  };
  document.getElementById("anteprima-email-btn").addEventListener("click", () => {
    const encoded = encodeURIComponent(testoPiano());
    window.location.href = `mailto:?subject=${encodeURIComponent(titolo)}&body=${encoded}`;
  });
  document.getElementById("anteprima-wa-btn").addEventListener("click", () => {
    const encoded = encodeURIComponent(testoPiano());
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  });
  document.getElementById("anteprima-close-btn").addEventListener("click", closeModal);
}

function attachRingraziamentiEvents() {
  document.getElementById("add-ringraziamento-btn").addEventListener("click", () => openRingraziamentoForm(null));
  document.querySelectorAll("[data-edit-ringraziamento]").forEach(el => el.addEventListener("click", () => openRingraziamentoForm(el.dataset.editRingraziamento)));
  document.querySelectorAll("[data-del-ringraziamento]").forEach(el => el.addEventListener("click", () => {
    const r = state.ringraziamenti.find(x => x.id === el.dataset.delRingraziamento);
    if (!r) return;
    if (confirm(`Eliminare ${r.cognome} ${r.nome}?`)) {
      state.ringraziamenti = state.ringraziamenti.filter(x => x.id !== el.dataset.delRingraziamento);
      saveState();
      renderSection();
      toast("Nominativo eliminato");
    }
  }));
  document.getElementById("anteprima-cartolina-btn").addEventListener("click", () => apriAnteprimaReportRingraziamenti("cartolina"));
  document.getElementById("anteprima-casoncelli-btn").addEventListener("click", () => apriAnteprimaReportRingraziamenti("casoncelli"));
}

// ---------- Sponsor / Amici degli Alpini ----------
let editingSponsorId = null;

function renderSponsor() {
  const list = state.sponsor.slice().sort((a,b) => (a.nome||"").localeCompare(b.nome||""));

  let listHtml;
  if (list.length === 0) {
    listHtml = `<div class="empty-state"><div class="icon">💼</div>Nessuno sponsor in elenco.</div>`;
  } else {
    listHtml = list.map(sp => {
      const badges = [];
      if (sp.telefono) badges.push(`<span class="badge badge-icon" title="Telefono">📞</span>`);
      if (sp.whatsapp) badges.push(`<span class="badge whatsapp badge-icon" title="WhatsApp">${WA_ICON}</span>`);
      if (sp.email) badges.push(`<span class="badge badge-icon" title="Email">✉️</span>`);
      return `
      <div class="card color-gold">
        <div class="card-row">
          <div>
            <div class="card-name">${esc(sp.nome)}</div>
            ${sp.telefono ? `<div class="card-sub">📞 ${esc(sp.telefono)}</div>` : ""}
            ${sp.email ? `<div class="card-sub">✉️ ${esc(sp.email)}</div>` : ""}
            <div class="badge-row">${badges.join("")}</div>
          </div>
          <div class="card-actions">
            <button data-edit-sponsor="${sp.id}">✏️</button>
            <button data-del-sponsor="${sp.id}">🗑️</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  return `
    <div class="section-title">💼 Sponsor <span style="font-size:0.8rem; font-weight:600; color:#666;">(${list.length})</span></div>

    <div class="card color-blue">
      <div style="font-weight:800; margin-bottom:10px;">📣 Richiedi supporto per la festa</div>
      <div class="form-group"><label>File / locandina (opzionale)</label><input type="file" id="sponsor-file"></div>
      <div class="form-group"><label>Messaggio</label><textarea id="sponsor-messaggio" placeholder="Es. Buongiorno, come ogni anno organizziamo la nostra festa e chiediamo un aiuto concreto..."></textarea></div>
      <button type="button" class="btn block" id="sponsor-share-btn" style="margin-top:6px;">📤 Condividi (con file, scegli l'app)</button>
      <div class="modal-actions" style="margin-top:12px;">
        <button type="button" class="btn secondary" id="sponsor-sms-btn">📩 SMS</button>
        <button type="button" class="btn" id="sponsor-wa-btn" style="background:#25D366; color:#fff;">${WA_ICON} WhatsApp</button>
      </div>
      <button type="button" class="btn block" id="sponsor-email-btn" style="background:#2c5a7a; color:#fff; margin-top:10px;">✉️ Email</button>
      <div class="card-sub" style="margin-top:10px;">Email va automaticamente a tutti gli sponsor con indirizzo email in elenco. SMS/WhatsApp aprono l'app di messaggistica: scegli tu i destinatari.</div>
    </div>

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">Elenco Sponsor</div>
    ${listHtml}
    <button class="fab" id="add-sponsor-btn">+</button>
  `;
}

function openSponsorForm(id) {
  editingSponsorId = id;
  const sp = id ? state.sponsor.find(x => x.id === id) : { nome:"", telefono:"", cellulare:"", whatsapp:false, email:"", note:"" };
  const html = `
    <div class="modal-title">${id ? "Modifica sponsor" : "Nuovo sponsor"}</div>
    <form id="sponsor-form">
      <div class="form-group"><label>Nome (azienda o referente) *</label><input type="text" id="sp-nome" value="${esc(sp.nome)}" required></div>
      <div class="two-col">
        <div class="form-group"><label>Telefono</label><input type="tel" id="sp-telefono" value="${esc(sp.telefono)}"></div>
        <div class="form-group"><label>Cellulare</label><input type="tel" id="sp-cellulare" value="${esc(sp.cellulare)}"></div>
      </div>
      <div class="checkbox-row" style="margin-bottom:14px;">
        <label><input type="checkbox" id="sp-whatsapp" ${sp.whatsapp?"checked":""}> WhatsApp</label>
      </div>
      <div class="form-group"><label>Email</label><input type="email" id="sp-email" value="${esc(sp.email)}"></div>
      <div class="form-group"><label>Note</label><textarea id="sp-note">${esc(sp.note)}</textarea></div>
      <div class="modal-actions">
        <button type="button" class="btn secondary" id="sponsor-cancel-btn">Annulla</button>
        <button type="submit" class="btn">Salva</button>
      </div>
    </form>
  `;
  showModal(html);
  document.getElementById("sponsor-cancel-btn").addEventListener("click", closeModal);
  document.getElementById("sponsor-form").addEventListener("submit", e => {
    e.preventDefault();
    saveSponsor();
  });
}

function saveSponsor() {
  const data = {
    nome: document.getElementById("sp-nome").value.trim(),
    telefono: document.getElementById("sp-telefono").value.trim(),
    cellulare: document.getElementById("sp-cellulare").value.trim(),
    whatsapp: document.getElementById("sp-whatsapp").checked,
    email: document.getElementById("sp-email").value.trim(),
    note: document.getElementById("sp-note").value.trim(),
  };
  if (!data.nome) { alert("Il nome è obbligatorio"); return; }
  if (editingSponsorId) {
    const idx = state.sponsor.findIndex(x => x.id === editingSponsorId);
    state.sponsor[idx] = Object.assign(state.sponsor[idx], data);
  } else {
    data.id = uid();
    state.sponsor.push(data);
  }
  saveState();
  closeModal();
  renderSection();
  toast("Sponsor salvato");
}

function buildSponsorTesto() {
  const msg = document.getElementById("sponsor-messaggio").value.trim();
  return msg || "Buongiorno, come ogni anno organizziamo la nostra festa e chiediamo un aiuto concreto. Grazie di cuore per il sostegno!";
}

async function condividiSponsor() {
  const testo = buildSponsorTesto();
  const fileInput = document.getElementById("sponsor-file");
  const file = fileInput.files[0];
  const shareData = { title: "Gruppo Alpini", text: testo };
  if (file) shareData.files = [file];
  if (!navigator.share) {
    alert("La condivisione diretta non è supportata su questo dispositivo/browser. Usa i pulsanti SMS, WhatsApp o Email qui sotto.");
    return;
  }
  if (file && navigator.canShare && !navigator.canShare({ files: [file] })) delete shareData.files;
  try {
    await navigator.share(shareData);
    toast("Condiviso");
  } catch (err) {
    if (err.name !== "AbortError") alert("Condivisione non riuscita.");
  }
}

function inviaSponsorTesto(canale) {
  const testo = buildSponsorTesto();
  const encoded = encodeURIComponent(testo);
  if (canale === "email") {
    const emails = state.sponsor.map(s => s.email).filter(e => e && e.trim());
    if (emails.length === 0) { alert("Nessuno sponsor ha un'email in elenco."); return; }
    const subject = encodeURIComponent("Richiesta supporto - Gruppo Alpini");
    window.location.href = `mailto:${emails.join(",")}?subject=${subject}&body=${encoded}`;
  } else if (canale === "sms") {
    window.location.href = `sms:?body=${encoded}`;
  } else {
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  }
  toast(canale === "email" ? "Aperta l'app email" : canale === "whatsapp" ? "Inviato su WhatsApp" : "Inviato via SMS");
}

function attachSponsorEvents() {
  document.getElementById("add-sponsor-btn").addEventListener("click", () => openSponsorForm(null));
  document.querySelectorAll("[data-edit-sponsor]").forEach(el => el.addEventListener("click", () => openSponsorForm(el.dataset.editSponsor)));
  document.querySelectorAll("[data-del-sponsor]").forEach(el => el.addEventListener("click", () => {
    const sp = state.sponsor.find(x => x.id === el.dataset.delSponsor);
    if (!sp) return;
    if (confirm(`Eliminare ${sp.nome}?`)) {
      state.sponsor = state.sponsor.filter(x => x.id !== el.dataset.delSponsor);
      saveState();
      renderSection();
      toast("Sponsor eliminato");
    }
  }));
  document.getElementById("sponsor-share-btn").addEventListener("click", condividiSponsor);
  document.getElementById("sponsor-sms-btn").addEventListener("click", () => inviaSponsorTesto("sms"));
  document.getElementById("sponsor-wa-btn").addEventListener("click", () => inviaSponsorTesto("whatsapp"));
  document.getElementById("sponsor-email-btn").addEventListener("click", () => inviaSponsorTesto("email"));
}

// ---------- Iniziative ----------
function getAllEmails() {
  const emails = [];
  state.socios.forEach(s => { if (s.email && s.email.trim()) emails.push(s.email.trim()); });
  state.ringraziamenti.forEach(r => { if (r.email && r.email.trim()) emails.push(r.email.trim()); });
  state.sponsor.forEach(sp => { if (sp.email && sp.email.trim()) emails.push(sp.email.trim()); });
  return Array.from(new Set(emails));
}

function orarieHOptions() {
  let out = "";
  for (let h = 0; h < 24; h++) {
    const v = String(h).padStart(2, "0");
    out += `<option value="${v}">${v}</option>`;
  }
  return out;
}
function getIniziativaOra() {
  const h = document.getElementById("iniz-ora-h").value;
  const m = document.getElementById("iniz-ora-m").value || "00";
  return h ? `${h}:${m}` : "";
}
function setIniziativaOra(val) {
  const hSel = document.getElementById("iniz-ora-h");
  const mSel = document.getElementById("iniz-ora-m");
  if (!hSel || !mSel) return;
  const parti = (val || "").split(":");
  hSel.value = parti[0] || "";
  const minuti = parseInt(parti[1], 10);
  mSel.value = (!isNaN(minuti) && minuti >= 15 && minuti < 45) ? "30" : "00";
}

function buildIniziativaTesto() {
  const nome = document.getElementById("iniz-nome").value.trim();
  const data = document.getElementById("iniz-data").value;
  const ora = getIniziativaOra();
  const luogo = document.getElementById("iniz-luogo").value.trim();
  const descrizione = document.getElementById("iniz-descrizione").value.trim();
  let testo = `🎉 ${nome || "Attività Gruppo"}\n\n`;
  if (data) testo += `📅 Data: ${fmtDate(data)}\n`;
  if (ora) testo += `🕐 Ora: ${ora}\n`;
  if (luogo) testo += `📍 Luogo: ${luogo}\n`;
  if (descrizione) testo += `\n📝 ${descrizione}`;
  return testo;
}

function renderIniziative() {
  const soloLettura = currentRole === "socio";
  const storico = (state.iniziativeStorico || []).slice().sort((a,b) => (b.data || "").localeCompare(a.data || ""));

  let storicoHtml;
  if (storico.length === 0) {
    storicoHtml = `<div class="card-sub">Nessuna iniziativa salvata.</div>`;
  } else {
    storicoHtml = storico.map(r => {
      const canali = r.canali || [];
      const badgesCanali = canali.map(ch => {
        const label = ch === "whatsapp" ? `${WA_ICON} WhatsApp` : ch === "email" ? "✉️ Email" : ch === "condivisione" ? "📤 Condiviso" : "📩 SMS";
        return soloLettura
          ? `<span class="badge">${label}</span>`
          : `<span class="badge" data-remove-canale="${r.id}|${ch}" style="cursor:pointer;" title="Rimuovi">${label} ✕</span>`;
      }).join("");
      const badgeFile = r.allegatoUrl
        ? (soloLettura
            ? `<span class="badge badge-icon" title="${esc(r.allegatoNome)}">📎</span>`
            : `<span class="badge badge-icon" data-remove-file="${r.id}" style="cursor:pointer;" title="Rimuovi allegato: ${esc(r.allegatoNome)}">📎 ✕</span>`)
        : "";
      const isPdf = (r.allegatoNome || "").toLowerCase().endsWith(".pdf");
      const thumb = r.allegatoThumbUrl || (isPdf ? "" : r.allegatoUrl);
      return `
      <div class="card color-purple" data-open-iniz="${r.id}" style="cursor:pointer;">
        <div class="card-row">
          <div>
            <div class="card-name">${esc(r.nome || "Attività")}</div>
            <div class="card-sub">📅 ${r.data ? fmtDate(r.data) : "Data non indicata"}${r.ora ? " · 🕐 " + esc(r.ora) : ""}</div>
            ${r.luogo ? `<div class="card-sub">📍 ${esc(r.luogo)}</div>` : ""}
            <div class="badge-row" style="margin-top:6px;">${r.istituzionali ? `<span class="badge">🏛️ Istituzionali</span>` : ""}${r.feste ? `<span class="badge">🎉 Feste</span>` : ""}${r.volontariato ? `<span class="badge">🤝 Volontariato</span>` : ""}${badgeFile}${badgesCanali}</div>
          </div>
          ${soloLettura ? "" : `
          <div class="card-actions">
            <button data-edit-iniz="${r.id}" onclick="event.stopPropagation()">✏️</button>
            <button data-del-iniz="${r.id}" onclick="event.stopPropagation()">🗑️</button>
          </div>`}
        </div>
        ${thumb ? `<img src="${esc(thumb)}" style="max-width:100%; border-radius:8px; margin-top:8px; border:1px solid #ccc;">` : ""}
      </div>`;
    }).join("");
  }

  const formNuovaIniziativa = soloLettura ? "" : `
    <div class="card color-purple">
      <div style="font-weight:800; margin-bottom:10px;">Nuova Attività</div>

      <div class="form-group"><label>Nome evento *</label><input type="text" id="iniz-nome" placeholder="Es. Festa di Primavera"></div>
      <div class="two-col">
        <div class="form-group"><label>Data</label><input type="date" id="iniz-data"></div>
        <div class="form-group"><label>Ora</label>
          <div style="display:flex; gap:6px;">
            <select id="iniz-ora-h" style="flex:1;"><option value="">--</option>${orarieHOptions()}</select>
            <select id="iniz-ora-m" style="flex:1;"><option value="00">:00</option><option value="30">:30</option></select>
          </div>
        </div>
      </div>
      <div class="form-group"><label>Luogo</label><input type="text" id="iniz-luogo"></div>
      <div class="form-group">
        <label>Categoria</label>
        <div class="checkbox-row" style="gap:10px; flex-wrap:nowrap;">
          <label style="font-size:0.78rem; white-space:nowrap;"><input type="checkbox" id="iniz-istituzionali" style="width:15px; height:15px;"> Istituz.</label>
          <label style="font-size:0.78rem; white-space:nowrap;"><input type="checkbox" id="iniz-feste" style="width:15px; height:15px;"> Feste</label>
          <label style="font-size:0.78rem; white-space:nowrap;"><input type="checkbox" id="iniz-volontariato" style="width:15px; height:15px;"> Volont.</label>
        </div>
      </div>
      <div class="form-group"><label>Descrizione evento</label><textarea id="iniz-descrizione" placeholder="Dettagli dell'iniziativa..."></textarea></div>
      <div class="form-group">
        <label>Allega file (opzionale)</label>
        <input type="file" id="iniz-file">
      </div>

      <div style="display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px;">
        <button type="button" class="btn secondary" id="iniz-save-btn" style="font-size:0.85rem; padding:9px 6px;">💾 Salva</button>
        <button type="button" class="btn" id="iniz-share-btn" style="font-size:0.85rem; padding:9px 6px;">📤 Condividi</button>
        <button type="button" class="btn" id="iniz-wa-btn" style="background:#25D366; color:#fff; font-size:0.85rem; padding:9px 6px;">${WA_ICON} WhatsApp</button>
        <button type="button" class="btn" id="iniz-email-btn" style="background:#2c5a7a; color:#fff; font-size:0.85rem; padding:9px 6px;">✉️ Email</button>
      </div>
      <div class="card-sub" style="margin-top:10px;">"Condividi", "WhatsApp" ed "Email" salvano subito l'iniziativa e ci attaccano il badge del canale usato, anche se poi annulli l'invio: tienilo a mente se stai solo facendo una prova. "Condividi" apre la scelta app del telefono e include anche il file selezionato. Email va automaticamente a tutti gli indirizzi disponibili tra Anagrafica, Ringraziamenti e Sponsor. WhatsApp apre l'app: scegli tu i destinatari.</div>
    </div>`;

  return `
    <div class="section-title">🎉 Attività</div>

    ${formNuovaIniziativa}

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Elenco Attività</div>
    ${storicoHtml}
  `;
}

async function registraStoricoIniziativa(canale) {
  const nome = document.getElementById("iniz-nome").value.trim();
  const data = document.getElementById("iniz-data").value;
  const ora = getIniziativaOra();
  const luogo = document.getElementById("iniz-luogo").value.trim();
  const descrizione = document.getElementById("iniz-descrizione").value.trim();
  const istituzionali = document.getElementById("iniz-istituzionali").checked;
  const feste = document.getElementById("iniz-feste").checked;
  const volontariato = document.getElementById("iniz-volontariato").checked;
  const fileInput = document.getElementById("iniz-file");
  const file = fileInput.files[0];

  state.iniziativeStorico = state.iniziativeStorico || [];
  let record = currentIniziativaId ? state.iniziativeStorico.find(r => r.id === currentIniziativaId) : null;
  if (!record) {
    record = { id: uid(), nome, data, ora, luogo, descrizione, istituzionali, feste, volontariato, allegatoUrl: "", allegatoNome: "", allegatoThumbUrl: "", canali: [], creato: new Date().toISOString() };
    state.iniziativeStorico.push(record);
    currentIniziativaId = record.id;
  } else {
    record.nome = nome; record.data = data; record.ora = ora; record.luogo = luogo; record.descrizione = descrizione;
    record.istituzionali = istituzionali; record.feste = feste; record.volontariato = volontariato;
  }

  if (file) {
    if (window.storage) {
      try {
        toast("Caricamento allegato...");
        record.allegatoUrl = await uploadDocumento(file, `iniziative/${record.id}`);
        record.allegatoNome = file.name;
        if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
          const miniatura = await generaMiniaturaPdf(file);
          if (miniatura) record.allegatoThumbUrl = await uploadDocumento(miniatura, `iniziative/${record.id}_thumb`);
        } else {
          record.allegatoThumbUrl = record.allegatoUrl;
        }
      } catch (err) {
        console.error(err);
        alert("Errore nel caricamento dell'allegato. L'iniziativa viene comunque salvata senza allegato.");
      }
    } else {
      alert("Firebase non configurato: l'allegato non può essere caricato su questo dispositivo.");
    }
  }

  if (canale && !record.canali.includes(canale)) record.canali.push(canale);
  saveState();
}

async function condividiIniziativa() {
  if (!document.getElementById("iniz-nome").value.trim()) { alert("Inserisci almeno il nome dell'evento"); return; }
  const testo = buildIniziativaTesto();
  const fileInput = document.getElementById("iniz-file");
  const file = fileInput.files[0];
  const shareData = { title: "Attività Gruppo Alpini", text: testo };
  if (file) shareData.files = [file];

  if (!navigator.share) {
    alert("La condivisione diretta non è supportata su questo dispositivo/browser. Usa i pulsanti WhatsApp o Email qui sotto.");
    return;
  }
  if (file && navigator.canShare && !navigator.canShare({ files: [file] })) delete shareData.files;
  try {
    await navigator.share(shareData);
    await registraStoricoIniziativa("condivisione");
    renderSection();
    toast("Condiviso e salvato");
  } catch (err) {
    if (err.name !== "AbortError") alert("Condivisione non riuscita.");
  }
}

async function inviaIniziativaTesto(canale) {
  if (!document.getElementById("iniz-nome").value.trim()) { alert("Inserisci almeno il nome dell'evento"); return; }
  const testo = buildIniziativaTesto();
  const encoded = encodeURIComponent(testo);

  if (canale === "email") {
    const emails = getAllEmails();
    if (emails.length === 0) { alert("Nessun indirizzo email trovato in Anagrafica, Ringraziamenti o Sponsor."); return; }
    const subject = encodeURIComponent(document.getElementById("iniz-nome").value.trim() || "Attività Gruppo Alpini");
    await registraStoricoIniziativa(canale);
    window.location.href = `mailto:${emails.join(",")}?subject=${subject}&body=${encoded}`;
  } else {
    await registraStoricoIniziativa(canale);
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  }
  renderSection();
  toast(canale === "email" ? "Aperta l'app email" : "Inviato su WhatsApp");
}

function caricaIniziativaNelForm(r) {
  currentIniziativaId = r.id;
  document.getElementById("iniz-nome").value = r.nome || "";
  document.getElementById("iniz-data").value = r.data || "";
  setIniziativaOra(r.ora || "");
  document.getElementById("iniz-luogo").value = r.luogo || "";
  document.getElementById("iniz-istituzionali").checked = !!r.istituzionali;
  document.getElementById("iniz-feste").checked = !!r.feste;
  document.getElementById("iniz-volontariato").checked = !!r.volontariato;
  document.getElementById("iniz-descrizione").value = r.descrizione || "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function attachIniziativeEvents() {
  currentIniziativaId = null;
  const saveBtn = document.getElementById("iniz-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", async () => {
    if (!document.getElementById("iniz-nome").value.trim()) { alert("Inserisci almeno il nome dell'evento"); return; }
    await registraStoricoIniziativa(null);
    renderSection();
    toast("Attività salvata");
  });
  const shareBtn = document.getElementById("iniz-share-btn");
  if (shareBtn) shareBtn.addEventListener("click", condividiIniziativa);
  const waBtn = document.getElementById("iniz-wa-btn");
  if (waBtn) waBtn.addEventListener("click", () => inviaIniziativaTesto("whatsapp"));
  const emailBtn = document.getElementById("iniz-email-btn");
  if (emailBtn) emailBtn.addEventListener("click", () => inviaIniziativaTesto("email"));

  document.querySelectorAll("[data-remove-canale]").forEach(el => {
    el.addEventListener("click", e => {
      e.stopPropagation();
      const [id, canale] = el.dataset.removeCanale.split("|");
      const r = (state.iniziativeStorico || []).find(x => x.id === id);
      if (!r) return;
      r.canali = (r.canali || []).filter(c => c !== canale);
      saveState();
      renderSection();
    });
  });

  document.querySelectorAll("[data-remove-file]").forEach(el => {
    el.addEventListener("click", e => {
      e.stopPropagation();
      const id = el.dataset.removeFile;
      const r = (state.iniziativeStorico || []).find(x => x.id === id);
      if (!r) return;
      if (!confirm("Rimuovere l'allegato da questa iniziativa?")) return;
      r.allegatoUrl = ""; r.allegatoNome = ""; r.allegatoThumbUrl = "";
      saveState();
      renderSection();
    });
  });

  document.querySelectorAll("[data-del-iniz]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.delIniz;
      const haOre = state.oreAlpine && state.oreAlpine[id] && Object.keys(state.oreAlpine[id]).length > 0;
      const msg = haOre
        ? "Vuoi veramente cancellare l'iniziativa? Verranno cancellate anche tutte le ore di volontariato registrate per questa iniziativa."
        : "Vuoi veramente cancellare l'iniziativa?";
      if (!confirm(msg)) return;
      state.iniziativeStorico = (state.iniziativeStorico || []).filter(r => r.id !== id);
      if (state.oreAlpine && state.oreAlpine[id]) delete state.oreAlpine[id];
      saveState();
      renderSection();
      toast("Attività eliminata");
    });
  });

  document.querySelectorAll("[data-edit-iniz]").forEach(el => {
    el.addEventListener("click", () => {
      const r = (state.iniziativeStorico || []).find(x => x.id === el.dataset.editIniz);
      if (r) caricaIniziativaNelForm(r);
    });
  });

  document.querySelectorAll("[data-open-iniz]").forEach(el => {
    el.addEventListener("click", () => {
      const r = (state.iniziativeStorico || []).find(x => x.id === el.dataset.openIniz);
      if (!r) return;
      const isPdf = (r.allegatoNome || "").toLowerCase().endsWith(".pdf");
      let allegatoHtml = "";
      if (r.allegatoThumbUrl) {
        allegatoHtml += `<img src="${esc(r.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; margin-top:10px; border:1px solid #ccc;">`;
      }
      if (r.allegatoUrl && isPdf) {
        allegatoHtml += `<a href="${esc(r.allegatoUrl)}" target="_blank" class="btn block" style="margin-top:10px;">📄 Apri ${esc(r.allegatoNome || "PDF")}</a>`;
      }
      const html = `
        <div class="modal-title">🎉 ${esc(r.nome || "Attività")}</div>
        <div class="card-sub" style="margin-bottom:8px;">📅 ${r.data ? fmtDate(r.data) : "Data non indicata"}${r.ora ? " · 🕐 " + esc(r.ora) : ""}</div>
        ${r.luogo ? `<div class="card-sub" style="margin-bottom:8px;">📍 ${esc(r.luogo)}</div>` : ""}
        ${r.descrizione ? `<div class="card-sub" style="white-space:pre-wrap; margin-bottom:12px;">📝 ${esc(r.descrizione)}</div>` : ""}
        ${allegatoHtml}
        <button type="button" class="btn secondary block" id="iniz-detail-close" style="margin-top:16px;">Chiudi</button>
      `;
      showModal(html);
      document.getElementById("iniz-detail-close").addEventListener("click", closeModal);
    });
  });
}

// ---------- Ore Alpine ----------
function renderOreAlpine() {
  const iniziative = (state.iniziativeStorico || []).slice().sort((a,b) => (b.data || "").localeCompare(a.data || ""));

  const totaleGeneraleRaw = Object.values(state.oreAlpine || {}).reduce((sum, map) =>
    sum + Object.values(map).reduce((s, v) => s + (parseFloat(v) || 0), 0), 0);
  const totaleGenerale = Math.round(totaleGeneraleRaw * 10) / 10;

  const oreIniziativa = id => Object.values((state.oreAlpine && state.oreAlpine[id]) || {}).reduce((s, v) => s + (parseFloat(v) || 0), 0);
  const sottoTotali = { istituzionali: 0, feste: 0, volontariato: 0 };
  iniziative.forEach(i => {
    const ore = oreIniziativa(i.id);
    if (i.istituzionali) sottoTotali.istituzionali += ore;
    if (i.feste) sottoTotali.feste += ore;
    if (i.volontariato) sottoTotali.volontariato += ore;
  });
  const r1 = Math.round(sottoTotali.istituzionali * 10) / 10;
  const r2 = Math.round(sottoTotali.feste * 10) / 10;
  const r3 = Math.round(sottoTotali.volontariato * 10) / 10;

  const iniziativaOpts = iniziative.map(i => `<option value="${i.id}" ${selectedOreIniziativaId===i.id?"selected":""}>${esc(i.nome || "Attività")}${i.data ? " - " + fmtDate(i.data) : ""}</option>`).join("");

  let rosterHtml = "";
  if (selectedOreIniziativaId) {
    const map = (state.oreAlpine && state.oreAlpine[selectedOreIniziativaId]) || {};
    const sociosSorted = state.socios.slice().sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));
    if (sociosSorted.length === 0) {
      rosterHtml = `<div class="card-sub">Nessun socio in Anagrafica.</div>`;
    } else {
      rosterHtml = sociosSorted.map(s => `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 0; border-bottom:1px solid #eee;">
          <span style="flex:1;">${esc(s.cognome)} ${esc(s.nome)}</span>
          <input type="number" min="0" step="0.5" data-ore-socio="${s.id}" value="${map[s.id] || ""}" placeholder="0" style="width:70px; padding:6px; border:2px solid var(--ink); border-radius:8px; text-align:center;">
        </div>`).join("");
    }
  }

  let eventiHtml;
  if (iniziative.length === 0) {
    eventiHtml = `<div class="empty-state"><div class="icon">⏱️</div>Nessuna attività salvata.<br><span style="font-size:0.8rem;">Vai nella sezione Attività per crearne una.</span></div>`;
  } else {
    eventiHtml = iniziative.map(i => {
      const map = (state.oreAlpine && state.oreAlpine[i.id]) || {};
      const tot = Math.round(Object.values(map).reduce((s, v) => s + (parseFloat(v) || 0), 0) * 10) / 10;
      return `
      <div class="card color-gold">
        <div class="card-row">
          <div style="cursor:pointer;" data-select-iniziativa="${i.id}">
            <div class="card-name">${esc(i.nome || "Attività")}</div>
            <div class="card-sub">📅 ${i.data ? fmtDate(i.data) : "Data non indicata"}</div>
            <div class="badge-row"><span class="badge">⏱️ ${tot} ore</span></div>
          </div>
          <div class="card-actions">
            <button data-edit-ore="${i.id}">✏️</button>
            <button data-del-ore="${i.id}">🗑️</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  return `
    <div class="section-title">⏱️ Ore Alpine</div>

    <div class="card color-blue" style="display:flex; align-items:center; justify-content:space-between; gap:14px; flex-wrap:wrap;">
      <div>
        <div style="font-weight:700; font-size:0.78rem; color:#555;">Totale ore volontariato</div>
        <div style="font-weight:900; font-size:2rem; line-height:1.15; white-space:nowrap;">${totaleGenerale}</div>
      </div>
      <div style="display:flex; gap:14px; flex-wrap:wrap;">
        <div style="text-align:center;"><div style="font-size:0.68rem; color:#777;">🏛️ Istituz.</div><div style="font-weight:800; font-size:0.95rem;">${r1}</div></div>
        <div style="text-align:center;"><div style="font-size:0.68rem; color:#777;">🎉 Feste</div><div style="font-weight:800; font-size:0.95rem;">${r2}</div></div>
        <div style="text-align:center;"><div style="font-size:0.68rem; color:#777;">🤝 Volont.</div><div style="font-weight:800; font-size:0.95rem;">${r3}</div></div>
      </div>
    </div>

    <div class="card color-gold" style="margin-top:16px;">
      <div style="font-weight:800; margin-bottom:10px;">Registra ore per attività</div>
      <div class="form-group">
        <label>Attività</label>
        <select id="ore-iniziativa-select">
          <option value="">-- seleziona attività --</option>
          ${iniziativaOpts}
        </select>
      </div>
      ${selectedOreIniziativaId ? `
        <div style="margin-top:10px;">${rosterHtml}</div>
        <button class="btn block" id="ore-save-btn" style="margin-top:12px;">Salva ore</button>
      ` : `<div class="card-sub">Seleziona un'attività per inserire le ore lavorate.</div>`}
    </div>

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">Eventi</div>
    ${eventiHtml}
  `;
}

function attachOreAlpineEvents() {
  document.getElementById("ore-iniziativa-select").addEventListener("change", e => {
    selectedOreIniziativaId = e.target.value || null;
    renderSection();
  });

  const saveBtn = document.getElementById("ore-save-btn");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const inputs = document.querySelectorAll("[data-ore-socio]");
    const map = {};
    inputs.forEach(inp => {
      const val = parseFloat(inp.value);
      if (val && val > 0) map[inp.dataset.oreSocio] = val;
    });
    state.oreAlpine = state.oreAlpine || {};
    state.oreAlpine[selectedOreIniziativaId] = map;
    saveState();
    selectedOreIniziativaId = null;
    renderSection();
    toast("Ore salvate");
  });

  document.querySelectorAll("[data-select-iniziativa], [data-edit-ore]").forEach(el => {
    el.addEventListener("click", () => {
      selectedOreIniziativaId = el.dataset.selectIniziativa || el.dataset.editOre;
      renderSection();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });

  document.querySelectorAll("[data-del-ore]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.delOre;
      const i = (state.iniziativeStorico || []).find(x => x.id === id);
      if (!confirm(`Azzerare le ore registrate per "${i ? i.nome : "questo evento"}"?`)) return;
      if (state.oreAlpine) delete state.oreAlpine[id];
      saveState();
      renderSection();
      toast("Ore azzerate");
    });
  });
}

// ---------- Pag. Bollino ----------
function getBollinoRecord(socioId, anno) {
  return state.pagamentiBollino.find(r => r.socioId === socioId && r.anno === anno);
}

function getBolliniIniziali(anno) {
  if (state.bolliniIniziali && state.bolliniIniziali[anno] !== undefined) return state.bolliniIniziali[anno];
  return state.socios.filter(s => { const r = getBollinoRecord(s.id, anno - 1); return r && r.pagato; }).length;
}

function renderBollino() {
  const anni = [];
  for (let y = 2020; y <= 2030; y++) anni.push(y);
  const anniOpts = anni.map(y => `<option value="${y}" ${y===bollinoAnno?"selected":""}>${y}</option>`).join("");

  const sociosSorted = state.socios.filter(s => s.carica !== "Simpatizzante" && s.carica !== "Amici" && !s.andatoAvanti).slice().sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));
  const socioOpts = sociosSorted.map(s => `<option value="${s.id}" ${editingBollinoRecord && editingBollinoRecord.socioId===s.id?"selected":""}>${esc(s.cognome)} ${esc(s.nome)}</option>`).join("");

  const rec = editingBollinoRecord;
  const importoDefault = rec ? rec.importo : state.settings.quotaBollino;
  const pagatoDefault = rec ? rec.pagato : false;
  const dataDefault = rec ? rec.data : "";

  const pagatiCount = sociosSorted.filter(s => { const r = getBollinoRecord(s.id, bollinoAnno); return r && r.pagato; }).length;
  const nonPagati = sociosSorted.filter(s => { const r = getBollinoRecord(s.id, bollinoAnno); return !r || !r.pagato; });
  const bolliniIniziali = getBolliniIniziali(bollinoAnno);
  const residui = bolliniIniziali - pagatiCount;

  let nonPagatiHtml;
  if (nonPagati.length === 0) {
    nonPagatiHtml = `<div class="card-sub">Tutti i soci hanno pagato il bollino ${bollinoAnno}. 🎉</div>`;
  } else {
    nonPagatiHtml = `<div class="badge-row">` + nonPagati.map(s => `<span class="badge" data-open-bollino="${s.id}" style="cursor:pointer;">${esc(s.cognome)} ${esc(s.nome)}</span>`).join("") + `</div>`;
  }

  return `
    <div class="section-title">🎫 Pag. Bollino</div>

    <div class="form-group" style="margin-bottom:10px;">
      <label style="font-size:0.72rem;">Anno</label>
      <select id="bollino-anno-select" style="padding:7px 10px; font-size:0.85rem;">${anniOpts}</select>
    </div>

    <div class="form-group" style="margin-bottom:16px;">
      <label style="font-size:0.72rem;">Bollini iniziali ${bollinoAnno} (rinnovo anno precedente)</label>
      <input type="number" id="bollino-iniziali-input" value="${bolliniIniziali}" min="0" style="padding:7px 10px; font-size:0.85rem;">
    </div>

    <div class="card color-gold">
      <div style="font-weight:800; margin-bottom:10px;">Registra pagamento — ${bollinoAnno}</div>
      <div class="form-group">
        <label>Associato</label>
        <select id="bollino-socio-select">
          <option value="">-- seleziona socio --</option>
          ${socioOpts}
        </select>
      </div>
      <div class="two-col" style="align-items:flex-end;">
        <div class="form-group" style="flex:1.5;"><label>Data pagamento</label><input type="text" id="bollino-data" placeholder="gg/mm/aaaa" value="${esc(dataDefault)}"></div>
        <div class="form-group" style="flex:0.7;"><label>Importo (€)</label><input type="number" id="bollino-importo" value="${esc(importoDefault)}" step="0.5" min="0" max="999"></div>
        <div class="form-group" style="flex:0 0 54px;">
          <label>Pagato</label>
          <input type="checkbox" id="bollino-pagato" ${pagatoDefault?"checked":""} style="width:26px; height:26px; margin-top:4px;">
        </div>
      </div>
      <button class="btn block" id="bollino-save-btn" style="margin-top:8px;">Salva</button>
    </div>

    <div class="card color-blue" style="margin-top:20px; text-align:center;">
      <div style="font-weight:700; font-size:0.8rem; color:#555;">Bollini residui ${bollinoAnno}</div>
      <div style="font-weight:900; font-size:2rem;">${residui}</div>
      <div class="card-sub">su ${bolliniIniziali} iniziali · ${pagatiCount} già consegnati</div>
    </div>

    <div class="card color-red" style="margin-top:14px;">
      <div style="font-weight:800; margin-bottom:8px;">⚠️ Non pagato ${bollinoAnno} <span style="font-weight:600; font-size:0.8rem; color:#666;">(${nonPagati.length}/${sociosSorted.length})</span></div>
      ${nonPagatiHtml}
    </div>
  `;
}

function attachBollinoEvents() {
  document.getElementById("bollino-anno-select").addEventListener("change", e => {
    bollinoAnno = parseInt(e.target.value, 10);
    editingBollinoRecord = null;
    renderSection();
  });

  document.getElementById("bollino-iniziali-input").addEventListener("change", e => {
    const val = parseInt(e.target.value, 10);
    state.bolliniIniziali = state.bolliniIniziali || {};
    state.bolliniIniziali[bollinoAnno] = isNaN(val) ? 0 : val;
    saveState();
    renderSection();
  });

  document.getElementById("bollino-socio-select").addEventListener("change", e => {
    const socioId = e.target.value;
    if (!socioId) { editingBollinoRecord = null; renderSection(); return; }
    const r = getBollinoRecord(socioId, bollinoAnno);
    editingBollinoRecord = r ? Object.assign({}, r) : { socioId, anno: bollinoAnno, pagato: false, data: "", importo: state.settings.quotaBollino };
    renderSection();
  });

  document.getElementById("bollino-save-btn").addEventListener("click", () => {
    const socioId = document.getElementById("bollino-socio-select").value;
    if (!socioId) { alert("Seleziona un associato"); return; }
    const pagato = document.getElementById("bollino-pagato").checked;
    const data = document.getElementById("bollino-data").value;
    const importo = parseFloat(document.getElementById("bollino-importo").value) || 0;

    let r = getBollinoRecord(socioId, bollinoAnno);
    if (r) {
      r.pagato = pagato; r.data = data; r.importo = importo;
    } else {
      state.pagamentiBollino.push({ id: uid(), socioId, anno: bollinoAnno, pagato, data, importo });
    }
    saveState();
    editingBollinoRecord = null;
    renderSection();
    toast("Pagamento salvato");
  });

  document.querySelectorAll("[data-open-bollino]").forEach(el => {
    el.addEventListener("click", () => {
      const socioId = el.dataset.openBollino;
      const r = getBollinoRecord(socioId, bollinoAnno);
      editingBollinoRecord = r ? Object.assign({}, r) : { socioId, anno: bollinoAnno, pagato: false, data: "", importo: state.settings.quotaBollino };
      renderSection();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}

// ---------- Bollino Amici (simpatizzanti) ----------
function renderBollinoAmici() {
  const anni = [];
  for (let y = 2020; y <= 2030; y++) anni.push(y);
  const anniOpts = anni.map(y => `<option value="${y}" ${y===bollinoAmiciAnno?"selected":""}>${y}</option>`).join("");

  const sociosSorted = state.socios.filter(s => s.carica === "Simpatizzante" && !s.andatoAvanti).slice().sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));
  const socioOpts = sociosSorted.map(s => `<option value="${s.id}" ${editingBollinoAmiciRecord && editingBollinoAmiciRecord.socioId===s.id?"selected":""}>${esc(s.cognome)} ${esc(s.nome)}</option>`).join("");

  const rec = editingBollinoAmiciRecord;
  const importoDefault = rec ? rec.importo : state.settings.quotaBollino;
  const pagatoDefault = rec ? rec.pagato : false;
  const dataDefault = rec ? rec.data : "";

  const pagatiCount = sociosSorted.filter(s => { const r = getBollinoRecord(s.id, bollinoAmiciAnno); return r && r.pagato; }).length;
  const nonPagati = sociosSorted.filter(s => { const r = getBollinoRecord(s.id, bollinoAmiciAnno); return !r || !r.pagato; });

  let nonPagatiHtml;
  if (sociosSorted.length === 0) {
    nonPagatiHtml = `<div class="card-sub">Nessun simpatizzante in Anagrafica.</div>`;
  } else if (nonPagati.length === 0) {
    nonPagatiHtml = `<div class="card-sub">Tutti i simpatizzanti hanno pagato il bollino ${bollinoAmiciAnno}. 🎉</div>`;
  } else {
    nonPagatiHtml = `<div class="badge-row">` + nonPagati.map(s => `<span class="badge" data-open-bollino-amici="${s.id}" style="cursor:pointer;">${esc(s.cognome)} ${esc(s.nome)}</span>`).join("") + `</div>`;
  }

  return `
    <div class="section-title">🤝 Bollino Amici</div>

    <div class="form-group" style="margin-bottom:10px;">
      <label style="font-size:0.72rem;">Anno</label>
      <select id="bollino-amici-anno-select" style="padding:7px 10px; font-size:0.85rem;">${anniOpts}</select>
    </div>

    <div class="card color-gold">
      <div style="font-weight:800; margin-bottom:10px;">Registra pagamento — ${bollinoAmiciAnno}</div>
      <div class="form-group">
        <label>Simpatizzante</label>
        <select id="bollino-amici-socio-select">
          <option value="">-- seleziona simpatizzante --</option>
          ${socioOpts}
        </select>
      </div>
      <div class="two-col" style="align-items:flex-end;">
        <div class="form-group" style="flex:1.5;"><label>Data pagamento</label><input type="text" id="bollino-amici-data" placeholder="gg/mm/aaaa" value="${esc(dataDefault)}"></div>
        <div class="form-group" style="flex:0.7;"><label>Importo (€)</label><input type="number" id="bollino-amici-importo" value="${esc(importoDefault)}" step="0.5" min="0" max="999"></div>
        <div class="form-group" style="flex:0 0 54px;">
          <label>Pagato</label>
          <input type="checkbox" id="bollino-amici-pagato" ${pagatoDefault?"checked":""} style="width:26px; height:26px; margin-top:4px;">
        </div>
      </div>
      <button class="btn block" id="bollino-amici-save-btn" style="margin-top:8px;">Salva</button>
    </div>

    <div class="card color-red" style="margin-top:20px;">
      <div style="font-weight:800; margin-bottom:8px;">⚠️ Non pagato ${bollinoAmiciAnno} <span style="font-weight:600; font-size:0.8rem; color:#666;">(${nonPagati.length}/${sociosSorted.length})</span></div>
      ${nonPagatiHtml}
    </div>
  `;
}

function attachBollinoAmiciEvents() {
  document.getElementById("bollino-amici-anno-select").addEventListener("change", e => {
    bollinoAmiciAnno = parseInt(e.target.value, 10);
    editingBollinoAmiciRecord = null;
    renderSection();
  });

  document.getElementById("bollino-amici-socio-select").addEventListener("change", e => {
    const socioId = e.target.value;
    if (!socioId) { editingBollinoAmiciRecord = null; renderSection(); return; }
    const r = getBollinoRecord(socioId, bollinoAmiciAnno);
    editingBollinoAmiciRecord = r ? Object.assign({}, r) : { socioId, anno: bollinoAmiciAnno, pagato: false, data: "", importo: state.settings.quotaBollino };
    renderSection();
  });

  document.getElementById("bollino-amici-save-btn").addEventListener("click", () => {
    const socioId = document.getElementById("bollino-amici-socio-select").value;
    if (!socioId) { alert("Seleziona un simpatizzante"); return; }
    const pagato = document.getElementById("bollino-amici-pagato").checked;
    const data = document.getElementById("bollino-amici-data").value;
    const importo = parseFloat(document.getElementById("bollino-amici-importo").value) || 0;

    let r = getBollinoRecord(socioId, bollinoAmiciAnno);
    if (r) {
      r.pagato = pagato; r.data = data; r.importo = importo;
    } else {
      state.pagamentiBollino.push({ id: uid(), socioId, anno: bollinoAmiciAnno, pagato, data, importo });
    }
    saveState();
    editingBollinoAmiciRecord = null;
    renderSection();
    toast("Pagamento salvato");
  });

  document.querySelectorAll("[data-open-bollino-amici]").forEach(el => {
    el.addEventListener("click", () => {
      const socioId = el.dataset.openBollinoAmici;
      const r = getBollinoRecord(socioId, bollinoAmiciAnno);
      editingBollinoAmiciRecord = r ? Object.assign({}, r) : { socioId, anno: bollinoAmiciAnno, pagato: false, data: "", importo: state.settings.quotaBollino };
      renderSection();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  });
}
// ---------- Conv. Consiglio ----------
function mandatoScadenza(dataInizio) {
  if (!dataInizio) return "";
  const d = new Date(dataInizio);
  if (isNaN(d)) return "";
  d.setFullYear(d.getFullYear() + 4);
  return d.toISOString().slice(0,10);
}

function renderConvConsiglio() {
  const membri = state.socios.filter(s => state.consiglio.membriIds.includes(s.id))
    .sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));
  const disponibili = state.socios.filter(s => !state.consiglio.membriIds.includes(s.id))
    .sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));

  const opts = disponibili.map(s => `<option value="${s.id}">${esc(s.cognome)} ${esc(s.nome)}</option>`).join("");

  let membriHtml;
  if (membri.length === 0) {
    membriHtml = `<div class="card-sub">Nessun componente selezionato.</div>`;
  } else {
    membriHtml = `<div class="badge-row">` + membri.map(s => `
      <span class="badge" style="font-size:0.66rem; padding:3px 7px;">${esc(s.cognome)} ${esc(s.nome)} <span data-remove-consiglio="${s.id}" style="cursor:pointer; font-weight:900; margin-left:3px;">✕</span></span>
    `).join("") + `</div>`;
  }

  const storico = (state.consiglio.storico || []).slice().sort((a,b) => (b.data || "").localeCompare(a.data || ""));

  let storicoHtml;
  if (storico.length === 0) {
    storicoHtml = `<div class="card-sub">Nessuna convocazione inviata finora.</div>`;
  } else {
    storicoHtml = storico.map(c => {
      const canali = c.canali || (c.canale ? [c.canale] : []);
      const badgesCanali = canali.map(ch => ch === "whatsapp" ? `<span class="badge">${WA_ICON} WhatsApp</span>` : ch === "email" ? `<span class="badge">✉️ Email</span>` : `<span class="badge">📩 SMS</span>`).join("");
      return `
      <div class="card color-purple" data-open-storico="${c.id}" style="cursor:pointer;">
        <div class="card-row">
          <div>
            <div class="card-name">📅 ${c.data ? fmtDate(c.data) : "Data non indicata"}${c.ora ? " · 🕐 " + esc(c.ora) : ""}</div>
            <div class="badge-row" style="margin-top:6px;">${badgesCanali}</div>
          </div>
          <div class="card-actions"><button data-del-storico="${c.id}">🗑️</button></div>
        </div>
      </div>
    `;
    }).join("");
  }

  return `
    <div class="section-title">📋 Consiglio</div>

    <div class="card color-blue">
      <div style="font-weight:800; margin-bottom:10px;">Consiglio Direttivo in carica</div>

      <div style="font-weight:700; font-size:0.85rem; margin:0 0 4px 0;">Aggiungi un socio al consiglio:</div>
      <div style="display:flex; gap:8px;">
        <select id="add-consiglio-select" style="flex:1; min-width:0; padding:10px; border:2px solid var(--ink); border-radius:10px;">
          <option value="">-- seleziona socio --</option>
          ${opts}
        </select>
        <button class="btn" id="add-consiglio-btn" style="padding:10px 14px;">+</button>
      </div>

      <div style="font-weight:700; font-size:0.85rem; margin:16px 0 6px 0;">Componenti attuali (${membri.length}):</div>
      ${membriHtml}
    </div>

    <button class="btn block" id="apri-convocazione-btn" style="margin-top:6px;">📣 Convoca il Consiglio</button>

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Cronistoria convocazioni</div>
    ${storicoHtml}
  `;
}

function attachConvConsiglioEvents() {
  const addBtn = document.getElementById("add-consiglio-btn");
  if (addBtn) addBtn.addEventListener("click", () => {
    const sel = document.getElementById("add-consiglio-select");
    if (!sel.value) return;
    state.consiglio.membriIds.push(sel.value);
    saveState();
    renderSection();
    toast("Aggiunto al consiglio");
  });

  document.querySelectorAll("[data-remove-consiglio]").forEach(el => {
    el.addEventListener("click", () => {
      const id = el.dataset.removeConsiglio;
      state.consiglio.membriIds = state.consiglio.membriIds.filter(x => x !== id);
      saveState();
      renderSection();
      toast("Rimosso dal consiglio");
    });
  });

  const convBtn = document.getElementById("apri-convocazione-btn");
  if (convBtn) convBtn.addEventListener("click", openConvocazioneForm);

  document.querySelectorAll("[data-del-storico]").forEach(el => {
    el.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (!confirm("Eliminare questa convocazione dalla cronistoria?")) return;
      state.consiglio.storico = (state.consiglio.storico || []).filter(c => c.id !== el.dataset.delStorico);
      saveState();
      renderSection();
    });
  });

  document.querySelectorAll("[data-open-storico]").forEach(el => {
    el.addEventListener("click", () => openStoricoDetail(el.dataset.openStorico));
  });
}

function openStoricoDetail(id) {
  const c = (state.consiglio.storico || []).find(x => x.id === id);
  if (!c) return;
  const canali = c.canali || (c.canale ? [c.canale] : []);
  const badgesCanali = canali.map(ch => ch === "whatsapp" ? `<span class="badge">${WA_ICON} WhatsApp</span>` : ch === "email" ? `<span class="badge">✉️ Email</span>` : `<span class="badge">📩 SMS</span>`).join("");
  const html = `
    <div class="modal-title">📣 Consiglio Direttivo</div>
    <div class="card-name" style="margin-bottom:10px;">📅 ${c.data ? fmtDate(c.data) : "Data non indicata"}${c.ora ? " · 🕐 " + esc(c.ora) : ""}</div>
    ${c.luogo ? `<div class="card-sub" style="margin-bottom:8px;">📍 ${esc(c.luogo)}</div>` : ""}
    ${c.odg ? `<div class="card-sub" style="white-space:pre-wrap; margin-bottom:12px;">📋 ${esc(c.odg)}</div>` : ""}
    <div class="badge-row" style="margin-bottom:16px;">${badgesCanali}</div>
    <button type="button" class="btn secondary block" id="storico-close-btn">Chiudi</button>
  `;
  showModal(html);
  document.getElementById("storico-close-btn").addEventListener("click", closeModal);
}

let currentConvocazioneId = null;

function openConvocazioneForm() {
  currentConvocazioneId = null;
  const membri = state.socios.filter(s => state.consiglio.membriIds.includes(s.id));
  if (membri.length === 0) {
    alert("Aggiungi prima almeno un componente al consiglio.");
    return;
  }
  const html = `
    <div class="modal-title">📣 Convoca il Consiglio</div>
    <div class="card-sub" style="margin-bottom:12px;">Destinatari: ${membri.map(s => esc(s.cognome + " " + s.nome)).join(", ")}</div>
    <div class="two-col">
      <div class="form-group"><label>Data</label><input type="date" id="cv-data"></div>
      <div class="form-group"><label>Ora</label><input type="time" id="cv-ora"></div>
    </div>
    <div class="form-group"><label>Luogo</label><input type="text" id="cv-luogo" placeholder="es. Sede del gruppo"></div>
    <div class="form-group"><label>Ordine del giorno</label><textarea id="cv-odg" placeholder="1) ...&#10;2) ..." style="min-height:100px;"></textarea></div>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="cv-sms-btn">📩 Invia SMS</button>
      <button type="button" class="btn" id="cv-wa-btn" style="background:#25D366; color:#fff;">${WA_ICON} WhatsApp</button>
    </div>
    <button type="button" class="btn block" id="cv-email-btn" style="background:#2c5a7a; color:#fff; margin-top:10px;">✉️ Invia Email</button>
    <div class="card-sub" style="margin-top:10px;" id="cv-hint">SMS e WhatsApp aprono l'app di messaggistica: scegli tu i destinatari tra i componenti del consiglio. L'email invece va già ai soci del consiglio che hanno un indirizzo email in anagrafica. Puoi usare più canali per la stessa convocazione.</div>
    <button type="button" class="btn secondary block" id="cv-close-btn" style="margin-top:14px;">Chiudi</button>
  `;
  showModal(html);
  document.getElementById("cv-close-btn").addEventListener("click", () => { currentConvocazioneId = null; closeModal(); renderSection(); });
  document.getElementById("cv-sms-btn").addEventListener("click", () => inviaConvocazione("sms"));
  document.getElementById("cv-wa-btn").addEventListener("click", () => inviaConvocazione("whatsapp"));
  document.getElementById("cv-email-btn").addEventListener("click", () => inviaConvocazione("email"));
}

function inviaConvocazione(canale) {
  const data = document.getElementById("cv-data").value;
  const ora = document.getElementById("cv-ora").value;
  const luogo = document.getElementById("cv-luogo").value.trim();
  const odg = document.getElementById("cv-odg").value.trim();

  let testo = "📣 Consiglio Direttivo\n\n";
  if (data) testo += `📅 Data: ${fmtDate(data)}\n`;
  if (ora) testo += `🕐 Ora: ${ora}\n`;
  if (luogo) testo += `📍 Luogo: ${luogo}\n`;
  if (odg) testo += `\n📋 Ordine del giorno:\n${odg}`;

  const encoded = encodeURIComponent(testo);

  if (canale === "email") {
    const membri = state.socios.filter(s => state.consiglio.membriIds.includes(s.id));
    const emails = membri.map(s => s.email).filter(e => e && e.trim());
    if (emails.length === 0) {
      alert("Nessun componente del consiglio ha un'email in anagrafica.");
      return;
    }
    const subject = encodeURIComponent("Convocazione Consiglio Direttivo" + (data ? " - " + fmtDate(data) : ""));
    registraStorico(canale, data, ora, luogo, odg);
    window.location.href = `mailto:${emails.join(",")}?subject=${subject}&body=${encoded}`;
    toast("Aperta l'app email");
    return;
  }

  registraStorico(canale, data, ora, luogo, odg);
  if (canale === "sms") {
    window.location.href = `sms:?body=${encoded}`;
  } else {
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  }
  toast(canale === "whatsapp" ? "Inviato su WhatsApp" : "Inviato via SMS");
}

function registraStorico(canale, data, ora, luogo, odg) {
  state.consiglio.storico = state.consiglio.storico || [];
  let record = currentConvocazioneId ? state.consiglio.storico.find(c => c.id === currentConvocazioneId) : null;
  if (!record) {
    record = { id: uid(), data, ora, luogo, odg, canali: [], creato: new Date().toISOString() };
    state.consiglio.storico.push(record);
    currentConvocazioneId = record.id;
  }
  if (!record.canali.includes(canale)) record.canali.push(canale);
  saveState();
}

// ---------- Modal ----------
function showModal(html) {
  document.getElementById("modal-box").innerHTML = html;
  document.getElementById("modal-overlay").classList.remove("hidden");
}
function closeModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  editingId = null;
}

// ---------- Settings ----------
function fmtDateTime(iso) {
  if (!iso) return "mai";
  const d = new Date(iso);
  if (isNaN(d)) return "mai";
  const pad = n => n.toString().padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openSettings() {
  const ridotto = currentRole === "direttivo";
  const sociAttivi = (state.socios || []).filter(socioIdoneoApp);
  const nAbilitati = sociAttivi.filter(s => s.accessoApp).length;
  const nIdonei = sociAttivi.filter(s => passwordInizialeSocio(s)).length;
  const nDoppie = schedeDoppie().length;
  const nSenzaData = sociAttivi.length - nIdonei;
  const bloccoGestioneUtenti = ridotto ? "" : `
    <div class="settings-block">
      <h3>🔑 Gestione utenti</h3>
      <div style="font-size:0.78rem; color:#666; margin-bottom:10px;">Ogni utente può avere una password (lasciala vuota per entrare senza password, come oggi). <b>Admin</b>: accesso completo, incluse Impostazioni avanzate (Gestione utenti, Backup/Ripristino, Zona pericolosa). <b>Direttivo</b>: accesso completo a tutte le sezioni operative, ma Impostazioni ridotte (senza Gestione utenti, Backup/Ripristino, Zona pericolosa). <b>Socio</b>: vede solo Home, Bacheca, Preghiera e Canto, Cena, Presenza Adunata, Attività, Panettoni &amp; C (prenotazione dei prodotti), Casoncellata (disponibilità), Manuali (solo quello dei Soci), Verbali Consiglio (solo consultazione) e Prenotaz. Sede (quest'ultima con modulo, avviso, calendario e richieste in sola visualizzazione, senza poter confermare) — usalo per una password unica da dare a tutti i soci.</div>
      <div id="utenti-lista">
        ${(state.settings.utenti || []).map((u, idx) => `
          <div class="card" data-utente-idx="${idx}" style="padding:10px; margin-bottom:8px;">
            <div class="two-col">
              <div class="form-group"><label>Nome</label><input type="text" class="ut-label" value="${esc(u.label)}"></div>
              <div class="form-group"><label>Ruolo</label>
                <select class="ut-ruolo">
                  <option value="admin" ${u.ruolo === "admin" ? "selected" : ""}>Admin (accesso completo + impostazioni avanzate)</option>
                  <option value="direttivo" ${u.ruolo === "direttivo" ? "selected" : ""}>Direttivo (accesso completo, impostazioni ridotte)</option>
                  <option value="socio" ${u.ruolo === "socio" ? "selected" : ""}>Socio (accesso limitato)</option>
                </select>
              </div>
            </div>
            <div class="form-group"><label>Password</label><input type="text" class="ut-password" value="${esc(u.password)}" placeholder="vuota = nessuna password"></div>
            <button type="button" class="btn danger" data-elimina-utente="${idx}" style="padding:4px 10px; font-size:0.78rem; margin-top:4px;">🗑️ Rimuovi utente</button>
          </div>
        `).join("")}
      </div>
      <button type="button" class="btn secondary block" id="aggiungi-utente-btn" style="margin-top:4px;">➕ Aggiungi utente</button>
    </div>

    <div class="settings-block">
      <h3>🔎 Controllo dati</h3>
      <div class="card-sub" style="margin-bottom:8px;">Cerca le schede dei soci doppie (stesso identificativo): fanno comparire falsi "Modificato" nel Log e rendono pericolosa l'eliminazione di una scheda.</div>
      ${nDoppie ? `<div class="card-sub" style="color:#b33; font-weight:700; margin-bottom:8px;">⚠️ Trovati ${nDoppie} gruppi di schede doppie</div>` : `<div class="card-sub" style="color:#1a6b3c; margin-bottom:8px;">Nessuna scheda doppia trovata.</div>`}
      <button type="button" class="btn block" id="controllo-dati-btn">🔎 Apri il controllo dati</button>
    </div>

    <div class="settings-block">
      <h3>📲 Accesso soci con nome e password</h3>
      <div class="card-sub" style="margin-bottom:8px;">Soci attivi (esclusi gli Amici): <strong>${sociAttivi.length}</strong> · abilitati all'accesso: <strong>${nAbilitati}</strong> · con data di nascita valida: <strong>${nIdonei}</strong> · senza data valida: <strong>${nSenzaData}</strong></div>
      <div style="font-size:0.78rem; color:#666; margin-bottom:8px;">La prima volta la password è la data di nascita (ggmmaaaa); poi il socio la cambia da Menù → Cambia password. Chi ha dimenticato la password si reimposta dalla sua scheda in Anagrafica.</div>
      <button type="button" class="btn block" id="accesso-abilita-tutti-btn" style="margin-bottom:6px;">✅ Abilita tutti i soci con data di nascita valida</button>
      <button type="button" class="btn secondary block" id="accesso-senza-data-btn" style="margin-bottom:6px;">📋 Elenca i soci senza data di nascita valida</button>
      <button type="button" class="btn danger block" id="accesso-disabilita-tutti-btn">⛔ Disabilita l'accesso a tutti</button>
    </div>

    <div class="settings-block">
      <h3>📄 Modulo Prenotazione Sede (da firmare)</h3>
      ${state.settings.moduloSedeUrl
        ? `<div class="card-sub" style="margin-bottom:8px;">File attuale: <a href="${esc(state.settings.moduloSedeUrl)}" target="_blank"><strong>${esc(state.settings.moduloSedeNome || "modulo.pdf")}</strong></a> <button type="button" class="btn danger" id="rimuovi-modulo-sede-btn" style="padding:3px 8px; font-size:0.75rem; margin-left:6px;">🗑️ Rimuovi</button></div>`
        : `<div class="card-sub" style="margin-bottom:8px;">Nessun modulo caricato.</div>`}
      <div class="form-group"><label>Carica/sostituisci file (PDF)</label><input type="file" id="set-modulo-sede-file" accept=".pdf"></div>
      <div style="font-size:0.78rem; color:#666;">Chi prenota potrà scaricarlo, stamparlo, firmarlo e restituirlo controfirmato secondo le modalità del Gruppo.</div>
    </div>`;

  const html = `
    <div class="modal-title">⚙️ Impostazioni</div>

    <div class="settings-block">
      <h3>Info dispositivo</h3>
      <div class="card-sub">Connesso come: <strong>${esc(userLabel(currentUser))}</strong> <button type="button" id="change-user-btn" class="btn secondary" style="padding:2px 10px; font-size:0.75rem; margin-left:6px;">Cambia</button></div>
      <div class="card-sub">Ultima modifica: <strong>${esc(userLabel(state.meta && state.meta.ultimaModificaDa))}</strong> il <strong>${fmtDateTime(state.meta && state.meta.ultimaModifica)}</strong></div>
      <div class="card-sub">Ultimo backup importato: <strong>${fmtDateTime(state.meta && state.meta.ultimoImport)}</strong></div>
      <div class="card-sub" style="color:${window.db ? "#1a6b3c" : "#b33"};">${window.db ? "☁️ Sincronizzazione Firebase attiva" : "⚠️ Firebase non configurato (dati solo su questo dispositivo)"}</div>
      <div class="card-sub">Dimensione dei dati: <strong>${Math.round(JSON.stringify(state).length / 1024)} KB</strong> su 1.024 KB (limite di Firebase)</div>
      <div class="card-sub">Ultimo salvataggio online: <strong>${SYNC_STATO.ok === null ? "nessuno in questa sessione" : (SYNC_STATO.ok ? "riuscito alle " : "NON riuscito (" + esc(SYNC_STATO.errore) + ") alle ") + (SYNC_STATO.quando ? new Date(SYNC_STATO.quando).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) : "")}</strong></div>
      <div class="card-sub">Ultimi dati ricevuti: <strong>${SYNC_STATO.ricevuto ? new Date(SYNC_STATO.ricevuto).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }) + (SYNC_STATO.daCache ? " (dalla memoria del telefono)" : "") : "-"}</strong></div>
      <button type="button" class="btn secondary block" id="controlla-sync-btn" style="margin-top:8px;">🔍 Controlla sincronizzazione</button>
    </div>

    ${bloccoGestioneUtenti}

    <div class="settings-block">
      <h3>Nome app</h3>
      <div class="form-group"><input type="text" id="set-appname" value="${esc(state.settings.appName)}"></div>
    </div>

    <div class="settings-block">
      <h3>Logo</h3>
      <div style="display:flex; align-items:center; gap:12px;">
        <img id="set-logo-preview" src="${state.settings.logo}" style="width:48px;height:48px;border-radius:10px;border:2px solid #1c1c1c;">
        <input type="file" id="set-logo" accept="image/*">
      </div>
    </div>

    <div class="settings-block">
      <h3>Quota Bollino (€/anno)</h3>
      <div class="form-group"><input type="number" id="set-quota" value="${esc(state.settings.quotaBollino)}" min="0" step="0.5"></div>
    </div>

    <div class="settings-block">
      <h3>Quota Nazionale (€)</h3>
      <div class="form-group"><input type="number" id="set-quota-nazionale" value="${esc(state.settings.quotaNazionale)}" min="0" step="0.5"></div>
      <div style="font-size:0.78rem; color:#666;">Parte del bollino che va versata alla sede nazionale ANA.</div>
    </div>

    <div class="settings-block">
      <h3>Importazione anagrafica da Excel</h3>
      <div class="form-group"><input type="file" id="import-excel" accept=".xlsx,.xls,.csv"></div>
      <div style="font-size:0.78rem; color:#666;">Se il socio esiste già (riconosciuto per Codice Fiscale, o per Cognome+Nome), i dati vengono aggiornati invece di creare un doppione. Colonne riconosciute: Cognome, Nome (oppure una colonna unica "Nominativo"/"Nome e Cognome" nel formato Cognome Nome, es. "De Rossi Mario" — viene divisa automaticamente), Data Nascita, Luogo Nascita, Provincia Nascita, Codice Fiscale, Matricola, Indirizzo, Paese, Provincia, CAP, Telefono, Cellulare, Email, Data Iscrizione, Carica, Alfiere (si/no), HACCP (si/no), Grado, Reparto, Anni Naja, Incarico Feste, Note.</div>
    </div>

    <div class="settings-block">
      <h3>Importazione certificati HACCP da PDF unico</h3>
      <button type="button" class="btn block" id="import-haccp-pdf-btn">📄 Importa PDF con più certificati</button>
      <div style="font-size:0.78rem; color:#666; margin-top:6px;">Carica un unico PDF con tutti i certificati HACCP (una pagina per socio): l'app divide le pagine in immagini singole e per ognuna scegli a quale socio assegnarla.</div>
    </div>

    <div class="settings-block">
      <h3>Importazione nominativi "Andati avanti" da TXT</h3>
      <button type="button" class="btn block" id="import-andati-avanti-txt-btn">📥 Importa elenco da file TXT</button>
      <div style="font-size:0.78rem; color:#666; margin-top:6px;">Un nome per riga nel file (es. "Rossi Mario"). Vengono creati come nuovi soci con Privacy e Andato avanti già spuntati; gli altri campi restano vuoti e li completi tu dopo, se serve.</div>
    </div>

    <div class="settings-block">
      <h3>📖 Preghiera e Canto</h3>
      <div class="form-group"><label>Testo Preghiera dell'Alpino</label><textarea id="set-testo-preghiera" rows="6" placeholder="Incolla qui il testo...">${esc(state.settings.testoPreghiera)}</textarea></div>
      <div class="form-group"><label>Testo Signore delle Cime</label><textarea id="set-testo-canto" rows="6" placeholder="Incolla qui il testo...">${esc(state.settings.testoCanto)}</textarea></div>
    </div>

    <div class="settings-block">
      <h3>🎂 Messaggio auguri compleanno</h3>
      <div class="form-group"><textarea id="set-testo-auguri" rows="3">${esc(state.settings.testoAuguriCompleanno)}</textarea></div>
      <div style="font-size:0.78rem; color:#666;">Puoi usare {nome} per inserire automaticamente il nome del socio. Il tasto WhatsApp nel riquadro "Oggi" apre la chat diretta col socio se ha un cellulare salvato in Anagrafica, altrimenti apre la scelta del destinatario.</div>
    </div>


    ${ridotto ? "" : `
    <div class="settings-block">
      <h3>Backup e ripristino</h3>
      <button class="btn block" id="backup-btn" style="margin-bottom:8px;">⬇️ Esegui backup</button>
      <button type="button" class="btn block" id="restore-btn" style="background:var(--gold);">⬆️ Ripristina da file</button>
      <input type="file" id="restore-input" accept=".json" style="display:none;">
    </div>

    <div class="settings-block">
      <h3 style="color:var(--red);">Zona pericolosa</h3>
      <button class="btn danger block" id="reset-bollino-btn">🗑️ Azzera tutti i pagamenti Bollino</button>
      <div style="font-size:0.78rem; color:#666; margin-top:6px;">Cancella tutti i pagamenti registrati (tutti gli anni, tutti i soci). Utile per ripartire puliti quando arriveranno i dati definitivi. L'anagrafica non viene toccata.</div>
    </div>
    `}

    <div class="modal-actions">
      <button type="button" class="btn secondary" id="cancel-settings">Chiudi</button>
      <button type="button" class="btn" id="save-settings">Salva</button>
    </div>
  `;
  showModal(html);
  document.getElementById("cancel-settings").addEventListener("click", closeModal);
  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("set-logo").addEventListener("change", handleLogoUpload);
  const backupBtn = document.getElementById("backup-btn");
  if (backupBtn) backupBtn.addEventListener("click", doBackup);
  const restoreBtn = document.getElementById("restore-btn");
  if (restoreBtn) restoreBtn.addEventListener("click", () => {
    document.getElementById("restore-input").click();
  });
  const restoreInput = document.getElementById("restore-input");
  if (restoreInput) restoreInput.addEventListener("change", handleRestore);
  const resetBollinoBtn = document.getElementById("reset-bollino-btn");
  if (resetBollinoBtn) resetBollinoBtn.addEventListener("click", resetBollino);
  document.getElementById("import-excel").addEventListener("change", handleExcelImport);
  document.getElementById("import-haccp-pdf-btn").addEventListener("click", openImportHaccpPdf);
  document.getElementById("import-andati-avanti-txt-btn").addEventListener("click", openImportAndatiAvantiTxt);
  document.getElementById("change-user-btn").addEventListener("click", () => {
    localStorage.removeItem("gestione_gruppo_user");
    localStorage.removeItem("gestione_gruppo_role");
    currentUser = null;
    currentRole = null;
    closeModal();
    showLoginScreen(() => { location.reload(); });
  });
  const controlloDatiBtn = document.getElementById("controllo-dati-btn");
  if (controlloDatiBtn) controlloDatiBtn.addEventListener("click", apriControlloDati);
  const abilitaTuttiBtn = document.getElementById("accesso-abilita-tutti-btn");
  if (abilitaTuttiBtn) abilitaTuttiBtn.addEventListener("click", () => {
    const target = state.socios.filter(s => socioIdoneoApp(s) && passwordInizialeSocio(s) && !s.accessoApp);
    if (!target.length) { alert("Nessun socio da abilitare."); return; }
    if (!confirm(`Abilitare l'accesso con nome e password a ${target.length} soci?`)) return;
    target.forEach(s => { s.accessoApp = true; });
    saveState();
    openSettings();
    toast(`${target.length} soci abilitati`);
  });
  const senzaDataBtn = document.getElementById("accesso-senza-data-btn");
  if (senzaDataBtn) senzaDataBtn.addEventListener("click", () => {
    const lista = state.socios.filter(s => socioIdoneoApp(s) && !passwordInizialeSocio(s)).map(s => `${s.cognome} ${s.nome}`.trim());
    alert(lista.length ? `Soci senza data di nascita valida (${lista.length}):\n\n` + lista.slice(0, 60).join("\n") + (lista.length > 60 ? "\n..." : "") : "Tutti i soci attivi hanno una data di nascita valida.");
  });
  const disabilitaTuttiBtn = document.getElementById("accesso-disabilita-tutti-btn");
  if (disabilitaTuttiBtn) disabilitaTuttiBtn.addEventListener("click", () => {
    const mio = currentUser && currentUser.startsWith("socio:") ? currentUser.slice(6) : null;
    const target = state.socios.filter(s => s.accessoApp && s.id !== mio);
    if (!target.length) { alert("Nessun accesso da disabilitare."); return; }
    if (!confirm(`Disabilitare l'accesso a ${target.length} soci? Chi è già collegato verrà disconnesso.`)) return;
    target.forEach(s => { s.accessoApp = false; });
    saveState();
    openSettings();
    toast(`${target.length} accessi disabilitati`);
  });
  const rimuoviModuloSedeBtn = document.getElementById("rimuovi-modulo-sede-btn");
  if (rimuoviModuloSedeBtn) rimuoviModuloSedeBtn.addEventListener("click", () => {
    if (!confirm("Rimuovere il modulo caricato?")) return;
    state.settings.moduloSedeUrl = "";
    state.settings.moduloSedeNome = "";
    saveState();
    openSettings();
  });
  document.getElementById("controlla-sync-btn").addEventListener("click", controllaSincronizzazione);
  const aggiungiUtenteBtn = document.getElementById("aggiungi-utente-btn");
  if (aggiungiUtenteBtn) aggiungiUtenteBtn.addEventListener("click", () => {
    state.settings.utenti = leggiUtentiDalForm();
    state.settings.utenti.push({ id: uid(), label: "Nuovo utente", ruolo: "socio", password: "" });
    openSettings();
  });
  document.querySelectorAll("[data-elimina-utente]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.eliminaUtente, 10);
      const utenti = leggiUtentiDalForm();
      if (utenti.length <= 1) { alert("Deve restare almeno un utente."); return; }
      utenti.splice(idx, 1);
      state.settings.utenti = utenti;
      openSettings();
    });
  });
}

async function handleLogoUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!window.storage) {
    // Firebase non configurato: fallback al vecchio comportamento locale (base64)
    const reader = new FileReader();
    reader.onload = ev => { state.settings.logo = ev.target.result; };
    reader.readAsDataURL(file);
    return;
  }
  try {
    toast("Caricamento logo...");
    const url = await uploadDocumento(file, "impostazioni/logo");
    state.settings.logo = url;
    const preview = document.getElementById("set-logo-preview");
    if (preview) preview.src = url;
  } catch (err) {
    console.error(err);
    alert("Errore nel caricamento del logo su Firebase.");
  }
}

function sociosOrdinatiPerSelect() {
  return [...state.socios].sort((a, b) => {
    const ca = (a.cognome || "").localeCompare(b.cognome || "");
    return ca !== 0 ? ca : (a.nome || "").localeCompare(b.nome || "");
  });
}

function separaNomeCognome(riga) {
  const parti = riga.trim().replace(/\s+/g, " ").split(" ");
  if (parti.length === 1) return { cognome: parti[0], nome: "" };
  const nome = parti[parti.length - 1];
  const cognome = parti.slice(0, -1).join(" ");
  return { cognome, nome };
}

function openImportAndatiAvantiTxt() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".txt,text/plain";
  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const righe = e.target.result.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
      if (righe.length === 0) { alert("Il file è vuoto."); return; }
      const persone = righe.map(separaNomeCognome);
      renderImportAndatiAvantiPreview(persone);
    };
    reader.readAsText(file, "UTF-8");
  });
  input.click();
}

function renderImportAndatiAvantiPreview(persone) {
  const html = `
    <div style="font-weight:800; margin-bottom:4px;">Importa nominativi "Andati avanti"</div>
    <div class="card-sub" style="margin-bottom:12px;">${persone.length} nominativi trovati. Verranno creati come nuovi soci con Privacy e Andato avanti già spuntati.</div>
    <div style="max-height:50vh; overflow-y:auto; border:1px solid #ddd; border-radius:10px; padding:8px;">
      ${persone.map(p => `<div style="padding:4px 0; border-bottom:1px solid #eee;">${esc(p.cognome)} ${esc(p.nome)}</div>`).join("")}
    </div>
    <div class="modal-actions" style="margin-top:14px;">
      <button type="button" class="btn secondary" id="import-aa-annulla">Annulla</button>
      <button type="button" class="btn" id="import-aa-conferma">Importa tutti</button>
    </div>
  `;
  showModal(html);
  document.getElementById("import-aa-annulla").addEventListener("click", () => { closeModal(); openSettings(); });
  document.getElementById("import-aa-conferma").addEventListener("click", () => {
    persone.forEach(p => {
      state.socios.push({
        id: uid(), cognome: p.cognome, nome: p.nome, dataNascita:"", luogoNascita:"", provinciaNascita:"", codiceFiscale:"", matricola:"",
        indirizzo:"", paese:"", provincia:"", cap:"", telefono:"", cellulare:"", sms:false, whatsapp:false,
        privacy: true, haccp:false, haccpDataCorso:"", haccpDataScadenza:"", email:"", dataIscrizione:"", carica:"", grado:"", reparto:"",
        anniNaja:"", alfiere:false, incaricoFeste:"", note:"", andatoAvanti: true, andatoAvantiData:""
      });
    });
    saveState();
    closeModal();
    renderSection();
    toast(`Importati ${persone.length} nominativi`);
  });
}

function normalizzaNome(s) {
  return (s || "")
    .toUpperCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/).filter(Boolean).sort().join(" ");
}

function ricostruisciTestoImpaginato(contenuto) {
  const righe = {};
  contenuto.items.forEach(it => {
    if (!it.str || !it.str.trim()) return;
    const y = Math.round(it.transform[5] / 3) * 3; // tolleranza per piccoli scostamenti verticali
    if (!righe[y]) righe[y] = [];
    righe[y].push({ x: it.transform[4], str: it.str });
  });
  const ys = Object.keys(righe).map(Number).sort((a, b) => b - a);
  return ys.map(y => righe[y].sort((a, b) => a.x - b.x).map(o => o.str).join(" ")).join("\n");
}

function estraiNomeDaTesto(testoImpaginato) {
  for (const riga of testoImpaginato.split("\n")) {
    const m = riga.match(/Si attesta che il Sig\.?\s*(.+)/i);
    if (m) {
      // Se sulla stessa riga c'è anche "Codice Fiscale" o "Nato a" (es. sono affiancati), tagliamo lì.
      return m[1].split(/\s*(?:Codice Fiscale|Nato a)\b.*/i)[0].replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

async function openImportHaccpPdf() {
  if (typeof pdfjsLib === "undefined") {
    alert("Libreria PDF non disponibile. Controlla la connessione e riprova.");
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".pdf,application/pdf";
  input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    closeModal();
    toast("Lettura del PDF in corso...");
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      const soci = sociosOrdinatiPerSelect();
      const pagine = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const contenuto = await page.getTextContent();
        const testoImpaginato = ricostruisciTestoImpaginato(contenuto);
        const nomeEstratto = estraiNomeDaTesto(testoImpaginato);

        const viewport = page.getViewport({ scale: 1.3 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

        let socioSuggeritoId = null;
        if (nomeEstratto) {
          const sigCercata = normalizzaNome(nomeEstratto);
          const corrispondenze = soci.filter(s => normalizzaNome(`${s.cognome} ${s.nome}`) === sigCercata);
          if (corrispondenze.length === 1) socioSuggeritoId = corrispondenze[0].id;
        }
        pagine.push({ numero: i, dataUrl: canvas.toDataURL("image/jpeg", 0.85), nomeEstratto, socioSuggeritoId });
      }
      renderImportHaccpAssegnazione(pagine);
    } catch (err) {
      console.error(err);
      alert("Errore nella lettura del PDF. Verifica che il file non sia protetto o danneggiato.");
    }
  });
  input.click();
}

function renderImportHaccpAssegnazione(pagine) {
  const soci = sociosOrdinatiPerSelect();
  const optionsHtml = (selezionatoId) => `<option value="">-- salta --</option>` + soci.map(s => `<option value="${s.id}" ${s.id === selezionatoId ? "selected" : ""}>${esc(s.cognome)} ${esc(s.nome)}</option>`).join("");
  const nSuggeriti = pagine.filter(p => p.socioSuggeritoId).length;
  const nSenzaNome = pagine.filter(p => !p.nomeEstratto).length;
  const html = `
    <div style="font-weight:800; margin-bottom:4px;">Assegna certificati HACCP</div>
    <div class="card-sub" style="margin-bottom:12px;">${pagine.length} pagine trovate. ${nSuggeriti} abbinate automaticamente per nome (controllale). ${nSenzaNome ? nSenzaNome + " pagine senza un nome riconoscibile (es. i retro): lasciale su \"salta\" o assegnale a mano." : ""}</div>
    <div id="haccp-import-list" style="display:flex; flex-direction:column; gap:14px; max-height:55vh; overflow-y:auto;">
      ${pagine.map(p => `
        <div style="display:flex; gap:10px; align-items:center; border:1px solid ${p.socioSuggeritoId ? "#ddd" : (p.nomeEstratto ? "#e8c34a" : "#ddd")}; background:${p.socioSuggeritoId ? "transparent" : (p.nomeEstratto ? "#fff8e1" : "#f5f5f0")}; border-radius:10px; padding:8px;">
          <img src="${p.dataUrl}" style="width:70px; height:auto; border-radius:6px; border:1px solid #ccc; flex-shrink:0;">
          <div style="flex:1;">
            <div class="card-sub" style="margin-bottom:4px;">Pagina ${p.numero}${p.nomeEstratto ? ` · sul certificato: <strong>${esc(p.nomeEstratto)}</strong>` : " · nessun nome riconosciuto"}</div>
            <select class="haccp-import-select" data-pagina="${p.numero}" style="width:100%;">${optionsHtml(p.socioSuggeritoId)}</select>
          </div>
        </div>
      `).join("")}
    </div>
    <div class="modal-actions" style="margin-top:14px;">
      <button type="button" class="btn secondary" id="haccp-import-cancel">Annulla</button>
      <button type="button" class="btn" id="haccp-import-confirm">Conferma import</button>
    </div>
  `;
  showModal(html);
  document.getElementById("haccp-import-cancel").addEventListener("click", () => { closeModal(); openSettings(); });
  document.getElementById("haccp-import-confirm").addEventListener("click", () => eseguiImportHaccp(pagine));
}

async function eseguiImportHaccp(pagine) {
  const selects = document.querySelectorAll(".haccp-import-select");
  const assegnazioni = [];
  selects.forEach(sel => {
    if (sel.value) {
      const pagina = pagine.find(p => p.numero === parseInt(sel.dataset.pagina, 10));
      if (pagina) assegnazioni.push({ socioId: sel.value, pagina });
    }
  });
  if (assegnazioni.length === 0) {
    alert("Non hai assegnato nessuna pagina a un socio.");
    return;
  }
  const btn = document.getElementById("haccp-import-confirm");
  btn.disabled = true;
  let fatti = 0;
  for (const a of assegnazioni) {
    fatti++;
    btn.textContent = `Caricamento ${fatti}/${assegnazioni.length}...`;
    try {
      const blob = await (await fetch(a.pagina.dataUrl)).blob();
      const socio = state.socios.find(s => s.id === a.socioId);
      if (!socio) continue;
      if (window.storage) {
        const url = await uploadDocumento(blob, `documenti/haccp/${a.socioId}`);
        socio.haccpFoto = url;
      } else {
        socio.haccpFoto = a.pagina.dataUrl;
      }
      socio.haccpFotoNome = `haccp_pagina_${a.pagina.numero}.jpg`;
    } catch (err) {
      console.error("Errore import HACCP socio " + a.socioId, err);
    }
  }
  saveState();
  closeModal();
  renderSection();
  toast(`Import completato: ${fatti} certificati caricati`);
}

function renderCena() {
  const soloLettura = currentRole === "socio";
  const cene = [...state.cene].sort((a, b) => (b.data || "").localeCompare(a.data || ""));
  const listaHtml = cene.length ? cene.map(c => `
    <div class="card" data-cena-id="${c.id}">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <div style="font-weight:800;">${esc(c.titolo || "Cena")}</div>
          <div class="card-sub">${fmtDate(c.data)}${c.ora ? " · " + esc(c.ora) : ""}${c.luogo ? " · " + esc(c.luogo) : ""}</div>
        </div>
        ${soloLettura ? "" : `<button type="button" class="btn danger" data-elimina-cena="${c.id}" style="padding:5px 10px; font-size:0.8rem;">🗑️</button>`}
      </div>
      <div class="card-sub" data-tally="${c.id}" style="margin-top:8px;">Caricamento risposte...</div>
      ${c.scadenza ? `<div class="card-sub" style="margin-top:4px;">${cenaChiusa(c.scadenza) ? "Iscrizioni chiuse (scadenza il " + fmtDate(c.scadenza) + ")" : "Iscrizioni aperte fino al " + fmtDate(c.scadenza)}</div>` : ""}
      <div data-iscr="${c.id}"></div>
      <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
        <button type="button" class="btn secondary" data-copia-link="${c.id}" style="font-size:0.82rem; padding:7px 10px;">🔗 Copia link</button>
        ${soloLettura ? "" : `<button type="button" class="btn" data-wa-link="${c.id}" style="background:#25D366; color:#fff; font-size:0.82rem; padding:7px 10px;">${WA_ICON} Invia su WhatsApp</button>`}
        <button type="button" class="btn secondary" data-report-cena="${c.id}" style="font-size:0.82rem; padding:7px 10px;">📋 Report nomi</button>
      </div>
      ${soloLettura ? "" : `<div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
        <button type="button" class="btn" data-cena-aggiungi="${c.id}" style="font-size:0.82rem; padding:7px 10px;">➕ Aggiungi adesione</button>
        <button type="button" class="btn secondary" data-cena-scadenza="${c.id}" style="font-size:0.82rem; padding:7px 10px;">📅 Scadenza iscrizioni</button>
      </div>`}
    </div>
  `).join("") : `<div class="card-sub">Nessuna cena creata finora.</div>`;

  const formNuovaCena = soloLettura ? "" : `
    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Nuova cena</div>
      <div class="form-group"><label>Titolo</label><input type="text" id="cena-titolo" placeholder="Es. Cena fine mese Settembre"></div>
      <div class="two-col">
        <div class="form-group"><label>Data</label><input type="date" id="cena-data"></div>
        <div class="form-group"><label>Ora</label>
          <div style="display:flex; gap:6px;">
            <select id="cena-ora-h" style="flex:1;"><option value="">--</option>${orarieHOptions()}</select>
            <select id="cena-ora-m" style="flex:1;"><option value="00">:00</option><option value="30">:30</option></select>
          </div>
        </div>
      </div>
      <div class="form-group"><label>Luogo</label><input type="text" id="cena-luogo" value="Sede Gruppo Alpini Bottonaga"></div>
      <div class="form-group"><label>Iscrizioni fino al (facoltativo)</label><input type="date" id="cena-scadenza"><div style="font-size:0.75rem; color:#666; margin-top:4px;">Dopo questa data nessuno può più iscriversi, né dall'app né dal link. Il Direttivo può comunque aggiungere adesioni a mano.</div></div>
      <div class="form-group"><label>Testo del messaggio</label>
        <textarea id="cena-testo" rows="5" placeholder="Scrivi qui il messaggio da mandare nel gruppo...">Ciao a tutti, ci sarà la solita cena di fine mese.
Siamo diventati tecnologicamente evoluti quindi cliccate qua sotto per confermare.
Se vuoi essere dei nostri clicca qua sotto:
PRESENTE</textarea>
        <div style="font-size:0.75rem; color:#666; margin-top:4px;">Se l'ultima riga è la parola "PRESENTE", il link viene attaccato proprio lì (es. "PRESENTE 👉 link"). Altrimenti il link viene aggiunto su una riga nuova in fondo al messaggio.</div>
      </div>
      <button type="button" class="btn block" id="crea-cena-btn" style="margin-top:6px;">➕ Crea e genera link</button>
    </div>`;

  return `
    <div class="section-title">🍽️ Cena mensile</div>
    <div class="card-sub" style="margin-bottom:12px;">${soloLettura ? "Elenco delle cene in programma." : "Crea l'evento, scrivi il tuo messaggio, poi apri WhatsApp: il link per confermare la presenza (nome + quante persone, tipo \"presente +3\") viene aggiunto in automatico in fondo al testo. Le risposte arrivano qui in tempo reale."}</div>

    ${formNuovaCena}

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Cene create</div>
    <div id="cena-lista">${listaHtml}</div>
  `;
}

function linkCena(cenaId) {
  return `${location.origin}${location.pathname}?cena=${cenaId}`;
}

function attachCenaEvents() {
  const creaBtn = document.getElementById("crea-cena-btn");
  if (creaBtn) creaBtn.addEventListener("click", creaCena);
  document.querySelectorAll("[data-elimina-cena]").forEach(btn => {
    btn.addEventListener("click", () => eliminaCena(btn.dataset.eliminaCena));
  });
  document.querySelectorAll("[data-copia-link]").forEach(btn => {
    btn.addEventListener("click", () => {
      const link = linkCena(btn.dataset.copiaLink);
      navigator.clipboard.writeText(link).then(() => toast("Link copiato!")).catch(() => alert(link));
    });
  });
  document.querySelectorAll("[data-wa-link]").forEach(btn => {
    btn.addEventListener("click", () => {
      const c = state.cene.find(x => x.id === btn.dataset.waLink);
      if (!c) return;
      const link = linkCena(c.id);
      const baseTesto = c.testo || "Ciao a tutti, ci sarà la cena. Se vuoi essere dei nostri clicca qua sotto:\nPRESENTE";
      const righe = baseTesto.split("\n");
      const ultima = righe[righe.length - 1].trim();
      let corpo;
      if (/^presente$/i.test(ultima)) {
        righe[righe.length - 1] = `${ultima.toUpperCase()} 👉 ${link}`;
        corpo = righe.join("\n");
      } else {
        corpo = `${baseTesto}\n${link}`;
      }
      const intestazioneRighe = [];
      if (c.titolo) intestazioneRighe.push(`🍽️ *${c.titolo}*`, "");
      if (c.data) intestazioneRighe.push(`📅 ${fmtDate(c.data)}`);
      if (c.ora) intestazioneRighe.push(`🕐 ${c.ora}`);
      if (c.luogo) intestazioneRighe.push(`📍 ${c.luogo}`);
      if (intestazioneRighe.length) intestazioneRighe.push("");
      const testo = intestazioneRighe.join("\n") + corpo;
      window.open(`https://wa.me/?text=${encodeURIComponent(testo)}`, "_blank");
    });
  });
  document.querySelectorAll("[data-tally]").forEach(el => caricaTallyCena(el.dataset.tally, el));
  document.querySelectorAll("[data-report-cena]").forEach(btn => {
    btn.addEventListener("click", () => apriReportCena(btn.dataset.reportCena));
  });
  document.querySelectorAll("[data-cena-aggiungi]").forEach(btn => {
    btn.addEventListener("click", () => apriAggiungiAdesioneCena(btn.dataset.cenaAggiungi));
  });
  document.querySelectorAll("[data-cena-scadenza]").forEach(btn => {
    btn.addEventListener("click", () => apriScadenzaCena(btn.dataset.cenaScadenza));
  });
}

async function creaCena() {
  const titolo = document.getElementById("cena-titolo").value.trim();
  const data = document.getElementById("cena-data").value;
  const h = document.getElementById("cena-ora-h").value;
  const m = document.getElementById("cena-ora-m").value || "00";
  const luogo = document.getElementById("cena-luogo").value.trim();
  const testo = document.getElementById("cena-testo").value.trim();
  const scadenza = document.getElementById("cena-scadenza").value;
  if (!data) { alert("Inserisci la data della cena"); return; }
  if (scadenza && scadenza > data) { alert("La data limite per iscriversi non può essere dopo la cena."); return; }
  const id = uid();
  const ora = h ? `${h}:${m}` : "";
  const nuova = { id, titolo, data, ora, luogo, testo, creato: new Date().toISOString() };
  if (scadenza) nuova.scadenza = scadenza;
  state.cene.push(nuova);
  saveState();
  if (window.db) {
    try {
      await db.collection(FIRESTORE_COLLECTION).doc(`cena_${id}`).set(Object.assign({ titolo, data, ora, luogo, testo, risposte: {} }, scadenza ? { scadenza } : {}));
    } catch (err) {
      console.error(err);
      alert("La cena è stata creata ma c'è stato un problema nel predisporre il link su Firebase. Riprova a crearla se il link non dovesse funzionare.");
    }
  }
  renderSection();
  toast("Cena creata! Apri WhatsApp o copia il link.");
}

async function eliminaCena(cenaId) {
  if (!confirm("Eliminare questa cena e tutte le risposte ricevute?")) return;
  state.cene = state.cene.filter(c => c.id !== cenaId);
  saveState();
  if (window.db) {
    db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`).delete().catch(err => console.error(err));
  }
  renderSection();
}

async function caricaTallyCena(cenaId, el) {
  if (!window.db) { el.textContent = "Sincronizzazione non disponibile"; return; }
  try {
    const doc = await db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`).get();
    const dati = doc.exists ? doc.data() : null;
    const blocco = document.querySelector(`[data-iscr="${cenaId}"]`);
    if (blocco) disegnaIscrizioneCena(cenaId, blocco, dati);
    if (!dati) { el.textContent = "Nessuna conferma ancora"; return; }
    const totale = risposteCenaUniche(dati.risposte).reduce((sum, r) => sum + (r.persone || 1), 0);
    el.innerHTML = totale > 0 ? `✅ <strong>${totale}</strong> persone confermate` : "Nessuna conferma ancora";
  } catch (err) {
    console.error(err);
    el.textContent = "Errore nel caricamento delle conferme";
  }
}

async function apriReportCena(cenaId) {
  const c = state.cene.find(x => x.id === cenaId);
  if (!window.db) { alert("Sincronizzazione non disponibile."); return; }
  showModal(`<div style="text-align:center; padding:30px 0;">Caricamento report...</div>`);
  try {
    const doc = await db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`).get();
    const risposte = doc.exists ? (doc.data().risposte || {}) : {};
    const elenco = risposteCenaUniche(risposte);
    const totale = elenco.reduce((sum, r) => sum + (r.persone || 1), 0);
    const righeHtml = elenco.length
      ? elenco.map(r => `<div style="display:flex; justify-content:space-between; padding:6px 0; border-bottom:1px solid #eee;"><span>${esc(r.nome || "Anonimo")}</span><strong>${r.persone || 1}</strong></div>`).join("")
      : `<div class="card-sub">Nessuna conferma ancora.</div>`;
    const html = `
      <div style="font-weight:800; margin-bottom:2px;">📋 Report presenze</div>
      <div class="card-sub" style="margin-bottom:14px;">${esc(c ? (c.titolo || "Cena") : "Cena")}</div>
      <div style="font-weight:800; font-size:1.3rem; color:#1a6b3c; margin-bottom:10px;">Totale: ${totale} persone</div>
      <div>${righeHtml}</div>
      <button type="button" class="btn block" id="report-cena-stampa" style="margin-top:14px;">🖨️ Stampa elenco per la spunta</button>
      <div class="modal-actions" style="margin-top:10px;">
        <button type="button" class="btn secondary block" id="report-cena-chiudi">Chiudi</button>
      </div>
    `;
    showModal(html);
    document.getElementById("report-cena-chiudi").addEventListener("click", closeModal);
    document.getElementById("report-cena-stampa").addEventListener("click", () => {
      const area = document.getElementById("print-area");
      const righeStampa = elenco.length
        ? elenco.map(r => `
          <tr>
            <td style="border:1px solid #000; padding:8px; width:36px; text-align:center;"><span style="display:inline-block; width:20px; height:20px; border:1.5px solid #000;"></span></td>
            <td style="border:1px solid #000; padding:8px;">${esc(r.nome || "Anonimo")}</td>
            <td style="border:1px solid #000; padding:8px; text-align:center; width:70px;">${r.persone || 1}</td>
          </tr>`).join("")
        : `<tr><td colspan="3" style="border:1px solid #000; padding:8px;">Nessuna conferma</td></tr>`;
      area.innerHTML = `
        <h2>${esc(c ? (c.titolo || "Cena") : "Cena")} — ${esc(state.settings.appName)}</h2>
        <p>${c && c.data ? "Data: " + fmtDate(c.data) : ""}${c && c.ora ? " ore " + esc(c.ora) : ""}${c && c.luogo ? " - " + esc(c.luogo) : ""}</p>
        <p>Totale confermato: ${totale} persone</p>
        <table style="width:100%; border-collapse:collapse; margin-top:10px;">
          <thead><tr>
            <th style="border:1px solid #000; padding:8px;">Presente</th>
            <th style="border:1px solid #000; padding:8px; text-align:left;">Nominativo</th>
            <th style="border:1px solid #000; padding:8px;">N. persone</th>
          </tr></thead>
          <tbody>${righeStampa}</tbody>
        </table>
      `;
      window.print();
    });
  } catch (err) {
    console.error(err);
    showModal(`<div style="text-align:center; padding:20px 0;">Errore nel caricamento del report.</div><div class="modal-actions"><button type="button" class="btn secondary block" onclick="closeModal()">Chiudi</button></div>`);
  }
}

// ---------- Cena: iscrizione dall'app, data limite, adesioni a mano ----------
// Per confrontare i nomi senza badare a maiuscole, accenti e ordine ("Rossi Mario" = "mario rossi").
function chiaveNomeCena(n) {
  return String(n || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean).sort().join(" ");
}

// Elenco delle adesioni senza doppioni: se un socio è iscritto dall'app, la stessa persona arrivata anche dal link non conta due volte.
function risposteCenaUniche(risposte) {
  const tutte = Object.keys(risposte || {}).map(id => Object.assign({ id }, risposte[id]));
  const conSocio = tutte.filter(e => e.socioId);
  const nomi = new Set(conSocio.map(e => chiaveNomeCena(e.nome)));
  return conSocio.concat(tutte.filter(e => !e.socioId && !nomi.has(chiaveNomeCena(e.nome))))
    .sort((x, y) => (x.nome || "").localeCompare(y.nome || "", "it", { sensitivity: "base" }));
}

// L'ultimo giorno utile per iscriversi è la data limite stessa (compresa).
function cenaChiusa(scadenza) { return !!scadenza && benOggi() > scadenza; }

// Scrive (o toglie, con valore null) una adesione. La data limite e la data della cena si controllano sul database,
// così un telefono con dati vecchi non può aggirarle. Il Direttivo (opzioni.gestore) può sempre.
async function scriviRispostaCena(cenaId, entryId, valore, opzioni) {
  const opz = opzioni || {};
  if (!window.db) return { errore: "Non sono collegato: controlla la connessione e riprova." };
  const ref = db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`);
  let esito = {};
  try {
    await conTimeout(db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) { esito = { errore: "Questo invito non è più valido." }; return; }
      const dati = snap.data();
      if (!opz.gestore && cenaChiusa(dati.scadenza)) { esito = { errore: `Le iscrizioni sono chiuse dal ${fmtDate(dati.scadenza)}.`, chiuse: true }; return; }
      if (opz.controllaData && !opz.gestore && dati.data && dati.data < benOggi()) { esito = { errore: "La cena si è già svolta." }; return; }
      tx.update(ref, { [`risposte.${entryId}`]: valore === null ? firebase.firestore.FieldValue.delete() : valore });
    }), 15000);
  } catch (err) {
    console.error(err);
    return { errore: "Non sono riuscito a salvare: controlla la connessione e riprova." };
  }
  return esito;
}

function blocchiPersone(n) { return `${n} ${n === 1 ? "persona" : "persone"}`; }

// Riquadro dell'iscrizione dentro la scheda della cena (per chi è entrato con il proprio nome).
function disegnaIscrizioneCena(cenaId, el, dati) {
  const c = state.cene.find(x => x.id === cenaId);
  if (!c || !el) return;
  const mio = benMioId(), s = mio ? socioCorrente() : null;
  if (!s) {
    el.innerHTML = currentRole === "socio" ? `<div class="iscr info">Per iscriverti dall'app entra con il tuo nome e la tua data di nascita. Oppure usa il <b>link</b> ricevuto su WhatsApp.</div>` : "";
    return;
  }
  const scadenza = (dati && dati.scadenza) || c.scadenza || "";
  const chiusa = cenaChiusa(scadenza);
  const unici = risposteCenaUniche(dati ? dati.risposte : {});
  const mioNome = `${s.cognome} ${s.nome}`.trim();
  const miaApp = unici.find(e => e.socioId === mio);
  const miaLink = miaApp ? null : unici.find(e => !e.socioId && chiaveNomeCena(e.nome) === chiaveNomeCena(mioNome));
  const attuale = miaApp || miaLink || null;
  const ricarica = () => { const t = document.querySelector(`[data-tally="${cenaId}"]`); if (t) caricaTallyCena(cenaId, t); };

  if (c.data && c.data < benOggi()) {
    el.innerHTML = `<div class="iscr passata">🕒 Cena già svolta${attuale ? ` · risultavi iscritto: ${blocchiPersone(attuale.persone || 1)}` : ""}</div>`;
    return;
  }
  const mostraForm = (n, titolo, etichetta, conAnnulla) => {
    el.innerHTML = `<div class="iscr nuova">
      <div class="iscr-t">${titolo}</div>
      ${scadenza ? `<div class="card-sub" style="margin:-4px 0 8px;">Iscrizioni aperte fino al ${fmtDate(scadenza)}</div>` : ""}
      <div class="iscr-q"><span>Quanti siete,<br>te compreso</span><div class="stp"><button type="button" data-i="meno" aria-label="Meno">−</button><b data-i="num">${n}</b><button type="button" data-i="piu" aria-label="Più">+</button></div></div>
      <div class="iscr-az"><button type="button" class="btn" data-i="salva">${etichetta}</button>${conAnnulla ? `<button type="button" class="btn secondary" data-i="annulla">Annulla</button>` : ""}</div>
    </div>`;
    let corrente = n;
    el.onclick = async e => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      const az = b.dataset.i;
      if (az === "meno" && corrente > 1) { corrente--; el.querySelector('[data-i="num"]').textContent = corrente; }
      else if (az === "piu") { corrente++; el.querySelector('[data-i="num"]').textContent = corrente; }
      else if (az === "annulla") disegnaIscrizioneCena(cenaId, el, dati);
      else if (az === "salva") {
        b.disabled = true;
        const esito = await scriviRispostaCena(cenaId, "socio_" + mio, { nome: mioNome, persone: corrente, socioId: mio, ts: new Date().toISOString(), da: "app" }, { controllaData: true });
        if (esito.errore) { alert(esito.errore); ricarica(); return; }
        if (miaLink) await scriviRispostaCena(cenaId, miaLink.id, null, { gestore: true });   // la risposta del link viene sostituita da quella dell'app
        scriviLog([{ ev: `🍽️ «${c.titolo || "Cena"}»: ${mioNome} ${attuale ? "ha cambiato l'iscrizione" : "si è iscritto"} (${blocchiPersone(corrente)})` }]);
        toast(attuale ? "Iscrizione aggiornata" : "Iscrizione registrata ✅");
        ricarica();
      }
    };
  };
  if (attuale) {
    el.innerHTML = `<div class="iscr fatto">
      <div class="iscr-ok">✅ Sei iscritto: ${blocchiPersone(attuale.persone || 1)}${miaLink ? ` <span style="font-weight:600; font-size:0.8rem;">(dal link)</span>` : ""}</div>
      ${chiusa ? `<div class="card-sub">Iscrizioni chiuse: per cambiare rivolgiti al Direttivo.</div>` : `<div class="iscr-az"><button type="button" class="btn secondary" data-i="cambia">Cambia</button><button type="button" class="btn secondary" data-i="togli">Togli</button></div>`}
    </div>`;
    el.onclick = async e => {
      const b = e.target.closest("[data-i]");
      if (!b) return;
      if (b.dataset.i === "cambia") mostraForm(attuale.persone || 1, "Cambia l'iscrizione", "Salva", true);
      else if (b.dataset.i === "togli") {
        if (!confirm("Togliere la tua iscrizione alla cena?")) return;
        const esito = await scriviRispostaCena(cenaId, attuale.id, null, { controllaData: true });
        if (esito.errore) { alert(esito.errore); ricarica(); return; }
        scriviLog([{ ev: `🍽️ «${c.titolo || "Cena"}»: ${mioNome} ha tolto l'iscrizione` }]);
        toast("Iscrizione tolta");
        ricarica();
      }
    };
  } else if (chiusa) {
    el.innerHTML = `<div class="iscr info">Le iscrizioni sono chiuse (scadenza il ${fmtDate(scadenza)}). Per partecipare rivolgiti al Direttivo.</div>`;
  } else {
    mostraForm(1, "Ci sei alla cena?", "✅ Ci sono", false);
  }
}

// Direttivo e Admin: aggiungere, cambiare o togliere l'adesione di un socio (per chi non usa l'app).
async function apriAggiungiAdesioneCena(cenaId) {
  if (currentRole === "socio") return;
  const c = state.cene.find(x => x.id === cenaId);
  if (!c || !window.db) { alert("Sincronizzazione non disponibile."); return; }
  let dati = null;
  try { const doc = await db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`).get(); dati = doc.exists ? doc.data() : null; } catch (e) { console.error(e); }
  if (!dati) { alert("Non riesco a leggere le adesioni di questa cena: controlla la connessione e riprova."); return; }
  const unici = risposteCenaUniche(dati.risposte);
  const trova = s => unici.find(x => x.socioId === s.id) || unici.find(x => !x.socioId && chiaveNomeCena(x.nome) === chiaveNomeCena(`${s.cognome} ${s.nome}`));
  const soci = state.socios.filter(s => !s.andatoAvanti).sort((x, y) => `${x.cognome} ${x.nome}`.localeCompare(`${y.cognome} ${y.nome}`, "it", { sensitivity: "base" }));
  let sel = null, n = 1;
  showModal(`<div id="ac-root">
    <div class="modal-title">➕ Aggiungi adesione</div>
    <div class="card-sub" style="margin-bottom:8px;">${esc(c.titolo || "Cena")}. Per i soci senza app o che hanno risposto a voce.</div>
    <input type="text" id="ac-cerca" placeholder="Cerca un socio..." style="width:100%; box-sizing:border-box; margin-bottom:6px;">
    <div id="ac-lista" style="max-height:34vh; overflow-y:auto;">${soci.map(s => { const e = trova(s); return `<div class="sg-riga" data-id="${s.id}" data-nome="${esc(`${s.cognome} ${s.nome}`.toLowerCase())}"><span style="width:22px;" data-spunta></span><span>${esc(s.cognome)} ${esc(s.nome)}</span>${e ? `<span class="card-sub" style="margin-left:auto;">iscritto: ${e.persone || 1}</span>` : ""}</div>`; }).join("")}</div>
    <div class="iscr-q" style="margin-top:12px;"><span>Quanti sono,<br>compreso il socio</span><div class="stp"><button type="button" data-ac="meno">−</button><b id="ac-num">1</b><button type="button" data-ac="piu">+</button></div></div>
    <div id="ac-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions" style="flex-wrap:wrap;">
      <button type="button" class="btn secondary" data-ac="chiudi">Annulla</button>
      <button type="button" class="btn danger" data-ac="togli" id="ac-togli" style="display:none;">Togli adesione</button>
      <button type="button" class="btn" data-ac="salva" id="ac-salva" disabled>Aggiungi</button>
    </div></div>`);
  const aggiorna = () => {
    document.getElementById("ac-num").textContent = n;
    document.querySelectorAll("#ac-lista .sg-riga").forEach(r => { const su = r.dataset.id === (sel && sel.id); r.classList.toggle("sel", su); r.querySelector("[data-spunta]").textContent = su ? "✅" : ""; });
    const e = sel ? trova(sel) : null;
    document.getElementById("ac-salva").disabled = !sel;
    document.getElementById("ac-salva").textContent = e ? "Aggiorna" : "Aggiungi";
    document.getElementById("ac-togli").style.display = e ? "" : "none";
  };
  document.getElementById("ac-cerca").addEventListener("input", ev => {
    const q = ev.target.value.trim().toLowerCase();
    document.querySelectorAll("#ac-lista .sg-riga").forEach(r => { r.style.display = !q || r.dataset.nome.includes(q) ? "" : "none"; });
  });
  document.getElementById("ac-root").addEventListener("click", async ev => {
    const riga = ev.target.closest(".sg-riga");
    if (riga) { sel = soci.find(s => s.id === riga.dataset.id); const e = trova(sel); n = e ? (e.persone || 1) : 1; document.getElementById("ac-errore").textContent = ""; aggiorna(); return; }
    const b = ev.target.closest("[data-ac]");
    if (!b) return;
    const az = b.dataset.ac, err = document.getElementById("ac-errore");
    if (az === "meno") { if (n > 1) n--; aggiorna(); }
    else if (az === "piu") { n++; aggiorna(); }
    else if (az === "chiudi") closeModal();
    else if ((az === "salva" || az === "togli") && sel) {
      b.disabled = true;
      const nome = `${sel.cognome} ${sel.nome}`.trim(), e = trova(sel);
      let esito;
      if (az === "salva") {
        esito = await scriviRispostaCena(cenaId, "socio_" + sel.id, { nome, persone: n, socioId: sel.id, ts: new Date().toISOString(), da: "direttivo" }, { gestore: true });
        if (!esito.errore && e && e.id !== "socio_" + sel.id) await scriviRispostaCena(cenaId, e.id, null, { gestore: true });
      } else {
        esito = await scriviRispostaCena(cenaId, e.id, null, { gestore: true });
      }
      if (esito.errore) { err.textContent = esito.errore; b.disabled = false; return; }
      scriviLog([{ ev: `🍽️ «${c.titolo || "Cena"}»: ${az === "salva" ? `adesione di ${nome} ${e ? "aggiornata" : "aggiunta"} dal Direttivo (${blocchiPersone(n)})` : `adesione di ${nome} tolta dal Direttivo`}` }]);
      closeModal();
      toast(az === "salva" ? "Adesione registrata" : "Adesione tolta");
      const t = document.querySelector(`[data-tally="${cenaId}"]`); if (t) caricaTallyCena(cenaId, t);
    }
  });
  aggiorna();
}

// Direttivo e Admin: data limite per iscriversi (facoltativa), valida per l'app e per il link.
function apriScadenzaCena(cenaId) {
  if (currentRole === "socio") return;
  const c = state.cene.find(x => x.id === cenaId);
  if (!c) return;
  showModal(`
    <div class="modal-title">📅 Scadenza iscrizioni</div>
    <div class="card-sub" style="margin-bottom:8px;">${esc(c.titolo || "Cena")} · cena del ${fmtDate(c.data)}. Dopo la data limite nessuno può più iscriversi o cambiare, né dall'app né dal link. Il Direttivo può comunque aggiungere adesioni a mano.</div>
    <div class="form-group"><label>Iscrizioni fino al (compreso)</label><input type="date" id="sc-data" value="${esc(c.scadenza || "")}"></div>
    <div id="sc-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions" style="flex-wrap:wrap;">
      <button type="button" class="btn secondary" id="sc-annulla">Annulla</button>
      ${c.scadenza ? `<button type="button" class="btn danger" id="sc-togli">Togli la scadenza</button>` : ""}
      <button type="button" class="btn" id="sc-salva">Salva</button>
    </div>`);
  document.getElementById("sc-annulla").addEventListener("click", closeModal);
  const applica = async valore => {
    const err = document.getElementById("sc-errore");
    if (valore && c.data && valore > c.data) { err.textContent = "La data limite non può essere dopo la cena."; return; }
    if (valore) c.scadenza = valore; else delete c.scadenza;
    saveState();
    if (window.db) {
      try { await db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`).update({ scadenza: valore ? valore : firebase.firestore.FieldValue.delete() }); }
      catch (e) { console.error(e); alert("La scadenza è salvata nell'app, ma non sono riuscito ad aggiornare il link. Riprova tra poco."); }
    }
    scriviLog([{ ev: `🍽️ «${c.titolo || "Cena"}»: ${valore ? "iscrizioni fino al " + fmtDate(valore) : "scadenza delle iscrizioni tolta"}` }]);
    closeModal();
    renderSection();
    toast(valore ? "Scadenza salvata" : "Scadenza tolta");
  };
  document.getElementById("sc-salva").addEventListener("click", () => applica(document.getElementById("sc-data").value));
  const togli = document.getElementById("sc-togli");
  if (togli) togli.addEventListener("click", () => applica(""));
}

// ---------- Pagina pubblica di conferma Cena (nome + numero persone, senza login) ----------
async function renderCenaRisposta(cenaId) {
  document.body.innerHTML = `<div id="cena-risposta-root" style="max-width:420px; margin:0 auto; padding:24px 16px; font-family:inherit; text-align:center;"></div>`;
  const root = document.getElementById("cena-risposta-root");
  root.innerHTML = `<div style="padding-top:40px;">Caricamento...</div>`;

  if (!window.db) {
    root.innerHTML = `<div style="padding-top:40px;">⚠️ Impossibile collegarsi, controlla la connessione e riapri il link.</div>`;
    return;
  }
  let cenaDoc;
  try {
    cenaDoc = await db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`).get();
  } catch (err) {
    root.innerHTML = `<div style="padding-top:40px;">⚠️ Errore di connessione. Riprova.</div>`;
    return;
  }
  if (!cenaDoc.exists) {
    root.innerHTML = `<div style="padding-top:40px;">Questo invito non è più valido.</div>`;
    return;
  }
  const c = cenaDoc.data();
  const chiusa = cenaChiusa(c.scadenza);
  const intestazione = `
    <div style="margin-bottom:18px;">
      <div style="font-weight:900; font-size:1.3rem; color:#1a6b3c;">🍽️ ${esc(c.titolo || "Cena")}</div>
      ${(c.data || c.ora || c.luogo) ? `<div style="color:#555; margin-top:4px;">${c.data ? fmtDate(c.data) : ""}${c.ora ? " ore " + esc(c.ora) : ""}${c.luogo ? " - " + esc(c.luogo) : ""}</div>` : ""}
      ${c.scadenza ? `<div style="color:#b36b00; margin-top:8px; font-weight:700;">${chiusa ? "Iscrizioni chiuse (scadenza il " + fmtDate(c.scadenza) + ")" : "Iscrizioni aperte fino al " + fmtDate(c.scadenza)}</div>` : ""}
      ${c.testo ? `<div style="color:#333; margin-top:10px; white-space:pre-wrap; text-align:left; background:#f5f5f0; border-radius:8px; padding:10px;">${esc(c.testo)}</div>` : ""}
    </div>
    <div id="cr-elenco" style="text-align:left; background:#fff; border:1px solid #ddd; border-radius:10px; padding:10px; margin-bottom:18px;"></div>`;

  function renderElenco(risposte) {
    const elenco = risposteCenaUniche(risposte);
    const totale = elenco.reduce((sum, r) => sum + (r.persone || 1), 0);
    const el = document.getElementById("cr-elenco");
    if (!el) return;
    if (elenco.length === 0) {
      el.innerHTML = `<div class="card-sub">Nessuno si è ancora prenotato. Sii il primo! 🎉</div>`;
      return;
    }
    el.innerHTML = `
      <div style="font-weight:800; margin-bottom:6px;">✅ Già prenotati: ${totale} ${totale === 1 ? "persona" : "persone"}</div>
      ${elenco.map(r => `<div style="display:flex; justify-content:space-between; padding:3px 0; font-size:0.9rem;"><span>${esc(r.nome || "Anonimo")}</span><span>${r.persone || 1}</span></div>`).join("")}
    `;
  }
  renderElenco(c.risposte);
  db.collection(FIRESTORE_COLLECTION).doc(`cena_${cenaId}`).onSnapshot(snap => {
    if (snap.exists) renderElenco(snap.data().risposte);
  }, err => console.error(err));

  // Ogni conferma è una voce a sé (id nuovo ogni volta): così, se dallo stesso
  // telefono si conferma per più persone (es. un familiare aiuta un anziano
  // del gruppo), la seconda risposta si aggiunge senza cancellare la prima.
  const messaggioChiuso = testo => `<div style="font-size:1.05rem; font-weight:700; color:#b36b00; padding-top:6px;">${esc(testo)}<div style="font-size:0.9rem; font-weight:400; color:#555; margin-top:6px;">Per informazioni rivolgiti al Direttivo del Gruppo.</div></div>`;
  const disegnaForm = () => {
    if (chiusa) { root.innerHTML = `${intestazione}${messaggioChiuso("Le iscrizioni a questa cena sono chiuse.")}`; return; }
    root.innerHTML = `
      ${intestazione}
      <div class="form-group" style="text-align:left;"><label>Nome della persona</label><input type="text" id="cr-nome" placeholder="Nome e cognome" style="width:100%; padding:10px; font-size:1rem;"></div>
      <div style="margin:14px 0 2px; color:#555;">In quanti sarete in totale (questa persona compresa)?</div>
      <div style="font-size:0.75rem; color:#888; margin-bottom:8px;">Es. lei/lui + 3 familiari = imposta 4</div>
      <div style="display:flex; align-items:center; justify-content:center; gap:16px;">
        <button type="button" id="cr-meno" style="width:52px; height:52px; font-size:1.6rem; font-weight:800; border-radius:50%; border:none; background:#eee;">−</button>
        <div id="cr-numero" style="font-size:2.2rem; font-weight:900; min-width:50px;">1</div>
        <button type="button" id="cr-piu" style="width:52px; height:52px; font-size:1.6rem; font-weight:800; border-radius:50%; border:none; background:#eee;">+</button>
      </div>
      <button type="button" id="cr-conferma" style="width:100%; margin-top:22px; padding:16px; font-size:1.1rem; font-weight:800; background:#1a6b3c; color:#fff; border:none; border-radius:12px;">✅ Conferma presenza</button>
      <div id="cr-msg" style="margin-top:14px; font-weight:700;"></div>
    `;
    let n = 1;
    const num = document.getElementById("cr-numero");
    document.getElementById("cr-meno").addEventListener("click", () => { if (n > 1) { n--; num.textContent = n; } });
    document.getElementById("cr-piu").addEventListener("click", () => { n++; num.textContent = n; });
    document.getElementById("cr-conferma").addEventListener("click", async () => {
      const nome = document.getElementById("cr-nome").value.trim();
      if (!nome) { document.getElementById("cr-msg").textContent = "Inserisci il nome."; return; }
      const btn = document.getElementById("cr-conferma");
      btn.disabled = true;
      document.getElementById("cr-msg").textContent = "Invio in corso...";
      try {
        const esito = await scriviRispostaCena(cenaId, uid(), { nome, persone: n, ts: new Date().toISOString() }, {});
        if (esito.errore) {
          if (esito.chiuse) { root.innerHTML = `${intestazione}${messaggioChiuso(esito.errore)}`; return; }
          btn.disabled = false; document.getElementById("cr-msg").textContent = esito.errore; return;
        }
        scriviLog([{ ev: `🍽️ Risposta alla cena "${c.titolo || ""}": ${nome} (${n} ${n === 1 ? "persona" : "persone"})` }], "__pubblico__");
        root.innerHTML = `${intestazione}<div style="font-size:1.1rem; font-weight:700; color:#1a6b3c; padding-top:10px;">✅ Grazie! Confermate ${n} ${n === 1 ? "persona" : "persone"} per ${esc(nome)}.</div><button type="button" id="cr-altra" style="width:100%; margin-top:18px; padding:14px; font-size:1rem; font-weight:700; background:#eee; border:none; border-radius:12px;">➕ Conferma un'altra persona</button>`;
        document.getElementById("cr-altra").addEventListener("click", disegnaForm);
      } catch (err) {
        console.error(err);
        btn.disabled = false;
        document.getElementById("cr-msg").textContent = "Errore nell'invio, riprova.";
      }
    });
  };
  disegnaForm();
}


function renderLibretto() {
  const preghiera = (state.settings.testoPreghiera || "").trim();
  const canto = (state.settings.testoCanto || "").trim();
  return `
    <div class="section-title">📖 Preghiera e Canto</div>
    <div class="card">
      <div style="font-weight:800; margin-bottom:8px;">🙏 Preghiera dell'Alpino</div>
      ${preghiera
        ? `<div style="white-space:pre-wrap; line-height:1.6;">${esc(preghiera)}</div>`
        : `<div class="card-sub">Testo non ancora inserito. Vai in Impostazioni per aggiungerlo.</div>`}
    </div>
    <div class="card" style="margin-top:14px;">
      <div style="font-weight:800; margin-bottom:8px;">🎵 Signore delle Cime</div>
      ${canto
        ? `<div style="white-space:pre-wrap; line-height:1.6;">${esc(canto)}</div>`
        : `<div class="card-sub">Testo non ancora inserito. Vai in Impostazioni per aggiungerlo.</div>`}
    </div>
  `;
}

function pulisciEventiScadutiBacheca() {
  const oggi = new Date(); oggi.setHours(0, 0, 0, 0);
  const filtrata = state.bacheca.filter(a => {
    if (!a.data) return true; // senza data, non scade da solo
    const d = parseDataISO(a.data);
    if (!d) return true;
    const giorniPassati = Math.floor((oggi - d) / 86400000);
    return giorniPassati < 2;
  });
  if (filtrata.length === state.bacheca.length) return;
  // Questo è l'unico salvataggio che parte da solo: se il telefono non ha ancora ricevuto i dati
  // aggiornati da Firebase potrebbe riscrivere dati vecchi e cancellare le modifiche fatte da altri.
  // Quindi aspetta: riproverà al prossimo disegno della Bacheca, a dati allineati.
  if (window.db && !SYNC_STATO.ricevuto) return;
  state.bacheca = filtrata;
  logComeSistema = true;
  try { saveState(); } finally { logComeSistema = false; }
}

function parseDataISO(str) {
  const d = new Date((str || "") + "T00:00:00");
  return isNaN(d.getTime()) ? null : d;
}

function cardAvviso(a, soloLettura) {
  const isPdf = (a.allegatoNome || "").toLowerCase().endsWith(".pdf");
  const thumb = a.allegatoThumbUrl || (isPdf ? "" : a.allegatoUrl);
  return `
    <div class="card" data-avviso-id="${a.id}" data-dettaglio-avviso="${a.id}" style="cursor:pointer;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <div style="font-weight:800;">${esc(a.titolo || "Avviso")}${isPdf ? " 📄" : ""}</div>
          <div class="card-sub">${a.data ? "📅 " + fmtDate(a.data) : fmtDateTime(a.creato)}</div>
        </div>
        ${soloLettura ? "" : `<button type="button" class="btn danger" data-elimina-avviso="${a.id}" style="padding:5px 10px; font-size:0.8rem;">🗑️</button>`}
      </div>
      ${thumb ? `<img src="${esc(thumb)}" style="max-width:100%; border-radius:8px; margin-top:8px; border:1px solid #ccc;">` : ""}
    </div>`;
}

function renderBacheca() {
  pulisciEventiScadutiBacheca();
  const soloLettura = currentRole === "socio";
  const avvisi = [...state.bacheca].sort((a, b) => {
    if (a.data && b.data) return a.data.localeCompare(b.data);
    if (a.data) return -1;
    if (b.data) return 1;
    return (b.creato || "").localeCompare(a.creato || "");
  });

  const prossimo = avvisi.length ? avvisi[0] : null;
  const altri = avvisi.slice(1);
  const altriHtml = altri.length ? altri.map(a => cardAvviso(a, soloLettura)).join("") : (prossimo ? "" : `<div class="card-sub">Nessun avviso in bacheca.</div>`);

  const formNuovoAvviso = soloLettura ? "" : `
    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Nuovo avviso</div>
      <div class="form-group"><label>Titolo</label><input type="text" id="avviso-titolo" placeholder="Es. Raduno Adunata Nazionale"></div>
      <div class="form-group"><label>Data evento (opzionale)</label><input type="date" id="avviso-data"></div>
      <div class="form-group"><label>Testo (opzionale)</label><textarea id="avviso-testo" rows="3" placeholder="Dettagli dell'avviso..."></textarea></div>
      <div class="form-group"><label>Allegato PDF o foto (opzionale)</label><input type="file" id="avviso-file" accept=".pdf,image/*"></div>
      <button type="button" class="btn block" id="crea-avviso-btn" style="margin-top:6px;">➕ Pubblica avviso</button>
    </div>`;

  return `
    <div class="section-title">📌 Bacheca</div>
    <div class="card-sub" style="margin-bottom:12px;">Avvisi semplici o con un allegato (PDF/foto di una locandina) per informare il gruppo. Gli eventi con data vengono rimossi da soli 2 giorni dopo.</div>

    ${prossimo ? `<div class="section-title" style="font-size:1.05rem;">⏭️ Il prossimo</div>${cardAvviso(prossimo, soloLettura)}` : ""}

    ${formNuovoAvviso}

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Altri avvisi</div>
    <div id="bacheca-lista">${altriHtml}</div>
  `;
}

function attachBachecaEvents() {
  const creaBtn = document.getElementById("crea-avviso-btn");
  if (creaBtn) creaBtn.addEventListener("click", creaAvviso);
  document.querySelectorAll("[data-elimina-avviso]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); eliminaAvviso(btn.dataset.eliminaAvviso); });
  });
  document.querySelectorAll("[data-dettaglio-avviso]").forEach(el => {
    el.addEventListener("click", () => apriDettaglioAvviso(el.dataset.dettaglioAvviso));
  });
}

function apriDettaglioAvviso(avvisoId) {
  const a = state.bacheca.find(x => x.id === avvisoId);
  if (!a) return;
  const isPdf = (a.allegatoNome || "").toLowerCase().endsWith(".pdf");
  let allegatoHtml = "";
  if (a.allegatoThumbUrl) {
    allegatoHtml += `<img src="${esc(a.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; margin-top:10px; border:1px solid #ccc;">`;
  }
  if (a.allegatoUrl && isPdf) {
    allegatoHtml += `<a href="${esc(a.allegatoUrl)}" target="_blank" class="btn block" style="margin-top:10px;">📄 Apri ${esc(a.allegatoNome || "PDF")}</a>`;
  }
  const html = `
    <div style="font-weight:900; font-size:1.2rem; margin-bottom:2px;">${esc(a.titolo || "Avviso")}</div>
    <div class="card-sub" style="margin-bottom:10px;">${a.data ? "📅 " + fmtDate(a.data) : fmtDateTime(a.creato)}</div>
    ${a.testo ? `<div style="white-space:pre-wrap;">${esc(a.testo)}</div>` : ""}
    ${allegatoHtml}
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="btn secondary block" id="dettaglio-avviso-chiudi">Chiudi</button>
    </div>
  `;
  showModal(html);
  document.getElementById("dettaglio-avviso-chiudi").addEventListener("click", closeModal);
}

async function generaMiniaturaPdf(file) {
  if (typeof pdfjsLib === "undefined") return null;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

async function creaAvviso() {
  const titolo = document.getElementById("avviso-titolo").value.trim();
  const data = document.getElementById("avviso-data").value;
  const testo = document.getElementById("avviso-testo").value.trim();
  const file = document.getElementById("avviso-file").files[0];
  if (!titolo) { alert("Inserisci un titolo per l'avviso"); return; }
  const id = uid();
  const nuovo = { id, titolo, data, testo, creato: new Date().toISOString(), allegatoUrl: "", allegatoNome: "", allegatoThumbUrl: "" };

  if (file) {
    if (window.storage) {
      try {
        toast("Caricamento allegato...");
        nuovo.allegatoUrl = await uploadDocumento(file, `bacheca/${id}`);
        nuovo.allegatoNome = file.name;
        if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
          toast("Genero l'anteprima della locandina...");
          const miniatura = await generaMiniaturaPdf(file);
          if (miniatura) nuovo.allegatoThumbUrl = await uploadDocumento(miniatura, `bacheca/${id}_thumb`);
        } else {
          nuovo.allegatoThumbUrl = nuovo.allegatoUrl;
        }
      } catch (err) {
        console.error(err);
        alert("Errore nel caricamento dell'allegato. L'avviso viene comunque pubblicato senza allegato.");
      }
    } else {
      alert("Firebase non configurato: l'allegato non può essere caricato su questo dispositivo.");
    }
  }

  state.bacheca.push(nuovo);
  saveState();
  renderSection();
  toast("Avviso pubblicato");
}

function eliminaAvviso(avvisoId) {
  if (!confirm("Eliminare questo avviso?")) return;
  state.bacheca = state.bacheca.filter(a => a.id !== avvisoId);
  saveState();
  renderSection();
}

// ---------- Presenza Adunata ----------
const MESI_IT = ["gennaio","febbraio","marzo","aprile","maggio","giugno","luglio","agosto","settembre","ottobre","novembre","dicembre"];

function chiaveDataAdunata(str) {
  const s = (str || "").toLowerCase();
  const annoMatch = s.match(/\b(20\d{2}|19\d{2})\b/);
  const anno = annoMatch ? parseInt(annoMatch[1], 10) : 0;
  let mese = 0;
  for (let i = 0; i < MESI_IT.length; i++) {
    if (s.includes(MESI_IT[i])) { mese = i + 1; break; }
  }
  if (!mese) {
    const numMatch = s.match(/\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})\b/);
    if (numMatch) mese = parseInt(numMatch[2], 10);
  }
  const giornoMatch = s.match(/\b(\d{1,2})\b/);
  const giorno = giornoMatch ? parseInt(giornoMatch[1], 10) : 0;
  return anno * 10000 + mese * 100 + giorno;
}

function cardAdunata(a, soloLettura) {
  const isPdf = (a.allegatoNome || "").toLowerCase().endsWith(".pdf");
  const thumb = a.allegatoThumbUrl || (isPdf ? "" : a.allegatoUrl);
  return `
    <div class="card" data-adunata-id="${a.id}" data-dettaglio-adunata="${a.id}" style="cursor:pointer;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <div style="font-weight:800;">${esc(a.titolo || "Adunata")}${isPdf ? " 📄" : ""}</div>
          <div class="card-sub">${esc(a.data) || ""}</div>
        </div>
        ${soloLettura ? "" : `<button type="button" class="btn danger" data-elimina-adunata="${a.id}" style="padding:5px 10px; font-size:0.8rem;">🗑️</button>`}
      </div>
      ${thumb ? `<img src="${esc(thumb)}" style="max-width:100%; border-radius:8px; margin-top:8px; border:1px solid #ccc;">` : ""}
    </div>`;
}

function renderPresenzaAdunata() {
  const soloLettura = currentRole === "socio";
  const adunate = [...state.adunate].sort((a, b) => chiaveDataAdunata(b.data) - chiaveDataAdunata(a.data));
  const listaHtml = adunate.length ? adunate.map(a => cardAdunata(a, soloLettura)).join("") : `<div class="card-sub">Nessuna adunata inserita.</div>`;

  const formNuovaAdunata = soloLettura ? "" : `
    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Nuova adunata</div>
      <div class="form-group"><label>Titolo</label><input type="text" id="adunata-titolo" placeholder="Es. Adunata Nazionale Vicenza"></div>
      <div class="form-group"><label>Data</label><input type="text" id="adunata-data" placeholder="Es. 10-11-12 Maggio 2027"></div>
      <div class="form-group"><label>Locandina (PDF o foto)</label><input type="file" id="adunata-file" accept=".pdf,image/*"></div>
      <button type="button" class="btn block" id="crea-adunata-btn" style="margin-top:6px;">➕ Pubblica adunata</button>
    </div>`;

  return `
    <div class="section-title">🎖️ Presenza Adunata</div>
    <div class="card-sub" style="margin-bottom:12px;">Elenco delle adunate, con locandina.</div>

    ${formNuovaAdunata}

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Adunate</div>
    <div id="adunata-lista">${listaHtml}</div>
  `;
}

function attachPresenzaAdunataEvents() {
  const creaBtn = document.getElementById("crea-adunata-btn");
  if (creaBtn) creaBtn.addEventListener("click", creaAdunata);
  document.querySelectorAll("[data-elimina-adunata]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); eliminaAdunata(btn.dataset.eliminaAdunata); });
  });
  document.querySelectorAll("[data-dettaglio-adunata]").forEach(card => {
    card.addEventListener("click", () => apriDettaglioAdunata(card.dataset.dettaglioAdunata));
  });
}

// ---------- Verbali Consiglio ----------
function cardVerbale(v, soloLettura) {
  return `
    <div class="card" data-dettaglio-verbale="${v.id}" style="cursor:pointer;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <div style="font-weight:800;">${esc(v.titolo || "Verbale")} 📄</div>
          <div class="card-sub">${v.data ? "📅 " + fmtDate(v.data) : ""}</div>
        </div>
        ${soloLettura ? "" : `<button type="button" class="btn danger" data-elimina-verbale="${v.id}" style="padding:5px 10px; font-size:0.8rem;">🗑️</button>`}
      </div>
      ${v.allegatoThumbUrl ? `<img src="${esc(v.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; margin-top:8px; border:1px solid #ccc;">` : ""}
    </div>`;
}

function renderVerbali() {
  const soloLettura = currentRole === "socio";
  const elenco = [...(state.verbali || [])].sort((a, b) => {
    if (!a.data && !b.data) return (b.creato || "").localeCompare(a.creato || "");
    if (!a.data) return 1;
    if (!b.data) return -1;
    return b.data.localeCompare(a.data);
  });
  const listaHtml = elenco.length ? elenco.map(v => cardVerbale(v, soloLettura)).join("") : `<div class="card-sub">Nessun verbale pubblicato.</div>`;

  const form = soloLettura ? "" : `
    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Nuovo verbale</div>
      <div class="form-group"><label>Titolo</label><input type="text" id="verbale-titolo" placeholder="Es. Verbale del Consiglio del 12 ottobre"></div>
      <div class="form-group"><label>Data della riunione</label><input type="date" id="verbale-data"></div>
      <div class="form-group"><label>File PDF del verbale</label><input type="file" id="verbale-file" accept=".pdf,application/pdf"></div>
      <button type="button" class="btn block" id="crea-verbale-btn" style="margin-top:6px;">➕ Pubblica verbale</button>
    </div>`;

  return `
    <div class="section-title">📑 Verbali Consiglio</div>
    <div class="card-sub" style="margin-bottom:12px;">Verbali delle riunioni del Consiglio Direttivo, dal più recente.</div>
    ${form}
    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Verbali</div>
    <div id="verbali-lista">${listaHtml}</div>
  `;
}

function attachVerbaliEvents() {
  const creaBtn = document.getElementById("crea-verbale-btn");
  if (creaBtn) creaBtn.addEventListener("click", creaVerbale);
  document.querySelectorAll("[data-elimina-verbale]").forEach(btn => {
    btn.addEventListener("click", e => { e.stopPropagation(); eliminaVerbale(btn.dataset.eliminaVerbale); });
  });
  document.querySelectorAll("[data-dettaglio-verbale]").forEach(card => {
    card.addEventListener("click", () => apriDettaglioVerbale(card.dataset.dettaglioVerbale));
  });
}

function apriDettaglioVerbale(id) {
  const v = (state.verbali || []).find(x => x.id === id);
  if (!v) return;
  const html = `
    <div style="font-weight:900; font-size:1.2rem; margin-bottom:2px;">${esc(v.titolo || "Verbale")}</div>
    <div class="card-sub" style="margin-bottom:10px;">${v.data ? "📅 " + fmtDate(v.data) : ""}</div>
    ${v.allegatoThumbUrl ? `<img src="${esc(v.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; border:1px solid #ccc;">` : ""}
    ${v.allegatoUrl ? `<a href="${esc(v.allegatoUrl)}" target="_blank" class="btn block" style="margin-top:10px;">📄 Apri il verbale</a>` : ""}
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="btn secondary block" id="dettaglio-verbale-chiudi">Chiudi</button>
    </div>
  `;
  showModal(html);
  document.getElementById("dettaglio-verbale-chiudi").addEventListener("click", closeModal);
}

async function creaVerbale() {
  const titolo = document.getElementById("verbale-titolo").value.trim();
  const data = document.getElementById("verbale-data").value;
  const file = document.getElementById("verbale-file").files[0];
  if (!titolo) { alert("Inserisci un titolo per il verbale"); return; }
  if (!file) { alert("Seleziona il file PDF del verbale"); return; }
  if (!(file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf")) { alert("Il verbale deve essere un file PDF"); return; }
  if (!window.storage) { alert("Firebase non configurato: il verbale non può essere caricato su questo dispositivo."); return; }
  const id = uid();
  const nuovo = { id, titolo, data, creato: new Date().toISOString(), allegatoUrl: "", allegatoNome: file.name, allegatoThumbUrl: "" };
  try {
    toast("Caricamento verbale...");
    nuovo.allegatoUrl = await uploadDocumento(file, `verbali/${id}`);
  } catch (err) {
    console.error(err);
    alert("Errore nel caricamento del verbale. Riprova.");
    return;
  }
  try {
    const miniatura = await generaMiniaturaPdf(file);
    if (miniatura) nuovo.allegatoThumbUrl = await uploadDocumento(miniatura, `verbali/${id}_thumb`);
  } catch (err) {
    console.warn("Anteprima verbale non generata", err);
  }
  state.verbali = state.verbali || [];
  state.verbali.push(nuovo);
  saveState();
  renderSection();
  toast("Verbale pubblicato");
}

function eliminaVerbale(id) {
  if (!confirm("Eliminare questo verbale?")) return;
  state.verbali = (state.verbali || []).filter(v => v.id !== id);
  saveState();
  renderSection();
}

// ---------- Archivio BUI (riservato a Capogruppo e Admin) ----------
function cardBui(v) {
  const ext = (v.allegatoNome || "").split(".").pop().toLowerCase();
  const icona = ext === "pdf" ? "📄" : (["jpg", "jpeg", "png", "gif", "webp"].includes(ext) ? "🖼️" : "📎");
  return `
    <div class="card" data-dettaglio-bui="${v.id}" style="cursor:pointer;">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <div style="font-weight:800;">${esc(v.titolo || "Documento")} ${icona}</div>
          <div class="card-sub">${v.data ? "📅 " + fmtDate(v.data) : ""}</div>
          ${v.note ? `<div class="card-sub" style="margin-top:2px;">${esc(v.note)}</div>` : ""}
        </div>
        <button type="button" class="btn danger" data-elimina-bui="${v.id}" style="padding:5px 10px; font-size:0.8rem;">🗑️</button>
      </div>
      ${v.allegatoThumbUrl ? `<img src="${esc(v.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; margin-top:8px; border:1px solid #ccc;">` : ""}
    </div>`;
}

function elencoBuiOrdinato(filtro) {
  const q = (filtro || "").trim().toLowerCase();
  return [...(state.archivioBui || [])]
    .filter(v => !q || `${v.titolo || ""} ${v.note || ""}`.toLowerCase().includes(q))
    .sort((a, b) => {
      if (!a.data && !b.data) return (b.creato || "").localeCompare(a.creato || "");
      if (!a.data) return 1;
      if (!b.data) return -1;
      return b.data.localeCompare(a.data);
    });
}

function renderArchivioBui() {
  const lista = elencoBuiOrdinato("");
  return `
    <div class="section-title">🗄️ Archivio BUI</div>
    <div class="card-sub" style="margin-bottom:12px;">Archivio documenti riservato al Capogruppo e all'amministratore.</div>
    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Nuovo documento</div>
      <div class="form-group"><label>Titolo *</label><input type="text" id="bui-titolo" placeholder="Es. Comunicazione sezione, anno 2026"></div>
      <div class="form-group"><label>Data (facoltativa)</label><input type="date" id="bui-data"></div>
      <div class="form-group"><label>Note (facoltative)</label><input type="text" id="bui-note" placeholder="Breve descrizione"></div>
      <div class="form-group"><label>File (PDF, foto, Word o Excel) *</label><input type="file" id="bui-file" accept=".pdf,application/pdf,image/*,.doc,.docx,.xls,.xlsx,.txt"></div>
      <button type="button" class="btn block" id="crea-bui-btn" style="margin-top:6px;">➕ Aggiungi all'archivio</button>
    </div>
    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Documenti (${lista.length})</div>
    <input type="text" id="bui-filtro" placeholder="Cerca per titolo o note..." style="width:100%; margin-bottom:10px; box-sizing:border-box;">
    <div id="bui-lista">${lista.length ? lista.map(cardBui).join("") : `<div class="card-sub">Nessun documento in archivio.</div>`}</div>
  `;
}

function attachArchivioBuiEvents() {
  document.getElementById("crea-bui-btn").addEventListener("click", creaDocumentoBui);
  const lista = document.getElementById("bui-lista");
  document.getElementById("bui-filtro").addEventListener("input", e => {
    const el = elencoBuiOrdinato(e.target.value);
    lista.innerHTML = el.length ? el.map(cardBui).join("") : `<div class="card-sub">Nessun documento corrisponde alla ricerca.</div>`;
  });
  lista.addEventListener("click", e => {
    const del = e.target.closest("[data-elimina-bui]");
    if (del) { e.stopPropagation(); eliminaDocumentoBui(del.dataset.eliminaBui); return; }
    const card = e.target.closest("[data-dettaglio-bui]");
    if (card) apriDettaglioBui(card.dataset.dettaglioBui);
  });
}

function apriDettaglioBui(id) {
  const v = (state.archivioBui || []).find(x => x.id === id);
  if (!v) return;
  const html = `
    <div style="font-weight:900; font-size:1.2rem; margin-bottom:2px;">${esc(v.titolo || "Documento")}</div>
    <div class="card-sub" style="margin-bottom:6px;">${v.data ? "📅 " + fmtDate(v.data) : ""}</div>
    ${v.note ? `<div class="card-sub" style="margin-bottom:10px;">${esc(v.note)}</div>` : ""}
    ${v.allegatoThumbUrl ? `<img src="${esc(v.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; border:1px solid #ccc;">` : ""}
    ${v.allegatoUrl ? `<a href="${esc(v.allegatoUrl)}" target="_blank" class="btn block" style="margin-top:10px;">📄 Apri ${esc(v.allegatoNome || "il file")}</a>` : ""}
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="btn secondary block" id="dettaglio-bui-chiudi">Chiudi</button>
    </div>
  `;
  showModal(html);
  document.getElementById("dettaglio-bui-chiudi").addEventListener("click", closeModal);
}

async function creaDocumentoBui() {
  if (!puoVedereArchivioBui()) return;
  const titolo = document.getElementById("bui-titolo").value.trim();
  const data = document.getElementById("bui-data").value;
  const note = document.getElementById("bui-note").value.trim();
  const file = document.getElementById("bui-file").files[0];
  if (!titolo) { alert("Inserisci un titolo per il documento"); return; }
  if (!file) { alert("Seleziona il file da archiviare"); return; }
  if (!window.storage) { alert("Firebase non configurato: il documento non può essere caricato su questo dispositivo."); return; }
  const id = uid();
  const nuovo = { id, titolo, data, note, creato: new Date().toISOString(), allegatoUrl: "", allegatoNome: file.name, allegatoThumbUrl: "" };
  const isPdf = file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf";
  try {
    toast("Caricamento documento...");
    nuovo.allegatoUrl = await uploadDocumento(file, `archivio-bui/${id}`);
  } catch (err) {
    console.error(err);
    alert("Errore nel caricamento del documento. Riprova.");
    return;
  }
  try {
    if (isPdf) {
      const miniatura = await generaMiniaturaPdf(file);
      if (miniatura) nuovo.allegatoThumbUrl = await uploadDocumento(miniatura, `archivio-bui/${id}_thumb`);
    } else if ((file.type || "").startsWith("image/")) {
      nuovo.allegatoThumbUrl = nuovo.allegatoUrl;
    }
  } catch (err) {
    console.warn("Anteprima non generata", err);
  }
  state.archivioBui = state.archivioBui || [];
  state.archivioBui.push(nuovo);
  saveState();
  renderSection();
  toast("Documento archiviato");
}

function eliminaDocumentoBui(id) {
  if (!puoVedereArchivioBui()) return;
  if (!confirm("Eliminare questo documento dall'archivio?")) return;
  state.archivioBui = (state.archivioBui || []).filter(v => v.id !== id);
  saveState();
  renderSection();
}

// ---------- Beneficenza (vendite di prodotti il cui ricavato va in beneficenza) ----------
// Ogni campagna ha prodotti, prenotazioni (nome + quantità), consegne e incassi. Tutte le scritture passano
// da una transazione che modifica SOLO l'elenco delle campagne: così un telefono con dati vecchi non può
// sovrascrivere il resto e due prenotazioni fatte nello stesso momento non si perdono.
let benCampagnaId = null;
let benFiltro = "";
let benProdottiForm = [];
const BEN_STATI = { aperta: "Prenotazioni aperte", consegna: "Prenotazioni chiuse, in consegna", conclusa: "Conclusa" };

function benNum(v) { const n = parseFloat(String(v === undefined || v === null ? "" : v).replace(",", ".")); return isNaN(n) ? 0 : n; }
function benEuro(v) { return benNum(v).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"; }
function benOggi() { const d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
function benGestore() { return currentRole === "admin" || currentRole === "direttivo"; }
function benMioId() { const s = socioCorrente(); return s ? s.id : null; }
function benTrova(id) { return (state.campagneBeneficenza || []).find(c => c.id === id); }
function benPrenotabile(c) { return !!c && c.stato === "aperta" && (!c.chiusuraPrenotazioni || benOggi() <= c.chiusuraPrenotazioni); }
function benPezzi(r) { return Object.values(r.q || {}).reduce((s, n) => s + (Number(n) || 0), 0); }
function benImporto(c, r) { return (c.prodotti || []).reduce((s, p) => s + (Number((r.q || {})[p.id]) || 0) * benNum(p.prezzo), 0); }
// Incasso = soldi realmente ricevuti. Le prenotazioni segnate "pagato" prima della 8.05 valgono l'importo dovuto.
function benIncassato(c, r) {
  if (r.importoPagato !== undefined && r.importoPagato !== null && r.importoPagato !== "") return Math.max(0, benNum(r.importoPagato));
  return r.pagato ? benImporto(c, r) : 0;
}
function benHaIncasso(c, r) { return benIncassato(c, r) > 0.004; }
function benStatoPagamento(c, r) {
  const inc = benIncassato(c, r), dov = benImporto(c, r);
  const stato = inc <= 0.004 ? "da pagare" : (inc < dov - 0.004 ? "parziale" : "pagato");
  return { stato, inc, dov, diff: inc - dov };
}
function benTestoDifferenza(diff) { return diff > 0.004 ? "+" + benEuro(diff) + " in più" : (diff < -0.004 ? "mancano " + benEuro(-diff) : ""); }

function benArticoli(c, r) { return (c.prodotti || []).filter(p => Number((r.q || {})[p.id]) > 0).map(p => `${r.q[p.id]}× ${p.nome}`).join(", "); }

function benTotali(c) {
  const per = {};
  (c.prodotti || []).forEach(p => { per[p.id] = { prenotati: 0, consegnati: 0 }; });
  let dovuto = 0, incassato = 0, inPiu = 0, mancante = 0, nPezzi = 0;
  (c.prenotazioni || []).forEach(r => {
    (c.prodotti || []).forEach(p => {
      const q = Number((r.q || {})[p.id]) || 0;
      if (q > 0) { per[p.id].prenotati += q; if (r.consegnato) per[p.id].consegnati += q; }
    });
    const imp = benImporto(c, r), inc = benIncassato(c, r);
    dovuto += imp; incassato += inc; inPiu += Math.max(0, inc - imp); mancante += Math.max(0, imp - inc); nPezzi += benPezzi(r);
  });
  (c.prodotti || []).forEach(p => {
    const mass = Math.floor(benNum(p.massimo));
    per[p.id].massimo = mass;
    per[p.id].disponibili = mass > 0 ? Math.max(0, mass - per[p.id].prenotati) : null;   // null = nessun limite
  });
  const costo = (c.prodotti || []).reduce((s, p) => s + benNum(p.ricevuti) * benNum(p.costo), 0);
  return { per, dovuto, incassato, inPiu, daIncassare: mancante, nPren: (c.prenotazioni || []).length, nPezzi, costo, ricavato: incassato - costo };
}

// Scrive le campagne con una transazione. mutatore(campagne) modifica una copia e può restituire {errore}.
async function benScrivi(mutatore, evLog) {
  const copia = x => JSON.parse(JSON.stringify(x || []));
  let nuove = null, esito = {};
  if (window.db) {
    const ref = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
    await conTimeout(db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      const camp = copia(snap.exists ? snap.data().campagneBeneficenza : state.campagneBeneficenza);
      esito = mutatore(camp) || {};
      if (esito.errore) return;
      nuove = camp;
      tx.set(ref, { campagneBeneficenza: camp }, { merge: true });
    }), 15000);
    if (esito.errore) return esito;
    state.campagneBeneficenza = nuove;
    localStorage.setItem("gestione_gruppo_data", JSON.stringify(state));
    logAggiornaBaseline();
  } else {
    const camp = copia(state.campagneBeneficenza);
    esito = mutatore(camp) || {};
    if (esito.errore) return esito;
    state.campagneBeneficenza = camp;
    saveState();
  }
  if (evLog) scriviLog([{ ev: evLog }]);
  renderSection();
  return esito;
}

function benBadgeStato(c) {
  const aperta = benPrenotabile(c);
  const testo = c.stato === "aperta" && !aperta ? "Prenotazioni chiuse" : (BEN_STATI[c.stato] || c.stato);
  return `<span class="badge${aperta ? "" : " badge-warning"}">${aperta ? "🟢 " : ""}${esc(testo)}</span>`;
}

function renderBeneficenza() {
  let html;
  if (benGestore()) {
    const c = benCampagnaId ? benTrova(benCampagnaId) : null;
    if (!c) benCampagnaId = null;
    html = c ? renderBenDettaglio(c) : renderBenElencoGestore();
  } else {
    html = renderBenSoci();
  }
  return `<div id="ben-root">${html}</div>`;
}

function renderBenElencoGestore() {
  const camp = [...(state.campagneBeneficenza || [])].sort((a, b) =>
    (a.stato === "conclusa") - (b.stato === "conclusa") || (b.creato || "").localeCompare(a.creato || ""));
  const cards = camp.length ? camp.map(c => {
    const t = benTotali(c);
    return `
    <div class="card" data-ben="apri" data-id="${c.id}" style="cursor:pointer;">
      <div class="card-name">${esc(c.titolo)}</div>
      <div class="card-sub">${esc(c.produttore || "")}${c.produttore && c.destinazione ? " · " : ""}${c.destinazione ? "ricavato a: " + esc(c.destinazione) : ""}</div>
      <div class="badge-row" style="margin-top:6px;">${benBadgeStato(c)}</div>
      <div class="card-sub" style="margin-top:6px;">${t.nPren} prenotazioni · ${t.nPezzi} pezzi · da incassare ${benEuro(t.dovuto)} · incassati ${benEuro(t.incassato)}</div>
    </div>`;
  }).join("") : `<div class="card-sub">Nessuna campagna: creane una con il tasto qui sopra.</div>`;
  return `
    <div class="section-title">🎁 Panettoni &amp; C</div>
    <div class="card-sub" style="margin-bottom:12px;">Prodotti dei produttori il cui ricavato va in beneficenza: prenotazioni dei soci, consegne, incassi e rendiconto finale.</div>
    <button type="button" class="btn block" data-ben="nuova-campagna" style="margin-bottom:14px;">➕ Nuova campagna</button>
    ${cards}`;
}

function benHtmlPrenotazioni(c) {
  const q = benFiltro.trim().toLowerCase();
  const lista = [...(c.prenotazioni || [])]
    .filter(r => !q || `${r.nome} ${r.prenotatoDa || ""}`.toLowerCase().includes(q))
    .sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "it"));
  if (!lista.length) return `<div class="card-sub">${(c.prenotazioni || []).length ? "Nessuna prenotazione corrisponde alla ricerca." : "Nessuna prenotazione."}</div>`;
  return lista.map(r => {
    const sp = benStatoPagamento(c, r);
    const diff = benTestoDifferenza(sp.diff);
    const etichetta = sp.stato === "pagato" ? (sp.diff > 0.004 ? "✅ Pagato (+" + benEuro(sp.diff) + ")" : "✅ Pagato") : (sp.stato === "parziale" ? "🟡 Parziale" : "💶 Da pagare");
    return `
    <div class="card" style="padding:12px;">
      <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
        <div>
          <div class="card-name">${esc(r.nome)}</div>
          ${r.prenotatoDa && r.prenotatoDa !== r.nome ? `<div class="card-sub">prenotato da ${esc(r.prenotatoDa)}</div>` : ""}
          <div class="card-sub">${esc(benArticoli(c, r)) || "-"}</div>
          ${r.note ? `<div class="card-sub">📝 ${esc(r.note)}</div>` : ""}
          <div class="card-sub" style="font-weight:700;">${benEuro(sp.dov)}${sp.inc > 0.004 ? ` · incassati ${benEuro(sp.inc)}${diff ? " (" + diff + ")" : ""}` : ""}</div>
        </div>
        <div class="card-actions">
          <button type="button" data-ben="modifica-pren" data-id="${c.id}" data-pid="${r.id}">✏️</button>
          <button type="button" data-ben="elimina-pren" data-id="${c.id}" data-pid="${r.id}">🗑️</button>
        </div>
      </div>
      <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
        <button type="button" class="btn ${sp.stato === "da pagare" ? "secondary" : ""}" data-ben="incasso" data-id="${c.id}" data-pid="${r.id}" style="padding:6px 12px; font-size:0.82rem;">${etichetta}</button>
        <button type="button" class="btn ${r.consegnato ? "" : "secondary"}" data-ben="consegnato" data-val="${r.consegnato ? 0 : 1}" data-id="${c.id}" data-pid="${r.id}" style="padding:6px 12px; font-size:0.82rem;">${r.consegnato ? "✅ Consegnato" : "📦 Da consegnare"}</button>
      </div>
    </div>`;
  }).join("");
}

function renderBenDettaglio(c) {
  const t = benTotali(c);
  const righeProd = (c.prodotti || []).map(p => {
    const pr = t.per[p.id];
    const disp = pr.disponibili === null ? "-" : (pr.disponibili === 0 ? "<b style=\"color:#b33;\" title=\"esaurito\">0</b>" : String(pr.disponibili));
    return `
    <tr><td>${esc(p.nome)}</td><td style="text-align:right;">${benNum(p.prezzo).toFixed(2).replace(".", ",")}</td><td style="text-align:right;">${pr.prenotati}</td>
    <td style="text-align:right;">${pr.massimo > 0 ? pr.massimo : "-"}</td><td style="text-align:right;">${disp}</td>
    <td style="text-align:right;">${benNum(p.ricevuti) || "-"}</td><td style="text-align:right;">${pr.consegnati}</td></tr>`;
  }).join("");
  const riga = (et, val, forte) => `<div style="display:flex; justify-content:space-between; padding:3px 0;${forte ? " font-weight:800; border-top:1px solid #ccc; margin-top:4px; padding-top:6px;" : ""}"><span>${et}</span><span style="white-space:nowrap;">${benEuro(val)}</span></div>`;
  return `
    <button type="button" class="btn secondary" data-ben="indietro" style="margin-bottom:10px;">← Tutte le campagne</button>
    <div class="section-title">🎁 ${esc(c.titolo)}</div>
    <div class="card">
      <div class="card-sub">${c.produttore ? "Produttore: <b>" + esc(c.produttore) + "</b><br>" : ""}${c.destinazione ? "Il ricavato va a: <b>" + esc(c.destinazione) + "</b><br>" : ""}${c.chiusuraPrenotazioni ? "Prenotazioni fino al " + fmtDate(c.chiusuraPrenotazioni) + "<br>" : ""}${c.dataConsegna ? "Consegna: " + fmtDate(c.dataConsegna) + "<br>" : ""}${c.note ? "📝 " + esc(c.note) : ""}</div>
      <div class="form-group" style="margin-top:10px;"><label>Fase della campagna</label>
        <select id="ben-stato">${Object.keys(BEN_STATI).map(k => `<option value="${k}" ${c.stato === k ? "selected" : ""}>${BEN_STATI[k]}</option>`).join("")}</select>
      </div>
      <div class="ben-tasti">
        <button type="button" class="btn secondary" data-ben="modifica-campagna" data-id="${c.id}" title="Modifica la campagna">✏️ Modifica</button>
        <button type="button" class="btn danger" data-ben="elimina-campagna" data-id="${c.id}" title="Elimina la campagna">🗑️ Elimina</button>
      </div>
    </div>
    <div class="card">
      <div style="font-weight:800; margin-bottom:8px;">Riepilogo</div>
      <div style="overflow-x:auto;"><table class="tab-ben" style="width:100%; border-collapse:collapse;">
        <thead><tr style="background:#f7f3e8;"><th style="text-align:left;">Prodotto</th><th style="text-align:right;">€</th><th style="text-align:right;">Pren.</th><th style="text-align:right;">Max</th><th style="text-align:right;">Disp.</th><th style="text-align:right;">Ric.</th><th style="text-align:right;">Cons.</th></tr></thead>
        <tbody>${righeProd}</tbody></table></div>
      <div style="margin-top:10px; font-size:0.9rem;">
        ${riga("Totale delle prenotazioni", t.dovuto)}${riga("Incassato", t.incassato)}${t.inPiu > 0.004 ? riga("&nbsp;&nbsp;di cui in più del dovuto", t.inPiu) : ""}${riga("Ancora da incassare", t.daIncassare)}
        ${riga("Costo della merce", t.costo)}${riga("Ricavato per la beneficenza", t.ricavato, true)}
        ${c.versatoImporto ? riga("Già versato" + (c.destinazione ? " a " + esc(c.destinazione) : ""), c.versatoImporto) : ""}
      </div>
      <div class="ben-tasti" style="margin-top:12px;">
        <button type="button" class="btn" data-ben="rendiconto" data-id="${c.id}" title="Rendiconto della campagna">📄 Rendiconto</button>
        <button type="button" class="btn secondary" data-ben="elenco" data-id="${c.id}" title="Elenco consegne">📋 Consegne</button>
      </div>
    </div>
    <button type="button" class="btn block" data-ben="nuova-pren" data-id="${c.id}" style="margin-bottom:10px;">➕ Nuova prenotazione</button>
    <input type="text" id="ben-filtro" placeholder="Cerca per nome..." value="${esc(benFiltro)}" style="width:100%; margin-bottom:10px; box-sizing:border-box;">
    <div id="ben-pren-lista">${benHtmlPrenotazioni(c)}</div>`;
}

function renderBenSoci() {
  const mio = benMioId();
  const attive = [...(state.campagneBeneficenza || [])].filter(c => c.stato !== "conclusa").sort((a, b) => (b.creato || "").localeCompare(a.creato || ""));
  const concluse = (state.campagneBeneficenza || []).filter(c => c.stato === "conclusa");
  const cards = attive.length ? attive.map(c => {
    const mie = mio ? (c.prenotazioni || []).filter(r => r.socioId === mio) : [];
    const modificabile = r => benPrenotabile(c) && !r.consegnato && !benHaIncasso(c, r);
    const tc = benTotali(c);
    return `
    <div class="card">
      <div class="card-name">${esc(c.titolo)}</div>
      <div class="card-sub">${c.produttore ? "Produttore: " + esc(c.produttore) + "<br>" : ""}${c.destinazione ? "Il ricavato va a: <b>" + esc(c.destinazione) + "</b><br>" : ""}${c.chiusuraPrenotazioni ? "Prenotazioni fino al " + fmtDate(c.chiusuraPrenotazioni) + "<br>" : ""}${c.dataConsegna ? "Consegna: " + fmtDate(c.dataConsegna) : ""}</div>
      ${c.note ? `<div class="card-sub" style="margin-top:4px;">📝 ${esc(c.note)}</div>` : ""}
      <div style="margin:8px 0; font-size:0.9rem;">${(c.prodotti || []).map(p => { const d = tc.per[p.id].disponibili; return `<div style="display:flex; justify-content:space-between; gap:8px; padding:2px 0;"><span>${esc(p.nome)}${d === null ? "" : (d === 0 ? ` <span style="color:#b33; font-size:0.8rem;">· esaurito</span>` : ` <span style="color:#666; font-size:0.8rem;">· restano ${d}</span>`)}</span><b>${benEuro(p.prezzo)}</b></div>`; }).join("")}</div>
      <div class="badge-row" style="margin-bottom:8px;">${benBadgeStato(c)}</div>
      ${benPrenotabile(c) ? `<button type="button" class="btn block" data-ben="prenota" data-id="${c.id}">🎁 Prenota</button>` : `<div class="card-sub">Le prenotazioni sono chiuse.</div>`}
      ${mie.length ? `<div style="font-weight:800; margin:12px 0 4px;">Le mie prenotazioni</div>` + mie.map(r => `
        <div class="card" style="padding:10px; margin-bottom:6px;">
          <div class="card-sub"><b>${esc(r.nome)}</b>: ${esc(benArticoli(c, r))}</div>
          <div class="card-sub">${(() => { const sp = benStatoPagamento(c, r); return benEuro(sp.dov) + " · " + (sp.stato === "pagato" ? "pagato" : (sp.stato === "parziale" ? "pagato in parte (" + benEuro(sp.inc) + " su " + benEuro(sp.dov) + ")" : "da pagare")); })()} · ${r.consegnato ? "consegnato" : "da consegnare"}</div>
          ${modificabile(r) ? `<div style="display:flex; gap:8px; margin-top:6px;"><button type="button" class="btn secondary" data-ben="modifica-pren" data-id="${c.id}" data-pid="${r.id}" style="padding:5px 12px; font-size:0.82rem;">✏️ Modifica</button><button type="button" class="btn danger" data-ben="annulla-pren" data-id="${c.id}" data-pid="${r.id}" style="padding:5px 12px; font-size:0.82rem;">Annulla</button></div>` : ""}
        </div>`).join("") : ""}
    </div>`;
  }).join("") : `<div class="card-sub">Al momento non ci sono campagne aperte.</div>`;
  const chiuse = concluse.length ? `<div class="section-title" style="font-size:1.05rem; margin-top:22px;">✅ Campagne concluse</div>` + concluse.map(c => `<div class="card"><div class="card-name">${esc(c.titolo)}</div><div class="card-sub">${c.versatoImporto ? "Versati " + benEuro(c.versatoImporto) + (c.destinazione ? " a " + esc(c.destinazione) : "") + (c.versatoData ? " il " + fmtDate(c.versatoData) : "") : (c.destinazione ? "Ricavato a: " + esc(c.destinazione) : "")}</div></div>`).join("") : "";
  return `
    <div class="section-title">🎁 Panettoni &amp; C</div>
    <div class="card-sub" style="margin-bottom:12px;">Prodotti il cui ricavato va in beneficenza: prenota quelli che vuoi e ritirali alla consegna.</div>
    ${cards}${chiuse}${mio ? "" : `<div class="card-sub" style="margin-top:10px;">Hai effettuato l'accesso con il profilo condiviso: puoi prenotare, ma per modificare o annullare una prenotazione rivolgiti al Direttivo.</div>`}`;
}

function attachBeneficenzaEvents() {
  const root = document.getElementById("ben-root");
  if (!root) return;
  root.addEventListener("click", e => {
    const el = e.target.closest("[data-ben]");
    if (!el) return;
    const az = el.dataset.ben, id = el.dataset.id, pid = el.dataset.pid;
    const gestore = benGestore();
    if (az === "apri" && gestore) { benCampagnaId = id; benFiltro = ""; renderSection(); }
    else if (az === "indietro") { benCampagnaId = null; renderSection(); }
    else if (az === "nuova-campagna") benFormCampagna();
    else if (az === "modifica-campagna") benFormCampagna(id);
    else if (az === "elimina-campagna") benEliminaCampagna(id);
    else if (az === "nuova-pren" || az === "prenota") benFormPrenotazione(id);
    else if (az === "modifica-pren") benFormPrenotazione(id, pid);
    else if (az === "elimina-pren" || az === "annulla-pren") benEliminaPrenotazione(id, pid);
    else if (az === "incasso") benFormIncasso(id, pid);
    else if (az === "pagato" || az === "consegnato") benImposta(id, pid, az, el.dataset.val === "1");
    else if (az === "rendiconto") benRendiconto(benTrova(id));
    else if (az === "elenco") benElencoConsegne(benTrova(id));
  });
  const filtro = document.getElementById("ben-filtro");
  if (filtro) filtro.addEventListener("input", () => {
    benFiltro = filtro.value;
    const c = benTrova(benCampagnaId);
    const lista = document.getElementById("ben-pren-lista");
    if (c && lista) lista.innerHTML = benHtmlPrenotazioni(c);
  });
  const stato = document.getElementById("ben-stato");
  if (stato) stato.addEventListener("change", async () => {
    if (!benGestore()) return;
    const c = benTrova(benCampagnaId);
    const nuovo = stato.value;
    const esito = await benScrivi(camp => { const cc = camp.find(x => x.id === benCampagnaId); if (!cc) return { errore: "Campagna non trovata." }; cc.stato = nuovo; }, `🎁 Campagna «${c ? c.titolo : ""}»: ${BEN_STATI[nuovo]}`).catch(() => ({ errore: "Non sono riuscito a salvare: controlla la connessione." }));
    if (esito && esito.errore) alert(esito.errore);
  });
}

async function benImposta(campId, prenId, campo, valore) {
  if (!benGestore()) return;
  const c = benTrova(campId);
  const r = c && (c.prenotazioni || []).find(x => x.id === prenId);
  const esito = await benScrivi(camp => {
    const cc = camp.find(x => x.id === campId); const rr = cc && (cc.prenotazioni || []).find(x => x.id === prenId);
    if (!rr) return { errore: "Prenotazione non trovata." };
    rr[campo] = valore;
  }, `🎁 «${c ? c.titolo : ""}»: ${r ? r.nome : ""} ${campo === "pagato" ? (valore ? "ha pagato" : "non ha pagato") : (valore ? "ha ritirato" : "non ha ritirato")}`).catch(() => ({ errore: "Non sono riuscito a salvare: controlla la connessione." }));
  if (esito && esito.errore) alert(esito.errore);
}

// Finestra dell'incasso: si scrive quanto è stato davvero versato (anche più o meno del dovuto) e si vede la differenza.
function benFormIncasso(campId, prenId) {
  if (!benGestore()) return;
  const c = benTrova(campId);
  const r = c && (c.prenotazioni || []).find(x => x.id === prenId);
  if (!r) return;
  const sp = benStatoPagamento(c, r);
  const iniziale = sp.inc > 0.004 ? sp.inc : sp.dov;
  showModal(`
    <div class="modal-title">💶 Incasso di ${esc(r.nome)}</div>
    <div class="card-sub" style="margin-bottom:6px;">${esc(benArticoli(c, r))}</div>
    <div style="font-weight:800; margin-bottom:10px;">Dovuto: ${benEuro(sp.dov)}</div>
    <div class="form-group"><label>Importo incassato (€)</label><input type="text" inputmode="decimal" id="ben-inc-importo" value="${iniziale.toFixed(2).replace(".", ",")}"></div>
    <div id="ben-inc-diff" style="font-weight:700; min-height:1.3em; margin-bottom:6px;"></div>
    <div id="ben-form-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions" style="flex-wrap:wrap;">
      <button type="button" class="btn secondary" id="ben-annulla">Annulla</button>
      ${sp.inc > 0.004 ? `<button type="button" class="btn danger" id="ben-inc-togli">Togli l'incasso</button>` : ""}
      <button type="button" class="btn" id="ben-inc-salva">Segna incassato</button>
    </div>`);
  // Solo numeri veri (45, 45,50, 45.5): qualsiasi altra cosa non è un importo e non deve mai finire per valere zero.
  const leggi = () => {
    const v = (document.getElementById("ben-inc-importo").value || "").replace(/[\s€]/g, "");
    return /^\d+([.,]\d{1,2})?$/.test(v) ? Math.round(benNum(v) * 100) / 100 : NaN;
  };
  const aggiorna = () => {
    const v = leggi(), el = document.getElementById("ben-inc-diff");
    if (isNaN(v)) { el.textContent = ""; return; }
    const d = Math.round((v - sp.dov) * 100) / 100;
    el.textContent = d > 0.004 ? `+${benEuro(d)} in più del dovuto` : (d < -0.004 ? `Mancano ${benEuro(-d)}: la prenotazione resta "parziale"` : "Importo esatto");
    el.style.color = d > 0.004 ? "#1a6b3c" : (d < -0.004 ? "#b36b00" : "#555");
  };
  document.getElementById("ben-inc-importo").addEventListener("input", aggiorna);
  aggiorna();
  document.getElementById("ben-annulla").addEventListener("click", closeModal);
  const registra = async (valore, evLog) => {
    const err = document.getElementById("ben-form-errore");
    let esito;
    try {
      esito = await benScrivi(camp => {
        const cc = camp.find(x => x.id === campId); const rr = cc && (cc.prenotazioni || []).find(x => x.id === prenId);
        if (!rr) return { errore: "Prenotazione non trovata." };
        rr.importoPagato = valore;
        rr.pagato = valore > 0.004 && valore >= benImporto(cc, rr) - 0.004;
        return {};
      }, evLog);
    } catch (e) { console.error(e); esito = { errore: "Non sono riuscito a salvare: controlla la connessione e riprova." }; }
    if (esito && esito.errore) { err.textContent = esito.errore; return; }
    closeModal();
    toast(valore > 0.004 ? "Incasso registrato" : "Incasso tolto");
  };
  document.getElementById("ben-inc-salva").addEventListener("click", () => {
    const v = leggi();
    if (isNaN(v) || v < 0) { document.getElementById("ben-form-errore").textContent = "Scrivi l'importo incassato (un numero, per esempio 50 o 45,50)."; return; }
    registra(v, `🎁 «${c.titolo}»: ${r.nome} ha versato ${benEuro(v)} (dovuto ${benEuro(sp.dov)})`);
  });
  const togli = document.getElementById("ben-inc-togli");
  if (togli) togli.addEventListener("click", () => registra(0, `🎁 «${c.titolo}»: tolto l'incasso di ${r.nome}`));
}

async function benEliminaPrenotazione(campId, prenId) {
  const c = benTrova(campId);
  const r = c && (c.prenotazioni || []).find(x => x.id === prenId);
  if (!r) return;
  const gestore = benGestore();
  if (!gestore && (r.socioId !== benMioId() || !benPrenotabile(c) || benHaIncasso(c, r) || r.consegnato)) { alert("Questa prenotazione non si può più annullare: rivolgiti al Direttivo."); return; }
  if (!confirm(`Eliminare la prenotazione di ${r.nome}?`)) return;
  const esito = await benScrivi(camp => {
    const cc = camp.find(x => x.id === campId); if (!cc) return { errore: "Campagna non trovata." };
    cc.prenotazioni = (cc.prenotazioni || []).filter(x => x.id !== prenId);
  }, `🎁 «${c.titolo}»: eliminata la prenotazione di ${r.nome}`).catch(() => ({ errore: "Non sono riuscito a salvare: controlla la connessione." }));
  if (esito && esito.errore) alert(esito.errore);
}

async function benEliminaCampagna(id) {
  if (!benGestore()) return;
  const c = benTrova(id);
  if (!c) return;
  if (!confirm(`Eliminare la campagna «${c.titolo}» con tutte le sue prenotazioni? L'operazione non si può annullare.`)) return;
  benCampagnaId = null;
  const esito = await benScrivi(camp => { const i = camp.findIndex(x => x.id === id); if (i >= 0) camp.splice(i, 1); }, `🎁 Eliminata la campagna «${c.titolo}»`).catch(() => ({ errore: "Non sono riuscito a salvare: controlla la connessione." }));
  if (esito && esito.errore) alert(esito.errore);
}

function benRiscriviProdotti() {
  const el = document.getElementById("ben-prodotti-form");
  if (!el) return;
  el.innerHTML = benProdottiForm.map((p, i) => `
    <div class="card" style="padding:10px; margin-bottom:8px;">
      <div class="form-group"><label>Prodotto</label><input type="text" class="bp-nome" value="${esc(p.nome)}" placeholder="Es. Panettone classico 1 kg"></div>
      <div class="two-col">
        <div class="form-group"><label>Prezzo di vendita (€)</label><input type="text" inputmode="decimal" class="bp-prezzo" value="${esc(p.prezzo)}"></div>
        <div class="form-group"><label>Costo d'acquisto (€)</label><input type="text" inputmode="decimal" class="bp-costo" value="${esc(p.costo)}" placeholder="0 se donato"></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Massimo prenotabile</label><input type="text" inputmode="numeric" class="bp-max" value="${esc(p.massimo || "")}" placeholder="vuoto = senza limite"></div>
        <div class="form-group"><label>Pezzi ricevuti</label><input type="text" inputmode="numeric" class="bp-ric" value="${esc(p.ricevuti || "")}" placeholder="a merce arrivata"></div>
      </div>
      <button type="button" class="btn danger bp-del" data-i="${i}" style="padding:4px 10px; font-size:0.78rem;">🗑️ Togli prodotto</button>
    </div>`).join("");
  el.querySelectorAll(".bp-del").forEach(b => b.addEventListener("click", () => {
    benLeggiProdotti();
    benProdottiForm.splice(parseInt(b.dataset.i, 10), 1);
    if (!benProdottiForm.length) benProdottiForm.push({ id: uid(), nome: "", prezzo: "", costo: "", massimo: "", ricevuti: "" });
    benRiscriviProdotti();
  }));
}

function benLeggiProdotti() {
  document.querySelectorAll("#ben-prodotti-form > .card").forEach((card, i) => {
    const p = benProdottiForm[i];
    if (!p) return;
    p.nome = card.querySelector(".bp-nome").value.trim();
    p.prezzo = card.querySelector(".bp-prezzo").value.trim();
    p.costo = card.querySelector(".bp-costo").value.trim();
    p.massimo = card.querySelector(".bp-max").value.trim();
    p.ricevuti = card.querySelector(".bp-ric").value.trim();
  });
}

function benFormCampagna(id) {
  if (!benGestore()) return;
  const c = id ? benTrova(id) : null;
  benProdottiForm = c && (c.prodotti || []).length ? JSON.parse(JSON.stringify(c.prodotti)) : [{ id: uid(), nome: "", prezzo: "", costo: "", massimo: "", ricevuti: "" }];
  showModal(`
    <div class="modal-title">🎁 ${c ? "Modifica campagna" : "Nuova campagna"}</div>
    <div class="form-group"><label>Titolo *</label><input type="text" id="ben-titolo" value="${esc(c ? c.titolo : "")}" placeholder="Es. Panettoni di Natale 2026"></div>
    <div class="form-group"><label>Produttore</label><input type="text" id="ben-produttore" value="${esc(c ? c.produttore : "")}"></div>
    <div class="form-group"><label>Il ricavato va a</label><input type="text" id="ben-destinazione" value="${esc(c ? c.destinazione : "")}" placeholder="Es. casa di riposo, banco alimentare..."></div>
    <div class="two-col">
      <div class="form-group"><label>Prenotazioni fino al</label><input type="date" id="ben-chiusura" value="${esc(c ? c.chiusuraPrenotazioni : "")}"></div>
      <div class="form-group"><label>Data di consegna</label><input type="date" id="ben-consegna" value="${esc(c ? c.dataConsegna : "")}"></div>
    </div>
    <div class="form-group"><label>Note per i soci</label><input type="text" id="ben-note" value="${esc(c ? c.note : "")}" placeholder="Es. ritiro in sede il sabato mattina"></div>
    <div style="font-weight:800; margin:8px 0;">Prodotti</div>
    <div id="ben-prodotti-form"></div>
    <button type="button" class="btn secondary block" id="ben-add-prod" style="margin-bottom:12px;">➕ Aggiungi un altro prodotto</button>
    ${c ? `<div class="two-col">
      <div class="form-group"><label>Importo già versato (€)</label><input type="text" inputmode="decimal" id="ben-versato" value="${esc(c.versatoImporto || "")}"></div>
      <div class="form-group"><label>Data del versamento</label><input type="date" id="ben-versato-data" value="${esc(c.versatoData || "")}"></div>
    </div>` : ""}
    <div id="ben-form-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="ben-annulla">Annulla</button>
      <button type="button" class="btn" id="ben-salva">Salva</button>
    </div>`);
  benRiscriviProdotti();
  document.getElementById("ben-annulla").addEventListener("click", closeModal);
  document.getElementById("ben-add-prod").addEventListener("click", () => {
    benLeggiProdotti();
    benProdottiForm.push({ id: uid(), nome: "", prezzo: "", costo: "", massimo: "", ricevuti: "" });
    benRiscriviProdotti();
  });
  document.getElementById("ben-salva").addEventListener("click", async () => {
    const err = document.getElementById("ben-form-errore");
    benLeggiProdotti();
    const titolo = document.getElementById("ben-titolo").value.trim();
    if (!titolo) { err.textContent = "Scrivi un titolo per la campagna."; return; }
    const prodotti = benProdottiForm.filter(p => p.nome).map(p => ({ id: p.id, nome: p.nome, prezzo: benNum(p.prezzo), costo: benNum(p.costo), massimo: Math.floor(benNum(p.massimo)), ricevuti: Math.floor(benNum(p.ricevuti)) }));
    if (!prodotti.length) { err.textContent = "Aggiungi almeno un prodotto con il nome."; return; }
    const dati = {
      titolo, prodotti,
      produttore: document.getElementById("ben-produttore").value.trim(),
      destinazione: document.getElementById("ben-destinazione").value.trim(),
      chiusuraPrenotazioni: document.getElementById("ben-chiusura").value,
      dataConsegna: document.getElementById("ben-consegna").value,
      note: document.getElementById("ben-note").value.trim(),
    };
    if (c) { dati.versatoImporto = benNum(document.getElementById("ben-versato").value); dati.versatoData = document.getElementById("ben-versato-data").value; }
    const btn = document.getElementById("ben-salva");
    btn.disabled = true; err.textContent = "";
    let esito;
    try {
      esito = await benScrivi(camp => {
        if (c) {
          const cc = camp.find(x => x.id === c.id);
          if (!cc) return { errore: "Campagna non trovata." };
          const restano = new Set(dati.prodotti.map(p => p.id));
          for (const vecchio of cc.prodotti || []) {
            if (!restano.has(vecchio.id) && (cc.prenotazioni || []).some(r => Number((r.q || {})[vecchio.id]) > 0)) return { errore: `Il prodotto «${vecchio.nome}» ha già delle prenotazioni: non si può togliere.` };
          }
          Object.assign(cc, dati);
        } else {
          camp.push(Object.assign({ id: uid(), stato: "aperta", prenotazioni: [], creato: new Date().toISOString() }, dati));
        }
        return {};
      }, `🎁 ${c ? "Modificata" : "Nuova"} campagna «${titolo}»`);
    } catch (e) { console.error(e); esito = { errore: "Non sono riuscito a salvare: controlla la connessione e riprova." }; }
    if (esito && esito.errore) { err.textContent = esito.errore; btn.disabled = false; return; }
    closeModal();
    toast("Campagna salvata");
  });
}

function benFormPrenotazione(campId, prenId) {
  const c = benTrova(campId);
  if (!c) return;
  const gestore = benGestore();
  const mioId = benMioId();
  const r = prenId ? (c.prenotazioni || []).find(x => x.id === prenId) : null;
  if (!gestore) {
    if (!benPrenotabile(c)) { alert("Le prenotazioni di questa campagna sono chiuse."); return; }
    if (r && (r.socioId !== mioId || benHaIncasso(c, r) || r.consegnato)) { alert("Questa prenotazione non si può più modificare: rivolgiti al Direttivo."); return; }
  }
  const sc = socioCorrente();
  const nomeIniziale = r ? r.nome : (sc && !gestore ? `${sc.cognome || ""} ${sc.nome || ""}`.trim() : "");
  // Quanti pezzi restano per ogni prodotto (esclusa la prenotazione che si sta modificando)
  const restano = {};
  (c.prodotti || []).forEach(p => {
    const mass = Math.floor(benNum(p.massimo));
    if (mass > 0) restano[p.id] = Math.max(0, mass - (c.prenotazioni || []).filter(x => x.id !== prenId).reduce((s, x) => s + (Number((x.q || {})[p.id]) || 0), 0));
  });
  const righe = (c.prodotti || []).map(p => `
    <div style="margin-bottom:10px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="flex:1;"><div style="font-weight:700;">${esc(p.nome)}</div><div class="card-sub">${benEuro(p.prezzo)}${restano[p.id] === undefined ? "" : (restano[p.id] === 0 ? ` · <b style="color:#b33;">esaurito</b>` : ` · restano <b>${restano[p.id]}</b> su ${Math.floor(benNum(p.massimo))}`)}</div></div>
        <input type="number" min="0" step="1" inputmode="numeric" class="ben-q" data-pid="${p.id}" value="${r && r.q && r.q[p.id] ? r.q[p.id] : 0}" style="width:84px; text-align:center;">
      </div>
      <div class="ben-avviso" data-pid="${p.id}" style="color:var(--red); font-size:0.8rem; min-height:0;"></div>
    </div>`).join("");
  showModal(`
    <div class="modal-title">🎁 ${r ? "Modifica prenotazione" : "Prenota"} — ${esc(c.titolo)}</div>
    <div class="form-group"><label>Nome di chi ritira *</label><input type="text" id="ben-nome" value="${esc(nomeIniziale)}" placeholder="Cognome e nome"></div>
    <div style="font-weight:800; margin:6px 0 8px;">Quantità</div>
    ${righe}
    <div style="font-weight:800; margin-bottom:8px;">Totale: <span id="ben-tot">0,00 €</span></div>
    <div class="form-group"><label>Note (facoltative)</label><input type="text" id="ben-pnote" value="${esc(r ? r.note : "")}"></div>
    <div id="ben-form-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="ben-annulla">Annulla</button>
      <button type="button" class="btn" id="ben-salva">${r ? "Salva" : "Prenota"}</button>
    </div>`);
  const leggiQ = () => {
    const q = {};
    document.querySelectorAll("#modal-overlay .ben-q").forEach(i => { const n = Math.floor(Number(i.value)); if (n > 0) q[i.dataset.pid] = n; });
    return q;
  };
  const aggiornaTot = () => {
    const q = leggiQ();
    (c.prodotti || []).forEach(p => {
      const av = document.querySelector(`#modal-overlay .ben-avviso[data-pid="${p.id}"]`);
      if (av) av.textContent = (restano[p.id] !== undefined && (q[p.id] || 0) > restano[p.id]) ? `Puoi prenotarne al massimo ${restano[p.id]}.` : "";
    });
    document.getElementById("ben-tot").textContent = benEuro((c.prodotti || []).reduce((s, p) => s + (q[p.id] || 0) * benNum(p.prezzo), 0));
  };
  document.querySelectorAll("#modal-overlay .ben-q").forEach(i => i.addEventListener("input", aggiornaTot));
  aggiornaTot();
  document.getElementById("ben-annulla").addEventListener("click", closeModal);
  document.getElementById("ben-salva").addEventListener("click", async () => {
    const err = document.getElementById("ben-form-errore");
    const nome = document.getElementById("ben-nome").value.trim();
    const note = document.getElementById("ben-pnote").value.trim();
    const q = leggiQ();
    const pezzi = Object.values(q).reduce((s, n) => s + n, 0);
    if (!nome) { err.textContent = "Scrivi il nome di chi ritira."; return; }
    if (!pezzi) { err.textContent = "Indica almeno un prodotto da prenotare."; return; }
    const btn = document.getElementById("ben-salva");
    btn.disabled = true; err.textContent = "";
    const chi = sc ? `${sc.cognome || ""} ${sc.nome || ""}`.trim() : "";
    let esito;
    try {
      esito = await benScrivi(camp => {
        const cc = camp.find(x => x.id === campId);
        if (!cc) return { errore: "Campagna non trovata." };
        if (!gestore && !benPrenotabile(cc)) return { errore: "Le prenotazioni di questa campagna sono chiuse." };
        const altre = (cc.prenotazioni || []).filter(x => x.id !== prenId);
        for (const p of cc.prodotti || []) {
          const mass = Math.floor(benNum(p.massimo));
          if (mass > 0 && (q[p.id] || 0) > 0) {
            const gia = altre.reduce((s, x) => s + (Number((x.q || {})[p.id]) || 0), 0);
            if (gia + q[p.id] > mass) return { errore: `Di «${p.nome}» restano ${Math.max(0, mass - gia)} pezzi prenotabili.` };
          }
        }
        cc.prenotazioni = cc.prenotazioni || [];
        if (prenId) {
          const rr = cc.prenotazioni.find(x => x.id === prenId);
          if (!rr) return { errore: "Prenotazione non trovata." };
          if (!gestore && (rr.socioId !== mioId || benHaIncasso(cc, rr) || rr.consegnato)) return { errore: "Questa prenotazione non si può più modificare: rivolgiti al Direttivo." };
          Object.assign(rr, { nome, q, note, aggiornato: new Date().toISOString(), daSocio: !gestore });
        } else {
          cc.prenotazioni.push({ id: uid(), nome, socioId: gestore ? "" : (mioId || ""), prenotatoDa: gestore ? "" : chi, q, note, pagato: false, consegnato: false, creato: new Date().toISOString(), aggiornato: new Date().toISOString(), daSocio: !gestore });
        }
        return {};
      }, `🎁 «${c.titolo}»: ${prenId ? "modificata la prenotazione di" : "nuova prenotazione di"} ${nome} (${pezzi} ${pezzi === 1 ? "pezzo" : "pezzi"})`);
    } catch (e) { console.error(e); esito = { errore: "Non sono riuscito a salvare: controlla la connessione e riprova." }; }
    if (esito && esito.errore) { err.textContent = esito.errore; btn.disabled = false; return; }
    closeModal();
    toast(prenId ? "Prenotazione aggiornata" : "Prenotazione registrata");
  });
}

function benRendiconto(c) {
  if (!c) return;
  const t = benTotali(c);
  const righe = [], testo = [`Campagna: ${c.titolo}`];
  if (c.produttore) testo.push(`Produttore: ${c.produttore}`);
  if (c.destinazione) testo.push(`Il ricavato va a: ${c.destinazione}`);
  testo.push("");
  (c.prodotti || []).forEach(p => {
    const pr = t.per[p.id];
    righe.push([esc(p.nome), String(pr.prenotati), String(Math.floor(benNum(p.ricevuti))), String(pr.consegnati), esc(benEuro(p.prezzo)), esc(benEuro(pr.prenotati * benNum(p.prezzo)))]);
    testo.push(`${p.nome}: prenotati ${pr.prenotati}, ricevuti ${Math.floor(benNum(p.ricevuti))}, consegnati ${pr.consegnati}, ${benEuro(p.prezzo)} l'uno`);
  });
  const voce = (et, val) => { righe.push([`<b>${esc(et)}</b>`, "", "", "", "", `<b>${esc(benEuro(val))}</b>`]); testo.push(`${et}: ${benEuro(val)}`); };
  testo.push("");
  voce("Totale delle prenotazioni", t.dovuto);
  voce("Incassato", t.incassato);
  if (t.inPiu > 0.004) voce("di cui in più del dovuto (resti non dati)", t.inPiu);
  voce("Ancora da incassare", t.daIncassare);
  voce("Costo della merce", t.costo);
  voce("Ricavato per la beneficenza", t.ricavato);
  if (benNum(c.versatoImporto) > 0) voce(`Versato${c.destinazione ? " a " + c.destinazione : ""}${c.versatoData ? " il " + fmtDate(c.versatoData) : ""}`, c.versatoImporto);
  apriAnteprimaReportGenerico(`Rendiconto - ${c.titolo}`, ["Voce", "Prenotati", "Ricevuti", "Consegnati", "Prezzo", "Importo"], righe, testo);
}

function benElencoConsegne(c) {
  if (!c) return;
  const lista = [...(c.prenotazioni || [])].sort((a, b) => (a.nome || "").localeCompare(b.nome || "", "it"));
  const segno = d => d > 0.004 ? "+" + benEuro(d) : (d < -0.004 ? "-" + benEuro(-d) : "");
  const righe = lista.map(r => { const sp = benStatoPagamento(c, r); return [esc(r.nome), esc(benArticoli(c, r)), esc(benEuro(sp.dov)), sp.inc > 0.004 ? esc(benEuro(sp.inc)) : "-", esc(segno(sp.diff)), r.consegnato ? "Sì" : "No", esc(r.note || "")]; });
  const testo = lista.map(r => { const sp = benStatoPagamento(c, r); return `${r.nome}: ${benArticoli(c, r)} - dovuto ${benEuro(sp.dov)}${sp.inc > 0.004 ? " - incassato " + benEuro(sp.inc) + (benTestoDifferenza(sp.diff) ? " (" + benTestoDifferenza(sp.diff) + ")" : "") : " - da pagare"} - ${r.consegnato ? "consegnato" : "da consegnare"}`; });
  apriAnteprimaReportGenerico(`Elenco consegne - ${c.titolo}`, ["Nome", "Articoli", "Importo", "Incassato", "Differenza", "Consegnato", "Note"], righe, testo);
}

// ---------- Canzoni (testi e file audio: solo Direttivo e Admin) ----------
const CANZONI_CATEGORIE = ["Canti alpini", "Canti religiosi", "Canti popolari", "Marce e inni", "Altro"];
const CANZONI_MAX_BYTES = 15 * 1024 * 1024;

function fmtMB(b) { return ((Number(b) || 0) / (1024 * 1024)).toLocaleString("it-IT", { maximumFractionDigits: 1 }) + " MB"; }
function eliminaFileStorage(url) {
  try {
    if (window.storage && url && /firebasestorage|storage\.googleapis/.test(url)) return storage.refFromURL(url).delete().catch(() => {});
  } catch (e) { /* se non si riesce, il file resta ma l'app funziona */ }
  return Promise.resolve();
}
function controllaFileAudio(file) {
  if (!file) return "";
  if (!(/^audio\//.test(file.type || "") || /\.(mp3|m4a|aac|ogg|wav)$/i.test(file.name || ""))) return "Scegli un file audio (meglio in formato mp3).";
  if (file.size > CANZONI_MAX_BYTES) return `Il file pesa ${fmtMB(file.size)}: il massimo è ${fmtMB(CANZONI_MAX_BYTES)}. Riducilo (per esempio a 128 kbps) e riprova.`;
  return "";
}

function canzoniOrdinate(filtro) {
  const q = (filtro || "").trim().toLowerCase();
  return [...(state.canzoni || [])]
    .filter(c => !q || `${c.titolo} ${c.categoria || ""} ${c.autore || ""} ${c.testo || ""}`.toLowerCase().includes(q))
    .sort((a, b) => (a.titolo || "").localeCompare(b.titolo || "", "it", { sensitivity: "base" }));
}

function cardCanzone(c) {
  return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
        <div>
          <div style="font-weight:800;">${esc(c.titolo)}</div>
          <div class="card-sub">${esc(c.categoria || "")}${c.autore ? " · " + esc(c.autore) : ""}${c.audioBytes ? " · " + fmtMB(c.audioBytes) : ""}</div>
        </div>
        <div class="card-actions">
          <button type="button" data-cz="modifica" data-id="${c.id}">✏️</button>
          <button type="button" data-cz="elimina" data-id="${c.id}">🗑️</button>
        </div>
      </div>
      ${c.audioUrl ? `<audio controls preload="none" src="${esc(c.audioUrl)}" style="width:100%; margin-top:8px;"></audio>` : ""}
      ${c.testo ? `<details style="margin-top:8px;"><summary style="cursor:pointer; font-weight:700;">Testo</summary><div style="white-space:pre-wrap; margin-top:6px; font-size:0.95rem;">${esc(c.testo)}</div></details>` : ""}
    </div>`;
}

function renderCanzoni() {
  const tutte = state.canzoni || [];
  const lista = canzoniOrdinate("");
  const byte = tutte.reduce((s, c) => s + (Number(c.audioBytes) || 0), 0);
  const nAudio = tutte.filter(c => c.audioUrl).length;
  return `
  <div id="cz-root">
    <div class="section-title">🎵 Canzoni</div>
    <div class="card-sub" style="margin-bottom:12px;">Testi e file audio dei canti. Sezione riservata a Direttivo e Admin. Spazio occupato dai file audio: <b>${fmtMB(byte)}</b> (${nAudio} ${nAudio === 1 ? "file" : "file"}).</div>
    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Nuova canzone</div>
      <div class="form-group"><label>Titolo *</label><input type="text" id="cz-titolo" placeholder="Es. Il Testamento del Capitano"></div>
      <div class="two-col">
        <div class="form-group"><label>Categoria</label><select id="cz-categoria">${CANZONI_CATEGORIE.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join("")}</select></div>
        <div class="form-group"><label>Autore o note</label><input type="text" id="cz-autore" placeholder="facoltativo"></div>
      </div>
      <div class="form-group"><label>Testo (facoltativo)</label><textarea id="cz-testo" rows="5" placeholder="Incolla qui il testo della canzone"></textarea></div>
      <div class="form-group"><label>File audio mp3 (facoltativo, massimo ${fmtMB(CANZONI_MAX_BYTES)})</label><input type="file" id="cz-file" accept="audio/*,.mp3"></div>
      <button type="button" class="btn block" data-cz="crea" style="margin-top:6px;">➕ Aggiungi la canzone</button>
    </div>
    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🎶 Elenco (${tutte.length})</div>
    <input type="text" id="cz-filtro" placeholder="Cerca per titolo, categoria o testo..." style="width:100%; margin-bottom:10px; box-sizing:border-box;">
    <div id="cz-lista">${lista.length ? lista.map(cardCanzone).join("") : `<div class="card-sub">Nessuna canzone inserita.</div>`}</div>
  </div>`;
}

function attachCanzoniEvents() {
  const root = document.getElementById("cz-root");
  if (!root) return;
  root.addEventListener("click", e => {
    const el = e.target.closest("[data-cz]");
    if (!el) return;
    if (el.dataset.cz === "crea") creaCanzone();
    else if (el.dataset.cz === "modifica") apriModificaCanzone(el.dataset.id);
    else if (el.dataset.cz === "elimina") eliminaCanzone(el.dataset.id);
  });
  const f = document.getElementById("cz-filtro");
  if (f) f.addEventListener("input", () => {
    const l = canzoniOrdinate(f.value);
    document.getElementById("cz-lista").innerHTML = l.length ? l.map(cardCanzone).join("") : `<div class="card-sub">Nessuna canzone corrisponde alla ricerca.</div>`;
  });
}

async function creaCanzone() {
  if (!(currentRole === "admin" || currentRole === "direttivo")) return;
  const titolo = document.getElementById("cz-titolo").value.trim();
  const file = document.getElementById("cz-file").files[0];
  if (!titolo) { alert("Inserisci il titolo della canzone"); return; }
  const problema = controllaFileAudio(file);
  if (problema) { alert(problema); return; }
  const id = uid();
  const nuova = { id, titolo, categoria: document.getElementById("cz-categoria").value, autore: document.getElementById("cz-autore").value.trim(),
    testo: document.getElementById("cz-testo").value.trim(), audioUrl: "", audioNome: "", audioBytes: 0, creato: new Date().toISOString() };
  if (file) {
    if (!window.storage) { alert("Firebase non configurato: il file audio non può essere caricato su questo dispositivo."); return; }
    try {
      toast("Caricamento del file audio...");
      nuova.audioUrl = await uploadDocumento(file, `canzoni/${id}`);
      nuova.audioNome = file.name; nuova.audioBytes = file.size;
    } catch (err) { console.error(err); alert("Errore nel caricamento del file audio. Riprova."); return; }
  }
  state.canzoni = state.canzoni || [];
  state.canzoni.push(nuova);
  saveState();
  renderSection();
  toast("Canzone aggiunta");
}

function apriModificaCanzone(id) {
  const c = (state.canzoni || []).find(x => x.id === id);
  if (!c) return;
  showModal(`
    <div class="modal-title">✏️ Modifica canzone</div>
    <div class="form-group"><label>Titolo *</label><input type="text" id="czm-titolo" value="${esc(c.titolo)}"></div>
    <div class="two-col">
      <div class="form-group"><label>Categoria</label><select id="czm-categoria">${CANZONI_CATEGORIE.map(k => `<option value="${esc(k)}" ${k === c.categoria ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></div>
      <div class="form-group"><label>Autore o note</label><input type="text" id="czm-autore" value="${esc(c.autore)}"></div>
    </div>
    <div class="form-group"><label>Testo</label><textarea id="czm-testo" rows="6">${esc(c.testo)}</textarea></div>
    <div class="form-group"><label>${c.audioUrl ? "Sostituisci il file audio (lascia vuoto per tenere quello attuale)" : "Aggiungi un file audio"}</label><input type="file" id="czm-file" accept="audio/*,.mp3"></div>
    <div id="czm-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="czm-annulla">Annulla</button>
      <button type="button" class="btn" id="czm-salva">Salva</button>
    </div>`);
  document.getElementById("czm-annulla").addEventListener("click", closeModal);
  document.getElementById("czm-salva").addEventListener("click", async () => {
    const err = document.getElementById("czm-errore");
    const titolo = document.getElementById("czm-titolo").value.trim();
    const file = document.getElementById("czm-file").files[0];
    if (!titolo) { err.textContent = "Il titolo è obbligatorio."; return; }
    const problema = controllaFileAudio(file);
    if (problema) { err.textContent = problema; return; }
    const btn = document.getElementById("czm-salva"); btn.disabled = true; err.textContent = "";
    const nuovo = { titolo, categoria: document.getElementById("czm-categoria").value, autore: document.getElementById("czm-autore").value.trim(), testo: document.getElementById("czm-testo").value.trim() };
    if (file) {
      if (!window.storage) { err.textContent = "Firebase non configurato: impossibile caricare il file."; btn.disabled = false; return; }
      try {
        nuovo.audioUrl = await uploadDocumento(file, `canzoni/${id}`);
        nuovo.audioNome = file.name; nuovo.audioBytes = file.size;
      } catch (e) { console.error(e); err.textContent = "Errore nel caricamento del file: riprova."; btn.disabled = false; return; }
    }
    Object.assign(c, nuovo);
    saveState();
    closeModal();
    renderSection();
    toast("Canzone aggiornata");
  });
}

function eliminaCanzone(id) {
  const c = (state.canzoni || []).find(x => x.id === id);
  if (!c) return;
  if (!confirm(`Eliminare la canzone «${c.titolo}»${c.audioUrl ? " e il suo file audio" : ""}?`)) return;
  eliminaFileStorage(c.audioUrl);
  state.canzoni = state.canzoni.filter(x => x.id !== id);
  saveState();
  renderSection();
}

// ---------- Manuali (PDF caricati dall'Admin; ognuno ha chi lo può vedere) ----------
const MANUALI_VISIBILITA = { tutti: "Tutti i soci", direttivo: "Solo Direttivo e Admin" };

function manualiVisibili() {
  const tutti = [...(state.manuali || [])];
  const v = currentRole === "socio" ? tutti.filter(m => m.visibilita === "tutti") : tutti;
  return v.sort((a, b) => (a.visibilita === "tutti") - (b.visibilita === "tutti") || (a.titolo || "").localeCompare(b.titolo || "", "it"));
}

function renderManuali() {
  const admin = currentRole === "admin";
  const gestore = currentRole !== "socio";
  const lista = manualiVisibili();
  const cards = lista.length ? lista.map(m => `
    <div class="card">
      <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
        <div>
          <div style="font-weight:800;">📘 ${esc(m.titolo)}</div>
          ${gestore ? `<div class="card-sub">Lo vede: <b>${esc(MANUALI_VISIBILITA[m.visibilita] || m.visibilita)}</b></div>` : ""}
          ${m.nota ? `<div class="card-sub">${esc(m.nota)}</div>` : ""}
          <div class="card-sub">Aggiornato il ${m.caricato ? fmtDate(m.caricato.slice(0, 10)) : "-"}${m.bytes ? " · " + fmtMB(m.bytes) : ""}</div>
        </div>
        ${admin ? `<div class="card-actions"><button type="button" data-mn="modifica" data-id="${m.id}">✏️</button><button type="button" data-mn="elimina" data-id="${m.id}">🗑️</button></div>` : ""}
      </div>
      ${m.allegatoThumbUrl ? `<img src="${esc(m.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; margin-top:8px; border:1px solid #ccc;">` : ""}
      ${m.allegatoUrl ? `<a href="${esc(m.allegatoUrl)}" target="_blank" rel="noopener" class="btn block" style="margin-top:10px; text-decoration:none; text-align:center;">📄 Apri il manuale</a>` : ""}
    </div>`).join("")
    : `<div class="card-sub">${currentRole === "socio" ? "Il manuale non è ancora disponibile: rivolgiti al Direttivo." : "Nessun manuale caricato: li carica l'Admin da questa pagina."}</div>`;
  const form = !admin ? "" : `
    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Nuovo manuale</div>
      <div class="form-group"><label>Titolo *</label><input type="text" id="mn-titolo" placeholder="Es. Manuale per i Soci"></div>
      <div class="form-group"><label>Chi lo può vedere</label><select id="mn-visibilita"><option value="tutti">${MANUALI_VISIBILITA.tutti}</option><option value="direttivo">${MANUALI_VISIBILITA.direttivo}</option></select></div>
      <div class="form-group"><label>Nota (facoltativa, es. versione dell'app)</label><input type="text" id="mn-nota" placeholder="Es. aggiornato alla versione 7.99"></div>
      <div class="form-group"><label>File PDF *</label><input type="file" id="mn-file" accept=".pdf,application/pdf"></div>
      <button type="button" class="btn block" data-mn="crea" style="margin-top:6px;">➕ Carica il manuale</button>
    </div>`;
  return `
  <div id="mn-root">
    <div class="section-title">📘 Manuali</div>
    <div class="card-sub" style="margin-bottom:12px;">${currentRole === "socio" ? "Il manuale d'uso dell'app." : "I manuali d'uso dell'app. I soci vedono solo quello pensato per loro."}</div>
    ${form}${cards}
  </div>`;
}

function attachManualiEvents() {
  const root = document.getElementById("mn-root");
  if (!root) return;
  root.addEventListener("click", e => {
    const el = e.target.closest("[data-mn]");
    if (!el) return;
    if (el.dataset.mn === "crea") creaManuale();
    else if (el.dataset.mn === "modifica") apriModificaManuale(el.dataset.id);
    else if (el.dataset.mn === "elimina") eliminaManuale(el.dataset.id);
  });
}

async function caricaPdfManuale(file, id) {
  const out = { allegatoUrl: await uploadDocumento(file, `manuali/${id}`), allegatoNome: file.name, bytes: file.size, allegatoThumbUrl: "" };
  try {
    const mini = await generaMiniaturaPdf(file);
    if (mini) out.allegatoThumbUrl = await uploadDocumento(mini, `manuali/${id}_thumb`);
  } catch (e) { console.warn("Anteprima del manuale non generata", e); }
  return out;
}

async function creaManuale() {
  if (currentRole !== "admin") return;
  const titolo = document.getElementById("mn-titolo").value.trim();
  const file = document.getElementById("mn-file").files[0];
  if (!titolo) { alert("Inserisci un titolo per il manuale"); return; }
  if (!file) { alert("Seleziona il file PDF del manuale"); return; }
  if (!(file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf")) { alert("Il manuale deve essere un file PDF"); return; }
  if (!window.storage) { alert("Firebase non configurato: il manuale non può essere caricato su questo dispositivo."); return; }
  const id = uid();
  let allegato;
  try { toast("Caricamento del manuale..."); allegato = await caricaPdfManuale(file, id); }
  catch (e) { console.error(e); alert("Errore nel caricamento del manuale. Riprova."); return; }
  state.manuali = state.manuali || [];
  state.manuali.push(Object.assign({ id, titolo, visibilita: document.getElementById("mn-visibilita").value, nota: document.getElementById("mn-nota").value.trim(), caricato: new Date().toISOString() }, allegato));
  saveState();
  renderSection();
  toast("Manuale caricato");
}

function apriModificaManuale(id) {
  const m = (state.manuali || []).find(x => x.id === id);
  if (!m || currentRole !== "admin") return;
  showModal(`
    <div class="modal-title">✏️ Modifica manuale</div>
    <div class="form-group"><label>Titolo *</label><input type="text" id="mnm-titolo" value="${esc(m.titolo)}"></div>
    <div class="form-group"><label>Chi lo può vedere</label><select id="mnm-visibilita"><option value="tutti" ${m.visibilita === "tutti" ? "selected" : ""}>${MANUALI_VISIBILITA.tutti}</option><option value="direttivo" ${m.visibilita === "direttivo" ? "selected" : ""}>${MANUALI_VISIBILITA.direttivo}</option></select></div>
    <div class="form-group"><label>Nota</label><input type="text" id="mnm-nota" value="${esc(m.nota)}"></div>
    <div class="form-group"><label>Sostituisci il PDF (lascia vuoto per tenere quello attuale)</label><input type="file" id="mnm-file" accept=".pdf,application/pdf"></div>
    <div id="mnm-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="mnm-annulla">Annulla</button>
      <button type="button" class="btn" id="mnm-salva">Salva</button>
    </div>`);
  document.getElementById("mnm-annulla").addEventListener("click", closeModal);
  document.getElementById("mnm-salva").addEventListener("click", async () => {
    const err = document.getElementById("mnm-errore");
    const titolo = document.getElementById("mnm-titolo").value.trim();
    const file = document.getElementById("mnm-file").files[0];
    if (!titolo) { err.textContent = "Il titolo è obbligatorio."; return; }
    if (file && !(file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf")) { err.textContent = "Il manuale deve essere un file PDF."; return; }
    const btn = document.getElementById("mnm-salva"); btn.disabled = true; err.textContent = "";
    const nuovo = { titolo, visibilita: document.getElementById("mnm-visibilita").value, nota: document.getElementById("mnm-nota").value.trim() };
    if (file) {
      if (!window.storage) { err.textContent = "Firebase non configurato."; btn.disabled = false; return; }
      try { Object.assign(nuovo, await caricaPdfManuale(file, id), { caricato: new Date().toISOString() }); }
      catch (e) { console.error(e); err.textContent = "Errore nel caricamento: riprova."; btn.disabled = false; return; }
    }
    Object.assign(m, nuovo);
    saveState();
    closeModal();
    renderSection();
    toast("Manuale aggiornato");
  });
}

function eliminaManuale(id) {
  const m = (state.manuali || []).find(x => x.id === id);
  if (!m || currentRole !== "admin") return;
  if (!confirm(`Eliminare il manuale «${m.titolo}»?`)) return;
  eliminaFileStorage(m.allegatoUrl);
  eliminaFileStorage(m.allegatoThumbUrl);
  state.manuali = state.manuali.filter(x => x.id !== id);
  saveState();
  renderSection();
}

// ---------- Controllo dati: schede dei soci doppie ----------
function hashTesto(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); }
function nomeSocioCompleto(s) { return `${(s && s.cognome) || ""} ${(s && s.nome) || ""}`.trim() || "(senza nome)"; }

// Gruppi di schede con lo stesso identificativo, più quelle senza identificativo.
function schedeDoppie() {
  const g = {};
  (state.socios || []).forEach(s => { const k = s && s.id ? String(s.id) : ""; (g[k] = g[k] || []).push(s); });
  return Object.keys(g).filter(k => g[k].length > 1 || k === "").map(k => ({ id: k, copie: g[k] }));
}

// Stesso nome e stessa data di nascita ma identificativi diversi: può essere un doppione o un omonimo.
function possibiliOmonimi() {
  const g = {};
  (state.socios || []).forEach(s => {
    if (!s || !s.id) return;
    const k = `${(s.cognome || "").trim().toLowerCase()} ${(s.nome || "").trim().toLowerCase()}|${s.dataNascita || ""}`;
    (g[k] = g[k] || []).push(s);
  });
  return Object.values(g).filter(l => l.length > 1 && new Set(l.map(s => s.id)).size > 1);
}

function avvisoSchedeDoppie() {
  if (currentRole === "socio") return "";
  const d = schedeDoppie();
  if (!d.length) return "";
  const nomi = d.map(x => x.id ? `${nomeSocioCompleto(x.copie[0])} (×${x.copie.length})` : `${x.copie.length} schede senza identificativo`).join(", ");
  return `<div class="card" style="background:#fff4d6; border:1px solid #e0b84a;"><b>⚠️ Schede doppie in Anagrafica:</b> ${esc(nomi)}.<br>Non eliminare nessuna delle copie: l'app le cancellerebbe tutte. ${currentRole === "admin" ? "Usa Impostazioni > Controllo dati per tenerne una sola." : "Avvisa l'Admin: le sistema da Impostazioni > Controllo dati."}</div>`;
}

function apriControlloDati() {
  if (currentRole !== "admin") return;
  const doppie = schedeDoppie(), omonimi = possibiliOmonimi();
  const compilati = s => Object.keys(s).filter(k => k !== "id" && s[k] !== "" && s[k] !== false && s[k] !== null && s[k] !== undefined && !(Array.isArray(s[k]) && !s[k].length)).length;
  const riga = (et, v) => v ? `<div class="card-sub">${et}: ${esc(v)}</div>` : "";
  const blocchi = doppie.map(g => {
    if (!g.id) {
      return `<div class="card"><div class="card-name">${g.copie.length} ${g.copie.length === 1 ? "scheda" : "schede"} senza identificativo</div>
        <div class="card-sub">${esc(g.copie.map(nomeSocioCompleto).join(", "))}</div>
        <button type="button" class="btn block" data-cd="assegna" style="margin-top:8px;">Assegna un identificativo a ognuna</button></div>`;
    }
    const nBol = (state.pagamentiBollino || []).filter(r => r.socioId === g.id).length;
    return `<div class="card"><div class="card-name">${esc(nomeSocioCompleto(g.copie[0]))} — ${g.copie.length} copie con lo stesso identificativo</div>
      ${nBol ? `<div class="card-sub">Bollini registrati per questo identificativo: ${nBol} (restano con la copia che tieni)</div>` : ""}
      ${g.copie.map((s, i) => `<div class="card" style="padding:10px; margin-top:8px;">
        <div style="font-weight:700;">Copia ${i + 1} · ${compilati(s)} campi compilati</div>
        ${riga("Cellulare", s.cellulare)}${riga("Telefono", s.telefono)}${riga("Email", s.email)}${riga("Nato il", s.dataNascita)}${riga("Categoria", s.carica)}${riga("Matricola", s.matricola)}${riga("Iscritto dal", s.dataIscrizione)}
        ${s.andatoAvanti ? '<div class="card-sub">💔 Andato avanti</div>' : ""}${s.accessoApp ? '<div class="card-sub">📲 Accesso all\'app abilitato</div>' : ""}
        <button type="button" class="btn" data-cd="tieni" data-id="${esc(g.id)}" data-i="${i}" data-fp="${hashTesto(jsonStabile(s))}" style="margin-top:8px; padding:7px 12px;">Tieni solo questa copia</button>
      </div>`).join("")}
      <button type="button" class="btn secondary block" data-cd="separa" data-id="${esc(g.id)}" style="margin-top:10px;">Tieni tutte (le altre ricevono un identificativo nuovo)</button>
    </div>`;
  }).join("");
  const om = omonimi.length ? `<div style="font-weight:800; margin:16px 0 6px;">Da controllare a occhio</div><div class="card-sub" style="margin-bottom:6px;">Stesso nome e stessa data di nascita ma identificativi diversi: può essere un doppione o un omonimo. Non faccio nulla da solo: controlla in Anagrafica.</div>${omonimi.map(l => `<div class="card" style="padding:10px;"><b>${esc(nomeSocioCompleto(l[0]))}</b>${l[0].dataNascita ? " · " + esc(l[0].dataNascita) : ""} — ${l.length} schede</div>`).join("")}` : "";
  showModal(`<div id="cd-root">
    <div class="modal-title">🔎 Controllo dati</div>
    ${doppie.length ? `<div class="card-sub" style="margin-bottom:8px;">Trovate schede doppie. Scegli per ognuna quale copia tenere. Le altre vengono eliminate e i bollini restano con la copia scelta.</div>${blocchi}` : `<div class="card"><b>✅ Nessuna scheda doppia.</b><div class="card-sub">Ogni socio ha un identificativo suo.</div></div>`}
    ${om}
    <div class="modal-actions" style="margin-top:14px;"><button type="button" class="btn secondary block" data-cd="chiudi">Chiudi</button></div>
  </div>`);
  document.getElementById("cd-root").addEventListener("click", e => {
    const el = e.target.closest("[data-cd]");
    if (!el) return;
    const az = el.dataset.cd;
    if (az === "chiudi") closeModal();
    else if (az === "tieni") controlloTieniSolo(el.dataset.id, parseInt(el.dataset.i, 10), el.dataset.fp);
    else if (az === "separa") controlloSepara(el.dataset.id);
    else if (az === "assegna") controlloAssegna();
  });
}

function controlloTieniSolo(id, indice, fp) {
  const copie = state.socios.filter(s => String(s.id) === id);
  const scelta = copie[indice];
  if (!scelta || hashTesto(jsonStabile(scelta)) !== fp) { alert("I dati sono cambiati nel frattempo: riapro il controllo."); apriControlloDati(); return; }
  const nome = nomeSocioCompleto(scelta);
  if (!confirm(`Tenere solo questa copia di ${nome} ed eliminare le altre ${copie.length - 1}?`)) return;
  state.socios = state.socios.filter(s => String(s.id) !== id || s === scelta);
  logAggiornaBaseline();   // la riga "Controllo dati" qui sotto racconta già tutto: niente "Modificato" ingannevole
  saveState();
  scriviLog([{ ev: `🔧 Controllo dati: scheda doppia di ${nome} sistemata (tenuta una copia, eliminate ${copie.length - 1})` }]);
  toast("Scheda doppia sistemata");
  apriControlloDati();
  renderSection();
}

function controlloSepara(id) {
  const copie = state.socios.filter(s => String(s.id) === id);
  if (copie.length < 2) { apriControlloDati(); return; }
  const nome = nomeSocioCompleto(copie[0]);
  if (!confirm(`Tenere tutte e ${copie.length} le schede di ${nome}? Le copie dopo la prima ricevono un identificativo nuovo e diventano soci separati.`)) return;
  copie.slice(1).forEach(s => { s.id = uid(); });
  logAggiornaBaseline();
  saveState();
  scriviLog([{ ev: `🔧 Controllo dati: schede di ${nome} separate (identificativi nuovi)` }]);
  toast("Schede separate");
  apriControlloDati();
  renderSection();
}

function controlloAssegna() {
  const senza = state.socios.filter(s => !s.id);
  if (!senza.length) { apriControlloDati(); return; }
  senza.forEach(s => { s.id = uid(); });
  logAggiornaBaseline();
  saveState();
  scriviLog([{ ev: `🔧 Controllo dati: assegnato un identificativo a ${senza.length} ${senza.length === 1 ? "scheda" : "schede"}` }]);
  toast("Identificativi assegnati");
  apriControlloDati();
  renderSection();
}

// ---------- Casoncellata: disponibilità dei soci ----------
const CASO_VOCI = [
  { k: "ven", giorno: -1, lungo: "Preparativi", corto: "Prep. ven", breve: "Ven" },
  { k: "sabP", giorno: 0, lungo: "Sabato pranzo", corto: "Sab pranzo", breve: "Sab pr." },
  { k: "sabC", giorno: 0, lungo: "Sabato cena", corto: "Sab cena", breve: "Sab ce." },
  { k: "domP", giorno: 1, lungo: "Domenica pranzo", corto: "Dom pranzo", breve: "Dom pr." },
  { k: "domC", giorno: 1, lungo: "Domenica cena", corto: "Dom cena", breve: "Dom ce." },
];
const CASO_GIORNI = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
const CASO_MESI = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno", "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

function casoData(sabatoISO, delta) { const [a, m, g] = String(sabatoISO).split("-").map(Number); return new Date(a, m - 1, g + delta, 12); }
function casoDataBreve(sabatoISO, delta) { const d = casoData(sabatoISO, delta); return `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}/${d.getFullYear()}`; }
function casoGiornoTesto(sabatoISO, delta) { const d = casoData(sabatoISO, delta); return `${CASO_GIORNI[d.getDay()]} ${d.getDate()} ${CASO_MESI[d.getMonth()]}`; }
function casoPeriodoTesto(ed) {
  const s = casoData(ed.sabato, 0), d = casoData(ed.sabato, 1);
  return s.getMonth() === d.getMonth() ? `sabato ${s.getDate()} e domenica ${d.getDate()} ${CASO_MESI[d.getMonth()]} ${d.getFullYear()}`
    : `sabato ${s.getDate()} ${CASO_MESI[s.getMonth()]} e domenica ${d.getDate()} ${CASO_MESI[d.getMonth()]} ${d.getFullYear()}`;
}
function casoTitolo(ed) { return `Casoncellata ${String(ed.sabato).slice(0, 4)}`; }
// La richiesta resta aperta finché il Direttivo non la chiude, e comunque non oltre la domenica della Casoncellata.
function casoScaduta(ed) { return casoData(ed.sabato, 1).getTime() + 12 * 3600 * 1000 < Date.now(); }
function casoAperta(ed) { return !!ed && ed.aperta !== false && !casoScaduta(ed); }
function casoRiassunto(r) { const v = CASO_VOCI.filter(x => r && r[x.k]).map(x => x.lungo); return v.length ? v.join(", ") : "non sono disponibile"; }

function scaricaTesto(nome, testo, tipo) {
  const blob = new Blob(["\ufeff" + testo], { type: tipo || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = nome;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

// Le risposte stanno in un documento a parte (come le cene): tanti soci possono rispondere insieme senza sovrascriversi.
// ---------- Reparti e incarichi della Casoncellata ----------
// L'elenco iniziale vale finché l'Admin non lo modifica (e allora si salva in state.casoReparti).
const CASO_REPARTI_BASE = [
  { id: "cucina", nome: "Cucina", incarichi: ["Resp. cucina", "Cucina", "Piatti freddi", "Lavapiatti"] },
  { id: "bar", nome: "Bar", incarichi: ["Bar piano terra", "Bar 1° piano", "Bar piano terra e 1° piano"] },
  { id: "sala", nome: "Sala", incarichi: ["Resp. piani", "Sala", "Portinaio"] },
  { id: "vendita", nome: "Vendita", incarichi: ["Vendita"] },
];
function casoReparti() { return state.casoReparti && state.casoReparti.length ? state.casoReparti : CASO_REPARTI_BASE; }
function chiaveRuolo(r) { return String(r || "").trim().toLowerCase().replace(/\s+/g, " "); }
// Dato un ruolo (testo), il reparto e l'incarico dell'elenco a cui corrisponde (senza badare a maiuscole), oppure null.
function incaricoDiRuolo(ruolo) {
  const k = chiaveRuolo(ruolo);
  if (!k) return null;
  for (const rep of casoReparti()) for (const inc of rep.incarichi) if (chiaveRuolo(inc) === k) return { reparto: rep, incarico: inc };
  return null;
}
function casoRuoloCanonico(ruolo) { const m = incaricoDiRuolo(ruolo); return m ? m.incarico : String(ruolo || ""); }

// Ruoli delle Casoncellate precedenti: per ogni socio l'ultimo ruolo avuto, i ruoli già usati e l'ultima edizione in cui qualcuno ne aveva uno.
async function ruoliPrecedentiCaso(ed) {
  const prec = (state.casoncellata || []).filter(e => e.id !== ed.id && String(e.sabato) < String(ed.sabato)).sort((x, y) => String(y.sabato).localeCompare(String(x.sabato)));
  const docs = await Promise.all(prec.map(e => leggiDocCaso(e.id)));
  const mappa = {}, ruoli = new Set(); let ultima = null;
  prec.forEach((e, i) => {
    const rs = (docs[i] && docs[i].risposte) || {};
    const anno = String(e.sabato).slice(0, 4);
    Object.keys(rs).forEach(k => {
      const r = rs[k], id = k.replace(/^socio_/, "");
      if (!r || !r.ruolo) return;
      ruoli.add(r.ruolo);
      if (!mappa[id]) mappa[id] = { ruolo: casoRuoloCanonico(r.ruolo), anno };
      if (!ultima) ultima = { anno, risposte: rs };
    });
  });
  return { mappa, ruoli, ultima };
}

// La proposta (ruolo dell'ultima edizione) si aggiunge solo se la risposta ha almeno una spunta e non ha già un ruolo.
async function scriviRispostaCaso(edId, socioId, valore, proposta) {
  if (!window.db) return { errore: "Non sono collegato: controlla la connessione e riprova." };
  const ref = db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${edId}`);
  let esito = {};
  try {
    await conTimeout(db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) { esito = { errore: "Questa richiesta non esiste più." }; return; }
      if (snap.data().chiusa) { esito = { errore: "La richiesta di disponibilità è chiusa.", chiusa: true }; return; }
      const upd = {};
      const esistente = (snap.data().risposte || {})["socio_" + socioId];
      const proponi = !!proposta && CASO_VOCI.some(v => valore[v.k]) && !(esistente && esistente.ruolo);
      if (esistente) {
        // già risposto: si aggiornano solo i campi del socio, così ruolo e note assegnati dal Direttivo restano
        Object.keys(valore).forEach(k => { upd[`risposte.socio_${socioId}.${k}`] = valore[k]; });
        if (proponi) { upd[`risposte.socio_${socioId}.ruolo`] = proposta.ruolo; upd[`risposte.socio_${socioId}.ruoloProposto`] = proposta.anno; }
      } else {
        const nuovo = Object.assign({}, valore);   // prima risposta: si scrive la voce intera
        if (proponi) { nuovo.ruolo = proposta.ruolo; nuovo.ruoloProposto = proposta.anno; }
        upd[`risposte.socio_${socioId}`] = nuovo;
      }
      tx.update(ref, upd);
    }), 15000);
  } catch (err) { console.error(err); return { errore: "Non sono riuscito a salvare: controlla la connessione e riprova." }; }
  return esito;
}
// Direttivo e Admin: scrive o toglie molte risposte in una volta, anche a richiesta chiusa o Casoncellata già svolta
// (per chi non usa l'app e per i fogli cartacei). Il valore null toglie la risposta.
async function scriviRisposteCasoMolte(edId, modifiche) {
  if (currentRole === "socio") return { errore: "Operazione riservata al Direttivo." };
  if (!window.db) return { errore: "Non sono collegato: controlla la connessione e riprova." };
  const ref = db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${edId}`);
  let esito = {};
  try {
    await conTimeout(db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) { esito = { errore: "Questa richiesta non esiste più." }; return; }
      const upd = {};
      Object.keys(modifiche).forEach(id => { upd[`risposte.socio_${id}`] = modifiche[id] === null ? firebase.firestore.FieldValue.delete() : modifiche[id]; });
      tx.update(ref, upd);
    }), 20000);
  } catch (err) { console.error(err); return { errore: "Non sono riuscito a salvare: controlla la connessione e riprova." }; }
  return esito;
}
async function leggiDocCaso(edId) {
  if (!window.db) return null;
  try { const d = await db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${edId}`).get(); return d.exists ? d.data() : null; } catch (e) { console.error(e); return null; }
}

function renderCasoncellata() {
  const gestore = currentRole !== "socio";
  const tutte = [...(state.casoncellata || [])].sort((x, y) => (y.sabato || "").localeCompare(x.sabato || ""));
  if (!gestore) {
    const ed = tutte.find(e => !casoScaduta(e));   // aperta, oppure chiusa dal Direttivo ma non ancora svolta: il socio rivede la sua risposta
    return `<div id="caso-root">
      <div class="section-title">🥟 Casoncellata</div>
      ${ed ? `<div class="card-sub" style="margin-bottom:12px;">${esc(casoTitolo(ed))} · ${esc(casoPeriodoTesto(ed))}</div><div data-caso-form="${ed.id}" class="card-sub">Caricamento...</div>`
           : `<div class="card"><div class="card-sub">Al momento non c'è nessuna richiesta di disponibilità per la Casoncellata.</div></div>`}
    </div>`;
  }
  return `<div id="caso-root">
    <div class="section-title">🥟 Casoncellata</div>
    <div class="card-sub" style="margin-bottom:12px;">Richiesta di disponibilità ai soci: preparativi del venerdì, pranzo e cena del sabato e della domenica.</div>
    <div class="card">
      <div style="font-weight:800; margin-bottom:8px;">Nuova richiesta</div>
      <div class="form-group"><label>Sabato della Casoncellata</label><input type="date" id="caso-sabato"></div>
      <div class="card-sub" style="margin-bottom:8px;">Venerdì e domenica si ricavano dal sabato.</div>
      <button type="button" class="btn block" data-caso="crea">➕ Apri la richiesta di disponibilità</button>
    </div>
    <div class="ben-tasti" style="margin:0 0 10px;">
      ${currentRole === "admin" ? `<button type="button" class="btn secondary" data-caso="reparti" title="Reparti e incarichi">⚙️ Reparti e incarichi</button>` : ""}
      <button type="button" class="btn secondary" data-caso="associa" title="Associa i ruoli scritti a mano agli incarichi">🔁 Associa i vecchi ruoli</button>
    </div>
    ${tutte.length ? tutte.map(ed => `
      <div class="card">
        <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
          <div><div style="font-weight:800;">${esc(casoTitolo(ed))}</div><div class="card-sub">${esc(casoPeriodoTesto(ed))}</div></div>
          <span class="stato ${casoAperta(ed) ? "ok" : "no"}">${casoScaduta(ed) ? "Già svolta" : (casoAperta(ed) ? "Richiesta aperta" : "Chiusa")}</span>
        </div>
        <div class="card-sub" data-caso-conta="${ed.id}" style="margin-top:8px;">Caricamento risposte...</div>
        <div class="ben-tasti" style="margin-top:10px;">
          <button type="button" class="btn" data-caso="report" data-id="${ed.id}">📊 Report</button>
          <button type="button" class="btn" data-caso="tabellone" data-id="${ed.id}" title="Chi c'è in ogni reparto, pranzo e cena">📋 Tabellone</button>
        </div>
        <div class="ben-tasti" style="margin-top:8px;">
          <button type="button" class="btn" data-caso="ruoli" data-id="${ed.id}" title="Assegna il ruolo a chi ha dato disponibilità">🧑‍🍳 Assegna ruoli</button>
          <button type="button" class="btn secondary" data-caso="mano" data-id="${ed.id}" title="Inserisci le disponibilità di chi non usa l'app o dal foglio cartaceo">📝 Inserisci a mano</button>
        </div>
        <div class="ben-tasti" style="margin-top:8px;">
          <button type="button" class="btn secondary" data-caso="${ed.aperta === false ? "riapri" : "chiudi"}" data-id="${ed.id}">${ed.aperta === false ? "Riapri ai soci" : "Chiudi ai soci"}</button>
          <button type="button" class="btn danger" data-caso="elimina" data-id="${ed.id}" title="Elimina la richiesta e tutte le risposte">🗑️ Elimina</button>
        </div>
      </div>`).join("") : `<div class="card-sub">Nessuna richiesta ancora creata.</div>`}
  </div>`;
}

function contaCaso(dati) {
  const r = Object.values((dati && dati.risposte) || {});
  const tot = { risposto: r.length };
  CASO_VOCI.forEach(v => { tot[v.k] = r.filter(x => x && x[v.k]).length; });
  return tot;
}

function attachCasoncellataEvents() {
  const root = document.getElementById("caso-root");
  if (!root) return;
  root.addEventListener("click", e => {
    const el = e.target.closest("[data-caso]");
    if (!el) return;
    const az = el.dataset.caso;
    if (az === "crea") creaRichiestaCaso();
    else if (az === "report") apriReportCaso(el.dataset.id);
    else if (az === "mano") apriInserimentoCaso(el.dataset.id);
    else if (az === "ruoli") apriAssegnaRuoliCaso(el.dataset.id);
    else if (az === "tabellone") apriTabelloneCaso(el.dataset.id);
    else if (az === "reparti") apriRepartiCaso();
    else if (az === "associa") apriAssociaRuoliCaso();
    else if (az === "chiudi") impostaApertaCaso(el.dataset.id, false);
    else if (az === "riapri") impostaApertaCaso(el.dataset.id, true);
    else if (az === "elimina") eliminaRichiestaCaso(el.dataset.id);
  });
  root.querySelectorAll("[data-caso-form]").forEach(async el => {
    const ed = (state.casoncellata || []).find(x => x.id === el.dataset.casoForm);
    if (ed) disegnaFormCaso(ed, el, await leggiDocCaso(ed.id));
  });
  root.querySelectorAll("[data-caso-conta]").forEach(async el => {
    const dati = await leggiDocCaso(el.dataset.casoConta);
    if (!dati) { el.textContent = "Risposte non disponibili (controlla la connessione)."; return; }
    const t = contaCaso(dati);
    el.innerHTML = `<b>${t.risposto}</b> ${t.risposto === 1 ? "ha risposto" : "hanno risposto"} · ` + CASO_VOCI.map(v => `${v.corto}: <b>${t[v.k]}</b>`).join(" · ");
  });
}

// Il riquadro del socio: cinque voci, una nota facoltativa, un tasto.
function disegnaFormCaso(ed, el, dati) {
  const mio = benMioId(), s = mio ? socioCorrente() : null;
  el.className = "";
  if (!s) { el.innerHTML = `<div class="iscr info">Per dare la tua disponibilità entra con il tuo nome e la tua data di nascita, non con il profilo condiviso.</div>`; return; }
  const mia = dati && dati.risposte ? dati.risposte["socio_" + mio] : null;
  const chiusa = !dati || dati.chiusa || !casoAperta(ed);
  const dettaglio = mia ? `<div class="card-sub" style="margin-top:8px;">✅ Hai risposto il ${fmtDate(String(mia.ts || "").slice(0, 10))}: ${esc(casoRiassunto(mia))}.</div>` : "";
  if (chiusa) {
    el.innerHTML = `<div class="iscr passata">La richiesta di disponibilità è chiusa.</div>${mia ? dettaglio : `<div class="card-sub" style="margin-top:8px;">Non hai risposto.</div>`}`;
    return;
  }
  el.innerHTML = `<div class="iscr nuova">
    <div class="iscr-t">Dai la tua disponibilità</div>
    <div class="caso-griglia">
      <div class="g-t g-ven">Venerdì</div><div class="g-t g-sab">Sabato ${casoDataBreve(ed.sabato, 0)}</div><div class="g-t g-dom">Domenica ${casoDataBreve(ed.sabato, 1)}</div>
      <div class="g-v">Preparativi</div><div class="g-v">Pranzo</div><div class="g-v">Cena</div><div class="g-v">Pranzo</div><div class="g-v">Cena</div>
      ${CASO_VOCI.map(v => `<label class="g-c" title="${esc(v.lungo)}"><input type="checkbox" data-v="${v.k}" aria-label="${esc(v.lungo)}" ${mia && mia[v.k] ? "checked" : ""}></label>`).join("")}
    </div>
    <div data-caso-errore style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <button type="button" class="btn block" data-salva>${mia ? "Aggiorna la mia disponibilità" : "Salva la mia disponibilità"}</button>
    ${dettaglio}
    <div class="card-sub" style="margin-top:6px;">Se non puoi nessun giorno, salva senza spuntare niente: il Direttivo saprà che hai risposto.</div>
  </div>`;
  el.querySelector("[data-salva]").addEventListener("click", async ev => {
    const btn = ev.currentTarget; btn.disabled = true;
    const valore = { nome: `${s.cognome} ${s.nome}`.trim(), ts: new Date().toISOString() };
    CASO_VOCI.forEach(v => { valore[v.k] = el.querySelector(`[data-v="${v.k}"]`).checked; });
    const prec = await ruoliPrecedentiCaso(ed);
    const esito = await scriviRispostaCaso(ed.id, mio, valore, prec.mappa[mio] || null);
    if (esito.errore) { el.querySelector("[data-caso-errore]").textContent = esito.errore; btn.disabled = false; if (esito.chiusa) disegnaFormCaso(ed, el, await leggiDocCaso(ed.id)); return; }
    scriviLog([{ ev: `🥟 ${casoTitolo(ed)}: ${valore.nome} ${mia ? "ha cambiato la disponibilità" : "ha dato la disponibilità"} (${casoRiassunto(valore)})` }]);
    toast("Disponibilità salvata ✅");
    disegnaFormCaso(ed, el, await leggiDocCaso(ed.id));
  });
}

// ---- Direttivo e Admin ----
async function creaRichiestaCaso() {
  if (currentRole === "socio") return;
  const sabato = document.getElementById("caso-sabato").value;
  if (!sabato) { alert("Scegli la data del sabato della Casoncellata."); return; }
  if (casoData(sabato, 0).getDay() !== 6 && !confirm("La data scelta non è un sabato. Continuare lo stesso?")) return;
  if ((state.casoncellata || []).some(e => e.sabato === sabato)) { alert("Esiste già una richiesta per questa data."); return; }
  if (casoData(sabato, 1).getTime() + 12 * 3600 * 1000 < Date.now() && !confirm("Questa Casoncellata è già passata: per i soci la richiesta resterà chiusa, ma tu potrai inserire le disponibilità a mano (per esempio dal foglio cartaceo). Continuare?")) return;
  const id = uid();
  if (window.db) {
    try { await db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${id}`).set({ sabato, chiusa: false, risposte: {} }); }
    catch (e) { console.error(e); alert("Non sono riuscito a creare la richiesta: controlla la connessione e riprova."); return; }
  }
  state.casoncellata = state.casoncellata || [];
  state.casoncellata.push({ id, sabato, aperta: true, creato: new Date().toISOString() });
  saveState();
  renderSection();
  toast("Richiesta aperta ai soci");
}

async function impostaApertaCaso(edId, aperta) {
  if (currentRole === "socio") return;
  const ed = (state.casoncellata || []).find(x => x.id === edId);
  if (!ed) return;
  if (window.db) {
    try { await db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${edId}`).update({ chiusa: !aperta }); }
    catch (e) { console.error(e); alert("Non sono riuscito ad aggiornare la richiesta: controlla la connessione e riprova."); return; }
  }
  ed.aperta = aperta;
  saveState();
  renderSection();
  toast(aperta ? "Richiesta riaperta" : "Richiesta chiusa");
}

async function eliminaRichiestaCaso(edId) {
  if (currentRole === "socio") return;
  const ed = (state.casoncellata || []).find(x => x.id === edId);
  if (!ed || !confirm(`Eliminare la richiesta «${casoTitolo(ed)}» e tutte le risposte dei soci?`)) return;
  if (window.db) { try { await db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${edId}`).delete(); } catch (e) { console.error(e); } }
  state.casoncellata = state.casoncellata.filter(x => x.id !== edId);
  saveState();
  renderSection();
}

// "Inserisci a mano": l'elenco dei soci con le cinque colonne da spuntare, come sul foglio cartaceo.
async function apriInserimentoCaso(edId) {
  if (currentRole === "socio") return;
  const ed = (state.casoncellata || []).find(x => x.id === edId);
  if (!ed) return;
  const dati = await leggiDocCaso(edId);
  if (!dati) { alert("Non riesco a leggere le risposte: controlla la connessione e riprova."); return; }
  const risposte = dati.risposte || {};
  const prec = await ruoliPrecedentiCaso(ed);
  const soci = state.socios.filter(s => !s.andatoAvanti).sort((x, y) => `${x.cognome} ${x.nome}`.localeCompare(`${y.cognome} ${y.nome}`, "it", { sensitivity: "base" }));
  const flag = r => { const o = {}; CASO_VOCI.forEach(v => { o[v.k] = !!(r && r[v.k]); }); return o; };
  const iniziale = {};
  soci.forEach(s => { iniziale[s.id] = risposte["socio_" + s.id] ? flag(risposte["socio_" + s.id]) : null; });
  showModal(`<div id="cm-root">
    <div class="modal-title">📝 Inserisci a mano</div>
    <div class="card-sub" style="margin-bottom:8px;">${esc(casoTitolo(ed))}. Per i soci senza app o dal foglio cartaceo. Spunta i momenti: una riga senza spunte non compare nel report. Chi ha risposto dall'app è già spuntato.</div>
    <input type="text" id="cm-cerca" placeholder="Cerca un socio..." style="width:100%; box-sizing:border-box; margin-bottom:6px;">
    <div class="cm-testa">
      <div class="cm-riga"><span class="cm-nome"></span><span class="cm-g" style="width:38px;">Ven</span><span class="cm-g" style="width:80px;">Sab ${casoDataBreve(ed.sabato, 0).slice(0, 5)}</span><span class="cm-g" style="width:80px;">Dom ${casoDataBreve(ed.sabato, 1).slice(0, 5)}</span></div>
      <div class="cm-riga"><span class="cm-nome"></span><span class="cm-c">Prep.</span><span class="cm-c">Pr.</span><span class="cm-c">Ce.</span><span class="cm-c">Pr.</span><span class="cm-c">Ce.</span></div>
    </div>
    <div id="cm-lista" style="max-height:42vh; overflow-y:auto;">${soci.map(s => `
      <div class="cm-riga" data-id="${s.id}" data-nome="${esc(`${s.cognome} ${s.nome}`.toLowerCase())}">
        <span class="cm-nome">${esc(s.cognome)} ${esc(s.nome)}</span>${CASO_VOCI.map(v => `<span class="cm-c"><input type="checkbox" data-s="${s.id}" data-k="${v.k}" ${iniziale[s.id] && iniziale[s.id][v.k] ? "checked" : ""}></span>`).join("")}
      </div>`).join("")}</div>
    <div class="cm-riga cm-tot"><span class="cm-nome"><b>Totale</b></span>${CASO_VOCI.map(v => `<span class="cm-c"><b data-tot="${v.k}">0</b></span>`).join("")}</div>
    <div id="cm-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-top:6px;"></div>
    <div class="modal-actions"><button type="button" class="btn secondary" id="cm-chiudi">Chiudi</button><button type="button" class="btn" id="cm-salva">Salva</button></div>
  </div>`);
  const spunta = (id, k) => document.querySelector(`#cm-lista input[data-s="${id}"][data-k="${k}"]`).checked;
  const totali = () => CASO_VOCI.forEach(v => { document.querySelector(`[data-tot="${v.k}"]`).textContent = soci.filter(s => spunta(s.id, v.k)).length; });
  totali();
  document.getElementById("cm-lista").addEventListener("change", totali);
  document.getElementById("cm-cerca").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#cm-lista .cm-riga").forEach(r => { r.style.display = !q || r.dataset.nome.includes(q) ? "" : "none"; });
  });
  document.getElementById("cm-chiudi").addEventListener("click", closeModal);
  document.getElementById("cm-salva").addEventListener("click", async () => {
    const modifiche = {}; let aggiornate = 0, tolte = 0;
    soci.forEach(s => {
      const nuovo = {}; CASO_VOCI.forEach(v => { nuovo[v.k] = spunta(s.id, v.k); });
      const iniz = iniziale[s.id], haX = CASO_VOCI.some(v => nuovo[v.k]);
      const uguale = iniz ? CASO_VOCI.every(v => iniz[v.k] === nuovo[v.k]) : !haX;
      if (uguale) return;
      if (!haX) { modifiche[s.id] = null; tolte++; return; }
      const prima = risposte["socio_" + s.id];
      let ruolo = prima ? prima.ruolo || "" : "", proposto = prima && prima.ruolo ? String(prima.ruoloProposto || "") : "";
      if (!ruolo && prec.mappa[s.id]) { ruolo = prec.mappa[s.id].ruolo; proposto = prec.mappa[s.id].anno; }   // ruolo dell'ultima edizione, da confermare
      const voce = Object.assign({ nome: `${s.cognome} ${s.nome}`.trim(), nota: prima ? prima.nota || "" : "", ruolo, ts: new Date().toISOString(), da: "direttivo" }, nuovo);
      if (proposto) voce.ruoloProposto = proposto;
      modifiche[s.id] = voce;
      aggiornate++;
    });
    if (!aggiornate && !tolte) { closeModal(); return; }
    const btn = document.getElementById("cm-salva"); btn.disabled = true;
    const esito = await scriviRisposteCasoMolte(edId, modifiche);
    if (esito.errore) { document.getElementById("cm-errore").textContent = esito.errore; btn.disabled = false; return; }
    scriviLog([{ ev: `🥟 ${casoTitolo(ed)}: disponibilità inserite a mano dal Direttivo (${aggiornate} ${aggiornate === 1 ? "riga" : "righe"}${tolte ? ", " + tolte + " tolte" : ""})` }]);
    closeModal();
    toast("Disponibilità salvate");
    renderSection();
  });
}

// Direttivo e Admin: scrive Ruolo e Note di più soci in una volta, senza toccare il resto della risposta (spunte, orario, origine).
async function scriviRuoliCaso(edId, modifiche) {
  if (currentRole === "socio") return { errore: "Operazione riservata al Direttivo." };
  if (!window.db) return { errore: "Non sono collegato: controlla la connessione e riprova." };
  const ref = db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${edId}`);
  let esito = {};
  try {
    await conTimeout(db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) { esito = { errore: "Questa richiesta non esiste più." }; return; }
      const risposte = snap.data().risposte || {};
      const upd = {};
      Object.keys(modifiche).forEach(id => {
        if (!risposte["socio_" + id]) return;   // si assegna solo a chi ha una risposta
        upd[`risposte.socio_${id}.ruolo`] = modifiche[id].ruolo;
        upd[`risposte.socio_${id}.nota`] = modifiche[id].nota;
        upd[`risposte.socio_${id}.ruoloProposto`] = modifiche[id].proposto ? modifiche[id].proposto : firebase.firestore.FieldValue.delete();   // confermato o cambiato: niente più asterisco
      });
      if (Object.keys(upd).length) tx.update(ref, upd);
    }), 20000);
  } catch (err) { console.error(err); return { errore: "Non sono riuscito a salvare: controlla la connessione e riprova." }; }
  return esito;
}

const CASO_RUOLI_BASE = ["Cuochi", "Lavapiatti", "Camerieri piatti", "Camerieri bar", "Pulizia tavoli", "Gazebo"];

// "Assegna ruoli": chi ha dato disponibilità, con le sue spunte, il Ruolo (un menu con gli incarichi, raggruppati per reparto) e le Note.
// Se c'è una Casoncellata precedente con i ruoli, in cima c'è il riepilogo per reparto (per tappare i buchi) e i ruoli copiati restano "da confermare".
function opzioniRuoloCaso(corrente) {
  const m = incaricoDiRuolo(corrente);
  const gruppi = casoReparti().map(rep => `<optgroup label="${esc(rep.nome)}">${rep.incarichi.map(inc => `<option value="${esc(inc)}"${m && m.incarico === inc ? " selected" : ""}>${esc(inc)}</option>`).join("")}</optgroup>`).join("");
  const altro = corrente && !m ? `<optgroup label="Altro (da associare)"><option value="${esc(corrente)}" selected>${esc(corrente)}</option></optgroup>` : "";
  return `<option value=""${!corrente ? " selected" : ""}>— nessun ruolo —</option>${gruppi}${altro}`;
}

async function apriAssegnaRuoliCaso(edId) {
  if (currentRole === "socio") return;
  const ed = (state.casoncellata || []).find(x => x.id === edId);
  if (!ed) return;
  const dati = await leggiDocCaso(edId);
  if (!dati) { alert("Non riesco a leggere le risposte: controlla la connessione e riprova."); return; }
  const risposte = dati.risposte || {};
  const nome = s => `${s.cognome} ${s.nome}`.trim();
  const ordina = (x, y) => nome(x).localeCompare(nome(y), "it", { sensitivity: "base" });
  const soci = state.socios.filter(s => {
    const r = risposte["socio_" + s.id];
    return !s.andatoAvanti && r && (CASO_VOCI.some(v => r[v.k]) || r.ruolo || r.nota);
  }).sort(ordina);
  if (!soci.length) { alert("Nessun socio ha ancora dato disponibilità. Aspetta le risposte, oppure usa «Inserisci a mano»."); return; }
  const prec = await ruoliPrecedentiCaso(ed);
  const iniz = {};
  soci.forEach(s => { const r = risposte["socio_" + s.id]; iniz[s.id] = { ruolo: casoRuoloCanonico(r.ruolo || ""), nota: String(r.nota || ""), prop: String(r.ruoloProposto || "") }; });
  const confermati = new Set();
  // chi c'era nell'ultima edizione con un ruolo, e non ha risposto o ha detto di non poter venire
  const nonRisposto = [], hannoDettoNo = [];
  if (prec.ultima) {
    state.socios.filter(s => !s.andatoAvanti).sort(ordina).forEach(s => {
      const rp = prec.ultima.risposte["socio_" + s.id];
      if (!rp || !rp.ruolo) return;
      const cur = risposte["socio_" + s.id];
      if (!cur) nonRisposto.push(`${nome(s)} (${casoRuoloCanonico(rp.ruolo)})`);
      else if (!CASO_VOCI.some(v => cur[v.k])) hannoDettoNo.push(`${nome(s)} (${casoRuoloCanonico(rp.ruolo)})`);
    });
  }
  const haProposte = soci.some(s => iniz[s.id].prop);
  showModal(`<div id="ar-root">
    <div class="modal-title">🧑‍🍳 Assegna ruoli</div>
    <div class="card-sub" style="margin-bottom:4px;">${esc(casoTitolo(ed))}. Scegli l'incarico di ognuno dal menu e, se serve, scrivi una nota.</div>
    ${prec.ultima ? `<div class="box-riep"><div style="font-weight:800;">Riepilogo per reparto</div><div id="ar-riep"></div>
      ${nonRisposto.length ? `<div style="font-size:.82rem; margin-top:4px;"><b>Non hanno ancora risposto, c'erano nel ${esc(prec.ultima.anno)} (${nonRisposto.length}):</b> ${esc(nonRisposto.join(", "))}.</div>` : ""}
      ${hannoDettoNo.length ? `<div style="font-size:.82rem; margin-top:4px;"><b>Hanno detto che non possono (${hannoDettoNo.length}):</b> ${esc(hannoDettoNo.join(", "))}.</div>` : ""}</div>` : ""}
    <div class="box-att" id="ar-banner" style="display:none;"><span id="ar-banner-t"></span><button type="button" class="btn" id="ar-conferma" style="padding:6px 12px; font-size:.85rem;">Conferma tutti</button></div>
    <input type="text" id="ar-cerca" placeholder="Cerca un socio..." style="width:100%; box-sizing:border-box;">
    <div class="ar-filtri"><button type="button" class="ar-f att" data-f="tutti"></button><button type="button" class="ar-f" data-f="senza"></button>${haProposte ? '<button type="button" class="ar-f" data-f="conferma"></button>' : ""}</div>
    <div class="ar-conta" id="ar-conta"></div>
    <div id="ar-lista" style="max-height:44vh; overflow-y:auto;">${soci.map(s => { const r = risposte["socio_" + s.id]; return `
      <div class="ar-riga" data-id="${s.id}" data-nome="${esc(nome(s).toLowerCase())}">
        <div class="ar-nome">${esc(nome(s))}<span class="ar-tag" data-tag="${s.id}" style="display:none;"></span></div>
        <div class="ar-chips">${CASO_VOCI.filter(v => r[v.k]).map(v => `<span class="ar-chip">${esc(v.breve)}</span>`).join("") || '<span class="card-sub">Ha risposto: nessun giorno</span>'}</div>
        <div class="ar-campi"><div><label>Ruolo</label><select data-r="${s.id}" class="sel-ruolo">${opzioniRuoloCaso(iniz[s.id].ruolo)}</select></div><div><label>Note</label><input type="text" maxlength="120" data-n="${s.id}" placeholder="facoltative" value="${esc(iniz[s.id].nota)}"></div></div>
      </div>`; }).join("")}</div>
    <div id="ar-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-top:6px;"></div>
    <div class="modal-actions"><button type="button" class="btn secondary" id="ar-chiudi">Chiudi</button><button type="button" class="btn" id="ar-salva">Salva</button></div>
  </div>`);
  let filtro = "tutti";
  const val = (sel, id) => document.querySelector(`#ar-lista [${sel}="${id}"]`).value.trim().replace(/\s+/g, " ");
  // un ruolo copiato resta "da confermare" finché non lo confermi o lo cambi
  const propAttiva = id => !!iniz[id].prop && !confermati.has(id) && val("data-r", id) === iniz[id].ruolo;
  const riepilogo = () => {
    const box = document.getElementById("ar-riep");
    if (!box) return;
    const ora = {}, prima = {}, altroOra = {}, altroPrima = {};
    const conta = (mappa, altro, ruolo) => { const m = incaricoDiRuolo(ruolo); if (m) mappa[m.incarico] = (mappa[m.incarico] || 0) + 1; else if (ruolo) altro[ruolo] = (altro[ruolo] || 0) + 1; };
    Object.keys(prec.ultima.risposte).forEach(k => {
      const rp = prec.ultima.risposte[k], s = state.socios.find(x => "socio_" + x.id === k);
      if (rp && rp.ruolo && s && !s.andatoAvanti) conta(prima, altroPrima, rp.ruolo);
    });
    soci.forEach(s => conta(ora, altroOra, val("data-r", s.id)));
    const diff = (q, p) => { const d = q - p; return `<td class="${d < 0 ? "male" : d > 0 ? "bene" : ""}">${d < 0 ? "mancano " + (-d) : d > 0 ? "+" + d : "ok"}</td>`; };
    let righe = "";
    casoReparti().forEach(rep => {
      const q = rep.incarichi.reduce((n, i) => n + (ora[i] || 0), 0), p = rep.incarichi.reduce((n, i) => n + (prima[i] || 0), 0);
      if (!q && !p) return;
      righe += `<tr class="rep-r"><td>${esc(rep.nome)}</td><td>${q}</td><td>${p}</td>${diff(q, p)}</tr>`;
      rep.incarichi.forEach(i => { if (ora[i] || prima[i]) righe += `<tr><td class="i">${esc(i)}</td><td>${ora[i] || 0}</td><td>${prima[i] || 0}</td>${diff(ora[i] || 0, prima[i] || 0)}</tr>`; });
    });
    const testi = [...new Set(Object.keys(altroOra).concat(Object.keys(altroPrima)))];
    if (testi.length) {
      righe += `<tr class="rep-r"><td>Altro (da associare)</td><td>${testi.reduce((n, t) => n + (altroOra[t] || 0), 0)}</td><td>${testi.reduce((n, t) => n + (altroPrima[t] || 0), 0)}</td><td></td></tr>`;
      testi.forEach(t => { righe += `<tr><td class="i">${esc(t)}</td><td>${altroOra[t] || 0}</td><td>${altroPrima[t] || 0}</td><td></td></tr>`; });
    }
    box.innerHTML = `<table class="riep"><tr><th></th><th>Quest'anno</th><th>Nel ${esc(prec.ultima.anno)}</th><th></th></tr>${righe}</table>`;
  };
  const aggiornaLive = () => {
    const conRuolo = soci.filter(s => val("data-r", s.id)).length;
    document.getElementById("ar-conta").textContent = `${conRuolo} su ${soci.length} con un ruolo`;
    const daConf = soci.filter(s => propAttiva(s.id)).length;
    const anni = [...new Set(soci.filter(s => iniz[s.id].prop).map(s => iniz[s.id].prop))].sort().join(" e dal ");
    document.getElementById("ar-banner").style.display = daConf ? "flex" : "none";
    document.getElementById("ar-banner-t").textContent = `⚠️ ${daConf} ${daConf === 1 ? "ruolo proposto" : "ruoli proposti"} dal ${anni}, da confermare`;
    soci.forEach(s => {
      const att = propAttiva(s.id), tag = document.querySelector(`[data-tag="${s.id}"]`);
      tag.style.display = att ? "" : "none"; tag.textContent = att ? `dal ${iniz[s.id].prop} *` : "";
      document.querySelector(`#ar-lista [data-r="${s.id}"]`).classList.toggle("prop", att);
    });
    riepilogo();
    return { conRuolo, daConf };
  };
  const aggiorna = () => {
    const q = document.getElementById("ar-cerca").value.trim().toLowerCase();
    const { conRuolo, daConf } = aggiornaLive();
    document.querySelector('[data-f="tutti"]').textContent = `Tutti (${soci.length})`;
    document.querySelector('[data-f="senza"]').textContent = `Senza ruolo (${soci.length - conRuolo})`;
    const bc = document.querySelector('[data-f="conferma"]'); if (bc) bc.textContent = `Da confermare (${daConf})`;
    document.querySelectorAll("#ar-lista .ar-riga").forEach(r => {
      const id = r.dataset.id;
      const ok = (!q || r.dataset.nome.includes(q)) && (filtro === "tutti" || (filtro === "senza" && !val("data-r", id)) || (filtro === "conferma" && propAttiva(id)));
      r.style.display = ok ? "" : "none";
    });
    document.querySelectorAll(".ar-f").forEach(b => b.classList.toggle("att", b.dataset.f === filtro));
  };
  aggiorna();
  document.getElementById("ar-cerca").addEventListener("input", aggiorna);
  document.querySelectorAll(".ar-f").forEach(b => b.addEventListener("click", () => { filtro = b.dataset.f; aggiorna(); }));
  // la riga non sparisce dal filtro mentre la si sta modificando: si ricalcola quando si esce dal campo
  document.getElementById("ar-lista").addEventListener("focusout", aggiorna);
  document.getElementById("ar-lista").addEventListener("input", aggiornaLive);
  document.getElementById("ar-lista").addEventListener("change", aggiornaLive);
  document.getElementById("ar-conferma").addEventListener("click", () => { soci.forEach(s => { if (propAttiva(s.id)) confermati.add(s.id); }); aggiorna(); });
  document.getElementById("ar-chiudi").addEventListener("click", closeModal);
  document.getElementById("ar-salva").addEventListener("click", async () => {
    const modifiche = {}; let n = 0;
    soci.forEach(s => {
      const ruolo = val("data-r", s.id), nota = val("data-n", s.id), proposto = propAttiva(s.id) ? iniz[s.id].prop : "";
      if (ruolo !== iniz[s.id].ruolo || nota !== iniz[s.id].nota || proposto !== iniz[s.id].prop) { modifiche[s.id] = { ruolo, nota, proposto }; n++; }
    });
    if (!n) { closeModal(); return; }
    const btn = document.getElementById("ar-salva"); btn.disabled = true;
    const esito = await scriviRuoliCaso(edId, modifiche);
    if (esito.errore) { document.getElementById("ar-errore").textContent = esito.errore; btn.disabled = false; return; }
    scriviLog([{ ev: `🥟 ${casoTitolo(ed)}: ruoli e note assegnati dal Direttivo (${n} ${n === 1 ? "riga" : "righe"})` }]);
    closeModal();
    toast("Ruoli salvati");
    renderSection();
  });
}

// ---- Reparti e incarichi (solo Admin) ----
function repartiModificabili() {
  if (!state.casoReparti || !state.casoReparti.length) state.casoReparti = JSON.parse(JSON.stringify(CASO_REPARTI_BASE));
  return state.casoReparti;
}
// Quante risposte (in tutti gli anni) hanno questo incarico: serve ad avvisare prima di toglierlo.
async function usoIncarichiCaso(incarichi) {
  const chiavi = new Set(incarichi.map(chiaveRuolo)); let n = 0;
  const docs = await Promise.all((state.casoncellata || []).map(e => leggiDocCaso(e.id)));
  docs.forEach(d => { if (d) Object.values(d.risposte || {}).forEach(r => { if (r && chiavi.has(chiaveRuolo(r.ruolo))) n++; }); });
  return n;
}
function apriRepartiCaso() {
  if (currentRole !== "admin") return;
  const reparti = casoReparti();
  const pulisci = t => String(t || "").trim().replace(/\s+/g, " ");
  showModal(`<div id="rc-root">
    <div class="modal-title">⚙️ Reparti e incarichi</div>
    <div class="card-sub" style="margin-bottom:6px;">Solo l'Admin. Gli incarichi si scelgono poi dal menu del Ruolo in «Assegna ruoli». Le modifiche valgono subito.</div>
    ${reparti.map(rep => `<div class="gr" data-rep="${esc(rep.id)}">
      <div class="t"><span>${esc(rep.nome)}</span><span><button type="button" class="rc-ico" data-rc="rinomina" data-rep="${esc(rep.id)}" title="Rinomina il reparto">✏️</button><button type="button" class="rc-ico" data-rc="elimina-rep" data-rep="${esc(rep.id)}" title="Elimina il reparto">🗑️</button></span></div>
      <div>${rep.incarichi.map(inc => `<span class="c">${esc(inc)} <button type="button" class="rc-x" data-rc="elimina-inc" data-rep="${esc(rep.id)}" data-inc="${esc(inc)}" title="Togli l'incarico">✕</button></span>`).join("") || '<span class="card-sub">Nessun incarico</span>'}</div>
      <div class="rc-nuovo"><input type="text" maxlength="40" placeholder="Nuovo incarico…" data-nuovo-inc="${esc(rep.id)}"><button type="button" class="btn secondary" data-rc="aggiungi-inc" data-rep="${esc(rep.id)}">＋</button></div>
    </div>`).join("")}
    <div class="rc-nuovo" style="margin-top:8px;"><input type="text" maxlength="30" placeholder="Nuovo reparto…" id="rc-nuovo-rep"><button type="button" class="btn secondary" data-rc="aggiungi-rep">＋ Reparto</button></div>
    <div id="rc-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-top:6px;"></div>
    <div class="modal-actions"><button type="button" class="btn" data-rc="chiudi">Chiudi</button></div>
  </div>`);
  const errore = t => { document.getElementById("rc-errore").textContent = t; };
  const fatto = ev => { saveState(); scriviLog([{ ev: `🥟 Reparti e incarichi della Casoncellata: ${ev}` }]); apriRepartiCaso(); };
  document.getElementById("rc-root").addEventListener("click", async e => {
    const b = e.target.closest("[data-rc]");
    if (!b) return;
    const az = b.dataset.rc, repId = b.dataset.rep;
    if (az === "chiudi") { closeModal(); renderSection(); return; }
    if (az === "aggiungi-rep") {
      const n = pulisci(document.getElementById("rc-nuovo-rep").value);
      if (!n) { errore("Scrivi il nome del reparto."); return; }
      if (casoReparti().some(r => chiaveRuolo(r.nome) === chiaveRuolo(n))) { errore(`Il reparto «${n}» esiste già.`); return; }
      repartiModificabili().push({ id: uid(), nome: n, incarichi: [] });
      fatto(`aggiunto il reparto «${n}»`); return;
    }
    const rep = repartiModificabili().find(r => r.id === repId);
    if (!rep) return;
    if (az === "aggiungi-inc") {
      const n = pulisci(document.querySelector(`[data-nuovo-inc="${repId}"]`).value);
      if (!n) { errore("Scrivi il nome dell'incarico."); return; }
      const gia = incaricoDiRuolo(n);
      if (gia) { errore(`L'incarico «${gia.incarico}» esiste già (reparto ${gia.reparto.nome}).`); return; }
      rep.incarichi.push(n);
      fatto(`aggiunto l'incarico «${n}» a ${rep.nome}`); return;
    }
    if (az === "rinomina") {
      const n = pulisci(prompt("Nuovo nome del reparto", rep.nome));
      if (!n || n === rep.nome) return;
      if (casoReparti().some(r => r.id !== rep.id && chiaveRuolo(r.nome) === chiaveRuolo(n))) { errore(`Il reparto «${n}» esiste già.`); return; }
      const vecchio = rep.nome; rep.nome = n;
      fatto(`il reparto «${vecchio}» ora si chiama «${n}»`); return;
    }
    if (az === "elimina-inc") {
      const inc = b.dataset.inc, uso = await usoIncarichiCaso([inc]);
      if (!confirm(`Togliere l'incarico «${inc}» dal reparto ${rep.nome}?${uso ? `\n\n${uso} ${uso === 1 ? "risposta ha" : "risposte hanno"} questo incarico (in tutti gli anni): resteranno con il ruolo scritto, da associare di nuovo.` : ""}`)) return;
      rep.incarichi = rep.incarichi.filter(x => x !== inc);
      fatto(`tolto l'incarico «${inc}» da ${rep.nome}`); return;
    }
    if (az === "elimina-rep") {
      const uso = await usoIncarichiCaso(rep.incarichi);
      if (!confirm(`Eliminare il reparto «${rep.nome}»${rep.incarichi.length ? ` e i suoi ${rep.incarichi.length} ${rep.incarichi.length === 1 ? "incarico" : "incarichi"}` : ""}?${uso ? `\n\n${uso} ${uso === 1 ? "risposta ha" : "risposte hanno"} uno di questi incarichi (in tutti gli anni): resteranno con il ruolo scritto, da associare di nuovo.` : ""}`)) return;
      state.casoReparti = repartiModificabili().filter(r => r.id !== rep.id);
      if (!state.casoReparti.length) state.casoReparti = [{ id: uid(), nome: "Nuovo reparto", incarichi: [] }];   // l'elenco non resta mai vuoto (tornerebbe a quello iniziale)
      fatto(`eliminato il reparto «${rep.nome}»`); return;
    }
  });
}

// ---- Associare i vecchi ruoli (scritti a mano) agli incarichi ----
async function apriAssociaRuoliCaso() {
  if (currentRole === "socio") return;
  const edizioni = [...(state.casoncellata || [])].sort((x, y) => String(x.sabato).localeCompare(String(y.sabato)));
  const docs = await Promise.all(edizioni.map(e => leggiDocCaso(e.id)));
  if (docs.some(d => !d) && !window.db) { alert("Non riesco a leggere le risposte: controlla la connessione e riprova."); return; }
  const trovati = {};   // chiave → { etichette: {testo: n}, n, anni:Set }
  docs.forEach((d, i) => {
    if (!d) return;
    const anno = String(edizioni[i].sabato).slice(0, 4);
    Object.values(d.risposte || {}).forEach(r => {
      if (!r || !r.ruolo || incaricoDiRuolo(r.ruolo)) return;
      const k = chiaveRuolo(r.ruolo), t = trovati[k] = trovati[k] || { etichette: {}, n: 0, anni: new Set() };
      t.etichette[r.ruolo] = (t.etichette[r.ruolo] || 0) + 1; t.n++; t.anni.add(anno);
    });
  });
  const chiavi = Object.keys(trovati).sort();
  if (!chiavi.length) { alert("Nessun ruolo da associare: tutti i ruoli corrispondono agli incarichi."); return; }
  const etichetta = k => Object.keys(trovati[k].etichette).sort((a, b) => trovati[k].etichette[b] - trovati[k].etichette[a])[0];
  const opzioni = `<option value="">— scegli l'incarico —</option>${casoReparti().map(rep => `<optgroup label="${esc(rep.nome)}">${rep.incarichi.map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join("")}</optgroup>`).join("")}`;
  showModal(`<div id="as-root">
    <div class="modal-title">🔁 Associa i vecchi ruoli</div>
    <div class="card-sub" style="margin-bottom:6px;">Nelle Casoncellate già caricate ci sono ruoli scritti a mano. Dì a quale incarico corrisponde ognuno: l'app li aggiorna in tutti gli anni, così i confronti con l'anno scorso funzionano.</div>
    ${chiavi.map(k => `<div class="ar-riga"><div class="ar-nome">«${esc(etichetta(k))}» <span style="font-weight:600; color:#666; font-size:.85rem;">· ${trovati[k].n} ${trovati[k].n === 1 ? "risposta" : "risposte"} ${trovati[k].anni.size > 1 ? "in " + trovati[k].anni.size + " anni" : "nel " + [...trovati[k].anni][0]}</span></div>
      <div class="ar-campi" style="margin-top:4px;"><div><label>Diventa</label><select data-k="${esc(k)}" class="sel-ruolo">${opzioni}</select></div></div></div>`).join("")}
    <div id="as-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-top:6px;"></div>
    <div class="modal-actions"><button type="button" class="btn secondary" id="as-chiudi">Più tardi</button><button type="button" class="btn" id="as-applica">Applica a tutti gli anni</button></div>
  </div>`);
  document.getElementById("as-chiudi").addEventListener("click", closeModal);
  document.getElementById("as-applica").addEventListener("click", async () => {
    const mappa = {};
    document.querySelectorAll("#as-root select[data-k]").forEach(s => { if (s.value) mappa[s.dataset.k] = s.value; });
    if (!Object.keys(mappa).length) { document.getElementById("as-errore").textContent = "Scegli l'incarico di almeno un ruolo."; return; }
    const btn = document.getElementById("as-applica"); btn.disabled = true;
    let aggiornate = 0, errori = 0;
    for (const e of edizioni) {
      if (!window.db) break;
      const ref = db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${e.id}`);
      try {
        await conTimeout(db.runTransaction(async tx => {
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const risposte = snap.data().risposte || {}, upd = {};
          Object.keys(risposte).forEach(k => { const r = risposte[k]; if (r && r.ruolo && mappa[chiaveRuolo(r.ruolo)] && !incaricoDiRuolo(r.ruolo)) { upd[`risposte.${k}.ruolo`] = mappa[chiaveRuolo(r.ruolo)]; aggiornate++; } });
          if (Object.keys(upd).length) tx.update(ref, upd);
        }), 20000);
      } catch (err) { console.error(err); errori++; }
    }
    if (errori) { document.getElementById("as-errore").textContent = "Alcuni anni non sono stati aggiornati: controlla la connessione e riprova."; btn.disabled = false; return; }
    scriviLog([{ ev: `🥟 Casoncellata: ruoli scritti a mano associati agli incarichi (${aggiornate} ${aggiornate === 1 ? "risposta" : "risposte"})` }]);
    closeModal();
    toast(`${aggiornate} ${aggiornate === 1 ? "ruolo aggiornato" : "ruoli aggiornati"}`);
    renderSection();
  });
}

// ---- Tabellone per reparto: chi c'è in ogni reparto, pranzo e cena, giorno per giorno (come il foglio) ----
const CASO_GIORNI_TAB = [
  { nome: "SABATO", delta: 0, momenti: [{ k: "sabP", nome: "Pranzo" }, { k: "sabC", nome: "Cena" }] },
  { nome: "DOMENICA", delta: 1, momenti: [{ k: "domP", nome: "Pranzo" }, { k: "domC", nome: "Cena" }] },
];
const CASO_COLORI_REPARTO = ["#b3541e", "#1a6b3c", "#2d6a9f", "#8a6500", "#6b3fa0", "#a02d55", "#4a6b1a"];

async function apriTabelloneCaso(edId) {
  if (currentRole === "socio") return;
  const ed = (state.casoncellata || []).find(x => x.id === edId);
  if (!ed) return;
  const dati = await leggiDocCaso(edId);
  if (!dati) { alert("Non riesco a leggere le risposte: controlla la connessione e riprova."); return; }
  const risposte = dati.risposte || {};
  const prec = await ruoliPrecedentiCaso(ed);
  const reparti = casoReparti();
  const persone = Object.keys(risposte).map(k => {
    const id = k.replace(/^socio_/, ""), r = risposte[k], s = state.socios.find(x => x.id === id);
    return { id, r, s, nome: s ? `${s.cognome} ${s.nome}`.trim() : String(r.nome || id) };
  }).filter(p => !(p.s && p.s.andatoAvanti)).sort((x, y) => x.nome.localeCompare(y.nome, "it", { sensitivity: "base" }));
  if (!persone.some(p => CASO_VOCI.some(v => p.r[v.k]))) { alert("Nessuno ha ancora dato disponibilità."); return; }
  const info = p => incaricoDiRuolo(p.r.ruolo);
  // l'anno scorso: persone per reparto e per momento
  const prima = {};
  if (prec.ultima) Object.keys(prec.ultima.risposte).forEach(k => {
    const rp = prec.ultima.risposte[k], s = state.socios.find(x => "socio_" + x.id === k);
    if (!rp || !rp.ruolo || (s && s.andatoAvanti)) return;
    const m = incaricoDiRuolo(rp.ruolo);
    if (!m) return;
    CASO_VOCI.forEach(v => { if (rp[v.k]) { prima[m.reparto.id] = prima[m.reparto.id] || {}; prima[m.reparto.id][v.k] = (prima[m.reparto.id][v.k] || 0) + 1; } });
  });
  const daAssociare = new Set();
  persone.forEach(p => { if (p.r.ruolo && !info(p)) daAssociare.add(chiaveRuolo(p.r.ruolo)); });
  if (prec.ultima) Object.values(prec.ultima.risposte).forEach(rp => { if (rp && rp.ruolo && !incaricoDiRuolo(rp.ruolo)) daAssociare.add(chiaveRuolo(rp.ruolo)); });
  const proposti = persone.some(p => p.r.ruolo && p.r.ruoloProposto && CASO_VOCI.some(v => p.r[v.k]));
  // l'incarico generico (uguale al nome del reparto: Cucina, Sala, Vendita) non si scrive accanto al nome
  const etichetta = p => { const m = info(p); return m && chiaveRuolo(m.incarico) !== chiaveRuolo(m.reparto.nome) ? m.incarico : ""; };
  const scarico = persone.filter(p => p.r.ven);
  const giorni = CASO_GIORNI_TAB.map(g => ({
    g, titolo: `${g.nome} ${casoDataBreve(ed.sabato, g.delta)}`,
    blocchi: reparti.map((rep, i) => ({ rep, colore: CASO_COLORI_REPARTO[i % CASO_COLORI_REPARTO.length], cols: g.momenti.map(mo => {
      const lista = persone.filter(p => { const m = info(p); return m && m.reparto.id === rep.id && p.r[mo.k]; });
      return { mo, lista, prima: (prima[rep.id] || {})[mo.k] || 0 };
    }) })),
    senza: persone.filter(p => !info(p) && g.momenti.some(mo => p.r[mo.k])),
  }));
  const senzaTesto = p => p.nome + (p.r.ruolo ? ` (${p.r.ruolo})` : "");
  const voce = p => `<div>${esc(p.nome)}${p.r.ruolo && p.r.ruoloProposto ? " *" : ""}${etichetta(p) ? ` <span class="tb-i">${esc(etichetta(p))}</span>` : ""}${p.r.nota ? ` <span class="tb-n">${esc(p.r.nota)}</span>` : ""}</div>`;
  const totale = (n, p) => prec.ultima ? `${n} <small>(${p})</small>` : `${n}`;
  // --- schermo (un riquadro sotto l'altro) ---
  const schermo = `<div class="tb-g">VENERDÌ ${casoDataBreve(ed.sabato, -1)} · SCARICO</div><div class="tb-sc"><b>${scarico.length} ${scarico.length === 1 ? "persona" : "persone"}${scarico.length ? ":" : ""}</b> ${esc(scarico.map(p => p.nome).join(", "))}</div>`
    + giorni.map(gi => `<div class="tb-g">${esc(gi.titolo)}</div>${gi.blocchi.map(b => `<div class="rb"><div class="h" style="background:${b.colore};">${esc(b.rep.nome)}</div>
      <table class="rt"><tr>${b.cols.map(c => `<th>${c.mo.nome}</th>`).join("")}</tr><tr>${b.cols.map(c => `<td>${c.lista.map(voce).join("") || '<span class="tb-v">—</span>'}</td>`).join("")}</tr>
      <tr class="tot">${b.cols.map(c => `<td>${totale(c.lista.length, c.prima)}</td>`).join("")}</tr></table></div>`).join("")}
      <div class="sr"><b>Senza ruolo / a disposizione:</b> ${esc(gi.senza.map(senzaTesto).join(", ")) || "nessuno"}</div>`).join("");
  // --- stampa (due riquadri affiancati, come il foglio) ---
  const bloccoStampa = b => {
    const n = Math.max(...b.cols.map(c => c.lista.length), 0);
    let righe = "";
    for (let i = 0; i < n; i++) righe += `<tr>${b.cols.map(c => { const p = c.lista[i]; return `<td style="border:1px solid #777; padding:2px 5px; height:15px;">${p ? `${esc(p.nome)}${p.r.ruolo && p.r.ruoloProposto ? " *" : ""}${etichetta(p) ? ` <i style="float:right; font-style:normal; color:#7a5a00; font-size:9px;">${esc(etichetta(p))}</i>` : ""}${p.r.nota ? ` <i style="font-style:italic; color:#555; font-size:9px;">(${esc(p.r.nota)})</i>` : ""}` : ""}</td>`; }).join("")}</tr>`;
    return `<div style="flex:1 1 0; min-width:0;"><div style="text-align:center; font-weight:800; font-size:12px;">${esc(b.rep.nome.toUpperCase())}</div>
      <table style="width:100%; border-collapse:collapse; font-size:11px;"><tr>${b.cols.map(c => `<th style="border:1px solid #777; background:#f1ede0; padding:2px;">${c.mo.nome}</th>`).join("")}</tr>${righe}
      <tr>${b.cols.map(c => `<td style="border:1px solid #777; padding:2px 5px; font-weight:700; background:#f7f5ee;">Totale ${totale(c.lista.length, c.prima).replace(/<small>/, '<span style="color:#777; font-weight:400;">').replace(/<\/small>/, "</span>")}</td>`).join("")}</tr></table></div>`;
  };
  const stampa = `<div style="font-family:Arial,sans-serif;">
    <div style="text-align:center; font-weight:800; font-size:15px; color:#b3261e; margin:6px 0;">VENERDÌ ${casoDataBreve(ed.sabato, -1)}</div>
    <div style="font-size:11px; margin-bottom:8px;"><b>SCARICO</b> &nbsp; ${esc(scarico.map(p => p.nome).join(", ")) || "nessuno"}</div>
    ${giorni.map(gi => { const righe = []; for (let i = 0; i < gi.blocchi.length; i += 2) righe.push(gi.blocchi.slice(i, i + 2));
      return `<div style="page-break-inside:avoid;"><div style="text-align:center; font-weight:800; font-size:15px; color:#b3261e; margin:12px 0 6px;">${esc(gi.titolo)}</div>
        ${righe.map(r => `<div style="display:flex; gap:22px; margin-bottom:10px;">${r.map(bloccoStampa).join("")}${r.length === 1 ? '<div style="flex:1 1 0;"></div>' : ""}</div>`).join("")}
        <div style="font-size:11px; margin:2px 0 6px;">Senza ruolo / a disposizione: ${esc(gi.senza.map(senzaTesto).join(", ")) || "nessuno"}</div></div>`; }).join("")}</div>`;
  // --- testo per WhatsApp e email, e file per Excel ---
  const testo = [`VENERDÌ ${casoDataBreve(ed.sabato, -1)} · SCARICO (${scarico.length}): ${scarico.map(p => p.nome).join(", ") || "nessuno"}`];
  const csv = [["Giorno", "Momento", "Reparto", "Incarico", "Cognome e nome", "Note"]];
  scarico.forEach(p => csv.push([`Venerdì ${casoDataBreve(ed.sabato, -1)}`, "Scarico", "", "", p.nome, p.r.nota || ""]));
  giorni.forEach(gi => {
    testo.push("", gi.titolo);
    gi.blocchi.forEach(b => { testo.push(b.rep.nome.toUpperCase()); b.cols.forEach(c => testo.push(`  ${c.mo.nome} (${c.lista.length}${prec.ultima ? ", nel " + prec.ultima.anno + ": " + c.prima : ""}): ${c.lista.map(p => p.nome + (p.r.ruolo && p.r.ruoloProposto ? "*" : "") + (etichetta(p) ? " - " + etichetta(p) : "")).join(", ") || "—"}`));
      b.cols.forEach(c => c.lista.forEach(p => csv.push([gi.titolo.charAt(0) + gi.titolo.slice(1).toLowerCase(), c.mo.nome, b.rep.nome, info(p) ? info(p).incarico : "", p.nome + (p.r.ruolo && p.r.ruoloProposto ? " *" : ""), p.r.nota || ""]))); });
    testo.push(`Senza ruolo / a disposizione: ${gi.senza.map(senzaTesto).join(", ") || "nessuno"}`);
    gi.senza.forEach(p => g_pushSenza(csv, gi, p));
  });
  function g_pushSenza(righeCsv, gi, p) { gi.g.momenti.forEach(mo => { if (p.r[mo.k]) righeCsv.push([gi.titolo.charAt(0) + gi.titolo.slice(1).toLowerCase(), mo.nome, "Senza ruolo", p.r.ruolo || "", p.nome, p.r.nota || ""]); }); }
  if (proposti) testo.push("", "* Ruolo ancora da confermare.");
  const virgolette = c => /[;"\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : String(c);
  const note = [prec.ultima ? `Totali: tra parentesi il ${prec.ultima.anno}.` : "", proposti ? "* Ruolo ancora da confermare." : "",
    daAssociare.size ? `Ci sono ${daAssociare.size} ${daAssociare.size === 1 ? "ruolo scritto a mano" : "ruoli scritti a mano"} da associare agli incarichi (tasto «Associa i vecchi ruoli»): finché non lo fai quelle persone compaiono in «Senza ruolo» e i confronti sono parziali.` : ""].filter(Boolean).join("<br>");
  apriAnteprimaReportGenerico(`Tabellone ${casoTitolo(ed)}`, [], [["x"]], testo,
    { corpoHtml: schermo, stampaHtml: stampa, sottotitolo: `Chi c'è in ogni reparto, pranzo e cena${prec.ultima ? ". In fondo i totali, tra parentesi il " + esc(prec.ultima.anno) : ""}.`, senzaPdf: true, senzaConteggio: true, nota: note,
      csv: { nome: `casoncellata_${String(ed.sabato).slice(0, 4)}_tabellone.csv`, testo: csv.map(r => r.map(virgolette).join(";")).join("\r\n") } });
}

// Intestazione a due livelli, come il foglio cartaceo: Venerdì | Sabato (data) | Domenica (data) | Note/Ruolo, e sotto i momenti.
function testataCaso(ed, stile) {
  const cella = `text-align:center; font-weight:700; border:1px solid #444; background:#f7f3e8; padding:${stile === "pdf" ? "6px" : "4px 3px"};${stile === "pdf" ? " font-family:Arial,sans-serif; font-size:13px;" : ""}`;
  const th = (testo, attr) => `<th style="${cella}" ${attr || ""}>${testo}</th>`;
  return `<tr>${th("Cognome e nome", 'rowspan="2"')}${th("Venerdì")}${th("Sabato " + casoDataBreve(ed.sabato, 0), 'colspan="2"')}${th("Domenica " + casoDataBreve(ed.sabato, 1), 'colspan="2"')}${th("Ruolo", 'rowspan="2"')}${th("Note", 'rowspan="2"')}</tr>`
    + `<tr>${th("Preparativi")}${th("Pranzo")}${th("Cena")}${th("Pranzo")}${th("Cena")}</tr>`;
}

// Report "stile Excel": come il foglio cartaceo. Una riga per socio che ha risposto, una X dove ha dato la disponibilità, i totali in fondo.
// Il file per Excel ha la stessa intestazione su due righe, più il cellulare in una colonna.
async function apriReportCaso(edId) {
  if (currentRole === "socio") return;
  const ed = (state.casoncellata || []).find(x => x.id === edId);
  if (!ed) return;
  const dati = await leggiDocCaso(edId);
  if (!dati) { alert("Non riesco a leggere le risposte: controlla la connessione e riprova."); return; }
  const risposte = dati.risposte || {};
  const soci = state.socios.filter(s => !s.andatoAvanti);
  const nome = s => `${s.cognome} ${s.nome}`.trim();
  const ordina = (x, y) => nome(x).localeCompare(nome(y), "it", { sensitivity: "base" });
  const hannoRisposto = soci.filter(s => risposte["socio_" + s.id]).sort(ordina);
  const nonRisposto = soci.filter(s => s.accessoApp && !risposte["socio_" + s.id]).sort(ordina);
  if (!hannoRisposto.length) { alert(`Nessun socio ha ancora risposto.${nonRisposto.length ? "\n\nNon hanno ancora risposto: " + nonRisposto.map(nome).join(", ") + "." : ""}`); return; }
  const intestazioni = ["Cognome e nome", "Venerdì - Preparativi", "Sabato - Pranzo", "Sabato - Cena", "Domenica - Pranzo", "Domenica - Cena", "Ruolo", "Note"];
  const tot = {}; CASO_VOCI.forEach(v => { tot[v.k] = 0; });
  const anniProposti = new Set();
  const righe = [], testo = [];
  const csv = [["Cognome e nome", "Cellulare", "Venerdì", "Sabato " + casoDataBreve(ed.sabato, 0), "", "Domenica " + casoDataBreve(ed.sabato, 1), "", "Ruolo", "Note"], ["", "", "Preparativi", "Pranzo", "Cena", "Pranzo", "Cena", "", ""]];
  const X = '<b style="display:block; text-align:center;">X</b>';
  hannoRisposto.forEach(s => {
    const r = risposte["socio_" + s.id];
    CASO_VOCI.forEach(v => { if (r[v.k]) tot[v.k]++; });
    const cell = s.cellulare || s.telefono || "";
    const prop = r.ruolo && r.ruoloProposto;   // ruolo copiato dall'edizione precedente, ancora da confermare
    if (prop) anniProposti.add(String(r.ruoloProposto));
    righe.push([`${esc(nome(s))}${cell ? `<div style="color:#666; font-size:0.9em;">${esc(cell)}</div>` : ""}`].concat(CASO_VOCI.map(v => r[v.k] ? X : ""), [esc(r.ruolo || "") + (prop ? " *" : ""), esc(r.nota || "")]));
    csv.push([nome(s), cell].concat(CASO_VOCI.map(v => r[v.k] ? "X" : ""), [(r.ruolo || "") + (prop ? " *" : ""), r.nota || ""]));
    testo.push(`${nome(s)}${r.ruolo ? " - " + r.ruolo + (prop ? "*" : "") : ""}: ${casoRiassunto(r)}${r.nota ? " (" + r.nota + ")" : ""}`);
  });
  righe.push(["<b>Totale</b>"].concat(CASO_VOCI.map(v => `<b style="display:block; text-align:center;">${tot[v.k]}</b>`), ["", ""]));
  csv.push(["Totale", ""].concat(CASO_VOCI.map(v => String(tot[v.k])), ["", ""]));
  testo.push("", "Totali: " + CASO_VOCI.map(v => `${v.corto} ${tot[v.k]}`).join(", "));
  const notaProp = anniProposti.size ? `* Ruolo proposto dal ${[...anniProposti].sort().join(" e dal ")}, ancora da confermare.` : "";
  const nota = [notaProp ? `<b>${esc(notaProp)}</b>` : "", nonRisposto.length ? `<b>Non hanno ancora risposto (${nonRisposto.length}):</b> ${esc(nonRisposto.map(nome).join(", "))}.` : ""].filter(Boolean).join("<br>");
  if (nonRisposto.length) testo.push(`Non hanno ancora risposto (${nonRisposto.length}): ${nonRisposto.map(nome).join(", ")}`);
  if (notaProp) { testo.push(notaProp); csv.push([notaProp]); }
  const virgolette = c => /[;"\n]/.test(c) ? `"${String(c).replace(/"/g, '""')}"` : String(c);
  apriAnteprimaReportGenerico(`Disponibilità ${casoTitolo(ed)}`, intestazioni, righe, testo,
    { nota, suggerimento: "↔ Scorri la tabella verso destra (o ruota il telefono) per vedere Domenica, Ruolo e Note.", compatto: true, griglia: true, primaFissa: true, testata: stile => testataCaso(ed, stile),
      csv: { nome: `casoncellata_${String(ed.sabato).slice(0, 4)}_disponibilita.csv`, testo: csv.map(r => r.map(virgolette).join(";")).join("\r\n") } });
}

// ---------- Sezione Log ----------
let logMese = null;
let logCache = [];

function renderLog() {
  if (!logMese) {
    const o = new Date();
    logMese = o.getFullYear() + "-" + String(o.getMonth() + 1).padStart(2, "0");
  }
  const [a, m] = logMese.split("-").map(Number);
  return `
    <div class="section-title">📜 Log attività</div>
    <div class="card-sub" style="margin-bottom:12px;">Registro di accessi, inserimenti, modifiche ed eliminazioni. Per tutelare la privacy vengono registrati solo cosa è cambiato e chi l'ha fatto, non i valori dei campi. Le aperture riportano anche la versione dell'app e il tipo di dispositivo.</div>
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <button type="button" class="btn secondary" id="log-prev-btn" style="padding:4px 12px;">◀</button>
        <div style="font-weight:800;">${MESI_CALENDARIO[m - 1]} ${a}</div>
        <button type="button" class="btn secondary" id="log-next-btn" style="padding:4px 12px;">▶</button>
      </div>
      <input type="text" id="log-filtro" placeholder="Filtra (utente, sezione, nome...)" style="width:100%; margin-bottom:10px; box-sizing:border-box;">
      <div style="display:grid; grid-template-columns:62px 44px 1fr; gap:6px; font-size:0.74rem; font-weight:800; color:#1a6b3c; border-bottom:2px solid #1a6b3c; padding-bottom:4px;">
        <div>Data</div><div>Ora</div><div>Evento</div>
      </div>
      <div id="log-lista" class="card-sub">Caricamento...</div>
      <button type="button" class="btn secondary block" id="log-aggiorna-btn" style="margin-top:10px;">🔄 Aggiorna</button>
    </div>
  `;
}

async function caricaLog() {
  const el = document.getElementById("log-lista");
  if (!el) return;
  let eventi = [];
  try {
    if (window.db) {
      const snap = await db.collection(FIRESTORE_COLLECTION).doc("log_" + logMese).get();
      eventi = snap.exists ? (snap.data().eventi || []) : [];
    } else {
      eventi = JSON.parse(localStorage.getItem("gestione_gruppo_log_locale") || "[]").filter(e => (e.t || "").startsWith(logMese));
    }
  } catch (err) {
    console.error(err);
    if (document.getElementById("log-lista")) document.getElementById("log-lista").textContent = "Errore nel caricamento del log.";
    return;
  }
  logCache = eventi.slice().sort((x, y) => (y.t || "").localeCompare(x.t || "") || (y.s || 0) - (x.s || 0));
  disegnaLog();
}

function disegnaLog() {
  const el = document.getElementById("log-lista");
  if (!el) return;
  const filtroEl = document.getElementById("log-filtro");
  const q = filtroEl ? filtroEl.value.trim().toLowerCase() : "";
  const lista = logCache.filter(e => !q || `${e.n || ""} ${e.ev || ""}`.toLowerCase().includes(q));
  if (!lista.length) {
    el.innerHTML = logCache.length ? "Nessun evento corrisponde al filtro." : "Nessun evento registrato in questo mese.";
    return;
  }
  const righe = lista.slice(0, 500).map(e => {
    const d = new Date(e.t);
    const data = d.toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit", year: "2-digit" });
    const ora = d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    return `<div style="display:grid; grid-template-columns:62px 44px 1fr; gap:6px; font-size:0.78rem; padding:6px 0; border-bottom:1px solid #eee; color:#222;">
      <div>${data}</div><div>${ora}</div><div><b>${esc(e.n || "—")}</b> — ${esc(e.ev || "")}</div>
    </div>`;
  }).join("");
  el.innerHTML = righe + (lista.length > 500 ? `<div class="card-sub" style="margin-top:8px;">Mostrati i 500 eventi più recenti di ${lista.length}: usa il filtro per restringere.</div>` : "");
}

function attachLogEvents() {
  const cambiaMese = delta => {
    const [a, m] = logMese.split("-").map(Number);
    const d = new Date(a, m - 1 + delta, 1);
    logMese = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    renderSection();
  };
  document.getElementById("log-prev-btn").addEventListener("click", () => cambiaMese(-1));
  document.getElementById("log-next-btn").addEventListener("click", () => cambiaMese(1));
  document.getElementById("log-aggiorna-btn").addEventListener("click", caricaLog);
  document.getElementById("log-filtro").addEventListener("input", disegnaLog);
  caricaLog();
}

// ---------- Prenotaz. Sede ----------
function fasceConflittuali(fascia) {
  return fascia === "giornata" ? ["pranzo", "cena", "giornata"] : [fascia, "giornata"];
}

function prenotazioneSovrapposta(data, fascia, escludiId) {
  return state.prenotazioni.some(p => p.id !== escludiId && p.data === data && fasceConflittuali(fascia).includes(p.fascia));
}

const MESI_CALENDARIO = ["Gennaio","Febbraio","Marzo","Aprile","Maggio","Giugno","Luglio","Agosto","Settembre","Ottobre","Novembre","Dicembre"];
let calSedeAnno = null;
let calSedeMese = null;
let calSedeVisibile = false;
let calSedeGiornoSelezionato = null;

function renderElencoPrenotazioni(soloLettura) {
  const elenco = [...state.prenotazioni].sort((a, b) =>
    (a.data || "").localeCompare(b.data || "") || FASCIA_ORDER.indexOf(a.fascia) - FASCIA_ORDER.indexOf(b.fascia)
  );
  if (!elenco.length) return `<div class="card-sub">Nessuna prenotazione.</div>`;
  return elenco.map(p => {
    const statoBadge = p.stato === "in attesa"
      ? `<span class="badge badge-icon badge-warning">⏳ In attesa di approvazione</span>`
      : `<span class="badge" style="background:#d7f0dd; border-color:#7ec98f;">✅ Confermata</span>`;
    return `
    <div class="card color-blue" data-prenotazione-id="${p.id}">
      <div class="card-row">
        <div>
          <div class="card-name">${p.data ? fmtDate(p.data) : "Data non indicata"} — ${esc(FASCIA_LABEL[p.fascia] || p.fascia)}</div>
          <div class="card-sub">👤 ${esc(p.nome || "-")}</div>
          ${p.motivo ? `<div class="card-sub">📝 ${esc(p.motivo)}</div>` : ""}
          <div class="badge-row" style="margin-top:6px;">${statoBadge}</div>
        </div>
        ${soloLettura ? "" : `
        <div class="card-actions">
          ${p.stato === "in attesa" ? `<button data-approva-prenotazione="${p.id}">✅</button>` : ""}
          <button data-elimina-prenotazione="${p.id}">🗑️</button>
        </div>`}
      </div>
    </div>`;
  }).join("");
}

function renderPrenotazioni() {
  if (currentRole === "socio") return renderPrenotazioniSocio();

  return `
    <div class="section-title">🗓️ Prenotaz. Sede</div>

    <div class="card">
      <div style="font-weight:800; margin-bottom:10px;">Conferma prenotazione</div>
      <div class="card-sub" style="margin-bottom:10px;">Da usare una volta ricevuto il modulo compilato e firmato: se la data è libera, inseriscila qui per confermarla. Comparirà evidenziata nel calendario.</div>
      ${state.settings.moduloSedeUrl ? `<a href="${esc(state.settings.moduloSedeUrl)}" target="_blank" class="btn block" style="margin-bottom:12px;">📄 Scarica il modulo</a>` : ""}
      <div class="form-group"><label>Data</label><input type="date" id="pren-data"></div>
      <div class="form-group"><label>Fascia</label>
        <select id="pren-fascia">
          <option value="pranzo">Pranzo</option>
          <option value="cena">Cena</option>
          <option value="giornata">Giornata intera</option>
        </select>
      </div>
      <div class="form-group"><label>Nome di chi prenota</label><input type="text" id="pren-nome" placeholder="Cognome e nome"></div>
      <div class="form-group"><label>Motivo (opzionale)</label><input type="text" id="pren-motivo" placeholder="Es. Compleanno, riunione, ecc."></div>
      <button type="button" class="btn block" id="pren-crea-btn" style="margin-top:6px;">✅ Conferma</button>
    </div>

    <button type="button" class="btn secondary block" id="pren-toggle-calendario-btn" style="margin-bottom:12px;">${calSedeVisibile ? "📋 Nascondi calendario" : "📅 Vedi calendario"}</button>
    ${calSedeVisibile ? renderCalendarioSede() : ""}

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Prenotazioni</div>
    ${renderElencoPrenotazioni(false)}
  `;
}

function renderPrenotazioniSocio() {
  return `
    <div class="section-title">🗓️ Prenotaz. Sede</div>
    <div class="card-sub" style="margin-bottom:14px;">Per prenotare l'uso della sede, scarica il modulo, compilalo e consegnalo secondo le modalità indicate dal Gruppo.</div>

    ${state.settings.moduloSedeUrl
      ? `<a href="${esc(state.settings.moduloSedeUrl)}" target="_blank" class="btn block" style="margin-bottom:12px;">📄 Scarica modulo</a>`
      : `<div class="card-sub" style="margin-bottom:12px;">Il modulo non è ancora stato caricato: chiedi a un referente del Gruppo.</div>`}

    <div class="card color-gold" style="margin-bottom:12px;">
      <div class="card-sub">La conferma della prenotazione è a cura del Consiglio Direttivo. Alcune date sono riservate alle attività istituzionali del Gruppo.</div>
    </div>

    <button type="button" class="btn secondary block" id="pren-toggle-calendario-btn">${calSedeVisibile ? "📋 Nascondi calendario" : "📅 Calendario"}</button>

    ${calSedeVisibile ? renderCalendarioSede() : ""}

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Richieste</div>
    ${renderElencoPrenotazioni(true)}
  `;
}

function generaGiorniMese(anno, mese) {
  const primoGiorno = new Date(anno, mese, 1);
  const ultimoGiorno = new Date(anno, mese + 1, 0);
  const offset = (primoGiorno.getDay() + 6) % 7; // lunedì = 0
  const giorni = [];
  for (let i = 0; i < offset; i++) giorni.push(null);
  for (let d = 1; d <= ultimoGiorno.getDate(); d++) giorni.push(d);
  return giorni;
}

function renderCalendarioSede() {
  const oggi = new Date();
  if (calSedeAnno === null) calSedeAnno = oggi.getFullYear();
  if (calSedeMese === null) calSedeMese = oggi.getMonth();

  const confermate = state.prenotazioni.filter(p => p.stato !== "in attesa");
  const giorni = generaGiorniMese(calSedeAnno, calSedeMese);
  const meseStr = String(calSedeMese + 1).padStart(2, "0");

  const celleHtml = giorni.map(g => {
    if (!g) return `<div class="cal-giorno cal-vuoto"></div>`;
    const dataStr = `${calSedeAnno}-${meseStr}-${String(g).padStart(2, "0")}`;
    const occupato = confermate.some(p => p.data === dataStr);
    const selezionato = dataStr === calSedeGiornoSelezionato;
    return `<div class="cal-giorno${occupato ? " cal-occupato" : ""}${selezionato ? " cal-selezionato" : ""}" data-cal-giorno="${dataStr}">
      <div class="cal-numero">${g}</div>
    </div>`;
  }).join("");

  let dettaglioGiornoHtml = "";
  if (calSedeGiornoSelezionato) {
    const delGiorno = confermate.filter(p => p.data === calSedeGiornoSelezionato);
    dettaglioGiornoHtml = `
      <div class="card-sub" style="margin-top:10px; font-weight:700;">${fmtDate(calSedeGiornoSelezionato)}</div>
      ${delGiorno.length
        ? delGiorno.map(p => `<div class="card-sub">• ${esc(FASCIA_LABEL[p.fascia] || p.fascia)} — ${esc(p.nome || "-")}</div>`).join("")
        : `<div class="card-sub">Nessuna prenotazione confermata questo giorno.</div>`}
    `;
  }

  return `
    <div class="card">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
        <button type="button" class="btn secondary" id="cal-prev-btn" style="padding:4px 12px;">◀</button>
        <div style="font-weight:800;">${MESI_CALENDARIO[calSedeMese]} ${calSedeAnno}</div>
        <button type="button" class="btn secondary" id="cal-next-btn" style="padding:4px 12px;">▶</button>
      </div>
      <div class="cal-grid">${celleHtml}</div>
      <div style="margin-top:10px; font-size:0.78rem;">🔴 Giorno con prenotazione confermata</div>
      ${dettaglioGiornoHtml}
    </div>
  `;
}

function attachPrenotazioniEvents() {
  const creaBtn = document.getElementById("pren-crea-btn");
  if (creaBtn) creaBtn.addEventListener("click", creaPrenotazione);
  document.querySelectorAll("[data-approva-prenotazione]").forEach(btn => {
    btn.addEventListener("click", () => approvaPrenotazione(btn.dataset.approvaPrenotazione));
  });
  document.querySelectorAll("[data-elimina-prenotazione]").forEach(btn => {
    btn.addEventListener("click", () => eliminaPrenotazione(btn.dataset.eliminaPrenotazione));
  });

  const toggleCalBtn = document.getElementById("pren-toggle-calendario-btn");
  if (toggleCalBtn) toggleCalBtn.addEventListener("click", () => {
    calSedeVisibile = !calSedeVisibile;
    if (!calSedeVisibile) calSedeGiornoSelezionato = null;
    renderSection();
  });
  const calPrevBtn = document.getElementById("cal-prev-btn");
  if (calPrevBtn) calPrevBtn.addEventListener("click", () => {
    calSedeMese--;
    if (calSedeMese < 0) { calSedeMese = 11; calSedeAnno--; }
    calSedeGiornoSelezionato = null;
    renderSection();
  });
  const calNextBtn = document.getElementById("cal-next-btn");
  if (calNextBtn) calNextBtn.addEventListener("click", () => {
    calSedeMese++;
    if (calSedeMese > 11) { calSedeMese = 0; calSedeAnno++; }
    calSedeGiornoSelezionato = null;
    renderSection();
  });
  document.querySelectorAll("[data-cal-giorno]").forEach(cella => {
    cella.addEventListener("click", () => {
      const g = cella.dataset.calGiorno;
      calSedeGiornoSelezionato = calSedeGiornoSelezionato === g ? null : g;
      renderSection();
    });
  });
}

function creaPrenotazione() {
  const data = document.getElementById("pren-data").value;
  const fascia = document.getElementById("pren-fascia").value;
  const nome = document.getElementById("pren-nome").value.trim();
  const motivo = document.getElementById("pren-motivo").value.trim();
  if (!data) { alert("Seleziona una data"); return; }
  if (!nome) { alert("Inserisci il nome di chi prenota"); return; }
  if (prenotazioneSovrapposta(data, fascia, null)) {
    alert("Questa data/fascia è già occupata da un'altra prenotazione.");
    return;
  }
  const stato = (currentRole === "admin" || currentRole === "direttivo") ? "confermata" : "in attesa";
  state.prenotazioni.push({ id: uid(), data, fascia, nome, motivo, stato, creato: new Date().toISOString() });
  saveState();
  renderSection();
  toast(stato === "confermata" ? "Prenotazione salvata" : "Prenotazione inviata, in attesa di approvazione");
}

function approvaPrenotazione(id) {
  const p = state.prenotazioni.find(x => x.id === id);
  if (!p) return;
  p.stato = "confermata";
  saveState();
  renderSection();
  toast("Prenotazione approvata");
}

function eliminaPrenotazione(id) {
  if (!confirm("Eliminare questa prenotazione?")) return;
  state.prenotazioni = state.prenotazioni.filter(p => p.id !== id);
  saveState();
  renderSection();
}

function apriDettaglioAdunata(adunataId) {
  const a = state.adunate.find(x => x.id === adunataId);
  if (!a) return;
  const isPdf = (a.allegatoNome || "").toLowerCase().endsWith(".pdf");
  let allegatoHtml = "";
  if (a.allegatoThumbUrl) {
    allegatoHtml += `<img src="${esc(a.allegatoThumbUrl)}" style="max-width:100%; border-radius:8px; margin-top:10px; border:1px solid #ccc;">`;
  }
  if (a.allegatoUrl && isPdf) {
    allegatoHtml += `<a href="${esc(a.allegatoUrl)}" target="_blank" class="btn block" style="margin-top:10px;">📄 Apri ${esc(a.allegatoNome || "PDF")}</a>`;
  }
  const html = `
    <div style="font-weight:900; font-size:1.2rem; margin-bottom:2px;">${esc(a.titolo || "Adunata")}</div>
    <div class="card-sub" style="margin-bottom:10px;">${esc(a.data) || ""}</div>
    ${allegatoHtml}
    <div class="modal-actions" style="margin-top:16px;">
      <button type="button" class="btn secondary block" id="dettaglio-adunata-chiudi">Chiudi</button>
    </div>
  `;
  showModal(html);
  document.getElementById("dettaglio-adunata-chiudi").addEventListener("click", closeModal);
}

async function creaAdunata() {
  const titolo = document.getElementById("adunata-titolo").value.trim();
  const data = document.getElementById("adunata-data").value.trim();
  const file = document.getElementById("adunata-file").files[0];
  if (!titolo) { alert("Inserisci un titolo per l'adunata"); return; }
  const id = uid();
  const nuovo = { id, titolo, data, creato: new Date().toISOString(), allegatoUrl: "", allegatoNome: "", allegatoThumbUrl: "" };

  if (file) {
    if (window.storage) {
      try {
        toast("Caricamento locandina...");
        nuovo.allegatoUrl = await uploadDocumento(file, `adunate/${id}`);
        nuovo.allegatoNome = file.name;
        if (file.name.toLowerCase().endsWith(".pdf") || file.type === "application/pdf") {
          toast("Genero l'anteprima della locandina...");
          const miniatura = await generaMiniaturaPdf(file);
          if (miniatura) nuovo.allegatoThumbUrl = await uploadDocumento(miniatura, `adunate/${id}_thumb`);
        } else {
          nuovo.allegatoThumbUrl = nuovo.allegatoUrl;
        }
      } catch (err) {
        console.error(err);
        alert("Errore nel caricamento della locandina. L'adunata viene comunque pubblicata senza locandina.");
      }
    } else {
      alert("Firebase non configurato: la locandina non può essere caricata su questo dispositivo.");
    }
  }

  state.adunate.push(nuovo);
  saveState();
  renderSection();
  toast("Adunata pubblicata");
}

function eliminaAdunata(adunataId) {
  if (!confirm("Eliminare questa adunata?")) return;
  state.adunate = state.adunate.filter(a => a.id !== adunataId);
  saveState();
  renderSection();
}

function leggiUtentiDalForm() {
  return Array.from(document.querySelectorAll("#utenti-lista [data-utente-idx]")).map((card, i) => {
    const esistente = state.settings.utenti[i] || {};
    return {
      id: esistente.id || uid(),
      label: card.querySelector(".ut-label").value.trim() || esistente.id || "Utente",
      ruolo: card.querySelector(".ut-ruolo").value,
      password: card.querySelector(".ut-password").value
    };
  });
}

async function saveSettings() {
  state.settings.appName = document.getElementById("set-appname").value.trim() || "Gestione Gruppo";
  state.settings.quotaBollino = parseFloat(document.getElementById("set-quota").value) || 0;
  state.settings.quotaNazionale = parseFloat(document.getElementById("set-quota-nazionale").value) || 0;
  state.settings.testoPreghiera = document.getElementById("set-testo-preghiera").value.trim();
  state.settings.testoCanto = document.getElementById("set-testo-canto").value.trim();
  state.settings.testoAuguriCompleanno = document.getElementById("set-testo-auguri").value.trim();
  if (document.getElementById("utenti-lista")) state.settings.utenti = leggiUtentiDalForm();

  const moduloFileEl = document.getElementById("set-modulo-sede-file");
  const moduloFile = moduloFileEl && moduloFileEl.files[0];
  if (moduloFile) {
    if (window.storage) {
      try {
        toast("Caricamento modulo...");
        state.settings.moduloSedeUrl = await uploadDocumento(moduloFile, "impostazioni/modulo-sede");
        state.settings.moduloSedeNome = moduloFile.name;
      } catch (err) {
        console.error(err);
        alert("Errore nel caricamento del modulo. Riprova.");
      }
    } else {
      alert("Firebase non configurato: il modulo non può essere caricato su questo dispositivo.");
    }
  }

  saveState();
  updateTopbar();
  closeModal();
  toast("Impostazioni salvate");
}

function resetBollino() {
  if (!confirm("Cancellare TUTTI i pagamenti Bollino registrati (tutti gli anni)? L'operazione non è reversibile.")) return;
  if (!confirm("Sei sicuro? Verranno azzerati tutti i pagamenti di tutti i soci e di tutti gli anni.")) return;
  state.pagamentiBollino = [];
  saveState();
  closeModal();
  renderSection();
  toast("Pagamenti Bollino azzerati");
}

function setPrivacyPerTutti() {
  const daFirmare = state.socios.filter(s => !s.privacy);
  if (daFirmare.length === 0) {
    alert("Tutti i soci hanno già la Privacy firmata.");
    return;
  }
  if (!confirm(`Segnare la Privacy come firmata per ${daFirmare.length} soci che non l'hanno ancora? (Chi ce l'ha già non viene toccato.)`)) return;
  daFirmare.forEach(s => { s.privacy = true; });
  saveState();
  closeModal();
  renderSection();
  toast(`Privacy segnata come firmata per ${daFirmare.length} soci`);
}

function setSmsPerCellulare() {
  const daSpuntare = state.socios.filter(s => s.cellulare && s.cellulare.trim() && !s.sms);
  if (daSpuntare.length === 0) {
    alert("Non ci sono soci con cellulare compilato e SMS ancora da spuntare.");
    return;
  }
  if (!confirm(`Spuntare SMS per ${daSpuntare.length} soci che hanno il cellulare compilato e non hanno già la spunta?`)) return;
  daSpuntare.forEach(s => { s.sms = true; });
  saveState();
  closeModal();
  renderSection();
  toast(`SMS spuntato per ${daSpuntare.length} soci`);
}

async function doBackup() {
  const data = JSON.stringify(state, null, 2);
  const stamp = new Date().toISOString().slice(0,10);
  const filename = `gestione-gruppo_backup_${stamp}.json`;

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "Backup JSON", accept: { "application/json": [".json"] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      toast("Backup salvato");
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
      console.error("Salvataggio con scelta cartella non riuscito, uso il download diretto", err);
    }
  }

  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  toast("Backup scaricato");
}

function handleRestore(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!confirm("Il ripristino sovrascrive tutti i dati attuali. Continuare?")) { e.target.value = ""; return; }
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const parsed = JSON.parse(ev.target.result);
      // Copia generica: qualsiasi sezione presente nel backup viene ripristinata,
      // comprese quelle che aggiungeremo in futuro e che non conosciamo ancora qui.
      Object.keys(parsed).forEach(key => {
        if (key === "settings") {
          state.settings = Object.assign(state.settings, parsed.settings || {});
        } else if (key === "meta") {
          // gestito subito dopo
        } else {
          state[key] = parsed[key];
        }
      });
      state.consiglio = Object.assign({ membriIds: [], dataInizioMandato: "", storico: [] }, state.consiglio || {});
      state.meta = state.meta || {};
      state.meta.ultimoImport = new Date().toISOString();
      saveState();
      updateTopbar();
      closeModal();
      renderSection();
      toast("Dati ripristinati");
    } catch (err) {
      alert("File di backup non valido");
    }
  };
  reader.readAsText(file);
}

const PREFISSI_COGNOME = ["de","del","della","dei","degli","dal","dalla","dalle","di","la","lo","le","van","von","mac","mc","sant","santa","santo","d'"];

function splitCognomeNome(full) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { cognome: full.trim(), nome: "" };
  const firstLower = parts[0].toLowerCase().replace(/[.']/g, "");
  if (parts.length >= 3 && PREFISSI_COGNOME.includes(firstLower)) {
    return { cognome: parts.slice(0, 2).join(" "), nome: parts.slice(2).join(" ") };
  }
  return { cognome: parts[0], nome: parts.slice(1).join(" ") };
}

function isValidCF(v) { return /^[A-Za-z0-9]{16}$/.test(v); }
function isValidProvinciaSigla(v) { return /^[A-Za-z]{2}$/.test(v); }
function isValidCAP(v) { return /^\d{5}$/.test(v); }
function isValidDataLike(v) {
  if (!v) return false;
  return /^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}$/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function handleExcelImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb = XLSX.read(ev.target.result, { type: "binary" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      let creati = 0, aggiornati = 0, totaleScarti = 0;
      rows.forEach(row => {
        const get = (...keys) => {
          for (const k of keys) {
            const foundKey = Object.keys(row).find(rk => rk.toLowerCase().trim() === k.toLowerCase());
            if (foundKey && row[foundKey] !== "") return row[foundKey].toString().trim();
          }
          return "";
        };
        const cognome = get("Cognome");
        const nome = get("Nome");
        let cognomeFinale = cognome;
        let nomeFinale = nome;
        if (!cognomeFinale && !nomeFinale) {
          const combinato = get("Nome e Cognome","Cognome e Nome","Nominativo","Nome Cognome","Socio","Associato");
          if (combinato) {
            const sp = splitCognomeNome(combinato);
            cognomeFinale = sp.cognome;
            nomeFinale = sp.nome;
          }
        }
        if (!cognomeFinale && !nomeFinale) return;

        let scartiRiga = 0;
        const validaOScarta = (val, isValid) => {
          if (!val) return "";
          if (isValid(val)) return val;
          scartiRiga++;
          return "";
        };

        const cfRaw = get("Codice Fiscale","CF").toUpperCase();
        const provRaw = get("Provincia").toUpperCase();
        const provNascitaRaw = get("Provincia Nascita","Provincia di nascita","Prov. Nascita").toUpperCase();
        const capRaw = get("CAP","Cap");
        const dataNascitaRaw = get("Data Nascita","Data di nascita");
        const dataIscrizioneRaw = get("Data Iscrizione","Data iscrizione");

        const datiRiga = {
          dataNascita: validaOScarta(dataNascitaRaw, isValidDataLike),
          luogoNascita: get("Luogo Nascita","Luogo di nascita"),
          provinciaNascita: validaOScarta(provNascitaRaw, isValidProvinciaSigla),
          codiceFiscale: validaOScarta(cfRaw, isValidCF),
          matricola: get("Matricola"),
          indirizzo: get("Indirizzo"),
          paese: get("Paese"),
          provincia: validaOScarta(provRaw, isValidProvinciaSigla),
          cap: validaOScarta(capRaw, isValidCAP),
          telefono: get("Telefono"),
          cellulare: get("Cellulare"),
          email: get("Email"),
          dataIscrizione: validaOScarta(dataIscrizioneRaw, isValidDataLike),
          carica: get("Carica","Ruolo"),
          grado: get("Grado"),
          reparto: get("Reparto"),
          brigataAlpina: get("Brigata Alpina", "Brigata alpina", "Brigata"),
          anniNaja: get("Anni Naja","Anni di naja"),
          incaricoFeste: get("Incarico Feste","Incarico"),
          note: get("Note"),
        };
        totaleScarti += scartiRiga;
        const alfieriRaw = get("Alfiere");
        const haccpRaw = get("HACCP");

        const cf = datiRiga.codiceFiscale;
        let socio = null;
        if (cf) socio = state.socios.find(s => s.codiceFiscale && s.codiceFiscale.toUpperCase() === cf);
        if (!socio) {
          socio = state.socios.find(s => s.cognome.trim().toLowerCase() === cognomeFinale.toLowerCase() && s.nome.trim().toLowerCase() === nomeFinale.toLowerCase());
        }

        if (socio) {
          // Aggiorna solo i campi presenti nel file, senza cancellare quelli già compilati con un vuoto
          Object.keys(datiRiga).forEach(k => {
            if (datiRiga[k]) socio[k] = datiRiga[k];
          });
          if (alfieriRaw) socio.alfiere = parseBoolSiNo(alfieriRaw);
          if (haccpRaw) socio.haccp = parseBoolSiNo(haccpRaw);
          aggiornati++;
        } else {
          state.socios.push(Object.assign({
            id: uid(),
            cognome: cognomeFinale, nome: nomeFinale,
            sms: false, whatsapp: false,
            alfiere: parseBoolSiNo(alfieriRaw),
            haccp: parseBoolSiNo(haccpRaw),
          }, datiRiga));
          creati++;
        }
      });
      saveState();
      closeModal();
      renderSection();
      toast(`${creati} nuovi soci, ${aggiornati} aggiornati${totaleScarti ? `, ${totaleScarti} campi scartati (formato non valido)` : ""}`);
    } catch (err) {
      console.error(err);
      alert("Errore durante l'importazione del file");
    }
  };
  reader.readAsBinaryString(file);
}

function parseBoolSiNo(v) {
  const s = (v || "").toString().trim().toLowerCase();
  return ["si","sì","x","1","true","pagato","yes","vero"].includes(s);
}
function toISODate(v) {
  if (!v) return "";
  const s = v.toString().trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,"0")}-${m[1].padStart(2,"0")}`;
  return "";
}

function handleBollinoImport(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const wb = XLSX.read(ev.target.result, { type: "binary" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      // Rileva se esiste una colonna il cui titolo è esso stesso un anno (es. "2026"),
      // usata da alcuni fogli come colonna "flag socio tesserato quell'anno"
      let annoColKey = null;
      if (rows.length) {
        Object.keys(rows[0]).forEach(k => {
          if (annoColKey) return;
          const kTrim = k.toString().trim();
          const asNum = parseInt(kTrim, 10);
          if (/^\d{4}(\.0)?$/.test(kTrim) && asNum >= 2015 && asNum <= 2035) annoColKey = k;
        });
      }
      let imported = 0, saltate = 0;
      rows.forEach(row => {
        const get = (...keys) => {
          for (const k of keys) {
            const foundKey = Object.keys(row).find(rk => rk.toLowerCase().trim() === k.toLowerCase());
            if (foundKey && row[foundKey] !== "") return row[foundKey].toString().trim();
          }
          return "";
        };
        const cf = get("Codice Fiscale","CF").toUpperCase();
        let cognome = get("Cognome");
        let nome = get("Nome");
        if (cognome && !nome && cognome.includes(" ")) {
          // La colonna "Cognome" contiene in realtà il nominativo intero (es. "Rossi Mario")
          const sp = splitCognomeNome(cognome);
          cognome = sp.cognome; nome = sp.nome;
        } else if (!cognome && !nome) {
          const nominativo = get("Cognome e Nome","Nominativo","Nome e Cognome");
          if (nominativo) {
            const sp = splitCognomeNome(nominativo);
            cognome = sp.cognome; nome = sp.nome;
          }
        }
        let socio = null;
        if (cf) socio = state.socios.find(s => s.codiceFiscale && s.codiceFiscale.toUpperCase() === cf);
        if (!socio && cognome) {
          socio = state.socios.find(s => s.cognome.toLowerCase() === cognome.toLowerCase() && (!nome || s.nome.toLowerCase() === nome.toLowerCase()));
        }

        let anno = parseInt(get("Anno"), 10);
        if (!anno && annoColKey) {
          const flagVal = (row[annoColKey] || "").toString().trim();
          if (!flagVal) { saltate++; return; } // riga non tesserata per quell'anno (o riga di intestazione/riepilogo)
          anno = parseInt(annoColKey, 10);
        }
        if (!socio || !anno) { saltate++; return; }

        const pagato = parseBoolSiNo(get("Pagato"));
        const importo = parseFloat(get("Importo")) || 0;
        const data = toISODate(get("Data","Data Pagamento"));

        let existing = getBollinoRecord(socio.id, anno);
        if (existing) {
          existing.pagato = pagato; existing.data = data; existing.importo = importo;
        } else {
          state.pagamentiBollino.push({ id: uid(), socioId: socio.id, anno, pagato, data, importo });
        }
        imported++;
      });
      saveState();
      closeModal();
      renderSection();
      toast(`${imported} pagamenti importati${saltate ? ", " + saltate + " righe saltate" : ""}`);
    } catch (err) {
      console.error(err);
      alert("Errore durante l'importazione del file");
    }
  };
  reader.readAsBinaryString(file);
}

// ---------- Report generico: anteprima + stampa + email + WhatsApp ----------
function stampaConLoghi(area) {
  const titoloOriginale = document.title;
  const eseguiStampa = () => {
    document.title = "";
    window.print();
    setTimeout(() => { document.title = titoloOriginale; }, 500);
  };
  const imgs = Array.from(area.querySelectorAll("img"));
  const nonCaricate = imgs.filter(img => !img.complete);
  if (nonCaricate.length === 0) {
    eseguiStampa();
    return;
  }
  let rimaste = nonCaricate.length;
  const controlla = () => { rimaste--; if (rimaste <= 0) eseguiStampa(); };
  nonCaricate.forEach(img => {
    img.addEventListener("load", controlla, { once: true });
    img.addEventListener("error", controlla, { once: true });
  });
  // rete di sicurezza: se qualcosa non scatta, stampa comunque dopo 1.5s
  setTimeout(() => { if (rimaste > 0) { rimaste = 0; eseguiStampa(); } }, 1500);
}

async function condividiReportComePdf(titolo, headers, rows, opzioni) {
  if (typeof html2canvas === "undefined" || typeof window.jspdf === "undefined") {
    alert("Generazione PDF non disponibile: manca la connessione per caricare le librerie necessarie (serve una volta sola, poi restano salvate).");
    return;
  }
  const btn = document.getElementById("anteprima-pdf-btn");
  const testoOriginale = btn ? btn.textContent : "";
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Genero il PDF..."; }

  const CONTENT_W = 750;
  const wrapper = document.createElement("div");
  wrapper.style.cssText = "position:fixed; left:0; top:0; width:0; height:0; overflow:hidden; z-index:-1;";
  document.body.appendChild(wrapper);

  const headerRowHtml = headers.map(h => `<th style="text-align:left; border-bottom:2px solid #000; padding:6px; font-family:Arial,sans-serif; font-size:13px;">${esc(h)}</th>`).join("");
  const testataPdf = opzioni && opzioni.testata ? opzioni.testata("pdf") : `<tr>${headerRowHtml}</tr>`;
  const bordoPdf = opzioni && opzioni.griglia ? "border:1px solid #999;" : "border-bottom:1px solid #ddd;";
  const rigaHtml = cells => `<tr>${cells.map(c => `<td style="padding:6px; ${bordoPdf} font-family:Arial,sans-serif; font-size:13px;">${c}</td>`).join("")}</tr>`;

  try {
    // --- misuro le altezze reali (carta intestata, riga intestazione colonne, riga dato) ---
    const misura = document.createElement("div");
    misura.style.cssText = `width:${CONTENT_W}px; background:#fff;`;
    misura.innerHTML = `
      <div id="misura-letterhead">${LETTERHEAD_HTML}</div>
      <table style="width:100%; border-collapse:collapse;">
        <thead id="misura-thead">${testataPdf}</thead>
        <tbody>
          ${rigaHtml(rows[0])}
        </tbody>
      </table>`;
    wrapper.appendChild(misura);
    await new Promise(r => setTimeout(r, 150));
    const letterheadH = document.getElementById("misura-letterhead").offsetHeight;
    const theadH = document.getElementById("misura-thead").offsetHeight;
    const rowH = misura.querySelector("tbody tr:last-child").offsetHeight || 30;
    wrapper.removeChild(misura);

    // rapporto di sicurezza tra area utile pagina A4 e larghezza contenuto
    const maxContentH = Math.floor(CONTENT_W * 1.40);
    const disponibiliPerRighe = maxContentH - letterheadH - theadH;
    const righePerPagina = Math.max(5, Math.floor(disponibiliPerRighe / rowH));

    const pagine = [];
    for (let i = 0; i < rows.length; i += righePerPagina) pagine.push(rows.slice(i, i + righePerPagina));

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });
    const MARGIN_MM = 8;
    const usableWidthMM = 210 - 2 * MARGIN_MM;

    for (let p = 0; p < pagine.length; p++) {
      const pageDiv = document.createElement("div");
      pageDiv.style.cssText = `width:${CONTENT_W}px; background:#fff; font-family:Arial,sans-serif;`;
      pageDiv.innerHTML = `
        ${LETTERHEAD_HTML}
        <table style="width:100%; border-collapse:collapse;">
          <thead>${testataPdf}</thead>
          <tbody>${pagine[p].map(rigaHtml).join("")}</tbody>
        </table>`;
      wrapper.appendChild(pageDiv);
      await new Promise(r => setTimeout(r, 100));
      const canvas = await html2canvas(pageDiv, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
      wrapper.removeChild(pageDiv);

      const imgData = canvas.toDataURL("image/jpeg", 0.92);
      const imgHmm = usableWidthMM * (canvas.height / canvas.width);
      if (p > 0) pdf.addPage();
      pdf.addImage(imgData, "JPEG", MARGIN_MM, MARGIN_MM, usableWidthMM, imgHmm);
    }

    document.body.removeChild(wrapper);
    if (btn) { btn.disabled = false; btn.textContent = testoOriginale; }

    const nomeFile = titolo.replace(/[^a-z0-9]+/gi, "_").toLowerCase() + ".pdf";
    const blob = pdf.output("blob");
    const file = new File([blob], nomeFile, { type: "application/pdf" });
    if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] }))) {
      try {
        await navigator.share({ files: [file], title: titolo });
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = nomeFile;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast("PDF scaricato — allegalo tu a WhatsApp o Email");
  } catch (err) {
    if (wrapper.parentNode) document.body.removeChild(wrapper);
    if (btn) { btn.disabled = false; btn.textContent = testoOriginale; }
    console.error(err);
    alert("Errore nella generazione del PDF.");
  }
}

function apriAnteprimaReportGenerico(titolo, headers, rows, testoRighe, opzioni) {
  if (!(opzioni && opzioni.corpoHtml) && rows.length === 0) {
    alert("Nessun risultato per i filtri selezionati.");
    return;
  }
  const pad = opzioni && opzioni.compatto ? "4px" : "6px";
  const headerHtml = headers.map(h => `<th style="text-align:left; padding:${pad};">${esc(h)}</th>`).join("");
  const headerHtmlPrint = headers.map(h => `<th style="text-align:left; border-bottom:2px solid #000; padding:${pad};">${esc(h)}</th>`).join("");
  // opzioni.testata(stile) restituisce un'intestazione a più righe (per esempio giorni sopra e momenti sotto); opzioni.griglia disegna tutti i bordi
  const theadSchermo = opzioni && opzioni.testata ? opzioni.testata("schermo") : `<tr style="background:#f7f3e8;">${headerHtml}</tr>`;
  const theadStampa = opzioni && opzioni.testata ? opzioni.testata("stampa") : `<tr>${headerHtmlPrint}</tr>`;
  const bordo = opzioni && opzioni.griglia ? "border:1px solid #999;" : "border-bottom:1px solid #ddd;";
  const righeHtml = opzioni && opzioni.corpoHtml ? "" : rows.map(cells => `<tr>${cells.map(c => `<td style="padding:${pad}; ${bordo}">${c}</td>`).join("")}</tr>`).join("");
  const html = `
    <div class="modal-title">🖨️ Anteprima — ${esc(titolo)}</div>
    <div class="card-sub" style="margin-bottom:12px;">${opzioni && opzioni.sottotitolo ? opzioni.sottotitolo : rows.length + " righe"} — generato il ${fmtDateTime(new Date().toISOString())}</div>
    ${opzioni && opzioni.corpoHtml ? `<div style="max-height:56vh; overflow-y:auto; margin-bottom:12px;">${opzioni.corpoHtml}</div>` : `<div style="max-height:50vh; overflow-y:auto; border:2px solid var(--ink); border-radius:10px; margin-bottom:16px;">
      <table class="${opzioni && opzioni.primaFissa ? "rep-prima-fissa" : ""}" style="width:100%; border-collapse:collapse; font-size:${opzioni && opzioni.compatto ? "0.76rem" : "0.82rem"};">
        <thead>${theadSchermo}</thead>
        <tbody>${righeHtml}</tbody>
      </table>
    </div>`}
    ${opzioni && opzioni.suggerimento ? `<div class="card-sub" style="margin:-8px 0 8px;">${opzioni.suggerimento}</div>` : ""}
    ${opzioni && opzioni.nota ? `<div class="card-sub" style="margin:-6px 0 14px;">${opzioni.nota}</div>` : ""}
    <button type="button" class="btn block" id="anteprima-stampa-btn" style="margin-bottom:10px;">🖨️ Stampa</button>
    ${opzioni && opzioni.csv ? `<button type="button" class="btn block" id="anteprima-csv-btn" style="margin-bottom:10px; background:#1d6f42; color:#fff;">📥 Scarica per Excel</button>` : ""}
    ${opzioni && opzioni.senzaPdf ? "" : `<button type="button" class="btn block" id="anteprima-pdf-btn" style="margin-bottom:10px; background:var(--gold);">📄 Condividi come PDF</button>`}
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="anteprima-email-btn">✉️ Email</button>
      <button type="button" class="btn" id="anteprima-wa-btn" style="background:#25D366; color:#fff;">${WA_ICON} WhatsApp</button>
    </div>
    <button type="button" class="btn secondary block" id="anteprima-close-btn" style="margin-top:14px;">Chiudi</button>
  `;
  showModal(html);

  document.getElementById("anteprima-stampa-btn").addEventListener("click", () => {
    const area = document.getElementById("print-area");
    const nCol = headers.length;
    area.innerHTML = opzioni && opzioni.stampaHtml ? `${LETTERHEAD_HTML}${opzioni.stampaHtml}${opzioni.nota ? `<div style="margin-top:10px; font-size:10pt;">${opzioni.nota}</div>` : ""}` : `
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr><td colspan="${nCol}" style="padding:0;">${LETTERHEAD_HTML}</td></tr>
          ${theadStampa}
        </thead>
        <tbody>${righeHtml}</tbody>
      </table>
      ${opzioni && opzioni.nota ? `<div style="margin-top:10px; font-size:11pt;">${opzioni.nota}</div>` : ""}
    `;
    stampaConLoghi(area);
  });

  const pdfBtn = document.getElementById("anteprima-pdf-btn");
  if (pdfBtn) pdfBtn.addEventListener("click", () => {
    condividiReportComePdf(titolo, headers, rows, opzioni);
  });
  const csvBtn = document.getElementById("anteprima-csv-btn");
  if (csvBtn) csvBtn.addEventListener("click", () => scaricaTesto(opzioni.csv.nome, opzioni.csv.testo, "text/csv;charset=utf-8"));

  const testoPiano = () => `📋 ${titolo}\n${opzioni && opzioni.senzaConteggio ? "" : rows.length + " righe\n"}\n` + testoRighe.join("\n");
  document.getElementById("anteprima-email-btn").addEventListener("click", () => {
    window.location.href = `mailto:?subject=${encodeURIComponent(titolo)}&body=${encodeURIComponent(testoPiano())}`;
  });
  document.getElementById("anteprima-wa-btn").addEventListener("click", () => {
    window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(testoPiano())}`, "_blank");
  });
  document.getElementById("anteprima-close-btn").addEventListener("click", closeModal);
}

// ---------- Report 1: Soci (filtri + colonne libere) ----------
const REPORT1_COLONNE = [
  { id: "matricola", label: "Matricola", get: s => s.matricola || "" },
  { id: "cognome", label: "Cognome", get: s => s.cognome || "" },
  { id: "nome", label: "Nome", get: s => s.nome || "" },
  { id: "dataNascita", label: "Data nascita", get: s => s.dataNascita || "" },
  { id: "luogoNascita", label: "Luogo nascita", get: s => s.luogoNascita || "" },
  { id: "provinciaNascita", label: "Prov. nascita", get: s => s.provinciaNascita || "" },
  { id: "codiceFiscale", label: "Codice Fiscale", get: s => s.codiceFiscale || "" },
  { id: "indirizzo", label: "Indirizzo", get: s => s.indirizzo || "" },
  { id: "paese", label: "Paese", get: s => s.paese || "" },
  { id: "provincia", label: "Provincia", get: s => s.provincia || "" },
  { id: "cap", label: "CAP", get: s => s.cap || "" },
  { id: "telefono", label: "Telefono", get: s => s.telefono || "" },
  { id: "cellulare", label: "Cellulare", get: s => s.cellulare || "" },
  { id: "email", label: "Email", get: s => s.email || "" },
  { id: "carica", label: "Carica", get: s => s.carica || "" },
  { id: "dataIscrizione", label: "Data iscrizione", get: s => s.dataIscrizione || "" },
  { id: "alfiere", label: "Alfiere", get: s => s.alfiere ? "Sì" : "No" },
  { id: "grado", label: "Grado", get: s => s.grado || "" },
  { id: "reparto", label: "Reparto", get: s => s.reparto || "" },
  { id: "brigata", label: "Brigata alpina", get: s => s.brigataAlpina || "" },
  { id: "anniNaja", label: "Anni naja", get: s => s.anniNaja || "" },
  { id: "incaricoFeste", label: "Incarico feste", get: s => s.incaricoFeste || "" },
  { id: "privacy", label: "Privacy firmata", get: s => s.privacy ? "Sì" : "No" },
  { id: "privacyFile", label: "File Privacy caricato", get: s => s.privacyFoto ? "Sì" : "No" },
  { id: "haccp", label: "HACCP", get: s => s.haccp ? "Sì" : "No" },
  { id: "haccpFile", label: "File HACCP caricato", get: s => s.haccpFoto ? "Sì" : "No" },
  { id: "accessoApp", label: "Accesso app", get: s => s.accessoApp ? "Sì" : "No" },
  { id: "taglia", label: "Taglia vestiario", get: s => s.tagliaVestiario || "" },
  { id: "sms", label: "SMS", get: s => s.sms ? "Sì" : "No" },
  { id: "whatsapp", label: "WhatsApp", get: s => s.whatsapp ? "Sì" : "No" },
  { id: "chiaviSede", label: "Chiavi sede", get: s => s.chiaviSede ? "Sì" : "No" },
  { id: "note", label: "Note", get: s => s.note || "" },
  { id: "andatoAvantiData", label: "Data (Andato avanti)", get: s => s.andatoAvantiData || "" },
];
const REPORT1_DEFAULT = ["cognome", "nome", "matricola", "telefono", "cellulare"];

function parseDataGGMMAAAA(str) {
  const m = (str || "").match(/(\d{1,2})[\/\-\.\s](\d{1,2})[\/\-\.\s](\d{2,4})/);
  if (!m) return null;
  let anno = parseInt(m[3], 10);
  if (anno < 100) anno += anno < 30 ? 2000 : 1900;
  const d = new Date(anno, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
  return isNaN(d.getTime()) ? null : d;
}

const TAGLIE_ORDINE = ["XXS", "XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL", "6XL"];
function chiaveTaglia(s) {
  const t = String((s && s.tagliaVestiario) || "").toUpperCase().replace(/\s+/g, "");
  if (!t) return null;
  const i = TAGLIE_ORDINE.indexOf(t);
  if (i >= 0) return i;
  const n = parseFloat(t.replace(",", "."));
  return isNaN(n) ? null : 100 + n;
}
const REPORT1_ORDINAMENTI = [
  { id: "taglia", label: "Taglia vestiario", tipo: "num", key: chiaveTaglia },
  { id: "brigata", label: "Brigata alpina", tipo: "testo", key: s => s.brigataAlpina || "" },
  { id: "cognome", label: "Cognome e nome (alfabetico)", tipo: "testo", key: s => `${s.cognome || ""} ${s.nome || ""}`.trim() },
  { id: "nome", label: "Nome e cognome", tipo: "testo", key: s => `${s.nome || ""} ${s.cognome || ""}`.trim() },
  { id: "dataNascita", label: "Data di nascita", tipo: "data", key: s => parseDataGGMMAAAA(s.dataNascita) },
  { id: "dataIscrizione", label: "Data iscrizione (anzianità)", tipo: "data", key: s => parseDataGGMMAAAA(s.dataIscrizione) },
  { id: "paese", label: "Residenza (paese)", tipo: "testo", key: s => s.paese || "" },
  { id: "provincia", label: "Provincia", tipo: "testo", key: s => s.provincia || "" },
  { id: "cap", label: "CAP", tipo: "testo", key: s => s.cap || "" },
  { id: "indirizzo", label: "Indirizzo (via)", tipo: "testo", key: s => s.indirizzo || "" },
  { id: "luogoNascita", label: "Luogo di nascita", tipo: "testo", key: s => s.luogoNascita || "" },
  { id: "carica", label: "Carica", tipo: "num", key: s => { const i = CARICHE.indexOf(s.carica); return i < 0 ? null : i; } },
  { id: "matricola", label: "Matricola", tipo: "testo", key: s => s.matricola || "" },
  { id: "andatoAvantiData", label: "Data andato avanti", tipo: "data", key: s => parseDataGGMMAAAA(s.andatoAvantiData) }
];

function ordinaSociReport(list, ordId, dir) {
  const o = REPORT1_ORDINAMENTI.find(x => x.id === ordId) || REPORT1_ORDINAMENTI[0];
  const segno = dir === "desc" ? -1 : 1;
  const opz = { numeric: true, sensitivity: "base" };
  const perNome = (a, b) => `${a.cognome || ""} ${a.nome || ""}`.localeCompare(`${b.cognome || ""} ${b.nome || ""}`, "it", opz);
  list.sort((a, b) => {
    const ka = o.key(a), kb = o.key(b);
    const va = ka === null || ka === "" || ka === undefined;
    const vb = kb === null || kb === "" || kb === undefined;
    if (va && vb) return perNome(a, b);
    if (va) return 1;   // i valori mancanti restano sempre in fondo
    if (vb) return -1;
    const r = o.tipo === "testo" ? ka.localeCompare(kb, "it", opz) : (ka - kb);
    return r ? r * segno : perNome(a, b);
  });
  return list;
}

function apriReportAndatiAvanti() {
  const elenco = state.socios
    .filter(s => s.andatoAvanti)
    .map(s => ({ s, data: parseDataGGMMAAAA(s.andatoAvantiData) }))
    .sort((a, b) => {
      if (!a.data && !b.data) return 0;
      if (!a.data) return 1;
      if (!b.data) return -1;
      return a.data - b.data;
    });
  const rows = elenco.map(({ s }) => [esc(s.cognome), esc(s.nome), esc(s.andatoAvantiData || "-")]);
  apriAnteprimaReportGenerico("Andati avanti", ["Cognome", "Nome", "Data"], rows);
}

function renderReport1() {
  const socios = state.socios.slice().sort((a, b) => (a.cognome + a.nome).localeCompare(b.cognome + b.nome));
  const socioOpts = socios.map(s => `<option value="${s.id}">${esc(s.cognome)} ${esc(s.nome)}</option>`).join("");
  const caricaHtml = CARICHE.map(c => `
    <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; padding:3px 0;">
      <input type="checkbox" class="rep1-carica" value="${esc(c)}" checked> ${esc(c)}
    </label>`).join("");
  const province = Array.from(new Set(state.socios.map(s => (s.provincia || "").toUpperCase()).filter(Boolean))).sort();
  const provinciaOpts = province.map(p => `<option value="${p}">${esc(p)}</option>`).join("");
  const colonneHtml = REPORT1_COLONNE.map(c => `
    <label style="display:flex; align-items:center; gap:5px; font-size:0.82rem; padding:3px 0;">
      <input type="checkbox" class="rep1-col" value="${c.id}" ${REPORT1_DEFAULT.includes(c.id) ? "checked" : ""}> ${esc(c.label)}
    </label>`).join("");
  return `
    <div class="section-title">📊 Report 1 – Soci</div>
    <div class="card" style="margin-bottom:16px;">
      <div class="form-group">
        <label>Socio</label>
        <select id="rep1-socio"><option value="">Tutti i soci</option>${socioOpts}</select>
      </div>
      <div class="form-group">
        <label>Categoria</label>
        <div style="margin-bottom:4px;">
          <a href="#" id="rep1-carica-tutte" style="font-size:0.78rem;">Seleziona tutte</a> &nbsp;·&nbsp;
          <a href="#" id="rep1-carica-nessuna" style="font-size:0.78rem;">Nessuna</a>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:4px 16px; border:1px solid #ddd; border-radius:8px; padding:8px;">${caricaHtml}</div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Provincia</label><select id="rep1-provincia"><option value="">Tutte</option>${provinciaOpts}</select></div>
        <div class="form-group"><label>Andato avanti</label><select id="rep1-andato-avanti"><option value="">Tutti</option><option value="no" selected>Escludi (solo attivi)</option><option value="si">Solo andati avanti</option></select></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Privacy firmata</label><select id="rep1-privacy"><option value="">Tutti</option><option value="si">Sì</option><option value="no">No</option></select></div>
        <div class="form-group"><label>File Privacy caricato</label><select id="rep1-privacy-file"><option value="">Tutti</option><option value="si">Sì</option><option value="no">No</option></select></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>HACCP</label><select id="rep1-haccp"><option value="">Tutti</option><option value="si">Sì</option><option value="no">No</option></select></div>
        <div class="form-group"><label>File HACCP caricato</label><select id="rep1-haccp-file"><option value="">Tutti</option><option value="si">Sì</option><option value="no">No</option></select></div>
      </div>
      <div class="two-col">
        <div class="form-group"><label>Ordina per</label><select id="rep1-ordina">
          <option value="auto" selected>Predefinito</option>
          ${REPORT1_ORDINAMENTI.map(o => `<option value="${o.id}">${o.label}</option>`).join("")}
        </select></div>
        <div class="form-group"><label>Ordine</label><select id="rep1-direzione">
          <option value="asc" selected>Crescente (A→Z, più vecchio prima)</option>
          <option value="desc">Decrescente (Z→A, più recente prima)</option>
        </select></div>
      </div>
      <div class="form-group">
        <label>Colonne da includere</label>
        <div style="margin-bottom:4px;">
          <a href="#" id="rep1-col-tutte" style="font-size:0.78rem;">Seleziona tutte</a> &nbsp;·&nbsp;
          <a href="#" id="rep1-col-nessuna" style="font-size:0.78rem;">Nessuna</a>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:4px 16px; border:1px solid #ddd; border-radius:8px; padding:8px;">${colonneHtml}</div>
      </div>
      <button type="button" class="btn block" id="rep1-genera-btn" style="margin-top:10px;">🔎 Genera report</button>
    </div>
    <button type="button" class="btn block" id="rep1-andati-avanti-btn" style="background:#666; color:#fff;">💔 Report Andati avanti (stampa su carta intestata)</button>
  `;
}

function attachReport1Events() {
  document.getElementById("rep1-andati-avanti-btn").addEventListener("click", apriReportAndatiAvanti);
  document.getElementById("rep1-col-tutte").addEventListener("click", e => {
    e.preventDefault();
    document.querySelectorAll(".rep1-col").forEach(el => el.checked = true);
  });
  document.getElementById("rep1-col-nessuna").addEventListener("click", e => {
    e.preventDefault();
    document.querySelectorAll(".rep1-col").forEach(el => el.checked = false);
  });
  document.getElementById("rep1-carica-tutte").addEventListener("click", e => {
    e.preventDefault();
    document.querySelectorAll(".rep1-carica").forEach(el => el.checked = true);
  });
  document.getElementById("rep1-carica-nessuna").addEventListener("click", e => {
    e.preventDefault();
    document.querySelectorAll(".rep1-carica").forEach(el => el.checked = false);
  });
  document.getElementById("rep1-genera-btn").addEventListener("click", () => {
    const socioId = document.getElementById("rep1-socio").value;
    const caricheSelezionate = Array.from(document.querySelectorAll(".rep1-carica:checked")).map(el => el.value);
    const provincia = document.getElementById("rep1-provincia").value;
    const privacyFiltro = document.getElementById("rep1-privacy").value;
    const privacyFileFiltro = document.getElementById("rep1-privacy-file").value;
    const haccpFiltro = document.getElementById("rep1-haccp").value;
    const haccpFileFiltro = document.getElementById("rep1-haccp-file").value;
    const andatoAvantiFiltro = document.getElementById("rep1-andato-avanti").value;
    const colonneIds = Array.from(document.querySelectorAll(".rep1-col:checked")).map(el => el.value);
    if (colonneIds.length === 0) { alert("Seleziona almeno una colonna."); return; }
    if (caricheSelezionate.length === 0) { alert("Seleziona almeno una categoria."); return; }
    let list = state.socios.slice();
    if (socioId) list = list.filter(s => s.id === socioId);
    if (caricheSelezionate.length < CARICHE.length) list = list.filter(s => caricheSelezionate.includes(s.carica));
    if (provincia) list = list.filter(s => (s.provincia || "").toUpperCase() === provincia);
    if (privacyFiltro === "si") list = list.filter(s => s.privacy);
    if (privacyFiltro === "no") list = list.filter(s => !s.privacy);
    if (privacyFileFiltro === "si") list = list.filter(s => s.privacyFoto);
    if (privacyFileFiltro === "no") list = list.filter(s => !s.privacyFoto);
    if (haccpFiltro === "si") list = list.filter(s => s.haccp);
    if (haccpFiltro === "no") list = list.filter(s => !s.haccp);
    if (haccpFileFiltro === "si") list = list.filter(s => s.haccpFoto);
    if (haccpFileFiltro === "no") list = list.filter(s => !s.haccpFoto);
    if (andatoAvantiFiltro === "si") list = list.filter(s => s.andatoAvanti);
    if (andatoAvantiFiltro === "no") list = list.filter(s => !s.andatoAvanti);
    let ordineScelto = document.getElementById("rep1-ordina").value;
    const direzione = document.getElementById("rep1-direzione").value;
    if (ordineScelto === "auto") ordineScelto = andatoAvantiFiltro === "si" ? "andatoAvantiData" : "cognome";
    ordinaSociReport(list, ordineScelto, direzione);
    const colonne = REPORT1_COLONNE.filter(c => colonneIds.includes(c.id));
    const headers = colonne.map(c => c.label);
    const rows = list.map(s => colonne.map(c => esc(c.get(s))));
    const testoRighe = list.map(s => colonne.map(c => `${c.label}: ${c.get(s)}`).join(" — "));
    apriAnteprimaReportGenerico("Report Soci", headers, rows, testoRighe);
  });
}

// ---------- Report 2: Ore Volontariato ----------
function renderReport2() {
  const iniziative = (state.iniziativeStorico || []).slice().sort((a, b) => (b.data || "").localeCompare(a.data || ""));
  const iniziativeOpts = iniziative.map(i => `<option value="${i.id}">${esc(i.nome)}${i.data ? " (" + fmtDate(i.data) + ")" : ""}</option>`).join("");
  const anni = Array.from(new Set(iniziative.map(i => (i.data || "").slice(0, 4)).filter(Boolean))).sort().reverse();
  const anniOpts = anni.map(a => `<option value="${a}">${a}</option>`).join("");
  return `
    <div class="section-title">📊 Report 2 – Ore Volontariato</div>
    <div class="card" style="margin-bottom:16px;">
      <div class="two-col">
        <div class="form-group"><label>Attività</label><select id="rep2-iniziativa"><option value="">Tutte (classifica generale)</option>${iniziativeOpts}</select></div>
        <div class="form-group"><label>Anno</label><select id="rep2-anno"><option value="">Tutti</option>${anniOpts}</select></div>
      </div>
      <button type="button" class="btn block" id="rep2-genera-btn" style="margin-top:6px;">🔎 Genera report</button>
    </div>
  `;
}

function attachReport2Events() {
  document.getElementById("rep2-genera-btn").addEventListener("click", () => {
    const iniziativaId = document.getElementById("rep2-iniziativa").value;
    const anno = document.getElementById("rep2-anno").value;
    const iniziativeFiltrate = (state.iniziativeStorico || []).filter(i => {
      if (iniziativaId && i.id !== iniziativaId) return false;
      if (anno && (i.data || "").slice(0, 4) !== anno) return false;
      return true;
    });
    const totali = {};
    iniziativeFiltrate.forEach(i => {
      const map = (state.oreAlpine && state.oreAlpine[i.id]) || {};
      Object.keys(map).forEach(socioId => {
        const ore = parseFloat(map[socioId]) || 0;
        if (ore <= 0) return;
        totali[socioId] = (totali[socioId] || 0) + ore;
      });
    });
    const righe = Object.keys(totali).map(socioId => {
      const s = state.socios.find(x => x.id === socioId);
      return { nome: s ? `${s.cognome} ${s.nome}` : "(socio eliminato)", ore: Math.round(totali[socioId] * 10) / 10 };
    }).sort((a, b) => b.ore - a.ore);
    if (righe.length === 0) { alert("Nessun dato per i filtri selezionati."); return; }
    const headers = ["Socio", "Ore totali"];
    const rows = righe.map(r => [esc(r.nome), esc(String(r.ore))]);
    const testoRighe = righe.map(r => `${r.nome}: ${r.ore} ore`);
    let titolo = "Report Ore Volontariato";
    if (iniziativaId) {
      const iniz = (state.iniziativeStorico || []).find(i => i.id === iniziativaId);
      if (iniz) titolo += ` — ${iniz.nome}`;
    }
    if (anno) titolo += ` — ${anno}`;
    apriAnteprimaReportGenerico(titolo, headers, rows, testoRighe);
  });
}

// ---------- Nav hide on scroll ----------
let lastScroll = window.scrollY;
function setupScrollHide() {
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    const delta = y - lastScroll;
    const navbar = document.getElementById("navbar");
    if (y < 40) {
      navbar && navbar.classList.remove("hide-nav");
    } else if (delta > 8) {
      navbar && navbar.classList.add("hide-nav");
    } else if (delta < -8) {
      navbar && navbar.classList.remove("hide-nav");
    }
    lastScroll = y;
  }, { passive: true });
}

// ---------- Init ----------
const SECTION_ORDER = ["home","anagrafica","conv-consiglio","bollino","bollino-amici","ringraziamenti","sponsor","cena","iniziative","ore-alpine","report","report2","conv-casoncellata","presenza-adunata","prenotazioni","beneficenza","canzoni","manuali","cassa","bacheca","verbali","libretto","archivio-bui","log"];

function vaiASezione(section) {
  if (!sezionePermessa(section)) return;
  const content = document.getElementById("app-content");
  const ordine = sezioniAttive();
  const oldIdx = ordine.indexOf(currentSection);
  const newIdx = ordine.indexOf(section);
  const direzione = (oldIdx !== -1 && newIdx !== -1 && newIdx !== oldIdx) ? (newIdx > oldIdx ? "avanti" : "indietro") : null;

  const eseguiCambio = () => {
    currentSection = section;
    searchTerm = ""; filterCarica = "";
    lastScroll = 0;
    window.scrollTo(0, 0);
    renderSection();
    if (direzione) {
      content.classList.add(direzione === "avanti" ? "slide-in-right" : "slide-in-left");
      content.addEventListener("animationend", () => {
        content.classList.remove("slide-in-right", "slide-in-left");
      }, { once: true });
    }
  };

  if (!direzione) { eseguiCambio(); return; }
  content.classList.add(direzione === "avanti" ? "slide-out-left" : "slide-out-right");
  content.addEventListener("animationend", () => {
    content.classList.remove("slide-out-left", "slide-out-right");
    eseguiCambio();
  }, { once: true });
}

// ---------- La mia scheda (modifica dei propri dati da parte del socio) ----------
// Il socio può modificare solo questi campi. Gli altri (matricola, carica, note, bollino, privacy, HACCP,
// SMS/WhatsApp, chiavi, alfiere, andato avanti, accesso app) restano gestiti dal Direttivo.
const TAGLIE_SUGGERITE = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "4XL", "5XL"];
const MIA_SCHEDA_CAMPI = ["cognome", "nome", "dataNascita", "luogoNascita", "provinciaNascita", "codiceFiscale",
  "indirizzo", "paese", "provincia", "cap", "telefono", "cellulare", "email", "tagliaVestiario", "grado", "reparto", "brigataAlpina", "anniNaja"];

function validaMiaScheda(input) {
  const campi = {};
  MIA_SCHEDA_CAMPI.forEach(k => { if (input[k] !== undefined && input[k] !== null) campi[k] = String(input[k]).trim(); });
  ["provinciaNascita", "provincia", "codiceFiscale"].forEach(k => { if (campi[k] !== undefined) campi[k] = campi[k].toUpperCase(); });
  if (!campi.cognome || !campi.nome) return { errore: "Cognome e nome sono obbligatori." };
  if (campi.dataNascita !== undefined && !passwordInizialeSocio({ dataNascita: campi.dataNascita })) {
    return { errore: "Data di nascita non valida: usa il formato gg-mm-aaaa con l'anno a 4 cifre." };
  }
  if (campi.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(campi.email)) return { errore: "L'indirizzo email non sembra valido." };
  return { campi };
}

// Scrive SOLO la scheda del socio dentro il documento principale, con una transazione:
// non sovrascrive il resto dei dati e non perde le modifiche fatte da altri nello stesso momento.
async function salvaMiaSchedaRemoto(socioId, campi) {
  const ref = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC);
  await conTimeout(db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("documento principale non trovato");
    const socios = (snap.data().socios || []).slice();
    const idx = socios.findIndex(s => s.id === socioId);
    if (idx < 0) throw new Error("socio non trovato");
    socios[idx] = Object.assign({}, socios[idx], campi, { aggiornatoDaSocio: new Date().toISOString() });
    tx.update(ref, { socios });
  }), 15000);
}

function apriMiaScheda() {
  const s = socioCorrente();
  if (!s) return;
  const simp = s.carica === "Simpatizzante";
  const campo = (k, label, extra) => `<div class="form-group"${extra && extra.stile ? ` style="${extra.stile}"` : ""}><label>${label}</label><input type="${(extra && extra.tipo) || "text"}" id="ms-${k}" value="${esc(s[k])}"${extra && extra.attr ? " " + extra.attr : ""}></div>`;
  const html = `
    <div class="modal-title">👤 La mia scheda</div>
    <div class="card-sub" style="margin-bottom:10px;">Qui puoi aggiornare i tuoi dati. Matricola, categoria e le altre voci le gestisce il Direttivo.</div>
    <div class="two-col">${campo("cognome", "Cognome *")}${campo("nome", "Nome *")}</div>
    <div class="two-col">${campo("dataNascita", "Data di nascita", { attr: 'placeholder="gg-mm-aaaa"' })}${campo("codiceFiscale", "Codice fiscale", { attr: 'style="text-transform:uppercase"' })}</div>
    ${simp ? "" : `<div class="two-col">${campo("luogoNascita", "Luogo di nascita")}${campo("provinciaNascita", "Prov. nascita", { attr: 'maxlength="2" style="text-transform:uppercase"' })}</div>`}
    ${campo("indirizzo", "Residenza - Indirizzo")}
    <div class="two-col">${campo("paese", "Paese")}${campo("provincia", "Provincia", { attr: 'maxlength="2" style="text-transform:uppercase"' })}${campo("cap", "CAP", { attr: 'maxlength="5" inputmode="numeric"' })}</div>
    <div class="two-col">${campo("telefono", "Telefono", { tipo: "tel" })}${campo("cellulare", "Cellulare", { tipo: "tel" })}</div>
    ${campo("email", "Email", { tipo: "email" })}
    ${simp ? "" : `<div class="two-col">${campo("anniNaja", "Anni di naja")}${campo("grado", "Grado")}</div>${campo("brigataAlpina", "Brigata Alpina")}${campo("reparto", "Reparto")}`}
    <div class="two-col">
      <div class="form-group"><label>Incarico feste</label><input type="text" value="${esc(s.incaricoFeste || "Nessuno")}" disabled title="Lo assegna il Direttivo"></div>
      <div class="form-group"><label>Taglia vestiario</label><input type="text" id="ms-tagliaVestiario" list="lista-taglie-ms" value="${esc(s.tagliaVestiario)}" placeholder="Es. L, XL, 52...">
        <datalist id="lista-taglie-ms">${TAGLIE_SUGGERITE.map(t => `<option value="${t}"></option>`).join("")}</datalist></div>
    </div>
    <div class="card-sub" style="margin:4px 0 10px;">Matricola: <strong>${esc(s.matricola) || "-"}</strong> · Iscritto dal: <strong>${esc(s.dataIscrizione) || "-"}</strong> · Categoria: <strong>${esc(s.carica) || "-"}</strong></div>
    <div style="font-size:0.74rem; color:#666; margin-bottom:8px;">Se cambi cognome e nome, per accedere userai quelli nuovi. Se non hai ancora cambiato password, cambiando la data di nascita cambia anche la password iniziale.</div>
    <div id="ms-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="ms-annulla">Annulla</button>
      <button type="button" class="btn" id="ms-salva">Salva</button>
    </div>`;
  showModal(html);
  document.getElementById("ms-annulla").addEventListener("click", closeModal);
  document.getElementById("ms-salva").addEventListener("click", async () => {
    const err = document.getElementById("ms-errore");
    const input = {};
    MIA_SCHEDA_CAMPI.forEach(k => { const el = document.getElementById("ms-" + k); if (el) input[k] = el.value; });
    const v = validaMiaScheda(input);
    if (v.errore) { err.textContent = v.errore; return; }
    if (!window.db) { err.textContent = "Firebase non configurato: impossibile salvare."; return; }
    const btn = document.getElementById("ms-salva");
    btn.disabled = true; err.textContent = "";
    try {
      await salvaMiaSchedaRemoto(s.id, v.campi);
    } catch (e) {
      console.error(e);
      err.textContent = "Non sono riuscito a salvare: controlla la connessione e riprova.";
      btn.disabled = false;
      return;
    }
    const idx = state.socios.findIndex(x => x.id === s.id);
    const prima = idx >= 0 ? JSON.parse(JSON.stringify(state.socios[idx])) : {};
    if (idx >= 0) Object.assign(state.socios[idx], v.campi);
    localStorage.setItem("gestione_gruppo_data", JSON.stringify(state));
    logAggiornaBaseline();
    const cambiati = logCampiCambiati(prima, state.socios[idx] || {});
    scriviLog([{ ev: `✏️ Ha modificato la propria scheda${cambiati ? " (" + cambiati + ")" : " (nessuna variazione)"}` }]);
    closeModal();
    updateTopbar();
    renderSection();
    toast("Scheda aggiornata");
  });
}

// ---------- Controllo della sincronizzazione ----------
async function controllaSincronizzazione() {
  if (!window.db) { alert("Firebase non è configurato su questo dispositivo."); return; }
  let snap;
  try {
    snap = await conTimeout(db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).get({ source: "server" }), 12000);
  } catch (e) {
    alert("Non riesco a leggere i dati dal server: il telefono è senza connessione oppure Firebase non risponde. I dati che vedi ora sono quelli salvati su questo dispositivo.");
    return;
  }
  if (!snap.exists) { alert("Sul server non ci sono ancora dati."); return; }
  const cloud = snap.data();
  const un = (nome, v) => !v ? `${nome} assente` : (linkSicuro(v) ? `${nome} ok` : `${nome} NON riconosciuto («${String(v).slice(0, 45)}»)`);
  const social = g => `${un("Instagram", g && g.instagram)}; ${un("Facebook", g && g.facebook)}`;
  const quando = m => m && m.ultimaModifica ? new Date(m.ultimaModifica).toLocaleString("it-IT") : "-";
  const kb = Math.round(JSON.stringify(cloud).length / 1024);
  const righe = [
    `SERVER (Firebase): ${kb} KB`,
    `  soci: ${(cloud.socios || []).length}`,
    `  link social: ${social(cloud.gruppoInfo)}`,
    `  ultima modifica: ${quando(cloud.meta)}`,
    "",
    "QUESTO TELEFONO",
    `  soci: ${(state.socios || []).length}`,
    `  link social: ${social(state.gruppoInfo)}`,
    `  ultima modifica: ${quando(state.meta)}`,
  ];
  const uguali = (cloud.socios || []).length === (state.socios || []).length &&
    !!(cloud.gruppoInfo && cloud.gruppoInfo.instagram) === !!(state.gruppoInfo && state.gruppoInfo.instagram) &&
    !!(cloud.gruppoInfo && cloud.gruppoInfo.facebook) === !!(state.gruppoInfo && state.gruppoInfo.facebook);
  righe.push("", uguali ? "Server e telefono combaciano." : "ATTENZIONE: server e telefono NON combaciano. Chiudi e riapri l'app; se i dati giusti sono su un altro dispositivo, salva di nuovo da lì.");
  alert(righe.join("\n"));
}

// ---------- Cambio password personale ----------
// A ogni apertura dell'app, finché il socio usa ancora la password iniziale (data di nascita),
// l'app gli propone di sceglierne una personale. "Più tardi" la rimanda alla prossima apertura.
async function controllaPasswordIniziale() {
  if (!currentUser || !currentUser.startsWith("socio:") || !window.db) return;
  const s = socioCorrente();
  if (!s) return;
  try {
    const rec = await leggiRecordPassword(s.id);
    if (rec) return;                       // ha già una password personale
  } catch (e) { return; }                  // offline o errore: non disturbare
  const m = document.getElementById("modal-overlay");
  if (m && !m.classList.contains("hidden")) return;   // c'è già una finestra aperta
  apriCambioPassword(true);
}

function apriCambioPassword(primoAccesso) {
  const socio = socioCorrente();
  if (!socio) return;
  const html = `
    <div class="modal-title">🔑 Cambia password</div>
    ${primoAccesso
      ? `<div class="card-sub" style="margin-bottom:10px;">Stai usando la password iniziale (la tua data di nascita). Scegline una personale: da ora userai quella.</div>`
      : `<div class="form-group"><label>Password attuale</label><input type="password" id="cp-attuale" autocomplete="current-password"></div>`}
    <div class="form-group"><label>Nuova password (almeno 6 caratteri)</label><input type="password" id="cp-nuova" autocomplete="new-password"></div>
    <div class="form-group"><label>Ripeti la nuova password</label><input type="password" id="cp-conferma" autocomplete="new-password"></div>
    <div id="cp-errore" style="color:var(--red); font-size:0.82rem; min-height:1.1em; margin-bottom:6px;"></div>
    <div class="modal-actions">
      <button type="button" class="btn secondary" id="cp-annulla">${primoAccesso ? "Più tardi" : "Annulla"}</button>
      <button type="button" class="btn" id="cp-salva">Salva</button>
    </div>`;
  showModal(html);
  document.getElementById("cp-annulla").addEventListener("click", closeModal);
  document.getElementById("cp-salva").addEventListener("click", async () => {
    const err = document.getElementById("cp-errore");
    const nuova = document.getElementById("cp-nuova").value;
    const conferma = document.getElementById("cp-conferma").value;
    if (nuova.length < 6) { err.textContent = "La nuova password deve avere almeno 6 caratteri."; return; }
    if (nuova !== conferma) { err.textContent = "Le due password non coincidono."; return; }
    if (nuova.replace(/\D/g, "") === passwordInizialeSocio(socio) && /^[\d\s\/\-.]+$/.test(nuova)) { err.textContent = "Non puoi usare la data di nascita: scegli un'altra password."; return; }
    const btn = document.getElementById("cp-salva");
    btn.disabled = true; err.textContent = "";
    try {
      if (!primoAccesso) {
        const r = await verificaPasswordSocio(socio, document.getElementById("cp-attuale").value);
        if (!r.ok) { err.textContent = "La password attuale non è corretta."; btn.disabled = false; return; }
      }
      await salvaNuovaPassword(socio.id, nuova);
    } catch (e) {
      console.error(e);
      err.textContent = "Non sono riuscito a salvare: controlla la connessione e riprova.";
      btn.disabled = false;
      return;
    }
    scriviLog([{ ev: "🔑 Password personale cambiata" }]);
    closeModal();
    toast("Password cambiata");
  });
}

// ---------- Menù laterale ----------
const MENU_GRUPPI = [
  { titolo: "", voci: [["home", "🏠", "Home"]] },
  { titolo: "Soci e tesseramento", voci: [["anagrafica", "👤", "Anagrafica"], ["conv-consiglio", "📋", "Consiglio"], ["bollino", "🎫", "Bollino"], ["bollino-amici", "🤝", "Bollino Amici"]] },
  { titolo: "Eventi", voci: [["cena", "🍽️", "Cena"], ["iniziative", "🎉", "Attività"], ["presenza-adunata", "🎖️", "Adunata"], ["prenotazioni", "🗓️", "Prenotaz. Sede"], ["beneficenza", "🎁", "Panettoni &amp; C"], ["conv-casoncellata", "🥟", "Casoncellata"]] },
  { titolo: "Comunicazione", voci: [["bacheca", "📌", "Bacheca"], ["verbali", "📑", "Verbali Consiglio"], ["libretto", "📖", "Preghiera e Canto"], ["canzoni", "🎵", "Canzoni"]] },
  { titolo: "Gestione e report", voci: [["archivio-bui", "🗄️", "Archivio BUI"], ["cassa", "💰", "Cassa"], ["ore-alpine", "⏱️", "Ore Alpine"], ["ringraziamenti", "🙏", "Ringraziamenti"], ["sponsor", "💼", "Sponsor"], ["report", "📊", "Report 1"], ["report2", "📊", "Report 2"], ["log", "📜", "Log"]] }
];

function isCapogruppo() {
  if (currentUser === "capogruppo" || currentUser === "pc_capogruppo") return true;
  const s = socioCorrente();
  return !!(s && s.carica === "Capogruppo");
}
function puoVedereArchivioBui() { return currentRole === "admin" || isCapogruppo(); }

// Sezioni che a chi non le può usare non compaiono nemmeno (grigie con il lucchetto) nel Menù
const SEZIONI_NASCOSTE_SE_NON_PERMESSE = ["archivio-bui", "canzoni"];

function sezionePermessa(sezione) {
  if (sezione === "archivio-bui") return puoVedereArchivioBui();
  if (currentRole === "socio") return SOCIO_SEZIONI.includes(sezione);
  if (currentRole !== "admin") return !SEZIONI_SOLO_ADMIN.includes(sezione);
  return true;
}

// ---------- Pallini delle novità ----------
// Rosso (ai soci): c'è una pubblicazione nuova nella sezione, o la sezione è nuova.
// Azzurro (a Direttivo e Admin): un socio ha fatto qualcosa (scheda aggiornata, ordine, iscrizione alla cena).
// Si ragiona per telefono: ogni telefono si ricorda quando è stata aperta l'ultima volta ogni sezione.
const PALLINI_SEZIONI_ROSSO = ["bacheca", "iniziative", "cena", "presenza-adunata", "verbali", "beneficenza", "conv-casoncellata", "manuali"];
const PALLINI_SEZIONI_AZZURRO = ["anagrafica", "beneficenza", "cena", "conv-casoncellata"];
let pallinoCasoTs = "";        // ultima disponibilità data da un socio per la Casoncellata
let pallinoCenaTs = "";        // ultima iscrizione alla cena fatta da un socio (letta dai documenti delle cene)
let vistoPrima = {};           // com'era "l'ultima apertura" prima di entrare nella sezione (serve per le etichette azzurre)
let ultimaSezioneVista = "";
let pallinoCenaTimer = null;

function chiaveVisto() { return "gestione_gruppo_visto_" + (currentUser || "anon"); }
function leggiVisto() {
  if (!currentUser) return null;
  try { return JSON.parse(localStorage.getItem(chiaveVisto()) || "null"); } catch (e) { return null; }
}
function salvaVisto(v) { try { localStorage.setItem(chiaveVisto(), JSON.stringify(v)); } catch (e) { /* senza memoria locale niente pallini, ma l'app funziona */ } }
// Primo avvio su questo telefono per questo utente: parte tutto pulito, niente pallini.
function inizializzaVisto() {
  const adesso = new Date().toISOString();
  const tutte = SECTION_ORDER.filter(s => sezionePermessa(s));
  const v = { sez: {}, conosciute: tutte.slice(), creato: adesso };
  tutte.forEach(s => { v.sez[s] = adesso; });
  salvaVisto(v);
  return v;
}

function ultimoTesto(lista) { return lista.reduce((m, x) => (x && x > m ? x : m), ""); }
// Data dell'ultima cosa pubblicata dal Direttivo/Admin in una sezione (per il rosso dei soci).
function ultimaPubblicazione(sez) {
  switch (sez) {
    case "bacheca": return ultimoTesto((state.bacheca || []).map(x => x.creato));
    case "iniziative": return ultimoTesto((state.iniziativeStorico || []).map(x => x.creato));
    case "cena": return ultimoTesto((state.cene || []).map(x => x.creato));
    case "presenza-adunata": return ultimoTesto((state.adunate || []).map(x => x.creato));
    case "verbali": return ultimoTesto((state.verbali || []).map(x => x.creato));
    case "beneficenza": return ultimoTesto((state.campagneBeneficenza || []).filter(c => c.stato === "aperta").map(x => x.creato));
    case "manuali": return ultimoTesto((state.manuali || []).filter(m => m.visibilita === "tutti").map(x => x.caricato));
    case "conv-casoncellata": return ultimoTesto((state.casoncellata || []).filter(casoAperta).map(x => x.creato));
  }
  return "";
}
// Data dell'ultima cosa fatta da un socio in una sezione (per l'azzurro di chi gestisce).
function ultimaAzioneSoci(sez) {
  switch (sez) {
    case "anagrafica": return ultimoTesto((state.socios || []).map(s => s.aggiornatoDaSocio));
    case "beneficenza": return ultimoTesto((state.campagneBeneficenza || []).reduce((acc, c) => acc.concat((c.prenotazioni || []).filter(r => r.daSocio).map(r => r.aggiornato || r.creato)), []));
    case "cena": return pallinoCenaTs;
    case "conv-casoncellata": return pallinoCasoTs;
  }
  return "";
}

// "rosso", "azzurro" oppure null.
function haPallino(sez) {
  const v = leggiVisto();
  if (!v || !sezionePermessa(sez)) return null;
  const visto = (v.sez && v.sez[sez]) || "";
  if (currentRole === "socio") {
    if (!(v.conosciute || []).includes(sez)) return "rosso";           // sezione nuova mai aperta su questo telefono
    if (!PALLINI_SEZIONI_ROSSO.includes(sez)) return null;
    const u = ultimaPubblicazione(sez);
    return u && u > visto ? "rosso" : null;
  }
  if (!PALLINI_SEZIONI_AZZURRO.includes(sez)) return null;
  const u = ultimaAzioneSoci(sez);
  return u && u > visto ? "azzurro" : null;
}
function pallinoVoce(sez) { const c = haPallino(sez); return c ? `<i class="pall-v ${c}" aria-hidden="true" title="${c === "rosso" ? "Novità" : "Qualcuno ha fatto qualcosa"}"></i>` : ""; }

// Quando si apre una sezione, la si segna come vista (e il pallino sparisce).
function segnaSezioneVista() {
  if (!currentUser || !currentSection) return;
  const sez = currentSection;
  const v = leggiVisto() || inizializzaVisto();
  v.sez = v.sez || {}; v.conosciute = v.conosciute || [];
  if (ultimaSezioneVista !== sez) { vistoPrima[sez] = v.sez[sez] || ""; ultimaSezioneVista = sez; }
  // si segna la più recente tra "adesso" e l'ultima pubblicazione: un telefono con l'orologio indietro non si lascia pallini fantasma
  const adesso = new Date().toISOString();
  const u = currentRole === "socio" ? ultimaPubblicazione(sez) : ultimaAzioneSoci(sez);
  v.sez[sez] = u && u > adesso ? u : adesso;
  if (!v.conosciute.includes(sez)) v.conosciute.push(sez);
  salvaVisto(v);
}

// Disegna i pallini sulla barra in basso (fuori dai tasti, così non sbiadiscono) e sul tasto Menù.
function aggiornaPallini() {
  const barra = document.getElementById("navbar");
  if (!barra) return;
  barra.querySelectorAll(".pall").forEach(e => e.remove());
  if (!currentUser) return;
  const mappa = {};
  SECTION_ORDER.forEach(s => { const c = haPallino(s); if (c) mappa[s] = c; });
  const nr = barra.getBoundingClientRect();
  const metti = (el, colore) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const i = document.createElement("i");
    i.className = "pall " + colore; i.setAttribute("aria-hidden", "true");
    i.style.left = (r.left - nr.left + r.width / 2 + 9) + "px"; i.style.top = (r.top - nr.top + 7) + "px";
    barra.appendChild(i);
  };
  const nellaBarra = new Set();
  barra.querySelectorAll(".nav-btn[data-section]").forEach(b => { nellaBarra.add(b.dataset.section); if (mappa[b.dataset.section]) metti(b, mappa[b.dataset.section]); });
  const dentro = Object.keys(mappa).filter(s => !nellaBarra.has(s));   // pallini su sezioni che stanno nel Menù
  if (dentro.length) metti(document.getElementById("menu-btn"), dentro.some(s => mappa[s] === "rosso") ? "rosso" : "azzurro");
}

// Etichetta azzurra sulla scheda di un socio che ha aggiornato i suoi dati dopo l'ultima volta che chi gestisce ha aperto l'Anagrafica.
function chipAggiornatoDalSocio(s) {
  if (currentRole === "socio" || !s.aggiornatoDaSocio) return "";
  if (s.aggiornatoDaSocio <= (vistoPrima.anagrafica || "")) return "";
  return `<div><span class="chip-az"><i></i>Scheda aggiornata dal socio · ${s.aggiornatoDaSocio.slice(8, 10)}/${s.aggiornatoDaSocio.slice(5, 7)}</span></div>`;
}

// Iscrizioni alla cena fatte da soci (dall'app o dal link), lette dai documenti delle cene recenti. Solo per chi gestisce.
function controllaPallinoCena() {
  if (!window.db || !currentUser || currentRole === "socio") return;
  clearTimeout(pallinoCenaTimer);
  pallinoCenaTimer = setTimeout(async () => {
    try {
      const limite = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
      const cene = (state.cene || []).filter(c => !c.data || c.data >= limite);
      const docs = await Promise.all(cene.map(c => db.collection(FIRESTORE_COLLECTION).doc(`cena_${c.id}`).get().catch(() => null)));
      let max = "";
      docs.forEach(d => { if (d && d.exists) Object.values(d.data().risposte || {}).forEach(r => { if (r && r.da !== "direttivo" && r.ts && r.ts > max) max = r.ts; }); });
      pallinoCenaTs = max;
      const docsCaso = await Promise.all((state.casoncellata || []).filter(casoAperta).map(e => db.collection(FIRESTORE_COLLECTION).doc(`casoncellata_${e.id}`).get().catch(() => null)));
      let maxCaso = "";
      docsCaso.forEach(d => { if (d && d.exists) Object.values(d.data().risposte || {}).forEach(r => { if (r && r.ts && r.da !== "direttivo" && r.ts > maxCaso) maxCaso = r.ts; }); });
      pallinoCasoTs = maxCaso;
      aggiornaPallini();
      const aperto = document.getElementById("menu-overlay") && document.getElementById("menu-overlay").classList.contains("open");
      if (aperto) renderMenuDrawer();
    } catch (e) { console.warn("Pallino della cena non calcolato", e); }
  }, 500);
}

function renderMenuDrawer() {
  const drawer = document.getElementById("menu-drawer");
  if (!drawer) return;
  const gruppi = MENU_GRUPPI.map(g => `
    ${g.titolo ? `<div class="menu-gruppo">${g.titolo}</div>` : ""}
    ${g.voci.filter(([sez]) => !SEZIONI_NASCOSTE_SE_NON_PERMESSE.includes(sez) || sezionePermessa(sez)).map(([sez, icona, label]) => {
      const permessa = sezionePermessa(sez);
      return `<button type="button" class="menu-voce${sez === currentSection ? " attiva" : ""}" data-menu-sezione="${sez}"${permessa ? "" : ' disabled aria-disabled="true"'}>
        <span class="mv-ic">${icona}</span><span class="mv-lb">${label}</span>${pallinoVoce(sez)}${permessa ? "" : '<span class="mv-lock" title="Non disponibile per il tuo profilo">🔒</span>'}
      </button>`;
    }).join("")}
  `).join("");
  drawer.innerHTML = `
    <div class="menu-head">
      <div>
        <div class="mh-titolo">Menù</div>
        <div class="mh-sub">${esc(userLabel(currentUser))}</div>
      </div>
      <button type="button" class="menu-close" id="menu-close-btn" aria-label="Chiudi il menù">✕</button>
    </div>
    ${gruppi}
    <div class="menu-gruppo">Profilo</div>
    ${currentUser && currentUser.startsWith("socio:") ? `<button type="button" class="menu-voce" data-menu-azione="scheda"><span class="mv-ic">👤</span><span class="mv-lb">La mia scheda</span></button>
    <button type="button" class="menu-voce" data-menu-azione="password"><span class="mv-ic">🔑</span><span class="mv-lb">Cambia password</span></button>` : ""}
    <button type="button" class="menu-voce${currentSection === "manuali" ? " attiva" : ""}" data-menu-sezione="manuali"><span class="mv-ic">📘</span><span class="mv-lb">Manuali</span>${pallinoVoce("manuali")}</button>
    <button type="button" class="menu-voce" data-menu-azione="guide"><span class="mv-ic">🎬</span><span class="mv-lb">Guide video</span></button>
    <button type="button" class="menu-voce" data-menu-azione="esci"><span class="mv-ic">🚪</span><span class="mv-lb">Esci</span></button>
    <div class="menu-foot">🔒 = non disponibile per il tuo profilo · v${APP_VERSION}</div>
  `;
}

function apriMenu() {
  renderMenuDrawer();
  const overlay = document.getElementById("menu-overlay");
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("menu-aperto");
}

function chiudiMenu() {
  const overlay = document.getElementById("menu-overlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("menu-aperto");
}

function setupMenuLaterale() {
  document.getElementById("menu-btn").addEventListener("click", apriMenu);
  document.getElementById("menu-scrim").addEventListener("click", chiudiMenu);
  document.getElementById("menu-drawer").addEventListener("click", e => {
    if (e.target.closest("#menu-close-btn")) { chiudiMenu(); return; }
    const azione = e.target.closest("[data-menu-azione]");
    if (azione) {
      chiudiMenu();
      if (azione.dataset.menuAzione === "password") apriCambioPassword(false);
      else if (azione.dataset.menuAzione === "scheda") apriMiaScheda();
      else if (azione.dataset.menuAzione === "guide") window.open("guide/", "_blank");
      else confermaCambiaUtente();
      return;
    }
    const voce = e.target.closest("[data-menu-sezione]");
    if (!voce || voce.disabled) return;
    chiudiMenu();
    vaiASezione(voce.dataset.menuSezione);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") chiudiMenu(); });
}

let touchStartX = 0, touchStartY = 0;
function setupSwipeNav() {
  const content = document.getElementById("app-content");
  content.addEventListener("touchstart", e => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
  }, { passive: true });
  content.addEventListener("touchend", e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const ordine = sezioniAttive();
    const idx = ordine.indexOf(currentSection);
    if (idx === -1) return;
    if (dx < 0 && idx < ordine.length - 1) {
      vaiASezione(ordine[idx + 1]);
    } else if (dx > 0 && idx > 0) {
      vaiASezione(ordine[idx - 1]);
    }
  }, { passive: true });
}

function init() {
  const cenaId = new URLSearchParams(location.search).get("cena");
  if (cenaId) {
    renderCenaRisposta(cenaId);
    return;
  }
  loadState();
  if (currentUser) {
    startApp();
    return;
  }
  // Utente non ancora identificato su questo dispositivo: prima di mostrare la
  // schermata "Chi sei?" proviamo a leggere da Firebase l'elenco utenti/password
  // aggiornato (potrebbe essere stato modificato da un altro dispositivo).
  if (window.db) {
    db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).get().then(snap => {
      if (snap.exists) applyStateFields(snap.data());
      showLoginScreen(startApp);
    }).catch(() => showLoginScreen(startApp));
  } else {
    showLoginScreen(startApp);
  }
}

const SOCIO_SEZIONI = ["home", "bacheca", "libretto", "cena", "presenza-adunata", "iniziative", "prenotazioni", "verbali", "beneficenza", "conv-casoncellata", "manuali"];
const SEZIONI_SOLO_ADMIN = ["cassa", "log"];

function sezioniAttive() {
  if (!puoVedereArchivioBui()) return sezioniAttiveBase().filter(s => s !== "archivio-bui");
  return sezioniAttiveBase();
}
function sezioniAttiveBase() {
  if (currentRole === "socio") return SECTION_ORDER.filter(s => SOCIO_SEZIONI.includes(s));
  if (currentRole !== "admin") return SECTION_ORDER.filter(s => !SEZIONI_SOLO_ADMIN.includes(s));
  return SECTION_ORDER;
}

function applyRoleRestrictions() {
  const settingsBtn = document.getElementById("settings-btn");

  if (currentRole !== "admin") {
    document.querySelectorAll(".nav-btn").forEach(b => {
      if (SEZIONI_SOLO_ADMIN.includes(b.dataset.section)) b.style.display = "none";
    });
    if (SEZIONI_SOLO_ADMIN.includes(currentSection)) currentSection = "home";
  }
  if (!sezionePermessa(currentSection)) currentSection = "home";

  if (currentRole !== "socio") {
    settingsBtn.textContent = "⚙️";
    settingsBtn.setAttribute("aria-label", "Impostazioni");
    return;
  }
  document.querySelectorAll(".nav-btn").forEach(b => {
    if (!SOCIO_SEZIONI.includes(b.dataset.section)) b.style.display = "none";
  });
  settingsBtn.textContent = "🔁";
  settingsBtn.setAttribute("aria-label", "Cambia utente");
  if (!SOCIO_SEZIONI.includes(currentSection)) currentSection = "home";
}

function confermaCambiaUtente() {
  if (!confirm("Vuoi cambiare utente?")) return;
  localStorage.removeItem("gestione_gruppo_user");
  localStorage.removeItem("gestione_gruppo_role");
  currentUser = null;
  currentRole = null;
  location.reload();
}

function startApp() {
  if (riallineaAccessoPersonale()) return;
  vistoPrima = {}; ultimaSezioneVista = ""; pallinoCenaTs = ""; pallinoCasoTs = "";
  logAggiornaBaseline();
  logAccesso(loginAppenaEffettuato);
  loginAppenaEffettuato = false;
  updateTopbar();
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => vaiASezione(btn.dataset.section));
  });
  applyRoleRestrictions();
  document.getElementById("settings-btn").addEventListener("click", () => {
    if (currentRole === "socio") { confermaCambiaUtente(); return; }
    openSettings();
  });
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target.id === "modal-overlay") { closeModal(); currentConvocazioneId = null; renderSection(); }
  });
  setupScrollHide();
  setupMenuLaterale();
  renderSection();
  initFirebaseSync();
  setTimeout(controllaPasswordIniziale, 1200);
  window.addEventListener("resize", aggiornaPallini);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") controllaPallinoCena(); });
  controllaPallinoCena();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then(reg => {
      reg.update();
      if (reg.waiting && navigator.serviceWorker.controller) {
        showUpdateBanner(reg.waiting);
      }
      reg.addEventListener("updatefound", () => {
        const newWorker = reg.installing;
        if (!newWorker) return;
        newWorker.addEventListener("statechange", () => {
          if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
            showUpdateBanner(newWorker);
          }
        });
      });
      setInterval(() => reg.update(), 10 * 60 * 1000);
    }).catch(err => console.error("SW error", err));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        navigator.serviceWorker.getRegistration().then(reg => reg && reg.update());
      }
    });

    let refreshing = false;
    const eraControllato = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Alla prima installazione non c'era un controllore: ricaricare qui farebbe sparire
      // la finestra "Cambia password" appena aperta. Si ricarica solo se è un vero aggiornamento.
      if (!eraControllato || refreshing) return;
      refreshing = true;
      window.location.reload();
    });
  }
}

function showUpdateBanner(worker) {
  if (document.getElementById("update-banner")) return;
  fetch(`version.json?t=${Date.now()}`, { cache: "no-store" })
    .then(r => r.json())
    .then(data => renderUpdateBanner(worker, data.version || "nuova"))
    .catch(() => renderUpdateBanner(worker, "nuova"));
}

function renderUpdateBanner(worker, newVersion) {
  if (document.getElementById("update-banner")) return;
  const html = `
    <div id="update-banner" style="position:fixed; left:0; right:0; bottom:0; z-index:9998; background:linear-gradient(135deg, #1a6b3c, #3fbf76); color:#fff; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; gap:12px; box-shadow:0 -2px 12px rgba(0,0,0,0.25); flex-wrap:wrap;">
      <div style="font-weight:600;">🔄 Nuova versione disponibile: <strong>v${esc(newVersion)}</strong> (stai usando v${esc(APP_VERSION)})</div>
      <div style="display:flex; gap:8px;">
        <button type="button" id="update-later-btn" style="background:transparent; border:1px solid #fff; color:#fff; padding:6px 14px; border-radius:8px; font-weight:600; cursor:pointer;">Più tardi</button>
        <button type="button" id="update-now-btn" style="background:#fff; color:#1a6b3c; border:none; padding:6px 16px; border-radius:8px; font-weight:700; cursor:pointer;">Aggiorna ora</button>
      </div>
    </div>`;
  document.body.insertAdjacentHTML("beforeend", html);
  document.getElementById("update-later-btn").addEventListener("click", () => {
    document.getElementById("update-banner").remove();
  });
  document.getElementById("update-now-btn").addEventListener("click", () => {
    const btn = document.getElementById("update-now-btn");
    btn.textContent = "Aggiornamento...";
    btn.disabled = true;
    forceHardReload();
  });
}

function forceHardReload() {
  let done = false;
  const goReload = () => {
    if (done) return;
    done = true;
    // Su alcune PWA installate (soprattutto iPhone) un semplice reload() a volte
    // non basta a far ripartire l'app: forziamo una navigazione vera con un
    // parametro che spezza qualsiasi cache residua del browser.
    window.location.href = window.location.pathname + "?v=" + Date.now();
  };
  Promise.all([
    ("caches" in window) ? caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))) : Promise.resolve(),
    ("serviceWorker" in navigator) ? navigator.serviceWorker.getRegistrations().then(regs => Promise.all(regs.map(r => r.unregister()))) : Promise.resolve()
  ]).then(goReload).catch(goReload);
  // Rete di sicurezza: ricarica comunque entro pochi secondi anche se qualcosa si blocca.
  setTimeout(goReload, 3000);
}

document.addEventListener("DOMContentLoaded", init);
