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
    const version = "poisson-v4";
    const equipeESIVO = nomClubPronostic(match.equipe);
    const normaliserNom = value => norm(value).replace(/[^a-z0-9]/g, "");
    const statistiques = (club,index=0) => {
      if(!club) return null;
      const joues=Math.max(0,Number(club.joues)||0);
      const victoires=Math.max(0,Number(club.victoires)||0);
      const nuls=Math.max(0,Number(club.nuls)||0);
      const defaites=Math.max(0,Number(club.defaites)||0);
      const matchs=Math.max(joues,victoires+nuls+defaites);
      if(!matchs) return null;
      const butsPour=Math.max(0,Number(club.butsPour)||0);
      const butsContre=Math.max(0,Number(club.butsContre)||0);
      const points=Number.isFinite(Number(club.points))?Number(club.points):victoires*3+nuls;
      const difference=Number.isFinite(Number(club.difference))?Number(club.difference):butsPour-butsContre;
      return {
        position:Math.max(1,Number(club.position)||index+1),
        joues:matchs,victoires,nuls,defaites,butsPour,butsContre,points,difference,
        butsMarquesParMatch:butsPour/matchs,
        butsEncaissesParMatch:butsContre/matchs,
        pointsParMatch:points/matchs,
        tauxVictoires:victoires/matchs,
        tauxNuls:nuls/matchs,
        tauxDefaites:defaites/matchs,
        differenceParMatch:difference/matchs
      };
    };
    let lambdaESIVO=1.25, lambdaAdverse=1.15;
    let source="Estimation neutre — classement de la catégorie indisponible";
    let statsESIVO=null, statsAdverse=null;
    try {
      const snap=await db().collection("classements").doc(match.equipe).get();
      if(snap.exists && Array.isArray(snap.data().clubs)) {
        const clubs=snap.data().clubs;
        const cibleESIVO=normaliserNom(equipeESIVO);
        let candidatsESIVO=clubs.map((club,index)=>({club,index,nom:normaliserNom(club.equipe)}))
          .filter(x=>x.nom===cibleESIVO || (x.nom.startsWith(cibleESIVO) && cibleESIVO.length>=5));
        // Certaines feuilles de classement nomment simplement le club « ESIVO »,
        // même pour les équipes B ou C : on ne prend cet alias que si aucun nom
        // propre à l'équipe n'a été trouvé dans le classement de cette catégorie.
        if(!candidatsESIVO.length && ["esivob","esivoc"].includes(cibleESIVO)) {
          candidatsESIVO=clubs.map((club,index)=>({club,index,nom:normaliserNom(club.equipe)}))
            .filter(x=>x.nom==="esivo");
        }
        const clubESIVO=candidatsESIVO.length
          ? candidatsESIVO.sort((a,b)=>a.nom.length-b.nom.length)[0].club
          : null;
        const cibleAdverse=normaliserNom(match.adversaire);
        const candidatsAdverses=clubs.map((club,index)=>({club,index,nom:normaliserNom(club.equipe)}))
          .filter(x=>x.nom===cibleAdverse || (x.nom.length>=5 && cibleAdverse.length>=5 && (x.nom.includes(cibleAdverse)||cibleAdverse.includes(x.nom))));
        const clubAdverse=candidatsAdverses.length
          ? candidatsAdverses.sort((a,b)=>Math.abs(a.nom.length-cibleAdverse.length)-Math.abs(b.nom.length-cibleAdverse.length))[0].club
          : null;
        statsESIVO=statistiques(clubESIVO,clubs.indexOf(clubESIVO));
        statsAdverse=statistiques(clubAdverse,clubs.indexOf(clubAdverse));
        const clubsAvecStats=clubs.map((club,index)=>statistiques(club,index)).filter(Boolean);
        if(statsESIVO && statsAdverse && clubsAvecStats.length>=2) {
          const moyenneButs=clubsAvecStats.reduce((s,x)=>s+x.butsMarquesParMatch,0)/clubsAvecStats.length;
          const moyenne=Math.max(0.55,moyenneButs||1.25);
          // Les statistiques de chaque équipe sont ramenées progressivement vers
          // la moyenne du championnat lorsque peu de rencontres ont été jouées.
          const stabiliser=(valeur,moyenneLigue,n)=>valeur*(n/(n+4))+moyenneLigue*(4/(n+4));
          const force=(s)=>{
            const rang=clubs.length>1?1-(Math.min(clubs.length,Math.max(1,s.position))-1)/(clubs.length-1):0.5;
            const ppg=Math.max(0,Math.min(3,s.pointsParMatch))/3;
            const diff=Math.max(-2,Math.min(2,s.differenceParMatch))/4+0.5;
            const victoire=Math.max(0,Math.min(1,s.tauxVictoires));
            const regularite=1-Math.max(0,Math.min(1,s.tauxDefaites));
            return 0.38*ppg+0.22*rang+0.18*diff+0.14*victoire+0.08*regularite;
          };
          const ecartForce=Math.max(-0.42,Math.min(0.42,(force(statsESIVO)-force(statsAdverse))*1.25));
          const butsPourESIVO=stabiliser(statsESIVO.butsMarquesParMatch,moyenne,statsESIVO.joues);
          const butsContreESIVO=stabiliser(statsESIVO.butsEncaissesParMatch,moyenne,statsESIVO.joues);
          const butsPourAdverse=stabiliser(statsAdverse.butsMarquesParMatch,moyenne,statsAdverse.joues);
          const butsContreAdverse=stabiliser(statsAdverse.butsEncaissesParMatch,moyenne,statsAdverse.joues);
          const domicileESIVO=match.domicile===true || ["domicile","home"].includes(norm(match.domicile)) || norm(match.domicile).includes("esivo");
          const avantageDomicile=domicileESIVO?1.08:0.93;
          const attaqueESIVO=0.55*butsPourESIVO+0.45*butsContreAdverse;
          const attaqueAdverse=0.55*butsPourAdverse+0.45*butsContreESIVO;
          lambdaESIVO=Math.max(0.25,Math.min(4.2,(0.65*attaqueESIVO+0.35*moyenne)*Math.exp(ecartForce)*avantageDomicile));
          lambdaAdverse=Math.max(0.25,Math.min(4.2,(0.65*attaqueAdverse+0.35*moyenne)*Math.exp(-ecartForce)/avantageDomicile));
          source="Classement actualisé : rang, points par match, victoires, défaites, différence et buts par match";
        } else {
          source="Classement partiel — statistiques d'une des deux équipes introuvables";
        }
      }
    } catch(err) {
      console.warn("Calcul des cotes : classement indisponible",err);
    }
    const probabilites=calculerProbabilites(lambdaESIVO,lambdaAdverse);
    const cotes=probabilites.map(p=>Math.round((1/Math.max(0.025,p))*100)/100);
    let scoreEstime=[0,0], meilleureProbabilite=-1;
    for(let butsESIVO=0;butsESIVO<=7;butsESIVO++) for(let butsAdverse=0;butsAdverse<=7;butsAdverse++) {
      const probabilite=poisson(lambdaESIVO,butsESIVO)*poisson(lambdaAdverse,butsAdverse);
      if(probabilite>meilleureProbabilite){meilleureProbabilite=probabilite;scoreEstime=[butsESIVO,butsAdverse];}
    }
    return {
      probabilites:probabilites.map(p=>Math.round(p*1000)/10),
      cotes,lambdaESIVO,lambdaAdverse,scoreEstime,source,version,
      statistiques:{esivo:statsESIVO,adversaire:statsAdverse}
    };
  };
  const matchDocData = (match, odds, kickoffAt) => ({
    sourceMatchId:match.id, equipe:match.equipe || "", adversaire:match.adversaire || "",
    date:match.date || "", heure:match.heure || "", domicile:match.domicile ?? "",
    competition:match.competition || "", kickoffAt,
    oddsSnapshot:odds, oddsCreatedAt:firebase.firestore.FieldValue.serverTimestamp(),
    statut:"ouvert", versionModele:odds.version || "poisson-v4"
  });

  // Synchronise les métadonnées et les estimations après toute modification
  // d'une rencontre dans le calendrier, quelle que soit sa catégorie.
  window.synchroniserPronosticMatchModifie = async function(match) {
    if (!match?.id) throw new Error("Identifiant de rencontre manquant.");
    const ref=db().collection("pronostics").doc(match.id);
    const kickoff=dateHeure(match);
    const existant=await ref.get();
    if(!existant.exists) return null;
    const donneesCalendrier={
      sourceMatchId:match.id,
      equipe:match.equipe||"",
      adversaire:match.adversaire||"",
      date:match.date||"",
      heure:match.heure||"",
      domicile:match.domicile??"",
      competition:match.competition||"",
      lieu:match.lieu||"",
      ville:match.ville||"",
      kickoffAt:firebase.firestore.Timestamp.fromDate(kickoff),
      updatedAt:firebase.firestore.FieldValue.serverTimestamp()
    };
    // Ne jamais recalculer les cotes d'un match commencé ou dont le résultat
    // est déjà enregistré : elles servent aussi au calcul des points.
    if(match.resultatEnregistre===true || kickoff<=new Date()) {
      await ref.set(donneesCalendrier,{merge:true});
      return existant.data().oddsSnapshot||null;
    }
    const odds=await cotesDepuisClassement(match);
    const statut=match.statutMatch==="reporte"?"suspendu":"ouvert";
    await ref.set({
      ...donneesCalendrier,
      oddsSnapshot:odds,
      versionModele:odds.version||"poisson-v4",
      oddsUpdatedAt:firebase.firestore.FieldValue.serverTimestamp(),
      statut
    },{merge:true});
    return odds;
  };

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
        db().collection("pronostics_classement").orderBy("total","desc").get()
      ]);
      const joueursClassement=rankingSnap.docs.map(doc=>({id:doc.id,...doc.data()}))
        .sort((a,b)=>(Number(b.total)||0)-(Number(a.total)||0));
      const profilsTop=await Promise.all(joueursClassement.slice(0,20).map(async joueur=>{
        try {
          const profil=await db().collection("profils_publics").doc(joueur.id).get();
          return [joueur.id,profil.exists?profil.data():null];
        } catch(_) { return [joueur.id,null]; }
      }));
      const profilsParUid=Object.fromEntries(profilsTop);
      const rangPersonnel=joueursClassement.findIndex(joueur=>joueur.id===user.uid)+1;
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
          ${admin?'<div class="pronostics-admin-actions"><button class="btn-primary" id="preparerPronosticsBtn">Actualiser les côtes et préparer les rencontres</button><button class="btn-primary" id="calculerPointsBtn">Calculer les points des résultats</button></div>':""}
        </div>
        <div id="pronosticsMessage" role="status"></div>
        <div class="pronostics-matches">
          ${picks.length?picks.map(({match,meta,pick})=>renderMatch(match,meta,pick)).join(""):'<div class="content-card"><h3>Aucune rencontre ouverte</h3><p>Les prochaines rencontres apparaîtront ici dès que leur calendrier sera disponible et que les pronostics auront été préparés.</p></div>'}
        </div>
        ${renderStatsPersonnelles(pointsDoc,rangPersonnel)}
        ${renderClassement(rankingSnap,profilsParUid,user.uid)}
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
      .filter(m=>m.type==="match" && m.resultatEnregistre!==true && m.statutMatch!=="reporte" && m.date && dateHeure(m)>now)
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
    const locked=kickoff<=new Date() || match.statutMatch==="reporte";
    const estCoupe=match.formatCompetition==="coupe";
    const odds=meta?.oddsSnapshot;
    const score=odds?.scoreEstime;
    const domicile=match.domicile===true || norm(match.domicile).includes("esivo");
    // Les cotes du modèle sont stockées dans l'ordre ESIVO / nul / adversaire.
    // L'affichage 1-N-2 doit, lui, toujours suivre domicile / nul / extérieur.
    const cotesAffichees = odds?.cotes
      ? (domicile ? odds.cotes : [odds.cotes[2], odds.cotes[1], odds.cotes[0]])
      : [];
    const probabilitesAffichees = odds?.probabilites
      ? (domicile ? odds.probabilites : [odds.probabilites[2], odds.probabilites[1], odds.probabilites[0]])
      : [];
    const scoreAffiche = score
      ? (domicile ? score : [score[1], score[0]])
      : null;
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
        ${match.statutMatch==="reporte"?`<p class="pronostics-postponed">RENCONTRE REPORTÉE · Pronostics suspendus</p>`:""}
        ${odds?`<div class="pronostics-odds"><span>1 <b>${cotesAffichees[0].toFixed(2)}</b><small>${probabilitesAffichees[0]}%</small></span><span>N <b>${cotesAffichees[1].toFixed(2)}</b><small>${probabilitesAffichees[1]}%</small></span><span>2 <b>${cotesAffichees[2].toFixed(2)}</b><small>${probabilitesAffichees[2]}%</small></span></div><p class="pronostics-model">Score estimé (domicile – extérieur) : <strong>${scoreAffiche[0]} – ${scoreAffiche[1]}</strong></p>`: '<p class="pronostics-pending">Pronostics bientôt ouverts par l’administrateur.</p>'}
        ${estCoupe?`<div class="pronostics-cup-pick"><label for="pick-qualif-${safeId}">Quelle équipe se qualifie ? <strong>+10 points</strong></label><select id="pick-qualif-${safeId}" ${(!meta||locked)?"disabled":""}><option value="">Choisir l’équipe qualifiée</option><option value="esivo" ${pick?.qualifieEquipe==="esivo"?"selected":""}>${esc(nomESIVO)}</option><option value="adversaire" ${pick?.qualifieEquipe==="adversaire"?"selected":""}>${esc(match.adversaire||"Adversaire")}</option></select></div>`:""}
        <div class="pronostics-pick">
          <label>Ton score ESIVO (90 minutes)</label>
          <input type="number" min="0" max="20" id="pick-home-${safeId}" value="${pick?pick.scoreESIVO:""}" ${(!meta||locked)?"disabled":""} aria-label="Buts ESIVO">
          <span>–</span>
          <input type="number" min="0" max="20" id="pick-away-${safeId}" value="${pick?pick.scoreAdversaire:""}" ${(!meta||locked)?"disabled":""} aria-label="Buts adversaire">
          <button class="btn-primary" data-save-pick="${safeId}" ${(!meta||locked)?"disabled":""}>${pick?"Modifier":"Valider"}</button>
        </div>
        <div class="pronostics-status">${locked?"Rencontre commencée · pronostic verrouillé":pick?"Ton pronostic est enregistré":meta?"Pronostics ouverts jusqu’au coup d’envoi":"En attente d’ouverture"}</div>
      </article>`;
  }

  function renderStatsPersonnelles(pointsDoc, rangPersonnel) {
    const data=pointsDoc.exists?pointsDoc.data():{};
    const details=data.details||{};
    const scores=Object.values(details).map(Number).filter(Number.isFinite);
    const total=Number(data.total)||0;
    const reussis=scores.filter(value=>value>0).length;
    const moyenne=scores.length?Math.round(total/scores.length):0;
    const meilleurScore=scores.length?Math.max(...scores):0;
    return `
      <section class="pronostics-personal-stats">
        <div><span>TON TOTAL</span><strong>${total}</strong><small>points</small></div>
        <div><span>TON CLASSEMENT</span><strong>${rangPersonnel>0?"#"+rangPersonnel:"—"}</strong><small>rang général</small></div>
        <div><span>PRONOSTICS COMPTABILISÉS</span><strong>${scores.length}</strong><small>rencontres</small></div>
        <div><span>PRONOSTICS RÉCOMPENSÉS</span><strong>${reussis}</strong><small>avec points</small></div>
        <div><span>MEILLEUR GAIN</span><strong>${meilleurScore}</strong><small>points sur un match</small></div>
        <div><span>MOYENNE</span><strong>${moyenne}</strong><small>points / rencontre</small></div>
      </section>`;
  }

  function badgeClassement(joueur, profil) {
    if (joueur.id === window.ESIVO_ADMIN_UID) return {texte:"FONDATEUR DU SITE ESIVO",fond:"#2687E8",couleur:"#FFFFFF"};
    const badges = {
      supporter:{texte:"SUPPORTER ESIVO",fond:"#E5BD37",couleur:"#19191D"},
      "licencie-esivo":{texte:"LICENCIÉ AU CLUB ESIVO",fond:"#AA1A24",couleur:"#FFFFFF"},
      "licencie-autre":{texte:"LICENCIÉ D'UN AUTRE CLUB",fond:"#268B57",couleur:"#FFFFFF"}
    };
    return badges[profil?.statut] || badges.supporter;
  }

  function renderClassement(snapshot, profilsParUid, currentUid) {
    const joueurs = snapshot.docs.map(doc => ({id:doc.id,...doc.data()}))
      .sort((a,b)=>(Number(b.total)||0)-(Number(a.total)||0));
    const rangPersonnel=joueurs.findIndex(joueur=>joueur.id===currentUid)+1;
    const top=joueurs.slice(0,20);
    const lignes=top.map((joueur,index)=>{
      const badge=badgeClassement(joueur,profilsParUid[joueur.id]);
      const rang=index+1;
      const medaille=rang===1?"🥇":rang===2?"🥈":rang===3?"🥉":"";
      return `
        <article class="pronostics-ranking-row ${index<3?"top-three":""} ${joueur.id===currentUid?"current-player":""}"
          data-profil-uid="${esc(joueur.id)}" role="button" tabindex="0"
          aria-label="Voir le profil de ${esc(joueur.pseudo||"Membre")}">
          <span class="pronostics-rank">${medaille||rang}</span>
          <div class="pronostics-ranking-member">
            <strong>${esc(joueur.pseudo||"Membre")}</strong>
            <span class="pronostics-ranking-badge" style="background:${badge.fond};color:${badge.couleur}">${esc(badge.texte)}</span>
          </div>
          <span class="pronostics-ranking-points">${Number(joueur.total)||0} pts</span>
        </article>`;
    }).join("");
    const rangHTML=rangPersonnel>20
      ? `<p class="pronostics-your-rank">Ta position : <strong>#${rangPersonnel}</strong> sur ${joueurs.length} membre(s) · ${Number(joueurs[rangPersonnel-1]?.total)||0} points</p>`
      : "";
    return `
      <section class="content-card pronostics-leaderboard">
        <div class="pronostics-section-heading"><div><span>ESIVO · PRONOSTICS</span><h3>CLASSEMENT GÉNÉRAL</h3></div><small>${Math.min(joueurs.length,20)} / ${joueurs.length} MEMBRES</small></div>
        ${joueurs.length ? `<div class="pronostics-ranking-list">${lignes}</div>${rangHTML}` : '<p class="pronostics-empty-ranking">Le classement apparaîtra après les premiers résultats comptabilisés.</p>'}
      </section>`;
  }

  const pointsPourPronostic = (pick, resultat, cotes) => {
    const signePronostique = Math.sign(pick.scoreESIVO-pick.scoreAdversaire);
    const signeReel = Math.sign(resultat.butsESIVO-resultat.butsAdversaire);
    const issueCorrecte = signePronostique === signeReel;
    const indexCote = signePronostique>0?0:signePronostique===0?1:2;
    const cote = Number(cotes?.[indexCote]) || 1;
    const pointsIssue = issueCorrecte ? Math.max(5,Math.min(50,Math.round(cote*10))) : 0;
    const bonusExact = issueCorrecte && pick.scoreESIVO===resultat.butsESIVO && pick.scoreAdversaire===resultat.butsAdversaire ? 10 : 0;
    const bonusQualification = resultat.formatCompetition==="coupe" && pick.qualifieEquipe && pick.qualifieEquipe===resultat.qualifieEquipe ? 10 : 0;
    return pointsIssue+bonusExact+bonusQualification;
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
          && Number.isInteger(m.butsESIVO) && Number.isInteger(m.butsAdversaire)
          && (m.formatCompetition!=="coupe" || !!m.qualifieEquipe));
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
          // L'action admin "Préparer" actualise explicitement les cotes des
          // rencontres futures déjà ouvertes, sans toucher aux pronostics.
          await ref.set({
            oddsSnapshot: odds,
            versionModele: odds.version || "poisson-v4",
            date: match.date || "",
            heure: match.heure || "",
            kickoffAt: firebase.firestore.Timestamp.fromDate(dateHeure(match)),
            statut: "ouvert",
            oddsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
          }, {merge:true});
          dejaPreparees++;
          continue;
        }
        await ref.set(matchDocData(match,odds,firebase.firestore.Timestamp.fromDate(dateHeure(match))));
        created++;
      }

      resultat = futures.length===0
        ? "Aucune rencontre future éligible trouvée dans le calendrier (type « match », date à venir, résultat non enregistré)."
        : created+" nouvelle(s) rencontre(s) préparée(s). "+dejaPreparees+" rencontre(s) existantes ont vu leurs cotes actualisées.";
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
    const selectQualification=document.getElementById("pick-qualif-"+matchId);
    const qualifieEquipe=selectQualification?.value || "";
    const message=document.getElementById("pronosticsMessage");
    if(!Number.isInteger(scoreESIVO)||!Number.isInteger(scoreAdversaire)||scoreESIVO<0||scoreESIVO>20||scoreAdversaire<0||scoreAdversaire>20) {
      if(message) message.textContent="Entre deux scores entiers compris entre 0 et 20.";
      return;
    }
    try {
      const matchDoc=await db().collection("matchs").doc(matchId).get();
      if(!matchDoc.exists || matchDoc.data().statutMatch==="reporte" || dateHeure(matchDoc.data())<=new Date()) {
        if(message) message.textContent="Cette rencontre est reportée ou a commencé : les pronostics sont fermés.";
        return;
      }
      if(matchDoc.data().formatCompetition==="coupe" && !qualifieEquipe) {
        if(message) message.textContent="Choisis également l’équipe que tu vois se qualifier.";
        return;
      }
      const pseudo=await pseudoUtilisateur(user);
      const ref=db().collection("pronostics").doc(matchId).collection("participants").doc(user.uid);
      const old=await ref.get();
      const data={
        uid:user.uid,
        pseudo:old.exists ? old.data().pseudo : pseudo,
        scoreESIVO,scoreAdversaire,
        qualifieEquipe: matchDoc.data().formatCompetition==="coupe" ? qualifieEquipe : null,
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

;
