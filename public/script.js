function $(s){return document.querySelector(s)}function $all(s){return Array.from(document.querySelectorAll(s))}function setText(e,t){if(e)e.textContent=t}function html(e,m){if(e)e.innerHTML=m}

// Predict the Future
(function(){
  const form = $('#f-form');
  const out = $('#f-out');
  if(!form || !out) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    setText(out, "🔮 Summoning prophecies...");
    const data = { name: form.name.value, birthMonth: form.birthMonth.value, favoritePlace: form.place.value };
    try{
      const res = await fetch('/api/predict-future', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(data) });
      const json = await res.json();
      setText(out, json.ok ? json.content : ('Error: ' + (json.error || 'Unknown error')));
      form.name.value=''; form.birthMonth.selectedIndex=0; form.place.value='';
    }catch{ setText(out, 'Network error. Please try again.'); }
  });
})();

// 5-Round Quiz with 20s per-question timer (auto-mark wrong on timeout)
// (Now avoids repeating previous questions server-side per topic)
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
        nextEl.innerHTML = '<div class="pill">🏁 Finished! Score: '+json.score+' / '+json.total+'</div>';
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

    startTimer(() => submitAnswer(0, null)); // timeout path
  }

  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const topic = e.target.topic.value;
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

// Find the Character (conversational) — hard level & multiple hints after 7th
(function(){
  const startForm = $('#start-form');
  const turnForm = $('#turn-form');
  const chat = $('#chat');
  const rounds = $('#rounds');
  const result = $('#result');
  const answerBox = $('#answer-box');
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
    const topic = e.target.topic.value;
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

        if(json.answer){ pushMsg('AI', json.answer); if(answerBox){ answerBox.textContent = json.answer; } }

        // Show multiple hints (after round 7)
        if(Array.isArray(json.hints) && json.hints.length){
          json.hints.forEach((h)=> pushMsg('AI', '💡 Hint: ' + h));
        }

        if(json.done){
          if(json.win){
            html(result, '<div class="pill">🎉 Correct! You found the character.</div>');
            pushMsg('AI', json.message || '🎉 Congrats!');
          } else {
            html(result, '<div class="pill">🕵️ Out of rounds.</div>');
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

// Find the Healthy-Diet (8 Qs; 4 + 4; then generate plan)
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
  const answers = new Array(8).fill("");

  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');

  async function start(){
    try{
      const res = await fetch('/api/healthy/start', { method:'POST' });
      const json = await res.json();
      if(!json.ok){ loading.textContent = 'Error: ' + (json.error || 'Unknown error'); return; }
      token = json.token;
      questions = json.questions || [];
      document.getElementById('hd-q1').textContent = questions[0] || 'Question 1';
      document.getElementById('hd-q2').textContent = questions[1] || 'Question 2';
      document.getElementById('hd-q3').textContent = questions[2] || 'Question 3';
      document.getElementById('hd-q4').textContent = questions[3] || 'Question 4';
      document.getElementById('hd-q5').textContent = questions[4] || 'Question 5';
      document.getElementById('hd-q6').textContent = questions[5] || 'Question 6';
      document.getElementById('hd-q7').textContent = questions[6] || 'Question 7';
      document.getElementById('hd-q8').textContent = questions[7] || 'Question 8';
      hide(loading); show(r1);
    }catch{
      loading.textContent = 'Network error. Please try again.';
    }
  }

  r1?.addEventListener('submit', (e)=>{
    e.preventDefault();
    const a1 = r1.a1.value.trim(), a2 = r1.a2.value.trim(), a3 = r1.a3.value.trim(), a4 = r1.a4.value.trim();
    if(!a1 || !a2 || !a3 || !a4) return;
    answers[0]=a1; answers[1]=a2; answers[2]=a3; answers[3]=a4;
    r1.a1.value=''; r1.a2.value=''; r1.a3.value=''; r1.a4.value='';
    hide(r1); show(r2);
  });

  r2?.addEventListener('submit', (e)=>{
    e.preventDefault();
    const a5 = r2.a5.value.trim(), a6 = r2.a6.value.trim(), a7 = r2.a7.value.trim(), a8 = r2.a8.value.trim();
    if(!a5 || !a6 || !a7 || !a8) return;
    answers[4]=a5; answers[5]=a6; answers[6]=a7; answers[7]=a8;
    r2.a5.value=''; r2.a6.value=''; r2.a7.value=''; r2.a8.value='';
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

// Future Price Prediction — fixed flow (answers → guess → reveal)
(function(){
  const card = document.getElementById('fpp-card');
  if(!card) return;

  const startForm = document.getElementById('fpp-start');
  const intro = document.getElementById('fpp-intro');
  const qaWrap = document.getElementById('fpp-qa');
  const status = document.getElementById('fpp-status');
  const qEl = document.getElementById('fpp-question');
  const yesBtn = document.getElementById('fpp-yes');
  const noBtn = document.getElementById('fpp-no');
  const actions = document.getElementById('fpp-actions');
  const genBtn = document.getElementById('fpp-generate');
  const guessWrap = document.getElementById('fpp-guess-wrap');
  const guessInput = document.getElementById('fpp-guess');
  const submitGuess = document.getElementById('fpp-submit-guess');
  const out = document.getElementById('fpp-out');

  let token = null;
  let product = null;
  let currency = null;
  let currentPrice = null;
  let questions = [];
  let ix = 0;
  const answers = new Array(10).fill(false);

  function show(el){ if(el) el.classList.remove('hidden'); }
  function hide(el){ if(el) el.classList.add('hidden'); }

  function renderQuestion(){
    status.textContent = `Question ${ix+1} of 10`;
    qEl.textContent = questions[ix] || '';
  }

  startForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    out.textContent = '';
    const category = startForm.category.value.trim();
    try{
      const res = await fetch('/api/fpp/start', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ category: category || undefined })
      });
      const json = await res.json();
      if(!json.ok){ out.textContent = 'Error: ' + (json.error || 'Unknown error'); return; }
      token = json.token;
      product = json.product;
      currency = json.currency;
      currentPrice = json.currentPrice;
      questions = json.questions || [];

      intro.style.display = 'block';
      intro.textContent = `Product: ${product} — Current Price: ${currency} ${currentPrice}`;

      ix = 0;
      show(qaWrap);
      hide(actions);
      hide(guessWrap);
      renderQuestion();
    }catch{
      out.textContent = 'Network error. Please try again.';
    }
  });

  function answer(val){
    answers[ix] = !!val;
    ix += 1;
    if(ix < 10){
      renderQuestion();
    }else{
      hide(qaWrap);
      show(actions);
    }
  }

  yesBtn?.addEventListener('click', ()=>answer(true));
  noBtn?.addEventListener('click',  ()=>answer(false));

  genBtn?.addEventListener('click', async ()=>{
    if(!token) return;
    out.textContent = '💹 Preparing the 5-year scenario...';
    try{
      const res = await fetch('/api/fpp/answers', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, answers })
      });
      const json = await res.json();
      if(!json.ok){ out.textContent = 'Error: ' + (json.error || 'Unknown error'); return; }
      out.textContent = `All set. Now enter your 5-year price guess for ${product}.`;
      show(guessWrap);
    }catch{
      out.textContent = 'Network error. Please try again.';
    }
  });

  submitGuess?.addEventListener('click', async ()=>{
    if(!token) return;
    const g = Number(guessInput.value);
    if(!isFinite(g)){ out.textContent = 'Please enter a numeric guess.'; return; }
    out.textContent = '🔢 Checking your guess...';
    try{
      const res = await fetch('/api/fpp/guess', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ token, guess: g })
      });
      const json = await res.json();
      if(!json.ok){ out.textContent = 'Error: ' + (json.error || 'Unknown error'); return; }

      out.textContent =
        (json.win
          ? `🎉 Great guess! You matched within 60%.\n\nYour Guess: ${json.currency} ${json.playerGuess}\nAI Price:  ${json.currency} ${json.aiPrice}\n\n${json.explanation || ''}`
          : `❌ Not quite. Better luck next time!\n\nYour Guess: ${json.currency} ${json.playerGuess}\nAI Price:  ${json.currency} ${json.aiPrice}\n\n${json.explanation || ''}`
        );

      guessInput.value = '';
    }catch{
      out.textContent = 'Network error. Please try again.';
    }
  });
})();

// Glam Builder — fixed to use /api/glam/score and token/items
// Glam Builder — wired to new HTML structure
(function(){
  const form = document.querySelector('#glam-start');
  if(!form) return;

  // New DOM refs per provided HTML
  const hud        = document.querySelector('#glam-hud');
  const timerEl    = document.querySelector('#glam-timer');
  const budgetEl   = document.querySelector('#glam-budget');
  const spendEl    = document.querySelector('#glam-spend');
  const countEl    = document.querySelector('#glam-count');
  const pageEl     = document.querySelector('#glam-page');

  const listEl     = document.querySelector('#glam-list');
  const pagerRow   = document.querySelector('#glam-pager');
  const prevBtn    = document.querySelector('#glam-prev');
  const nextBtn    = document.querySelector('#glam-next');

  const actionsRow = document.querySelector('#glam-actions');
  const finishBtn  = document.querySelector('#glam-finish');

  const outEl      = document.querySelector('#glam-out');

  // State
  let token = null;
  let items = [];
  let page = 0;                // 0-based
  let selected = new Set();    // holds absolute indices
  let tHandle = null;
  let timeLeft = 180;
  let budgetInr = 0;

  const perPage = 10;

  // Helpers
  const show = (el) => el && el.classList.remove('hidden');
  const hide = (el) => el && el.classList.add('hidden');

  function clearTimer(){ if(tHandle){ clearInterval(tHandle); tHandle = null; } }
  function startTimer(){
    clearTimer();
    timeLeft = 180;
    timerEl.textContent = `Time: ${timeLeft}s`;
    tHandle = setInterval(()=>{
      timeLeft -= 1;
      timerEl.textContent = `Time: ${timeLeft}s`;
      if(timeLeft <= 0){ clearTimer(); finishGame(); }
    }, 1000);
  }

  function updateHUD(){
    // Budget
    budgetEl.textContent = `Budget: ₹${budgetInr}`;
    // Spend
    const spend = Array.from(selected).reduce((sum, idx)=> sum + (Number(items[idx]?.price)||0), 0);
    spendEl.textContent = `Spend: ₹${spend}`;
    // Count
    countEl.textContent = `Selected: ${selected.size}/12`;
    // Page
    const totalPages = Math.max(1, Math.ceil(items.length / perPage));
    pageEl.textContent = `Page: ${Math.min(page+1, totalPages)}`;
  }

  function renderPage(){
    listEl.innerHTML = '';
    const start = page * perPage;
    const end   = Math.min(items.length, start + perPage);

    for(let i=start; i<end; i++){
      const p = items[i];
      const div = document.createElement('div');
      div.className = 'option';
      div.textContent = `${p.name} — ₹${p.price} (${p.description})`;
      div.style.cursor = 'pointer';
      if(selected.has(i)) div.classList.add('selected'); // rely on CSS .selected or keep fallback bg:
      // fallback highlight if no CSS rule:
      if(selected.has(i)) div.style.background = 'rgba(80,200,120,.2)'; else div.style.background = '';

      div.onclick = ()=>{
        if(selected.has(i)) selected.delete(i); else selected.add(i);
        // re-render row visual quickly without full re-render:
        if(selected.has(i)) { div.classList.add('selected'); div.style.background = 'rgba(80,200,120,.2)'; }
        else { div.classList.remove('selected'); div.style.background = ''; }
        updateHUD();
      };

      listEl.appendChild(div);
    }

    // Pager buttons
    prevBtn.disabled = page === 0;
    nextBtn.disabled = end >= items.length;

    updateHUD();
  }

  async function finishGame(){
    clearTimer();
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
        return;
      }
      // Show concise summary
      outEl.textContent = (json.win ? '🎉 Congrats! ' : '❌ ') +
        `Score: ${json.score}/100\n` +
        (json.summary ? `${json.summary}\n` : '') +
        `Budget: ₹${json.budgetInr} | Spend: ₹${json.totalSpend} | Picks: ${selected.size} | Time: ${json.timeTaken}s`;
    }catch{
      outEl.textContent = 'Network error.';
    }
  }

  // Pager handlers
  prevBtn.addEventListener('click', ()=>{ if(page>0){ page--; renderPage(); } });
  nextBtn.addEventListener('click', ()=>{ if((page+1)*perPage < items.length){ page++; renderPage(); } });

  // Finish
  finishBtn.addEventListener('click', (e)=>{ e.preventDefault(); finishGame(); });

  // Start form
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    hide(outEl);
    outEl.textContent = '';
    listEl.textContent = 'Loading...';

    const gender = form.gender.value;
    const budget = Number(form.budget.value);

    try{
      const res = await fetch('/api/glam/start', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ gender, budgetInr: budget })
      });
      const json = await res.json();
      if(!json.ok){
        listEl.textContent = 'Error: ' + (json.error || 'Unknown error');
        return;
      }

      token      = json.token;
      items      = Array.isArray(json.items) ? json.items : [];
      budgetInr  = Number(json.budgetInr) || budget || 0;
      selected.clear();
      page = 0;

      // Show UI sections
      show(hud);
      show(listEl);
      show(pagerRow);
      show(actionsRow);

      // Render + timer
      renderPage();
      startTimer();
    }catch{
      listEl.textContent = 'Network error';
    }
  });
})();

