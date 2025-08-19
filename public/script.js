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

// ===========================
// 💄 Budget Glam Builder (enhanced)
// ===========================
(function () {
  const startForm = document.querySelector('#glam-start');
  if (!startForm) return;

  // UI elements
  const hud        = document.querySelector('#glam-hud');
  const timerEl    = document.querySelector('#glam-timer');
  const budgetEl   = document.querySelector('#glam-budget');
  const spendEl    = document.querySelector('#glam-spend');
  const countEl    = document.querySelector('#glam-count');
  const pageEl     = document.querySelector('#glam-page');

  const listEl     = document.querySelector('#glam-list');
  const pager      = document.querySelector('#glam-pager');
  const prevBtn    = document.querySelector('#glam-prev');
  const nextBtn    = document.querySelector('#glam-next');

  const actions    = document.querySelector('#glam-actions');
  const finishBtn  = document.querySelector('#glam-finish');

  const reviewEl   = document.querySelector('#glam-review');
  const reviewList = document.querySelector('#glam-review-list');
  const genBtn     = document.querySelector('#glam-generate');

  const outEl      = document.querySelector('#glam-out');

  // State
  let token        = null;
  let items        = [];
  let budget       = 0;
  let page         = 0;
  let selected     = new Set();
  let tHandle      = null;
  let timeLeft     = 180; // seconds
  let startedAt    = 0;

  // Helpers
  function show(el) { el && el.classList.remove('hidden'); }
  function hide(el) { el && el.classList.add('hidden'); }
  function set(el, text) { if (el) el.textContent = text; }
  const visibleSlice = () => items.slice(page * 10, page * 10 + 10);
  const selectedTotal = () =>
    [...selected].reduce((sum, idx) => sum + (Number(items[idx]?.price) || 0), 0);

  function updateHUD() {
    set(budgetEl, `Budget: ₹${budget}`);
    set(spendEl, `Spend: ₹${selectedTotal()}`);
    set(countEl, `Selected: ${selected.size}/12`);
    set(pageEl, `Page: ${page + 1}`);
  }

  function clearTimer() {
    if (tHandle) {
      clearInterval(tHandle);
      tHandle = null;
    }
  }

  function startTimer() {
    clearTimer();
    timeLeft = 180;
    startedAt = Date.now();
    set(timerEl, `Time: ${timeLeft}s`);
    tHandle = setInterval(() => {
      timeLeft -= 1;
      set(timerEl, `Time: ${timeLeft}s`);
      if (timeLeft <= 0) {
        clearTimer();
        // Auto-finish: show review and allow generating results.
        goToReview(true);
      }
    }, 1000);
  }

  function renderList() {
    listEl.innerHTML = '';
    const slice = visibleSlice();

    slice.forEach((p, offset) => {
      const idx = page * 10 + offset;
      const d = document.createElement('div');
      d.className = 'option';

      const tags = Array.isArray(p.tags) ? p.tags : [];
      d.innerHTML = `
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
          <div>
            <div style="font-weight:600">${p.name}</div>
            <div style="opacity:.8">${p.description}</div>
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
              <span class="badge">${p.category}</span>
              ${p.ecoFriendly ? '<span class="badge">eco</span>' : ''}
              ${tags.map(t => `<span class="badge">${String(t)}</span>`).join('')}
            </div>
          </div>
          <div style="white-space:nowrap; font-weight:600">₹${p.price}</div>
        </div>
      `;

      // Selected styling
      if (selected.has(idx)) {
        d.style.background = 'rgba(80,200,120,.15)';
        d.style.borderColor = 'rgba(80,200,120,.5)';
      }

      d.style.cursor = 'pointer';
      d.onclick = () => {
        const price = Number(items[idx]?.price) || 0;
        if (!selected.has(idx)) {
          // Budget guard: block add if it would exceed budget
          const newTotal = selectedTotal() + price;
          if (newTotal > budget) {
            d.style.animation = 'shake .25s';
            setTimeout(() => (d.style.animation = ''), 260);
            outEl.style.display = 'block';
            outEl.textContent = `⚠️ Can't add "${items[idx].name}" — it would exceed your budget (₹${newTotal} > ₹${budget}).`;
            return;
          }
          selected.add(idx);
        } else {
          selected.delete(idx);
        }
        renderList();
        updateHUD();
        // hide any prior warning when user changes selection
        if (outEl.textContent.startsWith('⚠️')) outEl.textContent = '';
      };

      listEl.appendChild(d);
    });

    // Pager visibility
    prevBtn.style.display = page > 0 ? 'inline-block' : 'none';
    nextBtn.style.display = (page + 1) * 10 < items.length ? 'inline-block' : 'none';
    updateHUD();
  }

  function goToReview(autoFinished) {
    // Always hide the start form once the game runs (prevents “start section” from appearing on later pages)
    hide(startForm);

    hide(actions);
    hide(pager);
    hide(listEl);
    clearTimer();

    show(hud);
    show(reviewEl);
    show(genBtn);          // <-- ensure the Generate Results button is visible
    outEl.style.display = 'block';

    // Build review list UI
    reviewList.innerHTML = '';
    if (selected.size === 0) {
      const p = document.createElement('div');
      p.className = 'pill';
      p.textContent = 'No products selected.';
      reviewList.appendChild(p);
    } else {
      [...selected].forEach((idx) => {
        const it = items[idx];
        const row = document.createElement('div');
        row.className = 'option';
        row.innerHTML = `
          <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;">
            <div>
              <div style="font-weight:600">${it.name}</div>
              <div style="opacity:.8">${it.description}</div>
              <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
                <span class="badge">${it.category}</span>
                ${it.ecoFriendly ? '<span class="badge">eco</span>' : ''}
                ${(Array.isArray(it.tags) ? it.tags : []).map(t => `<span class="badge">${String(t)}</span>`).join('')}
              </div>
            </div>
            <div style="white-space:nowrap; font-weight:600">₹${it.price}</div>
          </div>
        `;
        reviewList.appendChild(row);
      });
    }

    // Messaging for auto-finish or too few picks
    const msgs = [];
    if (autoFinished) msgs.push('⏱ Time up — auto-finished with your current selections.');
    if (selected.size < 12) msgs.push('You selected fewer than 12 products; this will be marked as a fail.');
    outEl.textContent = msgs.join(' ') || 'Review your selections, then generate your results.';
  }

  async function generateResults() {
    if (!token) {
      outEl.style.display = 'block';
      outEl.textContent = 'Session not found. Please start again.';
      return;
    }
    outEl.style.display = 'block';
    outEl.textContent = '✨ Crunching your glam score...';

    const timeTaken = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const payload = {
      token,
      selectedIndices: [...selected],
      timeTaken
    };

    try {
      const res = await fetch('/api/glam/score', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      if (!json.ok) {
        outEl.textContent = 'Error: ' + (json.error || 'Unknown error');
        return;
      }

      // Build readable results
      const lines = [];
      lines.push(json.win ? `🎉 Great build! Score ${json.score}/100` : `😢 Failed. Score ${json.score}/100`);
      lines.push(`Budget: ₹${json.budgetInr}   •   Spend: ₹${json.totalSpend}   •   Time: ${json.timeTaken}s`);
      if (json.summary) lines.push('\nSummary: ' + json.summary);

      if (Array.isArray(json.positives) && json.positives.length) {
        lines.push('\nPositives:');
        json.positives.forEach(p => lines.push(` • ${p}`));
      }
      if (Array.isArray(json.negatives) && json.negatives.length) {
        lines.push('\nAreas to improve:');
        json.negatives.forEach(n => lines.push(` • ${n}`));
      }

      // Per-product info
      lines.push('\nYour picks:');
      [...selected].forEach((idx) => {
        const it = items[idx];
        const tagStr = (Array.isArray(it.tags) && it.tags.length) ? ` [${it.tags.join(', ')}]` : '';
        lines.push(` • ${it.name} — ₹${it.price}${tagStr}`);
        lines.push(`   ${it.description}`);
      });

      // Skin tips
      lines.push('\nSkin protection tips:');
      lines.push(' • Use broad-spectrum SPF 30+ daily; reapply every 2–3 hours outdoors.');
      lines.push(' • Layer light → heavy: cleanser → treatment → moisturizer → sunscreen (AM).');
      lines.push(' • Patch test new actives; avoid over-exfoliating to protect the skin barrier.');

      outEl.textContent = lines.join('\n');

      // Lock Generate button after results
      hide(genBtn);
    } catch {
      outEl.textContent = 'Network error while generating results.';
    }
  }

  // Pager
  prevBtn?.addEventListener('click', () => {
    if (page > 0) { page--; renderList(); }
  });
  nextBtn?.addEventListener('click', () => {
    if ((page + 1) * 10 < items.length) { page++; renderList(); }
  });

  // Finish -> Review (keep <12 picks allowed; will fail in scoring)
  finishBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    goToReview(false);
  });

  // Generate results
  genBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    generateResults();
  });

  // Start
  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    // Hide the start section immediately once the game begins
    hide(startForm);

    outEl.style.display = 'block';
    outEl.textContent = 'Loading products...';
    show(hud);
    show(listEl);
    show(pager);
    show(actions);
    hide(reviewEl);
    hide(genBtn);

    const gender = startForm.gender.value;
    const b = Number(startForm.budget.value);
    try {
      const res = await fetch('/api/glam/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gender, budgetInr: b })
      });
      const json = await res.json();
      if (!json.ok) { outEl.textContent = 'Error: ' + (json.error || 'Unknown error'); return; }

      token  = json.token;
      items  = json.items || [];
      budget = json.budgetInr || b;

      // Reset UI state
      page = 0;
      selected.clear();
      outEl.textContent = '';
      outEl.style.display = 'none';

      renderList();
      startTimer();
    } catch {
      outEl.textContent = 'Network error. Please try again.';
      // re-show start if failed to start
      show(startForm);
      hide(hud);
      hide(listEl);
      hide(pager);
      hide(actions);
      hide(reviewEl);
      hide(genBtn);
    }
  });
})();

// ===========================
// 🧩 Riddle Quest (5 rounds, 1 hint per round, win if >=4)
// ===========================
(function () {
  const startForm   = document.querySelector('#riddle-start');
  if (!startForm) return; // Not on this page

  const area        = document.querySelector('#riddle-area');
  const statusEl    = document.querySelector('#riddle-status');
  const scoreEl     = document.querySelector('#riddle-score');
  const hintBadge   = document.querySelector('#riddle-hint-badge');
  const textEl      = document.querySelector('#riddle-text');
  const ansForm     = document.querySelector('#riddle-answer-form');
  const guessInput  = document.querySelector('#riddle-guess');
  const hintBtn     = document.querySelector('#riddle-hint-btn');
  const skipBtn     = document.querySelector('#riddle-skip-btn');
  const feedbackEl  = document.querySelector('#riddle-feedback');

  let token = null;
  let idx = 0;          // 0-based; server returns 1-based display
  let total = 5;
  let score = 0;
  let hintUsed = false; // per-round

  function show(el) { el && (el.style.display = 'block'); }
  function hide(el) { el && (el.style.display = 'none'); }
  function set(el, txt) { if (el) el.textContent = txt; }
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  function renderRound(payload) {
    token   = payload.token || token;
    idx     = (payload.idx || 1) - 1;
    total   = payload.total || 5;
    score   = payload.score ?? score;
    hintUsed= !!payload.hintUsed;

    set(statusEl, `Riddle ${idx + 1} of ${total}`);
    set(scoreEl, `Score: ${score}`);
    set(textEl, payload.riddle || 'No riddle.');
    set(hintBadge, hintUsed ? 'Hint: used' : 'Hint: available');

    guessInput.value = '';
    feedbackEl.textContent = '';
    hide(feedbackEl);
  }

  // Start
  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const theme = startForm.theme.value.trim();
    try {
      const res = await fetch('/api/riddle/start', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ theme: theme || undefined })
      });
      const json = await res.json();
      if (!json.ok) {
        alert('Error: ' + (json.error || 'Unknown error'));
        return;
      }
      renderRound(json);
      startForm.style.display = 'none';
      area.style.display = 'block';
    } catch {
      alert('Network error. Please try again.');
    }
  });

  // Submit answer
  ansForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!token) return;
    const guess = guessInput.value.trim();
    if (!guess) return;

    hide(feedbackEl);
    try {
      const res = await fetch('/api/riddle/answer', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token, guess })
      });
      const json = await res.json();
      if (!json.ok) {
        set(feedbackEl, 'Error: ' + (json.error || 'Unknown error'));
        show(feedbackEl);
        return;
      }

      // End of game?
      if (json.done) {
        const lines = [];
        lines.push(json.win ? `🎉 Winner! You scored ${json.score}/${json.total}` :
                              `😢 Failed! You scored ${json.score}/${json.total}`);
        if (json.explanation) lines.push('\n' + json.explanation);
        set(feedbackEl, lines.join('\n'));
        show(feedbackEl);
        // Lock inputs
        hintBtn.disabled = true;
        guessInput.disabled = true;
        (ansForm.querySelector('button[type="submit"]') || {}).disabled = true;
        skipBtn.disabled = true;
        return;
      }

      // Next round returned
      if (json.correct) {
        set(feedbackEl, (json.explanation ? `✅ Correct!\n${json.explanation}` : '✅ Correct!'));
      } else {
        set(feedbackEl, (json.explanation ? `❌ Incorrect.\n${json.explanation}` : '❌ Incorrect.'));
      }
      show(feedbackEl);
      renderRound(json.next);
    } catch {
      set(feedbackEl, 'Network error. Please try again.');
      show(feedbackEl);
    }
  });

  // Use Hint (once per round)
  hintBtn.addEventListener('click', async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/riddle/hint', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token })
      });
      const json = await res.json();
      if (!json.ok) {
        set(feedbackEl, json.error || 'Unable to fetch hint.');
        show(feedbackEl);
        return;
      }
      set(feedbackEl, `💡 Hint: ${json.hint}`);
      show(feedbackEl);
      // Update hint status
      set(hintBadge, 'Hint: used');
    } catch {
      set(feedbackEl, 'Network error getting hint.');
      show(feedbackEl);
    }
  });

  // Skip current riddle (counts as incorrect, moves on)
  skipBtn.addEventListener('click', async () => {
    if (!token) return;
    try {
      const res = await fetch('/api/riddle/answer', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ token, guess: '__SKIP__' })
      });
      const json = await res.json();
      if (!json.ok) {
        set(feedbackEl, 'Error: ' + (json.error || 'Unknown error'));
        show(feedbackEl);
        return;
      }
      if (json.done) {
        const lines = [];
        lines.push(json.win ? `🎉 Winner! You scored ${json.score}/${json.total}` :
                              `😢 Failed! You scored ${json.score}/${json.total}`);
        if (json.explanation) lines.push('\n' + json.explanation);
        set(feedbackEl, lines.join('\n'));
        show(feedbackEl);
        hintBtn.disabled = true;
        guessInput.disabled = true;
        (ansForm.querySelector('button[type="submit"]') || {}).disabled = true;
        skipBtn.disabled = true;
        return;
      }
      set(feedbackEl, '⏭ Skipped.');
      show(feedbackEl);
      renderRound(json.next);
    } catch {
      set(feedbackEl, 'Network error. Please try again.');
      show(feedbackEl);
    }
  });
})();

