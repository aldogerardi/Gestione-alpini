// ===================== Gestione Gruppo =====================
const APP_VERSION = "4.21";
const APP_BUILD_DATE = "15/09/2026";

// ---------- Firebase: utenti dispositivo e sincronizzazione ----------
const FIRESTORE_COLLECTION = "gestioneGruppo";
const FIRESTORE_DOC = "stato";
const USERS = ["capogruppo", "pc_capogruppo", "segretario", "pc_segretario", "security", "pc_security"];
let currentUser = localStorage.getItem("gestione_gruppo_user") || null;
let firestoreUnsubscribe = null;

function userLabel(u) {
  if (!u) return "-";
  return u.startsWith("pc_") ? "💻 " + u.slice(3) : "📱 " + u;
}

function showLoginScreen(onDone) {
  const html = `
    <div id="login-screen" style="position:fixed; inset:0; background:#1a6b3c; z-index:9999; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:14px; padding:20px;">
      <div style="color:#fff; font-size:1.3rem; font-weight:800; margin-bottom:8px;">Chi sei?</div>
      <div style="display:flex; flex-direction:column; gap:10px; width:100%; max-width:320px;">
        ${USERS.map(u => `<button type="button" class="btn block login-btn" data-user="${u}" style="background:#fff; color:#1a6b3c; font-weight:700;">${userLabel(u)}</button>`).join("")}
      </div>
    </div>`;
  document.body.insertAdjacentHTML("afterbegin", html);
  document.querySelectorAll(".login-btn").forEach(b => {
    b.addEventListener("click", () => {
      currentUser = b.dataset.user;
      localStorage.setItem("gestione_gruppo_user", currentUser);
      document.getElementById("login-screen").remove();
      onDone();
    });
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
}

function syncToFirebase() {
  if (!window.db) return;
  const clean = JSON.parse(JSON.stringify(state));
  db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).set(clean).catch(err => {
    console.error("Errore salvataggio su Firebase", err);
    toast("⚠️ Salvato solo in locale, controlla la connessione");
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
    localStorage.setItem("gestione_gruppo_data", JSON.stringify(state));
    updateTopbar();
    renderSection();
  }, err => console.error("Errore sincronizzazione Firestore", err));
}

const CARICHE = ["Capogruppo","Capogruppo Onorario","Vice Capogruppo","Tesoriere","Vice Tesoriere","Segretario","Vice Segretario","Consigliere","Socio Alpino","Simpatizzante","Amici"];
const INCARICHI_FESTE = ["","Cucina","Lavapiatti","Bar","Patatine","Tagliata","Griglia","Formaggio fuso","Pulizie tavoli","Distribuzione"];

const LETTERHEAD_HTML = `
  <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; border-bottom:2px solid #1a6b3c; padding-bottom:8px; margin-bottom:14px;">
    <img src="data:image/png;base64,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" style="height:70px;">
    <div style="flex:1; text-align:center; color:#1a6b3c;">
      <div style="font-weight:800; font-style:italic; font-size:1.5rem; line-height:1.15;">GRUPPO ALPINI<br>BOTTONAGA</div>
      <div style="font-style:italic; font-size:0.82rem; margin-top:2px;">Via Corsica, 327 – 25125 Brescia&nbsp;&nbsp;&nbsp;Tel. 0303544982 / 030222612</div>
      <div style="font-style:italic; font-size:0.7rem; font-weight:700;">SEZ. BRESCIA</div>
    </div>
    <img src="data:image/jpeg;base64,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" style="height:60px;">
  </div>
`;

const WA_ICON = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.48 2 2 6.13 2 11.22c0 2.09.86 4.01 2.29 5.58L3 22l5.48-1.43a10.6 10.6 0 0 0 3.52.6c5.52 0 10-4.13 10-9.22C22 6.13 17.52 2 12 2zm.02 16.68c-1.1 0-2.18-.24-3.15-.7l-.23-.11-3.25.85.87-3.13-.15-.24a7.9 7.9 0 0 1-1.26-4.33c0-4.35 3.74-7.88 8.34-7.88 4.6 0 8.34 3.53 8.34 7.88 0 4.35-3.74 7.66-8.51 7.66z"/></svg>`;

const RUOLI_CONSIGLIO = ["Capogruppo","Vice Capogruppo","Tesoriere","Segretario","Consigliere"];

const PLACEHOLDER_SECTIONS = {
  "conv-primavera": { title: "Conv. Festa Primavera", icon: "🌸", desc: "Convocazioni per la Festa di Primavera." },
  "conv-alpina": { title: "Conv. Festa Alpina", icon: "⛰️", desc: "Convocazioni per la Festa Alpina." },
  "conv-casoncellata": { title: "Conv. Casoncellata", icon: "🥟", desc: "Convocazioni per la Casoncellata." },
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
  return `<span class="badge" data-view-privacy-doc style="padding:6px 10px; display:inline-flex; align-items:center; gap:6px; font-size:0.82rem; cursor:pointer;">${icon} ${esc(nome || "documento")} <span data-remove-privacy-doc style="cursor:pointer; font-weight:900; margin-left:2px;">✕</span></span>`;
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
  syncToFirebase();
}

// ---------- Utils ----------
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
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
  document.getElementById("app-build-date").textContent = "Agg. " + APP_BUILD_DATE;
}

function setActiveNav() {
  document.querySelectorAll(".nav-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.section === currentSection);
  });
  const activeBtn = document.querySelector(".nav-btn.active");
  if (activeBtn) activeBtn.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
}

function renderSection() {
  setActiveNav();
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
function renderHome() {
  const g = state.gruppoInfo || {};
  const capogruppo = state.socios.find(s => s.carica === "Capogruppo");
  const nomeCapogruppo = capogruppo ? `${capogruppo.cognome} ${capogruppo.nome}` : "Nessun Capogruppo impostato in Anagrafica";

  return `
    <div class="section-title">🏠 Home</div>
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
      <div class="form-group"><label>📷 Instagram (link)</label><input type="text" id="home-instagram" value="${esc(g.instagram)}" placeholder="https://instagram.com/..."></div>
      <div class="form-group"><label>📘 Facebook (link)</label><input type="text" id="home-facebook" value="${esc(g.facebook)}" placeholder="https://facebook.com/..."></div>
      <button type="button" class="btn block" id="home-save-btn" style="margin-top:6px;">💾 Salva</button>
    </div>
  `;
}

function attachHomeEvents() {
  document.getElementById("home-save-btn").addEventListener("click", () => {
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
  });
}

function renderAnagrafica() {
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
      if (s.carica) badges.push(`<span class="badge">${esc(s.carica)}</span>`);
      if (state.consiglio.membriIds.includes(s.id)) badges.push(`<span class="badge badge-icon" title="Membro del Consiglio Direttivo" style="background:#dbe9ff; border-color:#8fb4e8;">🏛️</span>`);
      if (s.incaricoFeste) badges.push(`<span class="badge">🎉 ${esc(s.incaricoFeste)}</span>`);
      if (s.sms) badges.push(`<span class="badge badge-icon" title="SMS">📩</span>`);
      if (s.whatsapp) badges.push(`<span class="badge whatsapp badge-icon" title="WhatsApp">${WA_ICON}</span>`);
      if (!s.privacy) badges.push(`<span class="badge badge-icon badge-warning" title="Privacy non firmata">🔒❗</span>`);
      if (s.haccp) badges.push(`<span class="badge badge-icon" title="Certificazione HACCP">🍽️</span>`);
      if (s.alfiere) badges.push(`<span class="badge badge-icon" title="Alfiere">🏅</span>`);
      if (s.email && s.email.trim()) badges.push(`<span class="badge badge-icon" title="Email presente">@</span>`);
      const annoCorrente = new Date().getFullYear();
      const bollinoOk = state.pagamentiBollino.find(r => r.socioId === s.id && r.anno === annoCorrente && r.pagato);
      if (!bollinoOk) badges.push(`<span class="badge badge-icon badge-warning" title="Bollino ${annoCorrente} non pagato">🎫❗</span>`);
      return `
        <div class="card color-green">
          <div class="card-row">
            <div class="card-info-col">
              <div class="card-name">${esc(s.cognome)} ${esc(s.nome)}</div>
              <div class="card-sub">${esc(s.cellulare || "")}${s.cellulare && s.telefono ? " · " : ""}${esc(s.telefono || "")}${s.dataIscrizione ? " · dal " + fmtDate(s.dataIscrizione) : ""}</div>
            </div>
            <div class="card-actions">
              <button data-edit="${s.id}">✏️</button>
              <button data-del="${s.id}">🗑️</button>
            </div>
          </div>
          <div class="badge-row badge-row-nowrap">${badges.join("")}</div>
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
}

function deleteSocio(id) {
  const s = state.socios.find(x => x.id === id);
  if (!s) return;
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
    telefono:"", cellulare:"", sms:false, whatsapp:false, privacy:false, haccp:false, haccpDataCorso:"", haccpDataScadenza:"", email:"",
    dataIscrizione:"", carica:"", grado:"", reparto:"", anniNaja:"", alfiere:false,
    incaricoFeste:"", note:""
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
      <div class="checkbox-row" style="margin-bottom:14px;">
        <label><input type="checkbox" id="f-sms" ${s.sms?"checked":""}> SMS</label>
        <label><input type="checkbox" id="f-whatsapp" ${s.whatsapp?"checked":""}> WhatsApp</label>
      </div>
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:12px;">
        <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;"><input type="checkbox" id="f-privacy" ${s.privacy?"checked":""}> 🔒 Privacy</label>
        <div style="text-align:right;">
          <div id="privacy-doc-chip" style="margin-bottom:2px;">${renderPrivacyChip(s.privacyFoto, s.privacyFotoNome)}</div>
          <div style="display:flex; align-items:center; gap:6px; justify-content:flex-end;">
            <span style="font-size:0.78rem; color:#666;">Doc.</span>
            <input type="file" id="f-privacy-foto" accept="image/*,application/pdf" style="display:none;">
            <button type="button" class="btn secondary" id="privacy-doc-btn" style="padding:6px 14px; font-size:0.78rem;">📎 Allega</button>
          </div>
        </div>
      </div>
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:14px;">
        <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;"><input type="checkbox" id="f-haccp" ${s.haccp?"checked":""}> 🍽️ HACCP</label>
        <div style="text-align:right;">
          <div id="haccp-doc-chip" style="margin-bottom:2px;">${renderPrivacyChip(s.haccpFoto, s.haccpFotoNome)}</div>
          <div style="display:flex; align-items:center; gap:6px; justify-content:flex-end;">
            <span style="font-size:0.78rem; color:#666;">Doc.</span>
            <input type="file" id="f-haccp-foto" accept="image/*,application/pdf" style="display:none;">
            <button type="button" class="btn secondary" id="haccp-doc-btn" style="padding:6px 14px; font-size:0.78rem;">📎 Allega</button>
          </div>
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
      <div class="two-col hide-if-simp" style="align-items:flex-end; margin-bottom:24px;">
        <div class="form-group" style="flex:0 0 auto;">
          <label>&nbsp;</label>
          <label style="display:flex; align-items:center; gap:6px; padding:9px 0;"><input type="checkbox" id="f-alfiere" ${s.alfiere?"checked":""}> 🎖️ Alfiere</label>
        </div>
        <div class="form-group"><label>Anni di naja</label><input type="text" id="f-naja" value="${esc(s.anniNaja)}"></div>
      </div>
      <div class="two-col hide-if-simp">
        <div class="form-group"><label>Grado</label><input type="text" id="f-grado" value="${esc(s.grado)}"></div>
        <div class="form-group"><label>Reparto</label><input type="text" id="f-reparto" value="${esc(s.reparto)}"></div>
      </div>
      <div class="form-group"><label>Incarico feste</label>
        <select id="f-incarico">${incarichi_opts}</select>
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

async function saveSocio() {
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
    privacy: document.getElementById("f-privacy").checked,
    haccp: document.getElementById("f-haccp").checked,
    haccpDataCorso: document.getElementById("f-haccp-data-corso").value.trim(),
    haccpDataScadenza: document.getElementById("f-haccp-data-scadenza").value.trim(),
    email: document.getElementById("f-email").value.trim(),
    dataIscrizione: document.getElementById("f-dataIscrizione").value.trim(),
    carica: document.getElementById("f-carica").value,
    alfiere: document.getElementById("f-alfiere").checked,
    grado: document.getElementById("f-grado").value.trim(),
    reparto: document.getElementById("f-reparto").value.trim(),
    anniNaja: document.getElementById("f-naja").value.trim(),
    incaricoFeste: document.getElementById("f-incarico").value,
    note: document.getElementById("f-note").value.trim(),
  };
  if (!data.cognome || !data.nome) { alert("Cognome e nome sono obbligatori"); return; }

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

function buildIniziativaTesto() {
  const nome = document.getElementById("iniz-nome").value.trim();
  const data = document.getElementById("iniz-data").value;
  const ora = document.getElementById("iniz-ora").value;
  const luogo = document.getElementById("iniz-luogo").value.trim();
  const descrizione = document.getElementById("iniz-descrizione").value.trim();
  let testo = `🎉 ${nome || "Iniziativa Gruppo"}\n\n`;
  if (data) testo += `📅 Data: ${fmtDate(data)}\n`;
  if (ora) testo += `🕐 Ora: ${ora}\n`;
  if (luogo) testo += `📍 Luogo: ${luogo}\n`;
  if (descrizione) testo += `\n📝 ${descrizione}`;
  return testo;
}

function renderIniziative() {
  const storico = (state.iniziativeStorico || []).slice().sort((a,b) => (b.data || "").localeCompare(a.data || ""));

  let storicoHtml;
  if (storico.length === 0) {
    storicoHtml = `<div class="card-sub">Nessuna iniziativa salvata.</div>`;
  } else {
    storicoHtml = storico.map(r => {
      const canali = r.canali || [];
      const badgesCanali = canali.map(ch => ch === "whatsapp" ? `<span class="badge">${WA_ICON} WhatsApp</span>` : ch === "email" ? `<span class="badge">✉️ Email</span>` : ch === "condivisione" ? `<span class="badge">📤 Condiviso</span>` : `<span class="badge">📩 SMS</span>`).join("");
      return `
      <div class="card color-purple" data-open-iniz="${r.id}" style="cursor:pointer;">
        <div class="card-row">
          <div>
            <div class="card-name">${esc(r.nome || "Iniziativa")}</div>
            <div class="card-sub">📅 ${r.data ? fmtDate(r.data) : "Data non indicata"}${r.ora ? " · 🕐 " + esc(r.ora) : ""}</div>
            ${r.luogo ? `<div class="card-sub">📍 ${esc(r.luogo)}</div>` : ""}
            <div class="badge-row" style="margin-top:6px;">${r.istituzionali ? `<span class="badge">🏛️ Istituzionali</span>` : ""}${r.feste ? `<span class="badge">🎉 Feste</span>` : ""}${r.volontariato ? `<span class="badge">🤝 Volontariato</span>` : ""}${r.fileNome ? `<span class="badge badge-icon" title="${esc(r.fileNome)}">📎</span>` : ""}${badgesCanali}</div>
          </div>
          <div class="card-actions">
            <button data-edit-iniz="${r.id}" onclick="event.stopPropagation()">✏️</button>
            <button data-del-iniz="${r.id}" onclick="event.stopPropagation()">🗑️</button>
          </div>
        </div>
      </div>`;
    }).join("");
  }

  return `
    <div class="section-title">🎉 Iniziative</div>

    <div class="card color-purple">
      <div style="font-weight:800; margin-bottom:10px;">Nuova Iniziativa</div>

      <div class="form-group"><label>Nome evento *</label><input type="text" id="iniz-nome" placeholder="Es. Festa di Primavera"></div>
      <div class="two-col">
        <div class="form-group"><label>Data</label><input type="date" id="iniz-data"></div>
        <div class="form-group"><label>Ora</label><input type="time" id="iniz-ora"></div>
      </div>
      <div class="form-group"><label>Luogo</label><input type="text" id="iniz-luogo"></div>
      <div class="form-group">
        <label>Categoria</label>
        <div class="checkbox-row" style="flex-wrap:wrap; row-gap:6px;">
          <label><input type="checkbox" id="iniz-istituzionali"> Istituzionali</label>
          <label><input type="checkbox" id="iniz-feste"> Feste</label>
          <label><input type="checkbox" id="iniz-volontariato"> Volontariato</label>
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
      <div class="card-sub" style="margin-top:10px;">"Condividi" apre la scelta app del telefono e include anche il file selezionato. Email va automaticamente a tutti gli indirizzi disponibili tra Anagrafica, Ringraziamenti e Sponsor. WhatsApp apre l'app: scegli tu i destinatari.</div>
    </div>

    <div class="section-title" style="font-size:1.05rem; margin-top:22px;">🗂️ Elenco Iniziative</div>
    ${storicoHtml}
  `;
}

function registraStoricoIniziativa(canale) {
  const nome = document.getElementById("iniz-nome").value.trim();
  const data = document.getElementById("iniz-data").value;
  const ora = document.getElementById("iniz-ora").value;
  const luogo = document.getElementById("iniz-luogo").value.trim();
  const descrizione = document.getElementById("iniz-descrizione").value.trim();
  const istituzionali = document.getElementById("iniz-istituzionali").checked;
  const feste = document.getElementById("iniz-feste").checked;
  const volontariato = document.getElementById("iniz-volontariato").checked;
  const fileInput = document.getElementById("iniz-file");
  const fileNome = fileInput.files[0] ? fileInput.files[0].name : "";

  state.iniziativeStorico = state.iniziativeStorico || [];
  let record = currentIniziativaId ? state.iniziativeStorico.find(r => r.id === currentIniziativaId) : null;
  if (!record) {
    record = { id: uid(), nome, data, ora, luogo, descrizione, istituzionali, feste, volontariato, fileNome, canali: [], creato: new Date().toISOString() };
    state.iniziativeStorico.push(record);
    currentIniziativaId = record.id;
  } else {
    record.nome = nome; record.data = data; record.ora = ora; record.luogo = luogo; record.descrizione = descrizione;
    record.istituzionali = istituzionali; record.feste = feste; record.volontariato = volontariato;
    if (fileNome) record.fileNome = fileNome;
  }
  if (canale && !record.canali.includes(canale)) record.canali.push(canale);
  saveState();
}

async function condividiIniziativa() {
  if (!document.getElementById("iniz-nome").value.trim()) { alert("Inserisci almeno il nome dell'evento"); return; }
  const testo = buildIniziativaTesto();
  const fileInput = document.getElementById("iniz-file");
  const file = fileInput.files[0];
  const shareData = { title: "Iniziativa Gruppo Alpini", text: testo };
  if (file) shareData.files = [file];

  if (!navigator.share) {
    alert("La condivisione diretta non è supportata su questo dispositivo/browser. Usa i pulsanti WhatsApp o Email qui sotto.");
    return;
  }
  if (file && navigator.canShare && !navigator.canShare({ files: [file] })) delete shareData.files;
  try {
    await navigator.share(shareData);
    registraStoricoIniziativa("condivisione");
    renderSection();
    toast("Condiviso e salvato");
  } catch (err) {
    if (err.name !== "AbortError") alert("Condivisione non riuscita.");
  }
}

function inviaIniziativaTesto(canale) {
  if (!document.getElementById("iniz-nome").value.trim()) { alert("Inserisci almeno il nome dell'evento"); return; }
  const testo = buildIniziativaTesto();
  const encoded = encodeURIComponent(testo);

  if (canale === "email") {
    const emails = getAllEmails();
    if (emails.length === 0) { alert("Nessun indirizzo email trovato in Anagrafica, Ringraziamenti o Sponsor."); return; }
    const subject = encodeURIComponent(document.getElementById("iniz-nome").value.trim() || "Iniziativa Gruppo Alpini");
    registraStoricoIniziativa(canale);
    window.location.href = `mailto:${emails.join(",")}?subject=${subject}&body=${encoded}`;
  } else {
    registraStoricoIniziativa(canale);
    window.open(`https://api.whatsapp.com/send?text=${encoded}`, "_blank");
  }
  renderSection();
  toast(canale === "email" ? "Aperta l'app email" : "Inviato su WhatsApp");
}

function caricaIniziativaNelForm(r) {
  currentIniziativaId = r.id;
  document.getElementById("iniz-nome").value = r.nome || "";
  document.getElementById("iniz-data").value = r.data || "";
  document.getElementById("iniz-ora").value = r.ora || "";
  document.getElementById("iniz-luogo").value = r.luogo || "";
  document.getElementById("iniz-istituzionali").checked = !!r.istituzionali;
  document.getElementById("iniz-feste").checked = !!r.feste;
  document.getElementById("iniz-volontariato").checked = !!r.volontariato;
  document.getElementById("iniz-descrizione").value = r.descrizione || "";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function attachIniziativeEvents() {
  currentIniziativaId = null;
  document.getElementById("iniz-save-btn").addEventListener("click", () => {
    if (!document.getElementById("iniz-nome").value.trim()) { alert("Inserisci almeno il nome dell'evento"); return; }
    registraStoricoIniziativa(null);
    renderSection();
    toast("Iniziativa salvata");
  });
  document.getElementById("iniz-share-btn").addEventListener("click", condividiIniziativa);
  document.getElementById("iniz-wa-btn").addEventListener("click", () => inviaIniziativaTesto("whatsapp"));
  document.getElementById("iniz-email-btn").addEventListener("click", () => inviaIniziativaTesto("email"));

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
      toast("Iniziativa eliminata");
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
      const html = `
        <div class="modal-title">🎉 ${esc(r.nome || "Iniziativa")}</div>
        <div class="card-sub" style="margin-bottom:8px;">📅 ${r.data ? fmtDate(r.data) : "Data non indicata"}${r.ora ? " · 🕐 " + esc(r.ora) : ""}</div>
        ${r.luogo ? `<div class="card-sub" style="margin-bottom:8px;">📍 ${esc(r.luogo)}</div>` : ""}
        ${r.descrizione ? `<div class="card-sub" style="white-space:pre-wrap; margin-bottom:12px;">📝 ${esc(r.descrizione)}</div>` : ""}
        ${r.fileNome ? `<div class="card-sub" style="margin-bottom:12px;">📎 ${esc(r.fileNome)}</div>` : ""}
        <button type="button" class="btn secondary block" id="iniz-detail-close">Chiudi</button>
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

  const iniziativaOpts = iniziative.map(i => `<option value="${i.id}" ${selectedOreIniziativaId===i.id?"selected":""}>${esc(i.nome || "Iniziativa")}${i.data ? " - " + fmtDate(i.data) : ""}</option>`).join("");

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
    eventiHtml = `<div class="empty-state"><div class="icon">⏱️</div>Nessuna iniziativa salvata.<br><span style="font-size:0.8rem;">Vai nella sezione Iniziative per crearne una.</span></div>`;
  } else {
    eventiHtml = iniziative.map(i => {
      const map = (state.oreAlpine && state.oreAlpine[i.id]) || {};
      const tot = Math.round(Object.values(map).reduce((s, v) => s + (parseFloat(v) || 0), 0) * 10) / 10;
      return `
      <div class="card color-gold">
        <div class="card-row">
          <div style="cursor:pointer;" data-select-iniziativa="${i.id}">
            <div class="card-name">${esc(i.nome || "Iniziativa")}</div>
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
      <div style="font-weight:800; margin-bottom:10px;">Registra ore per iniziativa</div>
      <div class="form-group">
        <label>Iniziativa</label>
        <select id="ore-iniziativa-select">
          <option value="">-- seleziona iniziativa --</option>
          ${iniziativaOpts}
        </select>
      </div>
      ${selectedOreIniziativaId ? `
        <div style="margin-top:10px;">${rosterHtml}</div>
        <button class="btn block" id="ore-save-btn" style="margin-top:12px;">Salva ore</button>
      ` : `<div class="card-sub">Seleziona un'iniziativa per inserire le ore lavorate.</div>`}
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

  const sociosSorted = state.socios.filter(s => s.carica !== "Simpatizzante" && s.carica !== "Amici").slice().sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));
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

  const sociosSorted = state.socios.filter(s => s.carica === "Simpatizzante").slice().sort((a,b) => (a.cognome+a.nome).localeCompare(b.cognome+b.nome));
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
  const html = `
    <div class="modal-title">⚙️ Impostazioni</div>

    <div class="settings-block">
      <h3>Info dispositivo</h3>
      <div class="card-sub">Connesso come: <strong>${esc(userLabel(currentUser))}</strong> <button type="button" id="change-user-btn" class="btn secondary" style="padding:2px 10px; font-size:0.75rem; margin-left:6px;">Cambia</button></div>
      <div class="card-sub">Ultima modifica: <strong>${esc(userLabel(state.meta && state.meta.ultimaModificaDa))}</strong> il <strong>${fmtDateTime(state.meta && state.meta.ultimaModifica)}</strong></div>
      <div class="card-sub">Ultimo backup importato: <strong>${fmtDateTime(state.meta && state.meta.ultimoImport)}</strong></div>
      <div class="card-sub" style="color:${window.db ? "#1a6b3c" : "#b33"};">${window.db ? "☁️ Sincronizzazione Firebase attiva" : "⚠️ Firebase non configurato (dati solo su questo dispositivo)"}</div>
    </div>

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

    <div class="modal-actions">
      <button type="button" class="btn secondary" id="cancel-settings">Chiudi</button>
      <button type="button" class="btn" id="save-settings">Salva</button>
    </div>
  `;
  showModal(html);
  document.getElementById("cancel-settings").addEventListener("click", closeModal);
  document.getElementById("save-settings").addEventListener("click", saveSettings);
  document.getElementById("set-logo").addEventListener("change", handleLogoUpload);
  document.getElementById("backup-btn").addEventListener("click", doBackup);
  document.getElementById("restore-btn").addEventListener("click", () => {
    document.getElementById("restore-input").click();
  });
  document.getElementById("restore-input").addEventListener("change", handleRestore);
  document.getElementById("reset-bollino-btn").addEventListener("click", resetBollino);
  document.getElementById("import-excel").addEventListener("change", handleExcelImport);
  document.getElementById("change-user-btn").addEventListener("click", () => {
    localStorage.removeItem("gestione_gruppo_user");
    currentUser = null;
    closeModal();
    showLoginScreen(() => { updateTopbar(); });
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

function saveSettings() {
  state.settings.appName = document.getElementById("set-appname").value.trim() || "Gestione Gruppo";
  state.settings.quotaBollino = parseFloat(document.getElementById("set-quota").value) || 0;
  state.settings.quotaNazionale = parseFloat(document.getElementById("set-quota-nazionale").value) || 0;
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

async function condividiReportComePdf(titolo, headers, rows) {
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
  const rigaHtml = cells => `<tr>${cells.map(c => `<td style="padding:6px; border-bottom:1px solid #ddd; font-family:Arial,sans-serif; font-size:13px;">${c}</td>`).join("")}</tr>`;

  try {
    // --- misuro le altezze reali (carta intestata, riga intestazione colonne, riga dato) ---
    const misura = document.createElement("div");
    misura.style.cssText = `width:${CONTENT_W}px; background:#fff;`;
    misura.innerHTML = `
      <div id="misura-letterhead">${LETTERHEAD_HTML}</div>
      <table style="width:100%; border-collapse:collapse;">
        <tbody>
          <tr id="misura-thead">${headerRowHtml}</tr>
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
          <thead><tr>${headerRowHtml}</tr></thead>
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

function apriAnteprimaReportGenerico(titolo, headers, rows, testoRighe) {
  if (rows.length === 0) {
    alert("Nessun risultato per i filtri selezionati.");
    return;
  }
  const headerHtml = headers.map(h => `<th style="text-align:left; padding:6px;">${esc(h)}</th>`).join("");
  const headerHtmlPrint = headers.map(h => `<th style="text-align:left; border-bottom:2px solid #000; padding:6px;">${esc(h)}</th>`).join("");
  const righeHtml = rows.map(cells => `<tr>${cells.map(c => `<td style="padding:6px; border-bottom:1px solid #ddd;">${c}</td>`).join("")}</tr>`).join("");
  const html = `
    <div class="modal-title">🖨️ Anteprima — ${esc(titolo)}</div>
    <div class="card-sub" style="margin-bottom:12px;">${rows.length} righe — generato il ${fmtDateTime(new Date().toISOString())}</div>
    <div style="max-height:50vh; overflow-y:auto; border:2px solid var(--ink); border-radius:10px; margin-bottom:16px;">
      <table style="width:100%; border-collapse:collapse; font-size:0.82rem;">
        <thead><tr style="background:#f7f3e8;">${headerHtml}</tr></thead>
        <tbody>${righeHtml}</tbody>
      </table>
    </div>
    <button type="button" class="btn block" id="anteprima-stampa-btn" style="margin-bottom:10px;">🖨️ Stampa</button>
    <button type="button" class="btn block" id="anteprima-pdf-btn" style="margin-bottom:10px; background:var(--gold);">📄 Condividi come PDF</button>
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
    area.innerHTML = `
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr><td colspan="${nCol}" style="padding:0;">${LETTERHEAD_HTML}</td></tr>
          <tr>${headerHtmlPrint}</tr>
        </thead>
        <tbody>${righeHtml}</tbody>
      </table>
    `;
    stampaConLoghi(area);
  });

  document.getElementById("anteprima-pdf-btn").addEventListener("click", () => {
    condividiReportComePdf(titolo, headers, rows);
  });

  const testoPiano = () => `📋 ${titolo}\n${rows.length} righe\n\n` + testoRighe.join("\n");
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
  { id: "anniNaja", label: "Anni naja", get: s => s.anniNaja || "" },
  { id: "incaricoFeste", label: "Incarico feste", get: s => s.incaricoFeste || "" },
  { id: "privacy", label: "Privacy firmata", get: s => s.privacy ? "Sì" : "No" },
  { id: "haccp", label: "HACCP", get: s => s.haccp ? "Sì" : "No" },
  { id: "sms", label: "SMS", get: s => s.sms ? "Sì" : "No" },
  { id: "whatsapp", label: "WhatsApp", get: s => s.whatsapp ? "Sì" : "No" },
  { id: "note", label: "Note", get: s => s.note || "" },
];
const REPORT1_DEFAULT = ["cognome", "nome", "matricola", "telefono", "cellulare"];

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
        <div class="form-group"><label>Privacy</label><select id="rep1-privacy"><option value="">Tutti</option><option value="si">Sì</option><option value="no">No</option></select></div>
      </div>
      <div class="form-group">
        <label>HACCP</label>
        <select id="rep1-haccp"><option value="">Tutti</option><option value="si">Sì</option><option value="no">No</option></select>
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
  `;
}

function attachReport1Events() {
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
    const haccpFiltro = document.getElementById("rep1-haccp").value;
    const colonneIds = Array.from(document.querySelectorAll(".rep1-col:checked")).map(el => el.value);
    if (colonneIds.length === 0) { alert("Seleziona almeno una colonna."); return; }
    if (caricheSelezionate.length === 0) { alert("Seleziona almeno una categoria."); return; }
    let list = state.socios.slice();
    if (socioId) list = list.filter(s => s.id === socioId);
    if (caricheSelezionate.length < CARICHE.length) list = list.filter(s => caricheSelezionate.includes(s.carica));
    if (provincia) list = list.filter(s => (s.provincia || "").toUpperCase() === provincia);
    if (privacyFiltro === "si") list = list.filter(s => s.privacy);
    if (privacyFiltro === "no") list = list.filter(s => !s.privacy);
    if (haccpFiltro === "si") list = list.filter(s => s.haccp);
    if (haccpFiltro === "no") list = list.filter(s => !s.haccp);
    list.sort((a, b) => (a.cognome + a.nome).localeCompare(b.cognome + b.nome));
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
        <div class="form-group"><label>Iniziativa</label><select id="rep2-iniziativa"><option value="">Tutte (classifica generale)</option>${iniziativeOpts}</select></div>
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
const SECTION_ORDER = ["home","anagrafica","conv-consiglio","bollino","bollino-amici","ringraziamenti","sponsor","iniziative","ore-alpine","report","report2","conv-primavera","conv-alpina","conv-casoncellata","presenza-adunata","cassa"];

function vaiASezione(section) {
  currentSection = section;
  searchTerm = ""; filterCarica = "";
  lastScroll = 0;
  window.scrollTo(0, 0);
  renderSection();
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
    const idx = SECTION_ORDER.indexOf(currentSection);
    if (idx === -1) return;
    if (dx < 0 && idx < SECTION_ORDER.length - 1) {
      vaiASezione(SECTION_ORDER[idx + 1]);
    } else if (dx > 0 && idx > 0) {
      vaiASezione(SECTION_ORDER[idx - 1]);
    }
  }, { passive: true });
}

function init() {
  loadState();
  if (!currentUser) {
    showLoginScreen(startApp);
  } else {
    startApp();
  }
}

function startApp() {
  updateTopbar();
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => vaiASezione(btn.dataset.section));
  });
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("modal-overlay").addEventListener("click", e => {
    if (e.target.id === "modal-overlay") { closeModal(); currentConvocazioneId = null; renderSection(); }
  });
  setupScrollHide();
  setupSwipeNav();
  renderSection();
  initFirebaseSync();

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
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
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
    if (worker) worker.postMessage({ type: "SKIP_WAITING" });
    // Ricarica comunque entro pochi secondi, anche se per qualche motivo
    // il nuovo service worker non prende il controllo subito.
    setTimeout(() => window.location.reload(), 2500);
  });
}

document.addEventListener("DOMContentLoaded", init);
