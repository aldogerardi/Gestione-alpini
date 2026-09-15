// ===================== Configurazione Firebase =====================
// ISTRUZIONI:
// 1) Vai su https://console.firebase.google.com e crea un NUOVO progetto
//    (separato da quello del ciclismo), es. "gestione-alpini".
// 2) Dentro il progetto: Impostazioni progetto (⚙️) > Generali > "Le tue app"
//    > icona "</>" (Web) > registra l'app > copia l'oggetto firebaseConfig
//    che ti viene mostrato e incollalo qui sotto al posto di quello finto.
// 3) Nel menu a sinistra vai su "Firestore Database" > Crea database >
//    scegli "Avvia in modalità di produzione" (le regole le mettiamo sotto).
// 4) Nel menu a sinistra vai su "Storage" > Crea (stesso discorso regole).
// 5) In Firestore, scheda "Regole", incolla:
//
//    rules_version = '2';
//    service cloud.firestore {
//      match /databases/{database}/documents {
//        match /gestioneGruppo/{docId} {
//          allow read, write: if true;
//        }
//      }
//    }
//
// 6) In Storage, scheda "Regole", incolla:
//
//    rules_version = '2';
//    service firebase.storage {
//      match /b/{bucket}/o {
//        match /{allPaths=**} {
//          allow read, write: if true;
//        }
//      }
//    }
//
// NOTA IMPORTANTE: con "allow read, write: if true" chiunque conosca
// l'indirizzo del tuo progetto Firebase può leggere/modificare i dati
// (non c'è login/password, come richiesto). È lo stesso livello di
// protezione di un link "chiunque abbia il link" - va bene per un
// gruppo ristretto e fidato come il vostro, ma tienilo a mente.

const firebaseConfig = {
  apiKey: "AIzaSyBYE2ag1gA8Kxan2zwDM1bMQPfNF_-gPbg",
  authDomain: "gestione-alpini.firebaseapp.com",
  projectId: "gestione-alpini",
  storageBucket: "gestione-alpini.firebasestorage.app",
  messagingSenderId: "883117994872",
  appId: "1:883117994872:web:fec7caaea032380b110e8d"
};

let db = null;
let storage = null;

try {
  if (firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("INSERISCI")) {
    firebase.initializeApp(firebaseConfig);
    window.db = firebase.firestore();
    window.storage = firebase.storage();
    db = window.db;
    storage = window.storage;
    // Persistenza offline: l'app continua a funzionare anche senza rete
    // e si risincronizza da sola appena torna la connessione.
    db.enablePersistence({ synchronizeTabs: true }).catch(err => {
      console.warn("Persistenza offline Firestore non attiva:", err.code);
    });
  } else {
    console.warn("Firebase non configurato: inserisci i tuoi dati in firebase-config.js. L'app funzionerà solo in locale su questo dispositivo.");
  }
} catch (e) {
  console.error("Errore inizializzazione Firebase", e);
}
