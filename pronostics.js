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
    let lambdaESIVO=1.25, lambdaAdverse=1.15, source="Estimation neutre — données de classement indisponibles";
    try {
      const snap = await db().collection("classements").doc(match.equipe).get();
      if (snap.exists && Array.isArray(snap.data().clubs)) {
        const clubs=snap.data().clubs;
        const esivo=clubs.find(c=>norm(c.equipe)==="esivo");
        const adverse=clubs.find(c=>norm(c.equipe)===norm(match.adversaire))
          || clubs.find(c=>norm(c.equipe).includes(norm(match.adversaire)) || norm(match.adversaire).includes(norm(c.equipe)));
        if(esivo && adverse) {
          const rate = c => {
            const j=Math.max(1,Number(c.joues)||0);
            return {
              gf:(Number(c.butsPour)||0)/j,
              ga:(Number(c.butsContre)||0)/j,
              ppg:(Number(c.points)||0)/j,
              diff:(Number(c.difference)||((Number(c.butsPour)||0)-(Number(c.butsContre)||0)))/j
            };
          };
          const e=rate(esivo), a=rate(adverse);
          const domicile = norm(match.domicile).includes("esivo") || match.domicile === true;
          const avantage = domicile ? 0.16 : -0.08;
          lambdaESIVO=Math.min(3.2,Math.max(0.35,0.72*e.gf+0.28*a.ga+avantage));
          lambdaAdverse=Math.min(3.2,Math.max(0.35,0.72*a.gf+0.28*e.ga-avantage));
          source="Classement officiel : forme statistique globale (buts et points par match)";
        }
      }
    } catch(err) { console.warn("Calcul des cotes : classement indisponible",err); }
    const probs=calculerProbabilites(lambdaESIVO,lambdaAdverse);
    const cotes=probs.map(p=>Math.round((1/Math.max(.05,p))*100)/100);
    let best=[0,0,0], bestP=-1;
    for(let h=0;h<=5;h++) for(let a=0;a<=5;a++) {
      const p=poisson(lambdaESIVO,h)*poisson(lambdaAdverse,a);
      if(p>bestP){bestP=p;best=[h,a];}
    }
    return {probabilites:probs.map(p=>Math.round(p*1000)/10),cotes,lambdaESIVO,lambdaAdverse,scoreEstime:best,source,version:"poisson-v1"};
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
      const [matchesSnap, pointsDoc] = await Promise.all([
        db().collection("matchs").get(),
        db().collection("pronostics_points").doc(user.uid).get()
      ]);
      const now=new Date();
      const matches=matchesSnap.docs.map(d=>({...d.data(),id:d.id}))
        .filter(m=>m.type==="match" && m.resultatEnregistre!==true && m.date && dateHeure(m)>now)
        .sort((a,b)=>dateHeure(a)-dateHeure(b));
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
          ${admin?'<button class="btn-primary" id="preparerPronosticsBtn">Préparer les nouvelles rencontres</button>':""}
        </div>
        <div id="pronosticsMessage" role="status"></div>
        <div class="pronostics-matches">
          ${picks.length?picks.map(({match,meta,pick})=>renderMatch(match,meta,pick)).join(""):'<div class="content-card"><h3>Aucune rencontre ouverte</h3><p>Les prochaines rencontres apparaîtront ici dès que leur calendrier sera disponible et que les pronostics auront été préparés.</p></div>'}
        </div>
        <div class="content-card pronostics-info"><h3>Comment ça marche ?</h3><p>Fais ton choix avant le coup d’envoi. Les pronostics sont verrouillés automatiquement à l’heure de la rencontre. Les cotes sont calculées à partir des statistiques disponibles et figées à l’ouverture de la rencontre.</p><small>Le score estimé est une projection statistique, pas une certitude ni une prédiction générée par une IA.</small></div>
      `;
      if(admin) document.getElementById("preparerPronosticsBtn")?.addEventListener("click",preparerRencontres);
      root.querySelectorAll("[data-save-pick]").forEach(button=>button.addEventListener("click",()=>sauvegarderPronostic(button.dataset.savePick)));
    } catch(err) {
      console.error("Pronostics ESIVO",err);
      root.innerHTML='<div class="content-card"><h3>Chargement impossible</h3><p>Vérifie que les règles Firestore du jeu des pronostics ont bien été intégrées et publiées. Détail : '+esc(err.code||err.message)+'</p></div>';
    }
  };

  function renderMatch(match,meta,pick) {
    const kickoff=dateHeure(match);
    const locked=kickoff<=new Date();
    const odds=meta?.oddsSnapshot;
    const score=odds?.scoreEstime;
    const labelDomicile=match.domicile===true || norm(match.domicile).includes("esivo") ? "DOMICILE" : "EXTÉRIEUR";
    const safeId=esc(match.id);
    return `
      <article class="pronostics-match">
        <div class="pronostics-match-top"><span>${esc(match.equipe)} · ${esc(match.competition||"Rencontre")}</span><span>${dateFR(kickoff)} · ${esc(match.heure||"")}</span></div>
        <div class="pronostics-teams"><div><small>${labelDomicile}</small><strong>ESIVO</strong></div><div class="pronostics-vs">VS</div><div><small>ADVERSAIRE</small><strong>${esc(match.adversaire||"À confirmer")}</strong></div></div>
        ${odds?`<div class="pronostics-odds"><span>1 <b>${odds.cotes[0].toFixed(2)}</b><small>${odds.probabilites[0]}%</small></span><span>N <b>${odds.cotes[1].toFixed(2)}</b><small>${odds.probabilites[1]}%</small></span><span>2 <b>${odds.cotes[2].toFixed(2)}</b><small>${odds.probabilites[2]}%</small></span></div><p class="pronostics-model">Score statistique estimé : <strong>${score[0]} – ${score[1]}</strong></p>`: '<p class="pronostics-pending">Pronostics bientôt ouverts par l’administrateur.</p>'}
        <div class="pronostics-pick">
          <label>Ton score</label>
          <input type="number" min="0" max="20" id="pick-home-${safeId}" value="${pick?pick.scoreESIVO:""}" ${(!meta||locked)?"disabled":""} aria-label="Buts ESIVO">
          <span>–</span>
          <input type="number" min="0" max="20" id="pick-away-${safeId}" value="${pick?pick.scoreAdversaire:""}" ${(!meta||locked)?"disabled":""} aria-label="Buts adversaire">
          <button class="btn-primary" data-save-pick="${safeId}" ${(!meta||locked)?"disabled":""}>${pick?"Modifier":"Valider"}</button>
        </div>
        <div class="pronostics-status">${locked?"Rencontre commencée · pronostic verrouillé":pick?"Ton pronostic est enregistré":meta?"Pronostics ouverts jusqu’au coup d’envoi":"En attente d’ouverture"}</div>
      </article>`;
  }

  async function preparerRencontres() {
    const user=auth()?.currentUser;
    if(!user || user.uid!==window.ESIVO_ADMIN_UID) return alert("Accès réservé à l’administrateur.");
    const btn=document.getElementById("preparerPronosticsBtn");
    const message=document.getElementById("pronosticsMessage");
    if(btn) btn.disabled=true;
    try {
      const snap=await db().collection("matchs").get();
      const now=new Date();
      const futures=snap.docs.map(d=>({...d.data(),id:d.id}))
        .filter(m=>m.type==="match" && m.date && dateHeure(m)>now && m.resultatEnregistre!==true);
      let created=0;
      for(const match of futures) {
        const ref=db().collection("pronostics").doc(match.id);
        const exists=await ref.get();
        if(exists.exists) continue;
        const odds=await cotesDepuisClassement(match);
        await ref.set(matchDocData(match,odds,firebase.firestore.Timestamp.fromDate(dateHeure(match))));
        created++;
      }
      if(message) message.textContent=created+" rencontre(s) préparée(s). Les fiches déjà ouvertes et leurs cotes n’ont pas été modifiées.";
      await window.initialiserPronosticsPage();
    } catch(err) {
      console.error(err);
      if(message) message.textContent="Erreur de préparation : "+(err.code||err.message);
    } finally { if(btn) btn.disabled=false; }
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
        uid:user.uid,pseudo,scoreESIVO,scoreAdversaire,
        updatedAt:firebase.firestore.FieldValue.serverTimestamp()
      };
      if(!old.exists) data.createdAt=firebase.firestore.FieldValue.serverTimestamp();
      await ref.set(data,{merge:false});
      if(message) message.textContent="Ton pronostic est enregistré !";
      await window.initialiserPronosticsPage();
    } catch(err) {
      console.error(err);
      if(message) message.textContent="Enregistrement impossible : "+(err.code||err.message)+". Vérifie les règles Firestore.";
    }
  }
})();
