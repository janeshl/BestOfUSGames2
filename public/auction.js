let sid=null,state=null,timer=null,loading=false;
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
function render(){
 if(!state)return;
 if(state.done){clearInterval(timer);app.innerHTML=`<div class="auction-results card"><h2>🔨 All 13 Players Auctioned</h2><p>All pools are complete. Evaluate the three squads.</p><button class="btn" onclick="results()"><span>Evaluate Teams</span></button><div id="results"></div></div>`;return}
 const p=state.current,left=Math.max(0,Math.ceil((state.roundEndsAt-Date.now())/1000));
 const teams=Object.values(state.teams).map(t=>`<div class="auction-team-card"><strong>${esc(t.name)}</strong><span>Purse: ${money(t.purse)}</span><small>${t.squad.length} players</small><div class="auction-squad-mini">${t.squad.map(x=>esc(x.name)).join(', ')||'No purchases yet'}</div></div>`).join('');
 app.innerHTML=`
 <div class="auction-teams-top">${teams}</div>
 <div class="auction-pool-banner">POOL: ${esc(state.poolName)} <span>Player ${state.index+1}/${state.total}</span></div>
 <div class="auction-main compact-auction">
   <div class="auction-player-card card">
    <div class="auction-player-head"><h2>${esc(p.name)}</h2><span class="auction-tag">${esc(p.tag)}</span></div>
    <div class="auction-stats"><span>⭐ ${p.rating}/100</span><span>Base ${money(p.base)}</span><span>🔨 Bid ${money(state.currentBid)}</span></div>
    <div class="auction-timer">⏱ <b>${left}s</b></div>
    <p class="auction-leader">${state.currentBidder?`Highest bidder: <b>${esc(state.teams[state.currentBidder].name)}</b>`:'No bids yet'}</p>
    ${state.auctionClosed ? `<div class="auction-closed">🔨 Auction closed</div><button class="btn" onclick="nextPlayer()"><span>${state.index+1>=state.total?'Finish Auction':'Next Player →'}</span></button>` : `<button class="btn" ${left<=0?'disabled':''} onclick="bid()"><span>Bid + ₹0.5 Cr</span></button>`}
   </div>
   <div class="auction-log card"><h3>Live Auction Updates</h3><div class="auction-log-scroll">${state.logs.slice().reverse().map(x=>`<p>${esc(x)}</p>`).join('')}</div></div>
 </div>`;
}
async function start(){try{loading=true;app.innerHTML='<div class="card"><h2>🏏 Preparing Auction</h2><p>AI is selecting a fresh pool of real cricketers...</p></div>';state=await api('/api/auction/start',{teamName:'Player Team'});sid=state.sessionId;render();timer=setInterval(tick,1000)}catch(e){app.innerHTML=`<div class="card"><h2>Unable to start auction</h2><p>${esc(e.message)}</p><button class="btn" onclick="start()"><span>Try Again</span></button></div>`}finally{loading=false}}
async function tick(){if(!sid||loading)return;try{state=await api('/api/auction/tick',{sessionId:sid});render()}catch(e){console.error(e)}}
async function bid(){try{state=await api('/api/auction/bid',{sessionId:sid});render()}catch(e){alert(e.message)}}
async function nextPlayer(){try{state=await api('/api/auction/next',{sessionId:sid});render()}catch(e){alert(e.message)}}
async function results(){try{const r=await api('/api/auction/results',{sessionId:sid});document.getElementById('results').innerHTML=`<h2>🏆 Winner: ${esc(r.winner.name)}</h2>`+r.ranked.map((x,i)=>`<div class="card"><h3>#${i+1} ${esc(x.name)} — ${x.score}/100</h3><p>Spent: ${money(x.spent)} | Remaining: ${money(x.remaining)}</p><p>${x.squad.map(p=>esc(p.name)).join(', ')||'No players purchased'}</p></div>`).join('')}catch(e){alert(e.message)}}
start();
