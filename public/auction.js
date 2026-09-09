let sid=null,state=null,syncTimer=null,loading=false,bidBusy=false;
const app=document.getElementById('auctionApp');

async function api(url,data={}){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const text=await r.text(); let j;
  try{j=JSON.parse(text)}catch{throw new Error(text||`Request failed (${r.status})`)}
  if(!r.ok||j.ok===false)throw new Error(j.error||j.message||`Request failed (${r.status})`);
  return j;
}
function money(n){return `₹${Number(n||0).toFixed(1)} Cr`}
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function roleIcon(role){return ({'Batsmen':'🏏','Bowlers':'🎯','All Rounders':'⭐','Wicket Keepers':'🧤','Unsold Players':'🔁'})[role]||'•'}
function closeRemaining(){return state?.waitingForClose&&state.closeAt?Math.max(0,Math.ceil((state.closeAt-Date.now())/1000)):0}
function roleCounts(t){const c={};for(const p of t.squad||[])c[p.pool]=(c[p.pool]||0)+1;return c}
function renderTeam(t){
  const c=roleCounts(t);
  return `<div class="auction-team-card"><strong>${esc(t.name)}</strong><span>Purse: ${money(t.purse)}</span><small>${t.squad.length}/6 players</small><div class="auction-role-mini">🏏 ${c['Batsmen']||0} &nbsp; 🎯 ${c['Bowlers']||0} &nbsp; ⭐ ${c['All Rounders']||0} &nbsp; 🧤 ${c['Wicket Keepers']||0}</div><div class="auction-squad-mini">${t.squad.map(x=>`${esc(x.name)} (${money(x.price)})`).join(', ')||'No purchases yet'}</div></div>`;
}
function render(){
  if(!state)return;
  if(state.done){
    clearInterval(syncTimer);
    app.innerHTML=`<div class="auction-results card"><h2>🏆 Auction Complete</h2><p>The main auction is followed by the <b>Unsold Players</b> second-chance pool. Every unsold player gets one more opportunity. Teams with fewer than 5 buys or without at least 1 batsman, 1 bowler and 1 wicket keeper are disqualified.</p><div class="auction-final-rules"><b>Winner assessment:</b> player ratings, squad variety, role availability, purse-spending tactic and overall auction strategy.</div><button class="btn" onclick="results()"><span>Evaluate Teams</span></button><div id="results"></div></div>`;
    return;
  }
  const p=state.current;
  if(!p){ app.innerHTML='<div class="card"><h2>Preparing the next auction pool…</h2></div>'; return; }
  const counts=state.poolCounts||{'Batsmen':6,'Bowlers':6,'All Rounders':5,'Wicket Keepers':3};
  const poolSummary=Object.entries(counts).map(([role,n])=>`<span>${roleIcon(role)} ${esc(role)}: ${n}</span>`).join('');
  const waiting=state.waitingForClose, close=closeRemaining();
  const leader=state.currentBidder?state.teams[state.currentBidder].name:null;
  const yourTeam=state.teams?.player, squadComplete=yourTeam&&yourTeam.squad.length>=6;
  const finalChance=!!state.finalChance;
  const status=finalChance
    ? '🔔 FINAL CALL — Your Team gets the last chance. Raise the bid or confirm No Interest to close.'
    : waiting
      ? `🔨 Auctioneer: ${close>0?`Bid accepted. ${close}s pause before the next bid.`:'Processing the next bid…'}`
      : '🎙️ Auctioneer: Bidding is open. Take your time.';
  const teamIds=['player','agent1','agent2'];
  const teamBoxes=teamIds.map(id=>{
    const t=state.teams[id], sig=state.teamSignals?.[id], c=roleCounts(t);
    const isPlayer=id==='player';
    const disabled=squadComplete||waiting||bidBusy;
    return `<div class="auction-team-box ${isPlayer?'player-team-box':''} ${sig?.type==='bid'?'bid-flash':''}">
      <div class="auction-team-box-head"><div><strong>${esc(t.name)}</strong><small>${t.squad.length}/6 players · Purse ${money(t.purse)}</small></div><div class="auction-bid-symbol">${sig?.type==='bid'?'💰':''}</div></div>
      <div class="auction-role-mini">🏏 ${c['Batsmen']||0} · 🎯 ${c['Bowlers']||0} · ⭐ ${c['All Rounders']||0} · 🧤 ${c['Wicket Keepers']||0}</div>
      <div class="auction-team-action">${isPlayer
        ? `<button class="btn auction-bid-btn" ${disabled?'disabled':''} onclick="bid()"><span>${squadComplete?'🔒 Squad Complete':'💰 Bid + ₹0.5 Cr'}</span></button><button class="btn auction-skip-btn" ${bidBusy||(!finalChance&&!state.current)?'disabled':''} onclick="skipPlayer()"><span>🚫 No Interest</span></button>`
        : `<div class="ai-live-action ${sig?.type==='bid'?'active':''}">${sig?.type==='bid'?`💰 ${esc(sig.text)}`:'🤖 Waiting / NO INTEREST'}</div>`}</div>
      <div class="auction-squad-mini">${t.squad.map(x=>`${esc(x.name)} (${money(x.price)})`).join(', ')||'No purchases yet'}</div>
    </div>`;
  }).join('');
  app.innerHTML=`
    <div class="auction-rules card compact-rules"><div><b>${state.phase==='unsold'?'🔁 Unsold Players — Second Chance Pool':'🏏 20-player Main Auction'}</b> · No fixed countdown</div><div class="auction-pool-list">${poolSummary}</div><div><b>Squad:</b> 5–6 buys · 🧤 WK + 🏏 batsman + 🎯 bowler required · Bidding locks at 6 players</div></div>
    <div class="auction-top-compact">
      <div class="auction-player-card card">
        <div class="auction-player-head"><h2>${esc(p.name)}</h2><span class="auction-tag">${esc(p.pool)}</span></div>
        <div class="auction-stats"><span>⭐ ${p.rating}/100</span><span>Base ${money(p.base)}</span><span>🔨 Current ${money(state.currentBid)}</span></div>
        <p class="auction-leader">${leader?`Highest bid: <b>${esc(leader)}</b>`:'No accepted bid yet'}</p>
        <div class="auction-status ${waiting||finalChance?'waiting':''}">${status}</div>
        ${finalChance?'<div class="final-call-box">⚠️ Final chance: bid once more, or press <b>No Interest</b> to confirm that the auctioneer may close this player.</div>':''}
      </div>
      <div class="auction-log card"><h3>Live Auction Updates</h3><div class="auction-log-scroll">${state.logs.slice().reverse().map(x=>`<p>${esc(x)}</p>`).join('')}</div></div>
    </div>
    <div class="auction-teams-bottom">${teamBoxes}</div>
    <div class="auction-next-row">${state.auctionClosed?`<div class="auction-closed">🔨 ${state.currentBidder?'SOLD':'UNSOLD'} — Auction closed.</div><button class="btn" onclick="nextPlayer()"><span>${state.index+1>=state.total?(state.phase==='main'?'Open Unsold Players Pool →':'Finish Auction'):'Next Player →'}</span></button>`:''}</div>`;
}

async function start(){
  try{loading=true;app.innerHTML='<div class="card"><h2>🏏 Preparing 20-player Auction</h2><p>No fixed auction timer. You control the pace; the auctioneer closes after 3 seconds without a higher bid.</p></div>';state=await api('/api/auction/start',{teamName:'Player Team'});sid=state.sessionId;render();clearInterval(syncTimer);syncTimer=setInterval(tick,900);}
  catch(e){app.innerHTML=`<div class="card"><h2>Unable to start auction</h2><p>${esc(e.message)}</p><button class="btn" onclick="start()"><span>Try Again</span></button></div>`}
  finally{loading=false}
}
async function tick(){if(!sid||loading)return;try{state=await api('/api/auction/tick',{sessionId:sid});render()}catch(e){console.error('Auction sync:',e.message)}}
async function bid(){if(bidBusy)return;bidBusy=true;try{state=await api('/api/auction/bid',{sessionId:sid});render()}catch(e){alert(e.message)}finally{bidBusy=false;render()}}
async function skipPlayer(){if(bidBusy)return;bidBusy=true;try{state=await api('/api/auction/skip',{sessionId:sid});render()}catch(e){alert(e.message)}finally{bidBusy=false;render()}}
async function nextPlayer(){try{state=await api('/api/auction/next',{sessionId:sid});render()}catch(e){alert(e.message)}}
async function results(){
  try{const r=await api('/api/auction/results',{sessionId:sid});document.getElementById('results').innerHTML=`<h2>🏆 Winner: ${esc(r.winner.name)} ${r.winner.disqualified?'(all teams disqualified)':''}</h2>`+r.ranked.map((x,i)=>{const b=x.analysis?.breakdown||{},roles=x.analysis?.roleCounts||{};const status=x.disqualified?`❌ DISQUALIFIED — ${esc((x.analysis?.reasons||[]).join('; '))}`:`✅ Eligible`;return `<div class="card auction-result-card"><h3>#${i+1} ${esc(x.name)} — ${x.score}/100</h3><p><b>${status}</b></p><p>Rating: ${x.analysis?.avgRating||0} avg · Spent: ${money(x.spent)} · Remaining: ${money(x.remaining)} · Avg buy: ${money(x.analysis?.avgPrice||0)}</p><p>🏏 ${roles['Batsmen']||0} · 🎯 ${roles['Bowlers']||0} · ⭐ ${roles['All Rounders']||0} · 🧤 ${roles['Wicket Keepers']||0}</p><p><b>Assessment:</b> Rating ${b.rating||0}/25 · Variety ${b.variety||0}/20 · Role availability ${b.roleAvailability||0}/20 · Squad completeness ${b.squadCompleteness||0}/10 · Spending tactic ${b.spendingTactic||0}/15 · Strategy/fit ${b.strategyFit||0}/10</p><p><b>Players:</b> ${x.squad.map(p=>`${esc(p.name)} — ${money(p.price)}`).join(', ')||'No players purchased'}</p></div>`}).join('')}
  catch(e){alert(e.message)}
}
start();
