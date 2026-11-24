const { onRequest } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();

const db = getFirestore();
const ADMIN_UID = "89slmmfD1FQdOmwbdPna1lqXIVH2";

const statuts = {
  supporter: {
    texte: "SUPPORTER ESIVO",
    fond: "#E5BD37",
    couleur: "#19191D"
  },
  "licencie-esivo": {
    texte: "LICENCIÉ AU CLUB ESIVO",
    fond: "#AA1A24",
    couleur: "#FFFFFF"
  },
  "licencie-autre": {
    texte: "LICENCIÉ D'UN AUTRE CLUB",
    fond: "#269B59",
    couleur: "#FFFFFF"
  }
};

async function recupererTousLesComptes() {
  const comptes = [];
  let pageToken;

  do {
    const page = await getAuth().listUsers(1000, pageToken);
    comptes.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);

  return comptes.sort((a, b) =>
    new Date(a.metadata.creationTime).getTime() -
    new Date(b.metadata.creationTime).getTime()
  );
}

exports.listerMembresPublics = onRequest(
  {
    region: "europe-west1",
    cors: true,
    maxInstances: 5
  },
  async (req, res) => {
    res.set("Cache-Control", "public, max-age=60, s-maxage=60");

    if (req.method !== "GET") {
      return res.status(405).json({ error: "Méthode non autorisée." });
    }

    try {
      const comptes = await recupererTousLesComptes();
      const total = comptes.length;
      const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
      const limiteDemandee = Number.parseInt(req.query.limit, 10) || 24;
      const limite = Math.min(48, Math.max(1, limiteDemandee));
      const comptesPage = comptes.slice(offset, offset + limite);
      const dernierCompte = comptes[comptes.length - 1] || null;

      const uids = [...new Set([
        ...comptesPage.map(compte => compte.uid),
        ...(dernierCompte ? [dernierCompte.uid] : [])
      ])];

      const references = uids.map(uid => db.collection("profils_publics").doc(uid));
      const documents = references.length ? await db.getAll(...references) : [];
      const profils = new Map(
        documents
          .filter(document => document.exists)
          .map(document => [document.id, document.data()])
      );

      const formaterMembre = compte => {
        const profil = profils.get(compte.uid) || {};
        const afficherNomPrenom = profil.afficherNomPrenom === true;
        const badge = compte.uid === ADMIN_UID
          ? {
              texte: "FONDATEUR DU SITE ESIVO",
              fond: "#2687E8",
              couleur: "#FFFFFF"
            }
          : (statuts[profil.statut] || statuts.supporter);

        return {
          uid: compte.uid,
          pseudo: String(profil.pseudo || compte.displayName || "Membre ESIVO").slice(0, 40),
          photo: profil.photoDataUrl || compte.photoURL || "",
          prenom: afficherNomPrenom ? String(profil.prenom || "") : "",
          nom: afficherNomPrenom ? String(profil.nom || "") : "",
          afficherNomPrenom,
          badge,
          dateInscription: compte.metadata.creationTime
        };
      };

      return res.status(200).json({
        total,
        offset,
        limit: limite,
        hasMore: offset + comptesPage.length < total,
        dernierInscrit: dernierCompte ? formaterMembre(dernierCompte) : null,
        membres: comptesPage.map(formaterMembre)
      });
    } catch (erreur) {
      console.error("Erreur annuaire public ESIVO :", erreur);
      return res.status(500).json({
        error: "Impossible de charger la liste des membres."
      });
    }
  }
);
