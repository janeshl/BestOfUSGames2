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

// 5-Round Quiz
(function(){
  const startForm = document.querySelector('#quiz-start');
  if(!startForm) return;
  const area = document.querySelector('#quiz-area');
  const status = document.querySelector('#quiz-status');
  const qEl = document.querySelector('#quiz-question');
  const optsEl = document.querySelector('#quiz-options');
  const explEl = document.querySelector('#quiz-expl');
  const nextEl = document.querySelector('#quiz-next');

  let token = null;

  function renderQuestion(idx, total, question, options){
    area.style.display = 'block';
    status.textContent = 'Question ' + idx + ' of ' + total;
    qEl.textContent = question || '';
    optsEl.innerHTML = '';
    explEl.style.display = 'none';
    explEl.textContent = '';
    nextEl.innerHTML = '';

    (options || []).forEach((opt, i) => {
      const d = document.createElement('div');
      d.className = 'option';
      d.textContent = (i+1) + '. ' + opt;
      d.onclick = async () => {
        Array.from(optsEl.children).forEach(n => n.style.pointerEvents='none');
        try{
          const res = await fetch('/api/quiz/answer', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ token, choice: i+1 })
          });
          const json = await res.json();
          if(!json.ok){ nextEl.innerHTML = '<div class="pill">Error: '+(json.error||'Unknown')+'</div>'; return; }
          d.style.borderColor = json.correct ? 'rgba(51,200,120,.8)' : 'rgba(255,80,80,.8)';
          if(json.explanation){
            explEl.textContent = json.explanation;
            explEl.style.display = 'block';
          }
          if(json.done){
            nextEl.innerHTML = '<div class="pill">🏁 Finished! Score: '+json.score+' / '+json.total+'</div>';
          } else if(json.next){
            const b = document.createElement('button');
            b.className = 'btn'; b.textContent = 'Next';
            b.onclick = (e) => {
              e.preventDefault();
              renderQuestion(json.next.idx, json.next.total, json.next.question, json.next.options);
            };
            nextEl.appendChild(b);
          }
        }catch{
          nextEl.innerHTML = '<div class="pill">Network error. Please try again.</div>';
        }
      };
      optsEl.appendChild(d);
    });
  }

  startForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const topic = e.target.topic.value;
    e.target.topic.value = '';
    optsEl.innerHTML = '<div class="pill">Preparing quiz...</div>';
    try{
      const res = await fetch('/api/quiz/start', {
        method:'POST', headers:{'Content-Type':'application/json'},
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

// Find the Character (conversational)
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
    html(chat, '<div class="pill">Picking a secret character...</div>');
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
        if(json.hint){ pushMsg('AI', '💡 Hint: ' + json.hint); }
        if(json.done){
          if(json.win){ html(result, '<div class="pill">🎉 Correct! You found ' + json.name + '.</div>'); }
          else { html(result, '<div class="pill">🕵️ Out of rounds. The character was ' + json.name + '.</div>'); }
          sessionId = null; if(json.message) pushMsg('AI', json.message); return;
        }
        if(typeof json.roundsLeft === 'number'){ roundsLeft = json.roundsLeft; setText(rounds, 'Rounds left: ' + roundsLeft); }
      }catch{ pushMsg('AI', 'Network error. Please try again.'); }
    });
  }
})();
