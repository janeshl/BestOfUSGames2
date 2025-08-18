function $(s){return document.querySelector(s)}
function $all(s){return Array.from(document.querySelectorAll(s))}
function setText(e,t){if(e)e.textContent=t}
function html(e,m){if(e)e.innerHTML=m}

/* ========================
   Predict the Future
======================== */
(function(){
  const form = $('#f-form');
  const out = $('#f-out');
  if(!form || !out) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setText(out, "🔮 Summoning prophecies...");
    const data = { name: form.name?.value, birthMonth: form.birthMonth?.value, favoritePlace: form.place?.value };
    try{
      const res = await fetch('/api/predict-future', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
      const json = await res.json();
      setText(out, json.ok ? json.content : ('Error: ' + (json.error || 'Unknown error')));
      if (form.name) form.name.value='';
      if (form.birthMonth) form.birthMonth.selectedIndex=0;
      if (form.place) form.place.value='';
    }catch{ setText(out, 'Network error. Please try again.'); }
  });
})();

/* ========================
   5-Round Quiz with 20s timer, win/lose message
======================== */
(function(){
  const startForm = document.querySelector('#quiz-start');
  if(!startForm) return;

  const area   = document.querySelector('#quiz-area');
  const status = document.querySelector('#quiz-status');
  const timerEl= document.querySelector('#quiz-timer');
  const qEl    = document.querySelector('#quiz-question');
  const optsEl = document.querySelector('#quiz-options');
  const explEl = document.querySelector('#quiz-expl');
  const nextEl = document.querySelector('#quiz-next');

  let token = null;
  let lock = false;           // prevents double answers
  let tHandle = null;         // interval handle
  let timeLeft = 20;          // seconds per question

  function clearTimer(){
    if(tHandle){ clearInterval(tHandle); tHandle = null; }
  }
  function startTimer(onExpire){
    clearTimer();
    timeLeft = 20;
    timerEl.textContent = `⏱ ${timeLeft}s`;
    tHandle = setInterval(()=>{
      timeLeft -= 1;
      timerEl.textContent = `⏱ ${timeLeft}s`;
      if(timeLeft <= 0){
        clearTimer();
        if(!lock) onExpire(); // auto-mark wrong
      }
    }, 1000);
  }

  async function submitAnswer(choiceIndex, clickedEl){
    if(lock) return; lock = true;
    // stop inputs
    Array.from(optsEl.children).forEach(n => n.style.pointerEvents='none');
    clearTimer();

    try{
      const res  = await fetch('/api/quiz/answer', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ token, choice: choiceIndex })
      });
      const json = await res.json();
      if(!json.ok){
        nextEl.innerHTML = '<div class="pill">Error: '+(json.error||'Unknown')+'</div>';
        lock = false; return;
      }

      // show correctness styling if we had a clicked option
      if(clickedEl){
        clickedEl.style.borderColor = json.correct ? 'rgba(51,200,120,.8)' : 'rgba(255,80,80,.8)';
      } else {
        // timeout path: lightly indicate timeout
        nextEl.innerHTML = '<div class="pill">⏳ Time up — counted as wrong.</div>';
      }

      if(json.explanation){
        explEl.textContent = json.explanation;
        explEl.style.display = 'block';
      } else {
        explEl.style.display = 'none';
      }

      if(json.done){
        const msg = json.message || (json.score >= 4
          ? `🎉 Winner! You scored ${json.score}/${json.total}`
          : `❌ Try again. You scored ${json.score}/${json.total}`);
        nextEl.innerHTML = '<div class="pill">'+msg+'</div>';
        return; // end
      }

      // prepare Next button (immediate move or click-to-advance)
      nextEl.innerHTML = '';
      const b = document.createElement('button');
      b.className = 'btn'; b.textContent = 'Next';
      b.onclick = (e) => {
        e.preventDefault();
        renderQuestion(json.next.idx, json.next.total, json.next.question, json.next.options);
      };
      nextEl.appendChild(b);

      lock = false;
    }catch{
      nextEl.innerHTML = '<div class="pill">Network error. Please try again.</div>';
      lock = false;
    }
  }

  function renderQuestion(idx, total, question, options){
    area.style.display = 'block';
    status.textContent = 'Question ' + idx + ' of ' + total;
    qEl.textContent = question || '';
    optsEl.innerHTML = '';
    explEl.style.display = 'none';
    explEl.textContent = '';
    nextEl.innerHTML = '';
    lock = false;

    // Build options
    (options || []).forEach((opt, i) => {
      const d = document.createElement('div');
      d.className = 'option';
      d.textContent = (i+1) + '. ' + opt;
      d.onclick = () => submitAnswer(i+1, d);  // user click path
      optsEl.appendChild(d);
    });

    // Start the 20s timer; on expire, submit choice 0 (always wrong)
    startTimer(() => submitAnswer(0, null));
  }

  // Start quiz
  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const topic = e.target.topic.value.trim();
    e.target.topic.value = '';
    optsEl.innerHTML = '<div class="pill">Preparing quiz...</div>';
    try{
      const res  = await fetch('/api/quiz/start', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ topic })
      });
      const json = await res.json();
      if(!json.ok){ optsEl.innerHTML = 'Error: ' + (json.error || 'Unknown error'); return; }
      token = json.token;
      renderQuestion(json.idx, json.total, json.question, json.options);
    }catch{
      optsEl.innerHTML = 'Network error. Please try again.';
    }
  });
})();

/* ========================
   Find the Character — show ONE hint at rounds 8, 9, 10
======================== */
(function(){
  const startForm = $('#start-form');
  const turnForm = $('#turn-form');
  const chat = $('#chat');
  const rounds = $('#rounds');
  const result = $('#result');
  if(!startForm || !chat) return;
  let sessionId = null, roundsLeft = 10;

  function pushMsg(who, text){
    const d = document.createElement('div'); d.className='msg';
    d.innerHTML = '<b>'+who+':</b> '+text;
    chat.appendChild(d);
    chat.scrollTop = chat.scrollHeight;
  }

  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    html(chat, '<div class="pill">Picking a secret HARD character...</div>');
    const topic = e.target.topic.value.trim();
    e.target.topic.value='';
    try{
      const res = await fetch('/api/character/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ topic }) });
      const json = await res.json();
      if(!json.ok){ html(chat, 'Error: ' + (json.error || 'Unknown error')); return; }
      sessionId = json.sessionId;
      roundsLeft = 10;
      $('#game').style.display = 'block';
      html(chat, '');
      pushMsg('AI', json.message || 'Ask your first yes/no question!');
      setText(rounds, 'Rounds left: ' + roundsLeft);
    }catch{ html(chat, 'Network error. Please try again.'); }
  });

  if(turnForm){
    turnForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if(!sessionId) return;
      const line = $('#userline').value.trim();
      if(!line) return;
      pushMsg('You', line);
      $('#userline').value='';
      try{
        const res = await fetch('/api/character/turn', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sessionId, text: line }) });
        const json = await res.json();
        if(!json.ok){ pushMsg('AI', 'Error: ' + (json.error || 'Unknown error')); return; }

        if(json.answer){ pushMsg('AI', json.answer); }

        // Exactly one hint per round (server sends at most one from rounds 8–10)
        if(Array.isArray(json.hints) && json.hints.length){
          pushMsg('AI', '💡 Hint: ' + json.hints[0]);
        }

        if(json.done){
          if(json.win){
            pushMsg('AI', json.message || '🎉 Congrats! You found it!');
            html(result, '<div class="pill">🎉 Correct! Amazing deduction.</div>');
          } else {
            const correct = json.name ? ` The character was <b>${json.name}</b>.` : '';
            html(result, `<div class="pill">🔚 Better luck next time.${correct}</div>`);
            if(json.message) pushMsg('AI', json.message);
          }
          sessionId = null;
          return;
        }
        if(typeof json.roundsLeft === 'number'){ roundsLeft = json.roundsLeft; setText(rounds, 'Rounds left: ' + roundsLeft); }
      }catch{ pushMsg('AI', 'Network error. Please try again.'); }
    });
  }
})();

/* ========================
   Healthy Diet (defensive: works with 8 or 10 inputs; 2 rounds)
======================== */
(function(){
  const card = document.getElementById('hd-card');
  if(!card) return;

  const loading = document.getElementById('hd-loading');
  const r1 = document.getElementById('hd-round1');
  const r2 = document.getElementById('hd-round2');
  const actions = document.getElementById('hd-actions');
  const out = document.getElementById('hd-output');

  let token = null;
  let questions = [];
  const r1Inputs = r1 ? Array.from(r1.querySelectorAll('input[name^="a"]')) : [];
  const r2Inputs = r2 ? Array.from(r2.querySelectorAll('input[name^="a"]')) : [];
  const totalSlots = r1Inputs.length + r2Inputs.length;
  const answers = new Array(totalSlots || 10).fill("");

  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');

  async function start(){
    try{
      const res = await fetch('/api/healthy/start', { method:'POST' });
      const json = await res.json();
      if(!json.ok){ loading.textContent = 'Error: ' + (json.error || 'Unknown error'); return; }
      token = json.token;
      questions = Array.isArray(json.questions) ? json.questions.slice(0, totalSlots || 10) : [];

      // Fill round 1 labels
      for(let i=0;i<r1Inputs.length;i++){
        const qEl = document.getElementById('hd-q'+(i+1));
        if(qEl) qEl.textContent = questions[i] || ('Question '+(i+1));
      }
      // Fill round 2 labels
      for(let i=0;i<r2Inputs.length;i++){
        const qEl = document.getElementById('hd-q'+(i+1+r1Inputs.length));
        if(qEl) qEl.textContent = questions[i+r1Inputs.length] || ('Question '+(i+1+r1Inputs.length));
      }

      hide(loading); show(r1);
    }catch{
      loading.textContent = 'Network error. Please try again.';
    }
  }

  r1?.addEventListener('submit', (e)=>{
    e.preventDefault();
    const vals = r1Inputs.map(inp => (inp.value || '').trim());
    if(vals.some(x=>!x)) return;
    vals.forEach((v, i) => { answers[i] = v; r1Inputs[i].value=''; });
    hide(r1); show(r2);
  });

  r2?.addEventListener('submit', (e)=>{
    e.preventDefault();
    const vals = r2Inputs.map(inp => (inp.value || '').trim());
    if(vals.some(x=>!x)) return;
    vals.forEach((v, i) => { answers[i + r1Inputs.length] = v; r2Inputs[i].value=''; });
    hide(r2); show(actions);
    out.textContent = "Ready to generate a personalized diet plan based on your answers.";
  });

  document.getElementById('hd-generate')?.addEventListener('click', async ()=>{
    if(!token) return;
    out.textContent = "🥗 Generating your diet plan...";
    try{
      const res = await fetch('/api/healthy/plan', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, answers })
      });
      const json = await res.json();
      out.textContent = json.ok ? (json.plan || "No content") : ('Error: ' + (json.error || 'Unknown error'));
    }catch{
      out.textContent = 'Network error. Please try again.';
    }
  });

  start();
})();

/* ========================
   Budget Glam Builder — fixes:
   - Keep start form hidden after start & after finish
   - Prevent selecting beyond budget
   - Robust Finish Now -> Results view
======================== */
(function(){
  const form = document.querySelector('#glam-start');
  if(!form) return;

  const hud        = document.querySelector('#glam-hud');
  const timerEl    = document.querySelector('#glam-timer');
  const budgetEl   = document.querySelector('#glam-budget');
  const spendEl    = document.querySelector('#glam-spend');
  const countEl    = document.querySelector('#glam-count');
  const pageEl     = document.querySelector('#glam-page');

  const toastEl    = document.querySelector('#glam-toast');

  const listEl     = document.querySelector('#glam-list');
  const pagerRow   = document.querySelector('#glam-pager');
  const prevBtn    = document.querySelector('#glam-prev');
  const nextBtn    = document.querySelector('#glam-next');

  const actionsRow = document.querySelector('#glam-actions');
  const finishBtn  = document.querySelector('#glam-finish');

  const outEl      = document.querySelector('#glam-out');

  let token = null;
  let items = [];
  let page = 0;
  let selected = new Set();
  let tHandle = null;
  let timeLeft = 180;
  let budgetInr = 0;
  let finishing = false;
  const perPage = 10;

  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');

  function showToast(msg){
    if(!toastEl) return;
    toastEl.textContent = msg || '';
    toastEl.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(()=> toastEl.classList.add('hidden'), 2200);
  }

  function clearTimer(){ if(tHandle){ clearInterval(tHandle); tHandle = null; } }
  function startTimer(){
    clearTimer();
    timeLeft = 180;
    timerEl.textContent = `Time: ${timeLeft}s`;
    tHandle = setInterval(()=>{
      timeLeft -= 1;
      if (timeLeft < 0) timeLeft = 0;
      timerEl.textContent = `Time: ${timeLeft}s`;
      if(timeLeft <= 0){ clearTimer(); finishGame(); }
    }, 1000);
  }

  function currentSpend(){
    return Array.from(selected).reduce((sum, idx)=> sum + (Number(items[idx]?.price)||0), 0);
  }

  function updateHUD(){
    budgetEl.textContent = `Budget: ₹${budgetInr}`;
    spendEl.textContent  = `Spend: ₹${currentSpend()}`;
    countEl.textContent  = `Selected: ${selected.size}/12`;
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    pageEl.textContent   = `Page: ${Math.min(page+1, totalPages)}`;
  }

  function renderPage(){
    listEl.innerHTML = '';
    const start = page * perPage;
    const end   = Math.min(items.length, start + perPage);

    for(let i=start; i<end; i++){
      const p = items[i];
      const div = document.createElement('div');
      div.className = 'option';

      const tagsArr = Array.isArray(p.tags) ? p.tags : [];
      const ecoTag = p.ecoFriendly ? 'Eco-Friendly' : null;
      const baseTags = [p.category || null, ecoTag].filter(Boolean);
      const allTags = [...baseTags, ...tagsArr].filter(Boolean).slice(0, 4);
      const tagsStr = allTags.length ? ` [${allTags.join(' · ')}]` : '';

      div.textContent = `${p.name} — ₹${p.price}${tagsStr}\n${p.description || ''}`;
      div.style.whiteSpace = 'pre-wrap';
      div.style.cursor = 'pointer';
      div.style.background = selected.has(i) ? 'rgba(80,200,120,.2)' : '';

      div.onclick = ()=>{
        if(finishing) return; // prevent changes while finishing

        if(selected.has(i)){
          // remove selection
          selected.delete(i);
          div.style.background = '';
          updateHUD();
          return;
        }

        // try add — block if budget would be exceeded
        const prospective = currentSpend() + (Number(p.price)||0);
        if(prospective > budgetInr){
          showToast(`🚫 Over budget: selecting this would cost ₹${prospective} (> ₹${budgetInr})`);
          return;
        }

        // add selection
        selected.add(i);
        div.style.background = 'rgba(80,200,120,.2)';
        updateHUD();
      };

      listEl.appendChild(div);
    }

    prevBtn.disabled = page === 0 || finishing;
    nextBtn.disabled = end >= items.length || finishing;

    updateHUD();
  }

  function renderResults(json){
    // Hide gameplay UI and keep start form hidden (so it doesn't look like we "went back")
    form.style.display = 'none';
    hide(hud); hide(listEl); hide(pagerRow); hide(actionsRow);
    outEl.style.display = 'block';

    const pos = Array.isArray(json.positives) ? json.positives.slice(0,6) : [];
    const neg = Array.isArray(json.negatives) ? json.negatives.slice(0,6) : [];

    const lines = [];
    lines.push(json.win ? '🎉 Great build!' : '❌ Try again.');
    lines.push(`Score: ${json.score}/100`);
    if(json.summary) lines.push(json.summary);
    lines.push(`Budget: ₹${json.budgetInr} | Spend: ₹${json.totalSpend} | Picks: ${selected.size} | Time: ${json.timeTaken}s`);
    if(pos.length){
      lines.push('\n👍 Positives:');
      pos.forEach((p,i)=>lines.push(`  ${i+1}. ${p}`));
    }
    if(neg.length){
      lines.push('\n⚠️ Areas to improve:');
      neg.forEach((n,i)=>lines.push(`  ${i+1}. ${n}`));
    }
    outEl.textContent = lines.join('\n');
  }

  async function finishGame(){
    if(finishing) return;
    finishing = true;
    clearTimer();

    // keep start form hidden (prevents "return" feel)
    form.style.display = 'none';

    outEl.style.display = 'block';
    outEl.textContent = 'Scoring your kit...';

    try{
      const res = await fetch('/api/glam/score', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          token,
          selectedIndices: Array.from(selected),
          timeTaken: 180 - Math.max(0, timeLeft)
        })
      });
      const json = await res.json();
      if(!json.ok){
        outEl.textContent = 'Error: ' + (json.error || 'Unknown error');
        finishing = false;
        return;
      }
      renderResults(json); // ✅ navigate to results view
    }catch{
      outEl.textContent = 'Network error.';
      finishing = false;
    }
  }

  prevBtn.addEventListener('click', ()=>{ if(page>0 && !finishing){ page--; renderPage(); } });
  nextBtn.addEventListener('click', ()=>{ if((page+1)*perPage < items.length && !finishing){ page++; renderPage(); } });
  finishBtn.addEventListener('click', (e)=>{ e.preventDefault(); finishGame(); });

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    finishing = false;
    hide(outEl);
    outEl.textContent = '';
    listEl.textContent = 'Loading...';

    const gender = form.gender.value;
    const budget = Number(form.budget.value);

    // Hide the start form once the game begins to avoid the "jump back" impression
    form.style.display = 'none';

    try{
      const res = await fetch('/api/glam/start', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ gender, budgetInr: budget })
      });
      const json = await res.json();
      if(!json.ok){
        listEl.textContent = 'Error: ' + (json.error || 'Unknown error');
        // Show form back if start failed
        form.style.display = '';
        return;
      }

      token      = json.token;
      items      = Array.isArray(json.items) ? json.items : [];
      budgetInr  = Number(json.budgetInr) || budget || 0;
      selected.clear();
      page = 0;

      show(hud); show(listEl); show(pagerRow); show(actionsRow);
      renderPage();
      startTimer();
    }catch{
      listEl.textContent = 'Network error';
      // Show form back if start failed
      form.style.display = '';
    }
  });
})();
