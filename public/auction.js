let sid=null,state=null,countdownTimer=null,syncTimer=null,loading=false;
const app=document.getElementById('auctionApp');

async function api(url,data={}){
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const text=await r.text();
  let j;
  try{j=JSON.parse(text)}catch{throw new Error(text||`Request failed (${r.status})`)}
  if(!r.ok||j.ok===false)throw new Error(j.error||j.message||`Request failed (${r.status})`);
  return j;
}
function money(n){return `₹${Number(n).toFixed(1)} Cr`}
function esc(v){return String(v??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function roleIcon(role){return ({'Batsmen':'🏏','Bowlers':'🎯','All Rounders':'⭐','Wicket Keepers':'🧤'})[role]||'•'}
function remaining(){return state?Math.max(0,Math.ceil((state.roundEndsAt-Date.now())/1000)):0}
function updateCountdown(){
  const el=document.getElementById('auctionCountdown');
  if(el)el.textContent=`${remaining()}s`;
}
function roleCounts(t){
  const counts={};
  for(const p of t.squad||[])counts[p.pool]=(counts[p.pool]||0)+1;
  return counts;
}
function renderTeam(t){
  const c=roleCounts(t);
  return `<div class="auction-team-card">
    <strong>${esc(t.name)}</strong><span>Purse: ${money(t.purse)}</span><small>${t.squad.length}/6 players</small>
    <div class="auction-role-mini">🏏 ${c['Batsmen']||0} &nbsp; 🎯 ${c['Bowlers']||0} &nbsp; ⭐ ${c['All Rounders']||0} &nbsp; 🧤 ${c['Wicket Keepers']||0}</div>
    <div class="auction-squad-mini">${t.squad.map(x=>`${esc(x.name)} (${money(x.price)})`).join(', ')||'No purchases yet'}</div>
  </div>`;
}
function render(){
  if(!state)return;
  if(state.done){
    clearInterval(syncTimer); clearInterval(countdownTimer);
    app.innerHTML=`<div class="auction-results card">
      <h2>🏆 All 20 Players Auctioned</h2>
      <p>The auction is complete. Teams with fewer than 5 buys or without at least 1 batsman, 1 bowler and 1 wicket keeper are disqualified.</p>
      <div class="auction-final-rules"><b>Winner assessment:</b> player ratings, squad variety, role availability, purse-spending tactic and overall auction strategy.</div>
      <button class="btn" onclick="results()"><span>Evaluate Teams</span></button><div id="results"></div>
    </div>`;
    return;
  }
  const p=state.current,left=remaining(),teams=Object.values(state.teams).map(renderTeam).join('');
  const counts=state.poolCounts||{'Batsmen':6,'Bowlers':6,'All Rounders':5,'Wicket Keepers':3};
  const poolSummary=Object.entries(counts).map(([role,n])=>`<span>${roleIcon(role)} ${esc(role)}: ${n}</span>`).join('');
  const playerNumber=state.index+1;
  app.innerHTML=`
    <div class="auction-rules card">
      <div><b>20-player auction</b> · 4 pools</div>
      <div class="auction-pool-list">${poolSummary}</div>
      <div><b>Squad:</b> 5–6 buys · Must include 🧤 1 WK, 🏏 1 batsman, 🎯 1 bowler</div>
    </div>
    <div class="auction-teams-top">${teams}</div>
    <div class="auction-pool-banner">POOL: ${roleIcon(state.poolName)} ${esc(state.poolName)} <span>Player ${playerNumber}/20</span></div>
    <div class="auction-main compact-auction">
      <div class="auction-player-card card">
        <div class="auction-player-head"><h2>${esc(p.name)}</h2><span class="auction-tag">${esc(p.tag)}</span></div>
        <div class="auction-stats"><span>⭐ ${p.rating}/100</span><span>Base ${money(p.base)}</span><span>🔨 Bid ${money(state.currentBid)}</span></div>
        <div class="auction-timer">⏱ <b id="auctionCountdown">${left}s</b> <small>10-second round</small></div>
        <p class="auction-leader">${state.currentBidder?`Highest bidder: <b>${esc(state.teams[state.currentBidder].name)}</b>`:'No bids yet'}</p>
        ${state.auctionClosed ? `<div class="auction-closed">🔨 Auction closed</div><button class="btn" onclick="nextPlayer()"><span>${playerNumber>=20?'Finish Auction':'Next Player →'}</span></button>` : `<button class="btn" ${left<=0?'disabled':''} onclick="bid()"><span>Bid + ₹0.5 Cr</span></button>`}
      </div>
      <div class="auction-log card"><h3>Live Auction Updates</h3><div class="auction-log-scroll">${state.logs.slice().reverse().map(x=>`<p>${esc(x)}</p>`).join('')}</div></div>
    </div>`;
  updateCountdown();
}
async function start(){
  try{
    loading=true;
    app.innerHTML='<div class="card"><h2>🏏 Preparing 20-player Auction</h2><p>Building 6 batsmen, 6 bowlers, 5 all-rounders and 3 wicket keepers...</p></div>';
    state=await api('/api/auction/start',{teamName:'Player Team'});
    sid=state.sessionId;
    render();
    clearInterval(syncTimer);clearInterval(countdownTimer);
    countdownTimer=setInterval(updateCountdown,250);
    syncTimer=setInterval(tick,2000);
  }catch(e){
    app.innerHTML=`<div class="card"><h2>Unable to start auction</h2><p>${esc(e.message)}</p><button class="btn" onclick="start()"><span>Try Again</span></button></div>`;
  }finally{loading=false}
}
async function tick(){
  if(!sid||loading)return;
  try{state=await api('/api/auction/tick',{sessionId:sid});render();}
  catch(e){console.error('Auction sync:',e.message)}
}
async function bid(){
  try{state=await api('/api/auction/bid',{sessionId:sid});render();}
  catch(e){alert(e.message)}
}
async function nextPlayer(){
  try{state=await api('/api/auction/next',{sessionId:sid});render();}
  catch(e){alert(e.message)}
}
async function results(){
  try{
    const r=await api('/api/auction/results',{sessionId:sid});
    document.getElementById('results').innerHTML=`<h2>🏆 Winner: ${esc(r.winner.name)} ${r.winner.disqualified?'(all teams disqualified)':''}</h2>`+
      r.ranked.map((x,i)=>{
        const b=x.analysis?.breakdown||{};
        const roles=x.analysis?.roleCounts||{};
        const status=x.disqualified?`❌ DISQUALIFIED — ${esc((x.analysis?.reasons||[]).join('; '))}`:`✅ Eligible`;
        return `<div class="card auction-result-card">
          <h3>#${i+1} ${esc(x.name)} — ${x.score}/100</h3>
          <p><b>${status}</b></p>
          <p>Rating: ${x.analysis?.avgRating||0} avg · Spent: ${money(x.spent)} · Remaining: ${money(x.remaining)} · Avg buy: ${money(x.analysis?.avgPrice||0)}</p>
          <p>🏏 ${roles['Batsmen']||0} · 🎯 ${roles['Bowlers']||0} · ⭐ ${roles['All Rounders']||0} · 🧤 ${roles['Wicket Keepers']||0}</p>
          <p><b>Assessment:</b> Rating ${b.rating||0}/25 · Variety ${b.variety||0}/20 · Role availability ${b.roleAvailability||0}/20 · Squad completeness ${b.squadCompleteness||0}/10 · Spending tactic ${b.spendingTactic||0}/15 · Strategy/fit ${b.strategyFit||0}/10</p>
          <p><b>Players:</b> ${x.squad.map(p=>`${esc(p.name)} — ${money(p.price)}`).join(', ')||'No players purchased'}</p>
        </div>`;
      }).join('');
  }catch(e){alert(e.message)}
}
start();
