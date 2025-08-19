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
   5-Round Quiz
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
  let lock = false;
  let tHandle = null;
  let timeLeft = 20;

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
        if(!lock) onExpire();
      }
    }, 1000);
  }

  async function submitAnswer(choiceIndex, clickedEl){
    if(lock) return; lock = true;
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

      if(clickedEl){
        clickedEl.style.borderColor = json.correct ? 'rgba(51,200,120,.8)' : 'rgba(255,80,80,.8)';
      } else {
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
        return;
      }

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

    (options || []).forEach((opt, i) => {
      const d = document.createElement('div');
      d.className = 'option';
      d.textContent = (i+1) + '. ' + opt;
      d.onclick = () => submitAnswer(i+1, d);
      optsEl.appendChild(d);
    });

    startTimer(() => submitAnswer(0, null));
  }

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
   Find the Character
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

// Future Price Prediction (hardened flow)
(function(){
  const card = document.getElementById('fpp-card');
  if(!card) return;

  const startForm   = document.getElementById('fpp-start');
  const intro       = document.getElementById('fpp-intro');
  const qaWrap      = document.getElementById('fpp-qa');
  const status      = document.getElementById('fpp-status');
  const qEl         = document.getElementById('fpp-question');
  const yesBtn      = document.getElementById('fpp-yes');
  const noBtn       = document.getElementById('fpp-no');
  const actions     = document.getElementById('fpp-actions');
  const genBtn      = document.getElementById('fpp-generate');
  const guessWrap   = document.getElementById('fpp-guess-wrap');
  const guessInput  = document.getElementById('fpp-guess');
  const submitGuess = document.getElementById('fpp-submit-guess');
  const out         = document.getElementById('fpp-out');

  let token = null;
  let product = null;
  let currency = null;
  let currentPrice = null;
  let questions = [];
  let ix = 0;
  let busy = false;
  const answers = new Array(10).fill(false);

  function show(el){ if(el) el.classList.remove('hidden'); }
  function hide(el){ if(el) el.classList.add('hidden'); }
  function set(txt){ if(out) out.textContent = txt; }
  function guard() { return token && Array.isArray(questions) && questions.length === 10; }

  function renderQuestion(){
    status.textContent = `Question ${ix+1} of 10`;
    qEl.textContent = questions[ix] || '';
  }

  startForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    set('');
    const category = startForm.category.value.trim();
    try{
      const res = await fetch('/api/fpp/start', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ category: category || undefined })
      });
      const json = await res.json();
      if(!json.ok){
        set('Error: ' + (json.error || 'Unknown error'));
        busy = false; return;
      }
      token = json.token;
      product = json.product;
      currency = json.currency;
      currentPrice = json.currentPrice;
      questions = Array.isArray(json.questions) ? json.questions.slice(0,10) : [];

      intro.style.display = 'block';
      intro.textContent = `Product: ${product} — Current Price: ${currency} ${currentPrice}`;

      ix = 0;
      show(qaWrap); hide(actions); hide(guessWrap);
      renderQuestion();
    }catch{
      set('Network error. Please try again.');
    } finally {
      busy = false;
    }
  });

  function answer(val){
    if (!guard()) { set('Session not ready. Please start again.'); return; }
    answers[ix] = !!val;
    ix += 1;
    if(ix < 10){
      renderQuestion();
    }else{
      hide(qaWrap);
      show(actions);
    }
  }

  yesBtn?.addEventListener('click', ()=> answer(true));
  noBtn ?.addEventListener('click', ()=> answer(false));

  genBtn?.addEventListener('click', async ()=>{
    if (busy) return;
    if (!guard()) { set('Session not ready. Please start again.'); return; }
    busy = true;
    set('💹 Preparing the 5-year scenario...');
    try{
      const res = await fetch('/api/fpp/answers', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, answers })
      });
      const json = await res.json();
      if(!json.ok){
        set('Error: ' + (json.error || 'Unknown error'));
        busy = false; return;
      }
      set(`All set. Now enter your 5-year price guess for ${product}.`);
      show(guessWrap);
    }catch{
      set('Network error. Please try again.');
    } finally {
      busy = false;
    }
  });

  submitGuess?.addEventListener('click', async ()=>{
    if (busy) return;
    if (!guard()) { set('Session not ready. Please start again.'); return; }
    const g = Number(guessInput.value);
    if(!Number.isFinite(g)){ set('Please enter a numeric guess.'); return; }
    busy = true;
    set('🔢 Checking your guess...');
    try{
      const res = await fetch('/api/fpp/guess', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, guess: g })
      });
      const json = await res.json();
      if(!json.ok){
        set('Error: ' + (json.error || 'Unknown error'));
        busy = false; return;
      }
      set(
        (json.win
          ? `🎉 Great guess! You Won.\n\n`
          : `❌ Not quite. Better luck next time!\n\n`)
        + `Your Guess: ${json.currency} ${json.playerGuess}\n`
        + `AI Price:  ${json.currency} ${json.aiPrice}\n\n`
        + (json.explanation || '')
      );
      guessInput.value = '';
      // Invalidate token after result (server deletes on success)
      token = null;
    }catch{
      set('Network error. Please try again.');
    } finally {
      busy = false;
    }
  });
})();

/* ========================
   Healthy Diet
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

      for(let i=0;i<r1Inputs.length;i++){
        const qEl = document.getElementById('hd-q'+(i+1));
        if(qEl) qEl.textContent = questions[i] || ('Question '+(i+1));
      }
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
   Budget Glam Builder — Bucketed list + 3 skin tips
   - Group items by category, show name + 1-sentence description
   - Auto-finish on timer (fail if <12)
   - Early finish allowed (fail if <12)
   - Over-budget guard
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

  // Review + Results sections (already in glam.html)
  const reviewSec   = document.querySelector('#glam-review');
  const reviewMeta  = document.querySelector('#glam-review-meta');
  const reviewList  = document.querySelector('#glam-review-list');
  const generateBtn = document.querySelector('#glam-generate');

  const resultsSec  = document.querySelector('#glam-results');
  const outEl       = document.querySelector('#glam-out');
  const detailList  = document.querySelector('#glam-detail');

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
      if(timeLeft <= 0){
        clearTimer();
        // Auto-finish with current picks; fail if <12
        generateResults(true);
      }
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

  // Helper: make a single sentence from product info
  function oneSentence(p){
    const desc = (p.description || '').trim();
    if(desc){
      // First sentence only
      const m = desc.match(/[^.!?]+[.!?]?/);
      if(m) return m[0].trim().replace(/\s+/g,' ');
    }
    // Fallback: generic line by category / eco tag
    const cat = (p.category || 'Product').toLowerCase();
    const eco = p.ecoFriendly ? ' Eco-friendly choice.' : '';
    return `A ${cat} suitable for everyday use.${eco}`.trim();
  }

  // Render a bucketed page view (by category) with clickable items
  function renderBucketed(container, indices, clickable=true){
    container.innerHTML = '';
    if(!indices.length){
      container.textContent = 'No items.';
      return;
    }

    // Group by category
    const groups = {};
    for(const idx of indices){
      const p = items[idx];
      const cat = p?.category || 'Other';
      if(!groups[cat]) groups[cat] = [];
      groups[cat].push(idx);
    }

    // Deterministic category order: common first, then alpha
    const preferred = ['Sunscreen','Cleanser','Moisturizer','Serum','Exfoliant','Toner','Eye Cream','Mask','Lip Care','Body','Hair','Primer','Spot Treatment','Other'];
    const cats = Object.keys(groups).sort((a,b)=>{
      const ia = preferred.indexOf(a); const ib = preferred.indexOf(b);
      if(ia !== -1 || ib !== -1){
        return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
      }
      return a.localeCompare(b);
    });

    for(const cat of cats){
      const head = document.createElement('div');
      head.className = 'card-copy';
      head.textContent = `• ${cat}`;
      head.style.margin = '8px 0 4px';
      container.appendChild(head);

      for(const idx of groups[cat]){
        const p = items[idx];
        const row = document.createElement('div');
        row.className = 'option';
        row.style.whiteSpace = 'pre-wrap';
        row.style.cursor = clickable ? 'pointer' : 'default';
        row.style.background = selected.has(idx) && clickable ? 'rgba(80,200,120,.2)' : '';

        // Name + price (first line)
        const line1 = `${p.name} — ₹${p.price}`;
        // One-sentence description (second line)
        const line2 = oneSentence(p);

        row.textContent = `${line1}\n${line2}`;
        if(clickable){
          row.onclick = ()=>{
            if(finishing) return;

            if(selected.has(idx)){
              selected.delete(idx);
              row.style.background = '';
              updateHUD();
              return;
            }
            const prospective = currentSpend() + (Number(p.price)||0);
            if(prospective > budgetInr){
              showToast(`🚫 Over budget: selecting this would cost ₹${prospective} (> ₹${budgetInr})`);
              return;
            }
            selected.add(idx);
            row.style.background = 'rgba(80,200,120,.2)';
            updateHUD();
          };
        }

        container.appendChild(row);
      }
    }
  }

  function renderPage(){
    const start = page * perPage;
    const end   = Math.min(items.length, start + perPage);
    const idxs  = [];
    for(let i=start; i<end; i++) idxs.push(i);
    renderBucketed(listEl, idxs, /*clickable*/ true);

    prevBtn.disabled = page === 0 || finishing;
    nextBtn.disabled = end >= items.length || finishing;

    updateHUD();
  }

  // Step 2: Review (if >=12 picks). If <12, go straight to results (fail).
  function goToReview(){
    clearTimer();
    if(selected.size < 12){
      // Finish now even with <12 → immediate results (failed)
      generateResults(false);
      return;
    }

    finishing = true;
    hide(hud); hide(listEl); hide(pagerRow); hide(actionsRow);

    const spend = currentSpend();
    reviewMeta.textContent = `You selected ${selected.size} items, Spend: ₹${spend} / Budget: ₹${budgetInr} | Time: ${180 - Math.max(0,timeLeft)}s`;

    // Render selected items bucketed (not clickable)
    const chosen = Array.from(selected);
    renderBucketed(reviewList, chosen, /*clickable*/ false);
    show(reviewSec);
  }

  // Build 3 skin tips (context aware)
  function skinTips(selItems){
    const hasSPF = selItems.some(p => {
      const text = `${p.name} ${p.category} ${(p.tags||[]).join(' ')}`.toLowerCase();
      return text.includes('spf') || text.includes('sunscreen') || (p.category||'').toLowerCase()==='sunscreen';
    });

    if(!hasSPF){
      return [
        "Add a broad-spectrum SPF 30+ to your daytime routine.",
        "Apply two-finger rule for face/neck; reapply every 2–3 hours outdoors.",
        "Seek shade 10am–4pm and wear sunglasses/hat for extra protection."
      ];
    }
    return [
      "Reapply sunscreen every 2–3 hours, and after sweat or towel-dry.",
      "Use the two-finger rule for adequate coverage; don't forget ears and neck.",
      "Combine SPF with shade and sunglasses for best protection."
    ];
  }

  // Step 3: Generate Results (server scoring)
  async function generateResults(autoTimed = false){
    if(finishing && !autoTimed) return; // prevent accidental double calls
    finishing = true;

    hide(hud); hide(listEl); hide(pagerRow); hide(actionsRow); hide(reviewSec);
    outEl.textContent = 'Scoring your kit...';
    detailList.innerHTML = '';
    show(resultsSec);

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
        return;
      }

      const selItems = Array.from(selected).map(i=>items[i]);
      const tips = skinTips(selItems);

      // Summary block
      const pos = Array.isArray(json.positives) ? json.positives.slice(0,6) : [];
      const neg = Array.isArray(json.negatives) ? json.negatives.slice(0,6) : [];
      const lines = [];
      lines.push(json.win ? '🎉 Great build!' : '❌ Run failed.');
      lines.push(`Score: ${json.score}/100`);
      if(json.summary) lines.push(json.summary);
      lines.push(`Budget: ₹${json.budgetInr} | Spend: ₹${json.totalSpend} | Picks: ${selected.size} | Time: ${json.timeTaken}s`);
      if(pos.length){
        lines.push('\n👍 Positives:');
        pos.forEach((p,i)=>lines.push(`  ${i+1}. ${p}`));
      }
      if(neg.length){
        lines.push('\n⚠️ Points to improve:');
        neg.forEach((n,i)=>lines.push(`  ${i+1}. ${n}`));
      }
      // 3 skin tips
      lines.push('\n🧴 Skin Protection Tips:');
      tips.forEach((t,i)=> lines.push(`  ${i+1}. ${t}`));
      outEl.textContent = lines.join('\n');

      // Two-sentence blurb per product (keep)
      detailList.innerHTML = '';
      selItems.forEach((p) => {
        const div = document.createElement('div');
        div.className = 'option';
        const tags = [...(p.tags||[]), p.category].filter(Boolean).slice(0,4);
        const tagTxt = tags.length ? ` [${tags.join(' · ')}]` : '';
        const s1 = `${p.name}${tagTxt} — ₹${p.price}.`;
        const s2 = (p.description && p.description.trim().length)
          ? `${oneSentence(p)}`
          : `Useful addition to round out your routine.`;
        div.textContent = `${s1} ${s2}`;
        detailList.appendChild(div);
      });
    }catch{
      outEl.textContent = 'Network error.';
    }
  }

  prevBtn.addEventListener('click', ()=>{ if(page>0 && !finishing){ page--; renderPage(); } });
  nextBtn.addEventListener('click', ()=>{ if((page+1)*perPage < items.length && !finishing){ page++; renderPage(); } });

  // Allow finishing before 12 picks — marked failed by server/results
  finishBtn.addEventListener('click', (e)=>{
    e.preventDefault();
    if(selected.size < 12){
      generateResults(false); // immediate results (failed)
    } else {
      goToReview();           // review first if valid
    }
  });

  generateBtn.addEventListener('click', (e)=>{ e.preventDefault(); generateResults(false); });

  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    finishing = false;

    // Reset screens
    hide(reviewSec); hide(resultsSec);
    outEl.textContent = ''; detailList.innerHTML = '';
    listEl.textContent = 'Loading...';

    const gender = form.gender.value;
    const budget = Number(form.budget.value);

    // Hide the form once game starts
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
        form.style.display = '';
        return;
      }

      token      = json.token;
      items      = Array.isArray(json.items) ? json.items : [];
      budgetInr  = Number(json.budgetInr) || budget || 0;
      selected.clear();
      page = 0;

      hud.classList.remove('hidden');
      listEl.classList.remove('hidden');
      pagerRow.classList.remove('hidden');
      actionsRow.classList.remove('hidden');

      renderPage();
      startTimer();
    }catch{
      listEl.textContent = 'Network error';
      form.style.display = '';
    }
  });
})();
