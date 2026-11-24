/* ESIVO — module des pronostics (version initiale) */
(() => {
  const db = () => window.esivoDb;
  const auth = () => window.esivoAuth;
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  })[c]);
  const dateHeure = match => {
    const heure = /^\d{1,2}:\d{2}$/.test(match.heure || "") ? match.heure : "12:00";
    return new Date((match.date || "") + "T" + heure + ":00");
  };
  const dateFR = value => value?.toLocaleDateString("fr-FR", {
    weekday:"long",day:"numeric",month:"long",year:"numeric"
  }) || "Date à confirmer";
  const norm = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toLowerCase().trim();
  const pseudoUtilisateur = async user => {
    if (user.displayName) return user.displayName.slice(0,20);
    try {
      const doc = await db().collection("membres").doc(user.uid).get();
      const data = doc.exists ? doc.data() : {};
      return String(data.pseudo || data.prenom || data.nom || "Membre").slice(0,20);
    } catch (_) { return "Membre"; }
  };
  const poisson = (lambda, k) => {
    let p = Math.exp(-lambda);
    for (let i=1;i<=k;i++) p *= lambda/i;
    return p;
  };
  const calculerProbabilites = (lambdaHome, lambdaAway) => {
    let home=0, draw=0, away=0;
    for(let h=0;h<=8;h++) for(let a=0;a<=8;a++) {
      const p=poisson(lambdaHome,h)*poisson(lambdaAway,a);
      if(h>a) home+=p; else if(h===a) draw+=p; else away+=p;
    }
    const total=home+draw+away || 1;
    return [home/total,draw/total,away/total];
  };
  const cotesDepuisClassement = async (match) => {
    const version = "poisson-v2";
    const equipeESIVO = nomClubPronostic(match.equipe);
    const normaliserNom = value => norm(value).replace(/[^a-z0-9]/g, "");
    const estESIVO = club => {
      const nom = normaliserNom(club?.equipe);
      const cible = normaliserNom(equipeESIVO);
      if (nom === cible) return true;
      // Certains classements enregistrent simplement le club sous le nom ESIVO.
      return cible === "esivo" && nom === "esivo";
    };

    const statistiques = club => {
      if (!club) return null;
      const joues = Math.max(0, Number(club.joues) || 0);
      const victoires = Math.max(0, Number(club.victoires) || 0);
      const nuls = Math.max(0, Number(club.nuls) || 0);
      const defaites = Math.max(0, Number(club.defaites) || 0);
      const matchsComptes = Math.max(joues, victoires + nuls + defaites);
      if (!matchsComptes) return null;
      const butsPour = Math.max(0, Number(club.butsPour) || 0);
      const butsContre = Math.max(0, Number(club.butsContre) || 0);
      const points = Number.isFinite(Number(club.points))
        ? Number(club.points)
        : victoires * 3 + nuls;
      const difference = Number.isFinite(Number(club.difference))
        ? Number(club.difference)
        : butsPour - butsContre;
      return {
        position: Math.max(1, Number(club.position) || 1),
        joues: matchsComptes, victoires, nuls, defaites,
        butsPour, butsContre, difference, points,
        butsMarquesParMatch: butsPour / matchsComptes,
        butsEncaissesParMatch: butsContre / matchsComptes,
        pointsParMatch: points / matchsComptes,
        tauxVictoires: victoires / matchsComptes,
        tauxDefaites: defaites / matchsComptes,
        differenceParMatch: difference / matchsComptes
      };
    };

    let lambdaESIVO = 1.25;
    let lambdaAdverse = 1.15;
    let source = "Estimation neutre — classement indisponible";
    let statsESIVO = null;
    let statsAdverse = null;
    try {
      const snap = await db().collection("classements").doc(match.equipe).get();
      if (snap.exists && Array.isArray(snap.data().clubs)) {
        const clubs = snap.data().clubs;
        const clubESIVO = clubs.find(estESIVO)
          || clubs.find(club => normaliserNom(club.equipe).startsWith("esivo"));
        const nomAdverse = normaliserNom(match.adversaire);
        const clubAdverse = clubs.find(club => normaliserNom(club.equipe) === nomAdverse)
          || clubs.find(club => {
            const nom = normaliserNom(club.equipe);
            return nom && nomAdverse && (nom.includes(nomAdverse) || nomAdverse.includes(nom));
          });

        statsESIVO = statistiques(clubESIVO);
        statsAdverse = statistiques(clubAdverse);

        if (statsESIVO && statsAdverse) {
          const moyenneButsLigue = clubs.reduce((total, club) => {
            const s = statistiques(club);
            return total + (s ? s.butsMarquesParMatch : 0);
          }, 0) / Math.max(1, clubs.filter(club => statistiques(club)).length);

          const moyenne = Math.max(0.55, moyenneButsLigue || 1.25);
          const forceClassement = (s) => {
            const rang = clubs.length > 1
              ? (clubs.length - Math.min(clubs.length, s.position)) / (clubs.length - 1)
              : 0.5;
            const ppg = Math.max(0, Math.min(3, s.pointsParMatch)) / 3;
            const difference = Math.max(-2, Math.min(2, s.differenceParMatch)) / 2;
            // Le classement synthétise les résultats ; les statistiques détaillées
            // permettent de départager les équipes à position proche.
            return 0.35 * rang
              + 0.30 * ppg
              + 0.15 * s.tauxVictoires
              - 0.10 * s.tauxDefaites
              + 0.10 * ((difference + 1) / 2);
          };

          const forceESIVO = forceClassement(statsESIVO);
          const forceAdverse = forceClassement(statsAdverse);
          const ecartForce = Math.max(-0.22, Math.min(0.22, (forceESIVO - forceAdverse) * 0.32));
          const domicileESIVO = match.domicile === true
            || ["domicile", "home"].includes(norm(match.domicile))
            || norm(match.domicile).includes("esivo");
          const avantageDomicile = domicileESIVO ? 1.10 : 0.92;

          const attaqueESIVO = 0.62 * statsESIVO.butsMarquesParMatch + 0.38 * statsAdverse.butsEncaissesParMatch;
          const attaqueAdverse = 0.62 * statsAdverse.butsMarquesParMatch + 0.38 * statsESIVO.butsEncaissesParMatch;

          lambdaESIVO = Math.max(0.25, Math.min(3.8,
            (0.72 * attaqueESIVO + 0.28 * moyenne) * (1 + ecartForce) * avantageDomicile
          ));
          lambdaAdverse = Math.max(0.25, Math.min(3.8,
            (0.72 * attaqueAdverse + 0.28 * moyenne) * (1 - ecartForce) / avantageDomicile
          ));
          source = "Classement complet : position, points, victoires, défaites, buts marqués et encaissés par match";
        }
      }
    } catch(err) {
      console.warn("Calcul des cotes : classement indisponible", err);
    }

    const probabilites = calculerProbabilites(lambdaESIVO, lambdaAdverse);
    const cotes = probabilites.map(p => Math.round((1 / Math.max(0.03, p)) * 100) / 100);
    let scoreEstime = [0, 0];
    let meilleureProbabilite = -1;
    for(let butsESIVO = 0; butsESIVO <= 6; butsESIVO++) {
      for(let butsAdverse = 0; butsAdverse <= 6; butsAdverse++) {
        const probabilite = poisson(lambdaESIVO, butsESIVO) * poisson(lambdaAdverse, butsAdverse);
        if(probabilite > meilleureProbabilite) {
          meilleureProbabilite = probabilite;
          scoreEstime = [butsESIVO, butsAdverse];
        }
      }
    }
    return {
      probabilites: probabilites.map(p => Math.round(p * 1000) / 10),
      cotes, lambdaESIVO, lambdaAdverse, scoreEstime, source, version,
      statistiques: { esivo: statsESIVO, adversaire: statsAdverse }
    };
  };
  const matchDocData = (match, odds, kickoffAt) => ({
    sourceMatchId:match.id, equipe:match.equipe || "", adversaire:match.adversaire || "",
    date:match.date || "", heure:match.heure || "", domicile:match.domicile ?? "",
    competition:match.competition || "", kickoffAt,
    oddsSnapshot:odds, oddsCreatedAt:firebase.firestore.FieldValue.serverTimestamp(),
    statut:"ouvert", versionModele:"poisson-v1"
  });

  window.initialiserPronosticsPage = async function() {
    const root=document.getElementById("pronosticsRoot");
    if(!root) return;
    root.innerHTML='<p class="pronostics-loading">Chargement des rencontres et de vos pronostics…</p>';
    const user=auth()?.currentUser;
    if(!user) {
      root.innerHTML='<div class="content-card"><h3>Connecte-toi pour jouer</h3><p>Les pronostics sont réservés aux membres connectés.</p><button class="btn-primary" onclick="showPage(\'Mon compte\')">Accéder à mon compte</button></div>';
      return;
    }
    try {
      const [matchesSnap, pointsDoc, rankingSnap] = await Promise.all([
        db().collection("matchs").get(),
        db().collection("pronostics_points").doc(user.uid).get(),
        db().collection("pronostics_classement").orderBy("total","desc").limit(20).get()
      ]);
      const now=new Date();
      const matches=prochainsMatchsParCategorie(matchesSnap.docs.map(d=>({...d.data(),id:d.id})),now);
      const picks=await Promise.all(matches.map(async m=>{
        const [parent,pick]=await Promise.all([
          db().collection("pronostics").doc(m.id).get(),
          db().collection("pronostics").doc(m.id).collection("participants").doc(user.uid).get()
        ]);
        return {match:m,meta:parent.exists?parent.data():null,pick:pick.exists?pick.data():null};
      }));
      const points=pointsDoc.exists?Number(pointsDoc.data().total||0):0;
      const admin=user.uid===window.ESIVO_ADMIN_UID;
      root.innerHTML=`
        <div class="pronostics-summary">
          <div><span>TES POINTS</span><strong>${points}</strong></div>
          <div><span>RENCONTRES À PRONOSTIQUER</span><strong>${picks.length}</strong></div>
        </div>
        <div class="pronostics-toolbar">
          <p>Pronostics virtuels · Aucun pari d’argent</p>
          ${admin?'<div class="pronostics-admin-actions"><button class="btn-primary" id="preparerPronosticsBtn">Préparer les nouvelles rencontres</button><button class="btn-primary" id="calculerPointsBtn">Calculer les points des résultats</button></div>':""}
        </div>
        <div id="pronosticsMessage" role="status"></div>
        <div class="pronostics-matches">
          ${picks.length?picks.map(({match,meta,pick})=>renderMatch(match,meta,pick)).join(""):'<div class="content-card"><h3>Aucune rencontre ouverte</h3><p>Les prochaines rencontres apparaîtront ici dès que leur calendrier sera disponible et que les pronostics auront été préparés.</p></div>'}
        </div>
        ${renderStatsPersonnelles(pointsDoc)}
        ${renderClassement(rankingSnap)}
        <div class="content-card pronostics-info"><h3>Comment ça marche ?</h3><p>Fais ton choix avant le coup d’envoi. Les pronostics sont verrouillés automatiquement à l’heure de la rencontre. Les cotes sont calculées à partir des statistiques disponibles et figées à l’ouverture de la rencontre.</p><small>Le score estimé est une projection statistique, pas une certitude ni une prédiction générée par une IA.</small></div>
      `;
      if(admin) {
        document.getElementById("preparerPronosticsBtn")?.addEventListener("click",preparerRencontres);
        document.getElementById("calculerPointsBtn")?.addEventListener("click",calculerPointsResultats);
      }
      root.querySelectorAll("[data-save-pick]").forEach(button=>button.addEventListener("click",()=>sauvegarderPronostic(button.dataset.savePick)));
    } catch(err) {
      console.error("Pronostics ESIVO",err);
      root.innerHTML='<div class="content-card"><h3>Chargement impossible</h3><p>Vérifie que les règles Firestore du jeu des pronostics ont bien été intégrées et publiées. Détail : '+esc(err.code||err.message)+'</p></div>';
    }
  };

  function cheminLogoPronostic(logo) {
    if(!logo) return "";
    const valeur=String(logo).trim();
    if(/^https?:\/\//i.test(valeur)) return valeur;
    const propre=valeur.replace(/^\/+/, "");
    return propre.startsWith("logos/") ? propre : "logos/" + propre;
  }

  function nomClubPronostic(categorie) {
    if(categorie==="Seniors B") return "ESIVO B";
    if(categorie==="Seniors C") return "ESIVO C";
    return "ESIVO";
  }

  function prochainsMatchsParCategorie(matches,now=new Date()) {
    const prochains=new Map();
    matches
      .filter(m=>m.type==="match" && m.resultatEnregistre!==true && m.date && dateHeure(m)>now)
      .sort((a,b)=>dateHeure(a)-dateHeure(b))
      .forEach(match=>{
        const categorie=String(match.equipe||"Autres");
        if(!prochains.has(categorie)) prochains.set(categorie,match);
      });
    // Une seule prochaine rencontre par catégorie, puis classement global
    // par date et heure de coup d'envoi (la plus proche en premier).
    return Array.from(prochains.values()).sort((a,b)=>dateHeure(a)-dateHeure(b));
  }

  function renderMatch(match,meta,pick) {
    const kickoff=dateHeure(match);
    const locked=kickoff<=new Date();
    const odds=meta?.oddsSnapshot;
    const score=odds?.scoreEstime;
    const domicile=match.domicile===true || norm(match.domicile).includes("esivo");
    const nomESIVO=nomClubPronostic(match.equipe);
    const nomDomicile=domicile?nomESIVO:(match.adversaire||"À confirmer");
    const nomExterieur=domicile?(match.adversaire||"À confirmer"):nomESIVO;
    const logoESIVO=cheminLogoPronostic("esivo.png");
    const logoAdversaire=cheminLogoPronostic(match.logo);
    const logoDomicile=domicile?logoESIVO:logoAdversaire;
    const logoExterieur=domicile?logoAdversaire:logoESIVO;
    const safeId=esc(match.id);
    return `
      <article class="pronostics-match">
        <div class="pronostics-match-top"><span>${esc(match.equipe)} · ${esc(match.competition||"Rencontre")}</span><span>${dateFR(kickoff)} · ${esc(match.heure||"")}</span></div>
        <div class="pronostics-teams pronostics-teams-logos">
          <div class="pronostics-team">
            ${logoDomicile?`<img class="pronostics-team-logo" src="${esc(logoDomicile)}" alt="Logo ${esc(nomDomicile)}">`:""}
            <small>DOMICILE</small><strong>${esc(nomDomicile)}</strong>
          </div>
          <div class="pronostics-vs">VS</div>
          <div class="pronostics-team">
            ${logoExterieur?`<img class="pronostics-team-logo" src="${esc(logoExterieur)}" alt="Logo ${esc(nomExterieur)}">`:""}
            <small>EXTÉRIEUR</small><strong>${esc(nomExterieur)}</strong>
          </div>
        </div>
        ${odds?`<div class="pronostics-odds"><span>1 <b>${odds.cotes[0].toFixed(2)}</b><small>${odds.probabilites[0]}%</small></span><span>N <b>${odds.cotes[1].toFixed(2)}</b><small>${odds.probabilites[1]}%</small></span><span>2 <b>${odds.cotes[2].toFixed(2)}</b><small>${odds.probabilites[2]}%</small></span></div><p class="pronostics-model">Score statistique estimé : <strong>${score[0]} – ${score[1]}</strong></p>`: '<p class="pronostics-pending">Pronostics bientôt ouverts par l’administrateur.</p>'}
        <div class="pronostics-pick">
          <label>Ton score ESIVO</label>
          <input type="number" min="0" max="20" id="pick-home-${safeId}" value="${pick?pick.scoreESIVO:""}" ${(!meta||locked)?"disabled":""} aria-label="Buts ESIVO">
          <span>–</span>
          <input type="number" min="0" max="20" id="pick-away-${safeId}" value="${pick?pick.scoreAdversaire:""}" ${(!meta||locked)?"disabled":""} aria-label="Buts adversaire">
          <button class="btn-primary" data-save-pick="${safeId}" ${(!meta||locked)?"disabled":""}>${pick?"Modifier":"Valider"}</button>
        </div>
        <div class="pronostics-status">${locked?"Rencontre commencée · pronostic verrouillé":pick?"Ton pronostic est enregistré":meta?"Pronostics ouverts jusqu’au coup d’envoi":"En attente d’ouverture"}</div>
      </article>`;
  }

  function renderStatsPersonnelles(pointsDoc) {
    const data=pointsDoc.exists?pointsDoc.data():{};
    const details=data.details||{};
    const scores=Object.values(details).map(Number).filter(Number.isFinite);
    const total=Number(data.total)||0;
    const reussis=scores.filter(value=>value>0).length;
    const moyenne=scores.length?Math.round(total/scores.length):0;
    return `
      <section class="pronostics-personal-stats">
        <div><span>TON TOTAL</span><strong>${total}</strong><small>points</small></div>
        <div><span>PRONOSTICS COMPTABILISÉS</span><strong>${scores.length}</strong><small>rencontres</small></div>
        <div><span>PRONOSTICS RÉCOMPENSÉS</span><strong>${reussis}</strong><small>issue correcte</small></div>
        <div><span>MOYENNE</span><strong>${moyenne}</strong><small>points / rencontre</small></div>
      </section>`;
  }

  function renderClassement(snapshot) {
    const joueurs = snapshot.docs.map(doc => ({id:doc.id,...doc.data()}))
      .sort((a,b)=>(Number(b.total)||0)-(Number(a.total)||0));
    return `
      <section class="content-card pronostics-leaderboard">
        <div class="pronostics-section-heading"><div><span>ESIVO · PRONOSTICS</span><h3>CLASSEMENT GÉNÉRAL</h3></div><small>TOP 20</small></div>
        ${joueurs.length ? `
          <div class="pronostics-ranking-list">
            ${joueurs.map((joueur,index)=>`
              <div class="pronostics-ranking-row ${index<3?"top-three":""}">
                <span class="pronostics-rank">${index+1}</span>
                <strong>${esc(joueur.pseudo||"Membre")}</strong>
                <span>${Number(joueur.total)||0} pts</span>
              </div>`).join("")}
          </div>` : '<p class="pronostics-empty-ranking">Le classement apparaîtra après les premiers résultats comptabilisés.</p>'}
      </section>`;
  }

  const pointsPourPronostic = (pick, resultat, cotes) => {
    const signePronostique = Math.sign(pick.scoreESIVO-pick.scoreAdversaire);
    const signeReel = Math.sign(resultat.butsESIVO-resultat.butsAdversaire);
    if(signePronostique !== signeReel) return 0;
    const indexCote = signePronostique>0?0:signePronostique===0?1:2;
    const cote = Number(cotes?.[indexCote]) || 1;
    const pointsIssue = Math.max(5,Math.min(50,Math.round(cote*10)));
    const bonusExact = pick.scoreESIVO===resultat.butsESIVO && pick.scoreAdversaire===resultat.butsAdversaire ? 10 : 0;
    return pointsIssue+bonusExact;
  };

  async function calculerPointsResultats() {
    const user=auth()?.currentUser;
    if(!user || user.uid!==window.ESIVO_ADMIN_UID) return alert("Accès réservé à l’administrateur.");
    const btn=document.getElementById("calculerPointsBtn");
    const message=document.getElementById("pronosticsMessage");
    if(btn) btn.disabled=true;
    try {
      const matchesSnap=await db().collection("matchs").get();
      const termines=matchesSnap.docs.map(d=>({...d.data(),id:d.id}))
        .filter(m=>m.type==="match" && m.resultatEnregistre===true
          && Number.isInteger(m.butsESIVO) && Number.isInteger(m.butsAdversaire));
      let matchesTraites=0, participations=0;
      for(const match of termines) {
        const metaRef=db().collection("pronostics").doc(match.id);
        const metaSnap=await metaRef.get();
        if(!metaSnap.exists) continue;
        const meta=metaSnap.data();
        const participantsSnap=await metaRef.collection("participants").get();
        const batch=db().batch();
        let operations=0;
        for(const participantDoc of participantsSnap.docs) {
          const pick=participantDoc.data();
          if(!Number.isInteger(pick.scoreESIVO)||!Number.isInteger(pick.scoreAdversaire)) continue;
          const uid=participantDoc.id;
          const pointsRef=db().collection("pronostics_points").doc(uid);
          const rankingRef=db().collection("pronostics_classement").doc(uid);
          const [pointsSnap, membreSnap]=await Promise.all([
            pointsRef.get(),
            db().collection("membres").doc(uid).get()
          ]);
          const oldData=pointsSnap.exists?pointsSnap.data():{};
          const details={...(oldData.details||{})};
          const nouveau=pointsPourPronostic(pick,match,meta.oddsSnapshot?.cotes);
          const ancien=Number(details[match.id])||0;
          details[match.id]=nouveau;
          const total=Math.max(0,(Number(oldData.total)||0)-ancien+nouveau);
          const pseudo=String(pick.pseudo||(membreSnap.exists?(membreSnap.data().pseudo||membreSnap.data().prenom||"Membre"):"Membre")).slice(0,20);
          batch.set(pointsRef,{uid,pseudo,total,details,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
          batch.set(rankingRef,{uid,pseudo,total,updatedAt:firebase.firestore.FieldValue.serverTimestamp()},{merge:true});
          operations+=2;
          participations++;
        }
        if(operations) await batch.commit();
        await metaRef.set({
          resultatComptabilise:true,
          resultatComptabiliseAt:firebase.firestore.FieldValue.serverTimestamp(),
          scoreOfficiel:{butsESIVO:match.butsESIVO,butsAdversaire:match.butsAdversaire}
        },{merge:true});
        matchesTraites++;
      }
      if(message) message.textContent=matchesTraites+" rencontre(s) traitée(s), "+participations+" pronostic(s) recalculé(s). Les corrections de résultats mettent à jour les points sans les cumuler deux fois.";
      await window.initialiserPronosticsPage();
    } catch(err) {
      console.error("Calcul des points",err);
      if(message) message.textContent="Calcul impossible : "+(err.code||err.message)+". Vérifie les règles Firestore.";
    } finally { if(btn) btn.disabled=false; }
  }

  async function preparerRencontres() {
    const user=auth()?.currentUser;
    if(!user || user.uid!==window.ESIVO_ADMIN_UID) return alert("Accès réservé à l’administrateur.");

    const btn=document.getElementById("preparerPronosticsBtn");
    const message=document.getElementById("pronosticsMessage");
    if(btn) btn.disabled=true;
    if(message) message.textContent="Préparation des rencontres en cours…";

    let resultat="";
    try {
      const snap=await db().collection("matchs").get();
      const now=new Date();
      const futures=prochainsMatchsParCategorie(
        snap.docs.map(d=>({...d.data(),id:d.id})),now
      );
      let created=0;
      let dejaPreparees=0;

      for(const match of futures) {
        const ref=db().collection("pronostics").doc(match.id);
        const exists=await ref.get();
        const odds=await cotesDepuisClassement(match);
        if(exists.exists) {
          const ancienneVersion = exists.data()?.versionModele || exists.data()?.oddsSnapshot?.version;
          // Mise à niveau unique des rencontres déjà ouvertes avec le nouveau modèle.
          // Ensuite, les cotes restent figées pour cette rencontre.
          if(ancienneVersion !== "poisson-v2") {
            await ref.set({
              oddsSnapshot: odds,
              versionModele: "poisson-v2",
              oddsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
            }, {merge:true});
            dejaPreparees++;
          } else {
            dejaPreparees++;
          }
          continue;
        }
        await ref.set(matchDocData(match,odds,firebase.firestore.Timestamp.fromDate(dateHeure(match))));
        created++;
      }

      resultat = futures.length===0
        ? "Aucune rencontre future éligible trouvée dans le calendrier (type « match », date à venir, résultat non enregistré)."
        : created+" nouvelle(s) rencontre(s) préparée(s). "+dejaPreparees+" rencontre(s) étaient déjà ouvertes.";
      await window.initialiserPronosticsPage();
      const messageApresChargement=document.getElementById("pronosticsMessage");
      if(messageApresChargement) messageApresChargement.textContent=resultat;
    } catch(err) {
      console.error("Erreur de préparation des pronostics :",err);
      const messageApresErreur=document.getElementById("pronosticsMessage");
      if(messageApresErreur) messageApresErreur.textContent="Erreur de préparation : "+(err.code||err.message||"erreur inconnue");
    } finally {
      const boutonApresChargement=document.getElementById("preparerPronosticsBtn");
      if(boutonApresChargement) boutonApresChargement.disabled=false;
    }
  }

  async function sauvegarderPronostic(matchId) {
    const user=auth()?.currentUser;
    if(!user) return;
    const home=document.getElementById("pick-home-"+matchId);
    const away=document.getElementById("pick-away-"+matchId);
    const scoreESIVO=Number(home?.value), scoreAdversaire=Number(away?.value);
    const message=document.getElementById("pronosticsMessage");
    if(!Number.isInteger(scoreESIVO)||!Number.isInteger(scoreAdversaire)||scoreESIVO<0||scoreESIVO>20||scoreAdversaire<0||scoreAdversaire>20) {
      if(message) message.textContent="Entre deux scores entiers compris entre 0 et 20.";
      return;
    }
    try {
      const pseudo=await pseudoUtilisateur(user);
      const ref=db().collection("pronostics").doc(matchId).collection("participants").doc(user.uid);
      const old=await ref.get();
      const data={
        uid:user.uid,
        pseudo:old.exists ? old.data().pseudo : pseudo,
        scoreESIVO,scoreAdversaire,
        updatedAt:firebase.firestore.FieldValue.serverTimestamp()
      };
      data.createdAt=old.exists
        ? old.data().createdAt
        : firebase.firestore.FieldValue.serverTimestamp();
      await ref.set(data,{merge:false});
      if(message) message.textContent="Ton pronostic est enregistré !";
      await window.initialiserPronosticsPage();
    } catch(err) {
      console.error(err);
      if(message) message.textContent="Enregistrement impossible : "+(err.code||err.message)+". Vérifie les règles Firestore.";
    }
  }
})();
