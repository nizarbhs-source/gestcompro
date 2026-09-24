import express from "express";
import multer from "multer";
import cors from "cors";
import { GoogleGenAI, Type } from "@google/genai";
import "dotenv/config";

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 Mo — même limite que côté client GestComPro
});

// CORS : origine configurable via ALLOWED_ORIGIN (ex: "https://mon-gestcompro.exemple.tn"). Laissé
// ouvert (*) par défaut tant que cette variable n'est pas définie — le vrai verrou d'accès reste la
// clé X-App-Api-Key (voir verifierAuthApplicative plus bas), que CORS ne remplace pas : CORS bloque
// seulement les appels faits DEPUIS un navigateur, pas depuis un script/curl qui connaîtrait la clé.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";
if (!ALLOWED_ORIGIN) {
  console.warn("⚠️  ALLOWED_ORIGIN non définie — CORS reste ouvert à toute origine (*). Définissez-la une fois votre domaine GestComPro connu pour restreindre l'accès.");
}
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : {}));
app.use(express.json());
app.use("/api/ttn", express.text({ type: "*/*", limit: "5mb" })); // le XML TEIF non signé arrive en corps brut, pas en JSON

// Limitation de débit minimaliste (sans dépendance externe non vérifiable ici) : compteur glissant en
// mémoire par IP. Suffisant pour un usage mono-entreprise ; ne survit pas à un redémarrage ni à
// plusieurs instances du serveur — pour un usage à plus grande échelle, préférer un vrai middleware
// dédié (express-rate-limit) avec un store partagé (Redis).
const COMPTEURS_REQUETES = new Map(); // ip -> [timestamps]
function limiterDebit(maxParMinute) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || "inconnu";
    const maintenant = Date.now();
    const fenetre = 60_000;
    const historique = (COMPTEURS_REQUETES.get(ip) || []).filter(t => maintenant - t < fenetre);
    if (historique.length >= maxParMinute) {
      return res.status(429).json({ ok: false, success: false, message: "Trop de requêtes — réessayez dans une minute." });
    }
    historique.push(maintenant);
    COMPTEURS_REQUETES.set(ip, historique);
    next();
  };
}
app.use("/api", limiterDebit(30)); // 30 requêtes/minute/IP sur toutes les routes — ajustable si besoin

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const MODELE = process.env.GEMINI_MODEL || "gemini-2.5-flash";
if (!GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY absente des variables d'environnement — /api/capture échouera tant qu'elle n'est pas définie.");
}
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

/* ===================== Schéma de réponse strict =====================
   IMPORTANT : ce schéma — et les noms de champs qu'il produit — doit rester identique à ce
   qu'attend GestComPro côté client (fonction traiterReponseIA() dans index.html). Le front-end a déjà
   tout son écran de vérification, son rapprochement fournisseur/article et ses contrôles automatiques
   câblés sur cette forme exacte de JSON. Si vous renommez un champ ici, renommez-le aussi côté client,
   sinon l'extraction arrivera dans l'app mais les champs resteront vides. */
const schemaExtraction = {
  type: Type.OBJECT,
  properties: {
    typeDocument: { type: Type.STRING, description: "facture_fournisseur, cheque, traite ou inconnu" },
    fournisseurNom: { type: Type.STRING },
    fournisseurMatriculeFiscal: { type: Type.STRING, description: "Format tunisien : 7 chiffres + 3 lettres/chiffres, ex 1234567ABM000" },
    numeroFacture: { type: Type.STRING, description: "Numéro de la facture, ou du chèque/de la traite selon le type de document" },
    dateFacture: { type: Type.STRING, description: "Date d'émission, format AAAA-MM-JJ" },
    dateEcheance: { type: Type.STRING, description: "Format AAAA-MM-JJ, vide si non applicable" },
    devise: { type: Type.STRING },
    lignes: {
      type: Type.ARRAY,
      description: "Lignes d'articles — vide pour un chèque ou une traite",
      items: {
        type: Type.OBJECT,
        properties: {
          designation: { type: Type.STRING },
          reference: { type: Type.STRING },
          quantite: { type: Type.NUMBER },
          prixUnitaireHT: { type: Type.NUMBER },
          tauxTVA: { type: Type.NUMBER },
          remise: { type: Type.NUMBER },
        },
      },
    },
    totalHT: { type: Type.NUMBER },
    totalTVA: { type: Type.NUMBER },
    totalTTC: { type: Type.NUMBER, description: "Pour un chèque/une traite : le montant" },
    contientFODEC: { type: Type.BOOLEAN, description: "true si une ligne \"FODEC\" (1% en général) apparaît explicitement dans le total du document — jamais déduite, uniquement si le mot FODEC ou son montant est visible" },
    montantFODEC: { type: Type.NUMBER, description: "Montant de la ligne FODEC si contientFODEC est true, sinon 0" },
    banque: { type: Type.STRING },
    beneficiaire: { type: Type.STRING },
    tireur: { type: Type.STRING },
    confiances: {
      type: Type.OBJECT,
      description: "Niveau de confiance par champ : haute, moyenne ou faible",
      properties: {
        fournisseurNom: { type: Type.STRING },
        numeroFacture: { type: Type.STRING },
        dateFacture: { type: Type.STRING },
        dateEcheance: { type: Type.STRING },
        totalTTC: { type: Type.STRING },
      },
    },
  },
  required: ["typeDocument"],
};

const promptExtraction = `Tu es un assistant de saisie comptable pour une entreprise tunisienne (GestComPro).
Analyse le document fourni (facture fournisseur, chèque, ou traite/lettre de change) et remplis le schéma JSON demandé, en respectant strictement les noms de champs fournis.
Règles impératives :
- N'invente JAMAIS une valeur absente du document : laisse le champ vide ("" ou 0) et une confiance "faible" plutôt que de deviner.
- Si le document est un chèque ou une traite : remplis "numeroFacture" (numéro du chèque/de la traite), "dateFacture" (date d'émission), "dateEcheance" (échéance, traite uniquement), "totalTTC" (montant), "banque", "beneficiaire" et/ou "tireur" ; laisse "lignes" vide.
- Le matricule fiscal tunisien est 7 chiffres + 3 lettres/chiffres (ex: 1234567ABM000) — ne le confonds jamais avec un numéro de téléphone ou de registre de commerce.
- Les nombres utilisent un point décimal, jamais de virgule ni de séparateur de milliers.
- FODEC : ne coche "contientFODEC" que si une ligne "FODEC" (ou son montant, généralement ~1% du HT) est EXPLICITEMENT visible dans le détail des totaux du document — ne le déduis jamais du type de produit ou d'une supposition.`;

app.post("/api/capture", verifierAuthApplicative, upload.single("document"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: "Aucun fichier reçu (champ 'document' attendu)." });
    }
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ success: false, error: "GEMINI_API_KEY non configurée côté serveur — voir README_DEPLOIEMENT.md." });
    }

    const filePart = {
      inlineData: {
        data: req.file.buffer.toString("base64"),
        mimeType: req.file.mimetype,
      },
    };

    const response = await ai.models.generateContent({
      model: MODELE,
      contents: [{ text: promptExtraction }, filePart],
      config: {
        temperature: 0.1, // légère marge, jamais 0 strict — évite les réponses vides répétées observées sur certains documents ambigus
        responseMimeType: "application/json",
        responseSchema: schemaExtraction,
      },
    });

    const data = JSON.parse(response.text);
    res.json({ success: true, data });
  } catch (err) {
    console.error("Erreur d'extraction Gemini :", err);
    res.status(500).json({
      success: false,
      error: "Échec de l'analyse IA : " + (err && err.message ? err.message : "erreur inconnue"),
    });
  }
});

// Point de contrôle simple pour vérifier que le serveur tourne et que la clé est bien chargée
// (sans jamais révéler la clé elle-même) — utile pour diagnostiquer un déploiement.
app.get("/api/health", (req, res) => {
  res.json({ ok: true, modele: MODELE, cleConfiguree: !!GEMINI_API_KEY, ttnConfigure: !!(EL_FATOORA_ENDPOINT && SIGNATURE_ENDPOINT) });
});

/* ===================== Relais TTN / El Fatoora — signature XAdES-BES + dépôt =====================
   Implémente exactement l'architecture déjà documentée dans GestComPro elle-même (Paramètres > El
   Fatoora > "Télécharger la note d'architecture") : le navigateur n'envoie plus que le XML TEIF non
   signé (donnée non sensible en soi) et une clé d'API interne à l'application (PAS un secret TTN) ;
   ce serveur, seul, détient le mot de passe El Fatoora et le jeton de signature XAdES-BES, en
   variables d'environnement — jamais dans le navigateur ni dans l'APK Android.
   ⚠️ Comme le rappelle déjà l'application : le format exact du webservice de dépôt El Fatoora n'est
   pas documenté publiquement de façon fiable. Ce relais reproduit fidèlement ce que GestComPro
   fait déjà côté navigateur (mêmes fonctions signerXmlTEIF/transmettreFactureTTN/verifierStatutTTN,
   juste déplacées ici) — à faire valider par TTN/votre prestataire avant tout envoi réel, comme pour
   la version navigateur. */
const EL_FATOORA_ENDPOINT = process.env.EL_FATOORA_ENDPOINT || "";
const EL_FATOORA_ENDPOINT_STATUT = process.env.EL_FATOORA_ENDPOINT_STATUT || "";
const EL_FATOORA_LOGIN = process.env.EL_FATOORA_LOGIN || "";
const EL_FATOORA_PASSWORD = process.env.EL_FATOORA_PASSWORD || "";
const SIGNATURE_ENDPOINT = process.env.SIGNATURE_ENDPOINT || "";
const SIGNATURE_TOKEN = process.env.SIGNATURE_TOKEN || "";
const APP_API_KEY = process.env.APP_API_KEY || "";
if (!EL_FATOORA_ENDPOINT || !SIGNATURE_ENDPOINT) {
  console.warn("⚠️  Variables El Fatoora/signature absentes — /api/ttn/* échouera tant qu'elles ne sont pas définies.");
}
if (!APP_API_KEY) {
  console.warn("⚠️  APP_API_KEY absente — /api/ttn/* refusera toute requête tant qu'elle n'est pas définie (voir .env.example).");
}

// Authentification applicative interne (PAS un secret TTN) : protège juste l'accès à ce relais.
function verifierAuthApplicative(req, res, next) {
  const cle = req.header("X-App-Api-Key");
  if (!APP_API_KEY || cle !== APP_API_KEY) return res.status(401).json({ ok: false, message: "Non autorisé (X-App-Api-Key manquante ou incorrecte)." });
  next();
}

// Extraction simple par expression régulière plutôt qu'un vrai parseur XML : suffisant pour les
// quelques balises attendues (NumeroSuivi/Statut/Erreur/Fault), et évite une dépendance
// supplémentaire pour un format de réponse que TTN ne documente de toute façon pas officiellement
// (même limite, déjà assumée, que le code navigateur existant — voir transmettreFactureTTN()).
function extraireBalise(xml, nom) {
  const m = xml.match(new RegExp(`<${nom}[^>]*>([\\s\\S]*?)</${nom}>`, "i"));
  return m ? m[1].trim() : null;
}

app.post("/api/ttn/signer-et-envoyer", verifierAuthApplicative, async (req, res) => {
  try {
    const xmlNonSigne = req.body;
    if (!xmlNonSigne || typeof xmlNonSigne !== "string" || !xmlNonSigne.trim()) {
      return res.status(400).json({ ok: false, message: "Corps de requête vide (XML TEIF non signé attendu)." });
    }
    if (!EL_FATOORA_ENDPOINT || !SIGNATURE_ENDPOINT) {
      return res.status(500).json({ ok: false, message: "Relais TTN non configuré côté serveur (variables d'environnement manquantes)." });
    }

    // 1) Signature XAdES-BES via le service TunTrust/DigiGo configuré
    let xmlSigne;
    try {
      const repSignature = await fetch(SIGNATURE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/xml; charset=utf-8", "Authorization": `Bearer ${SIGNATURE_TOKEN}` },
        body: xmlNonSigne,
      });
      if (!repSignature.ok) {
        const detail = await repSignature.text().catch(() => "");
        return res.status(502).json({ ok: false, message: `Échec de signature électronique (HTTP ${repSignature.status})${detail ? " — " + detail.slice(0, 300) : ""}.` });
      }
      xmlSigne = await repSignature.text();
    } catch (err) {
      return res.status(502).json({ ok: false, message: "Service de signature injoignable : " + err.message });
    }

    // 2) Dépôt SOAP à El Fatoora (TTN)
    const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const enveloppeSoap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
  <soapenv:Header>
    <Authentification>
      <Identifiant>${esc(EL_FATOORA_LOGIN)}</Identifiant>
      <MotDePasse>${esc(EL_FATOORA_PASSWORD)}</MotDePasse>
    </Authentification>
  </soapenv:Header>
  <soapenv:Body>
    <DeposerFacture><FichierXML><![CDATA[${xmlSigne}]]></FichierXML></DeposerFacture>
  </soapenv:Body>
</soapenv:Envelope>`;

    let texteReponse;
    try {
      const repTTN = await fetch(EL_FATOORA_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", "SOAPAction": "DeposerFacture" },
        body: enveloppeSoap,
      });
      texteReponse = await repTTN.text();
    } catch (err) {
      // Cas ambigu : si la coupure survient après réception par la TTN mais avant la réponse, on ne
      // peut pas savoir si le document a malgré tout été reçu — même limite honnête que côté
      // navigateur (voir envoyerFactureTTN() dans index.html).
      return res.status(502).json({ ok: false, ambigu: true, message: "Transmission à la TTN impossible : " + err.message + " Si cette erreur survient après une coupure réseau, le document a peut-être tout de même été reçu par la TTN — vérifiez sur le portail El Fatoora avant de retransmettre." });
    }

    const erreur = extraireBalise(texteReponse, "Erreur") || extraireBalise(texteReponse, "Fault");
    if (erreur) {
      return res.json({ ok: true, succes: false, statut: "REJETE", message: erreur });
    }
    res.json({
      ok: true,
      succes: true,
      numeroSuivi: extraireBalise(texteReponse, "NumeroSuivi"),
      statut: extraireBalise(texteReponse, "Statut") || "EN_ATTENTE",
    });
  } catch (err) {
    console.error("Erreur relais TTN (signer-et-envoyer) :", err);
    res.status(500).json({ ok: false, message: err.message || "Erreur inconnue." });
  }
});

app.get("/api/ttn/statut", verifierAuthApplicative, async (req, res) => {
  try {
    const numeroSuivi = req.query.numeroSuivi;
    if (!numeroSuivi) return res.status(400).json({ ok: false, message: "Paramètre numeroSuivi manquant." });
    if (!EL_FATOORA_ENDPOINT_STATUT) return res.status(500).json({ ok: false, message: "EL_FATOORA_ENDPOINT_STATUT non configuré côté serveur." });
    const headers = {};
    if (EL_FATOORA_LOGIN) headers["Authorization"] = "Basic " + Buffer.from(`${EL_FATOORA_LOGIN}:${EL_FATOORA_PASSWORD}`).toString("base64");
    const repTTN = await fetch(`${EL_FATOORA_ENDPOINT_STATUT}?numeroSuivi=${encodeURIComponent(numeroSuivi)}`, { headers });
    if (!repTTN.ok) return res.status(502).json({ ok: false, message: `Vérification de statut impossible (HTTP ${repTTN.status}).` });
    const data = await repTTN.json();
    res.json({ ok: true, statut: data && data.statut ? data.statut : null, brut: data });
  } catch (err) {
    console.error("Erreur relais TTN (statut) :", err);
    res.status(500).json({ ok: false, message: err.message || "Erreur inconnue." });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GestComPro — backend IA démarré sur le port ${PORT} (modèle : ${MODELE})`);
});
