import express from "express";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { customAlphabet } from "nanoid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
// Supports both the standard GROQ_API_KEY name and the QROQ_API_KEY name supplied in deployment settings.
const GROQ_API_KEY = process.env.GROQ_API_KEY || process.env.QROQ_API_KEY;
const GROQ_MODEL = process.env.MODEL_NAME || process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

if (!GROQ_API_KEY) console.warn("⚠️  GROQ_API_KEY (or QROQ_API_KEY) not set.");

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, max: 30 }));

// In-memory store (simple demo)
const sessions = new Map();
const recentByTopic = new Map();        // Character game: avoid repeats per topic (last 5)
const recentQuizByTopic = new Map();    // Quiz game: avoid repeating questions per topic (keep last 50 Qs)
const makeId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10);

/* ------------------------
   Prompt templates
------------------------- */
const PROMPTS = {
  // Game 1: Predict the Future
  fortune: ({ name, birthMonth, favoritePlace }) => [
    {
      role: "system",
      content:
        "You are a funny fortune teller. Create funny, positive unique predictions in 2-3 sentences. Use the inputs naturally and a additional any funny obects. Keep it light; no health, death, or lottery claims.",
    },
    {
      role: "user",
      content: `Make a humorous future prediction for:
Name: ${name}
Birth month: ${birthMonth}
Favorite place: ${favoritePlace}`,
    },
  ],

  // Game 2: 5-Round Quiz (HARD)
  quiz: (topic, bannedQuestions = []) => [
    { role: "system", content: `You are an expert quiz generator. Create EXACTLY 5 difficult multiple-choice questions STRICTLY and DIRECTLY related to the exact topic provided. Do not broaden, reinterpret, or substitute the topic. Every question must test knowledge specifically about that topic. Exactly 4 options per question, exactly one correct answer, answerIndex 1-4. Avoid these previous questions: ${bannedQuestions.join(" | ") || "(none)"}. Return STRICT JSON ONLY: {"questions":[{"question":"string","options":["string","string","string","string"],"answerIndex":1,"explanation":"string"}]}. No markdown or extra text.` },
    { role: "user", content: `Exact topic: "${topic}". Generate questions ONLY about this exact topic. JSON only.` },
  ],

  // Game 3: Guess the Character (hard)
  characterCandidates: (topic, excludeList = []) => [
    { role: "system", content: `You are curating a HARD Guess the Character game. Select EXACTLY 8 distinct people or fictional characters directly and unmistakably related to the exact topic. Prefer medium-hard or hard choices: important but not the most obvious first answer. Avoid random celebrities, loosely related names, generic figures, and repeated characters. Preserve the exact topic scope. Never repeat any name or alter ego from this exclusion list: ${excludeList.join(", ") || "(none)"}. Return STRICT JSON ONLY: {"candidates":["name1","name2","name3","name4","name5","name6","name7","name8"]}. No extra text.` },
    { role: "user", content: `Exact topic: "${topic}". Select hard, non-repetitive candidates ONLY directly related to this exact topic. JSON only.` },
  ],

  characterTurn: ({ name, qa, round, text }) => [
    { role: "system", content: `You are running a Guess the Character game. Secret character: "${name}". Answer naturally and briefly without revealing the name. Detect direct guesses. Return STRICT JSON: {"answer":"string","isGuess":true,"guessedName":"string","hints":["string"]}. If round is 8 or higher, hints MUST contain at least one helpful clue that does not mention the secret name. Hints become stronger in rounds 9 and 10. No markdown or extra text.` },
    { role: "user", content: `Previous Q&A:
${qa}
Current Round: ${round}
User message: ${text}` },
  ],

  characterHint: ({ name, topic, round }) => [
    { role: "system", content: `Generate one helpful clue for Guess the Character. Secret: "${name}". Topic: "${topic}". Round: ${round}. Do not mention the name. Round 8 broad clue, round 9 stronger, round 10 strongest without naming it. Max 25 words. Return STRICT JSON ONLY: {"hint":"string"}.` },
    { role: "user", content: "Generate the clue. JSON only." },
  ],

  // Agentic detective: private reasoning, candidate ranking and its own question. The secret name is never sent here.
  characterAgent: ({ topic, history, clues, round, previousGuesses }) => [
    { role: "system", content: `You are an autonomous expert detective competing in a hard Guess the Character game. You DO NOT know the secret name. You may use ONLY your own private Q&A history, public clues, the exact topic, and your previous guesses. Never use the player's private questions or answers. Analyze evidence deeply: eliminate candidates that contradict evidence, maintain a ranked shortlist, and ask the single most information-rich next question. Return STRICT JSON ONLY: {"analysis":"private concise reasoning","topCandidates":[{"name":"string","confidence":0},{"name":"string","confidence":0},{"name":"string","confidence":0}],"confidence":0,"question":"string or null","shouldGuess":false,"guess":null,"status":"short public status"}. Rules: exactly 3 plausible ranked candidates whenever evidence allows; confidence 0-100; never guess randomly; before round 5 normally investigate; early guess only at confidence >=85; rounds 8-9 use clues aggressively; round 10 must provide best guess; do not reveal private analysis or candidate names in status; ask a question that can discriminate between leading candidates. No markdown.` },
    { role: "user", content: `Exact topic: ${topic}

YOUR PRIVATE Q&A HISTORY:
${history || "(none)"}

PUBLIC CLUES:
${clues || "(none)"}

YOUR PREVIOUS GUESSES:
${previousGuesses || "(none)"}

Current round: ${round}
Analyze deeply and choose your next action.` }
  ],

  characterGuessJudge: ({ secretName, guess }) => [
    { role: "system", content: `You are a strict Guess the Character judge. Secret character: "${secretName}". Submitted guess: "${guess}". Decide whether the guess identifies the same person/character. Accept obvious alter-egos or civilian identities only when they unambiguously identify the secret character (e.g. Batman/Bruce Wayne). Return STRICT JSON ONLY: {"correct":true,"reason":"short reason"}.` },
    { role: "user", content: "Judge the answer. JSON only." }
  ],

  // Game 4: Healthy Diet — 10 questions
  healthyQuestions: () => [
    {
      role: "system",
      content:
        "Generate exactly 10 short, clear questions needed to draft a safe, practical diet plan. Return STRICT JSON: { \"questions\": string[10] }. No extra text.",
    },
    { role: "user", content: "JSON only." },
  ],

  // Game 4: Healthy Diet — build the plan
  healthyPlan: ({ questions, answers }) => [
    {
      role: "system",
      content: `You are a careful nutrition assistant. Using the user's responses, create a practical, culturally-flexible, **food-based** diet plan.
Safety rules:
- Do NOT give medical advice or diagnose; add a short non-medical disclaimer.
- Avoid unsafe extremes; give ranges & substitutions for allergies/intolerances.
- Focus on whole foods, hydration, and sustainable habits.

Output format (plain text):
1) Summary (2-3 bullets)
2) Daily Targets (calorie range, protein/carb/fat ranges)
3) Sample Day (Breakfast, Snack, Lunch, Snack, Dinner)
4) 7-Day Rotation Ideas (bullet list by day with 1–2 meals each)
5) Tips & Substitutions (bullets)
6) Disclaimer (1 line)`,
    },
    {
      role: "user",
      content: `Questions:
${questions.map((q, i) => `Q${i + 1}. ${q}`).join("\n")}

Answers:
${answers.map((a, i) => `A${i + 1}. ${a}`).join("\n")}

Create the plan now.`,
    },
  ],

  // Game 5: Future Price Prediction
  priceProduct: (category) => [
    {
      role: "system",
      content: `Suggest a single popular consumer product in the given category with its realistic current street price and currency.
Return STRICT JSON:
{ "product": string, "price": number, "currency": "USD"|"EUR"|"INR"|"GBP", "reason": string }
No extra text.`,
    },
    {
      role: "user",
      content: `Category (optional): ${category || "general electronics"}. JSON only.`,
    },
  ],

  priceQuestions: (product) => [
    {
      role: "system",
      content: `Write exactly 10 concise YES/NO questions about future scenarios that could move the 5-year price of the given product up or down.
Vary topics: demand, tech improvements, supply chain, regulation, competition, materials cost, macro trends, premium branding, accessories, after-sales.
Return STRICT JSON: { "questions": string[10] }. No extra text.`,
    },
    { role: "user", content: `Product: ${product}. JSON only.` },
  ],

  priceForecast: ({ product, currency, currentPrice, qa }) => [
    {
      role: "system",
      content: `You are a cautious forecaster. Based on YES/NO answers to 10 scenarios, estimate a plausible 5-year retail price for the product.
Rules:
- Do NOT claim certainty; this is a playful estimate.
- Keep the number reasonable relative to current price and answers.
- Return STRICT JSON: { "predictedPrice": number, "explanation": string (<= 120 words) }`,
    },
    {
      role: "user",
      content: `Product: ${product}
Currency: ${currency}
Current Price: ${currentPrice}
Answers (Y/N):
${qa.map((a, i) => `Q${i + 1}: ${a.q}\nA${i + 1}: ${a.a ? "Yes" : "No"}`).join("\n")}
JSON only.`,
    },
  ],

  // Game 6: Budget Glam Builder (strict names + tags)
  glamSuggest: ({ gender, budgetInr }) => [
    {
      role: "system",
      content: `Suggest 30 skincare/beauty products appropriate for the specified gender (or unisex).

Requirements:
- Market: India. Use realistic, specific product names (brand or brand-like), e.g., "DermaSoft Hydrating Cleanser", not "Starter Item".
- Currency: INR. Prices should be realistic for India (budget to mid-premium).
- Vary categories: cleanser, moisturizer, SPF/sunscreen, serum, exfoliant, toner/essence, face mask, lip care, body lotion, hair care, spot treatment, eye cream, primer, etc.
- Each item: one concise sentence (<= 15 words) describing benefit/texture/standout trait.
- Include "category" and a boolean "ecoFriendly".
- Optionally include "tags": short keywords like ["SPF50","fragrance-free","vitamin C"].

Return STRICT JSON ONLY:
{
  "items": [
    { "name": string, "price": number, "description": string, "category": string, "ecoFriendly": boolean, "tags": string[] } x30
  ]
}

Rules:
- No generic names like "Starter Item", "Sample Product", "Basic Moisturizer".
- No duplicate names; keep categories diverse.
- Keep sentences short and helpful.`,
    },
    {
      role: "user",
      content: `Gender: ${gender || "Unisex"}
BudgetINR: ${budgetInr}
JSON only.`,
    },
  ],

  glamScore: ({ budgetInr, selected, timeTaken }) => [
    {
      role: "system",
      content: `Score a player's beauty kit (0-100) based on:
- Budget utilization (closer to budget without exceeding is better)
- Coverage of protection & care: sunscreen/SPF, cleanser, moisturizer, serum/treatment; plus extras (lip/body/hair)
- Timing (<=180s is best; small penalty if slightly over)
- Synergy/combination (avoid redundant roles; cover AM/PM)
- Eco friendliness (higher share of ecoFriendly items gets bonus)

Output STRICT JSON:
{
  "score": number,
  "positives": string[],
  "negatives": string[],
  "summary": string
}`,
    },
    {
      role: "user",
      content: `BudgetINR: ${budgetInr}
TimeTakenSeconds: ${timeTaken}

Selected Items (${selected.length}):
${selected.map((it, i) => `#${i + 1} ${it.name} — ₹${it.price} — ${it.category} — eco:${it.ecoFriendly}`).join("\n")}

TotalSpend: ₹${selected.reduce((s, x) => s + Number(x.price || 0), 0)}
JSON only.`,
    },
  ],
};

/* ------------------------
   Groq Chat Completion
------------------------- */
async function chatCompletion(messages, temperature = 0.7, max_tokens = 256) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: GROQ_MODEL, messages, temperature, max_tokens }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Groq API ${res.status}: ${t}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() ?? "";
}

/* ========================
   Game 1: Predict the Future
======================== */
app.post("/api/predict-future", async (req, res) => {
  try {
    const { name, birthMonth, favoritePlace } = req.body ?? {};
    const messages = PROMPTS.fortune({ name, birthMonth, favoritePlace });
    const content = await chatCompletion(messages, 0.9, 180);
    res.json({ ok: true, content });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================
   Game 2: 5-Round Quiz (hard, no-repeat per topic)
======================== */
app.post("/api/quiz/start", async (req, res) => {
  try {
    const { topic = "General" } = req.body ?? {};

    // Build banlist from memory (lowercased)
    const prevQs = recentQuizByTopic.get(topic) || [];
    const bannedList = prevQs.map((q) => String(q).toLowerCase());

    // Ask model with banlist to diversify
    const messages = PROMPTS.quiz(topic, bannedList.slice(-50));
    let parsed = { questions: [] };

    try {
      const raw = await chatCompletion(messages, 0.5, 1100);
      parsed = JSON.parse(raw);
    } catch {
      // ignore and fallback below
    }

    let questions = Array.isArray(parsed.questions) ? parsed.questions : [];

    // Filter out repeats (double protection)
    const has = new Set(bannedList);
    questions = questions.filter(
      (q) => q?.question && !has.has(String(q.question).toLowerCase())
    );

    // Regenerate instead of showing unrelated placeholder questions
    if (questions.length < 5) {
      try {
        const retryRaw = await chatCompletion(PROMPTS.quiz(topic, bannedList.slice(-20)), 0.3, 1400);
        const retryParsed = JSON.parse(retryRaw);
        if (Array.isArray(retryParsed.questions)) questions = retryParsed.questions;
      } catch (err) {
        console.error("Quiz regeneration failed:", err.message);
      }
    }

    questions = questions.filter((q) => q?.question && Array.isArray(q.options) && q.options.length === 4 && Number(q.answerIndex) >= 1 && Number(q.answerIndex) <= 4).slice(0, 5);
    if (questions.length < 5) return res.status(500).json({ ok: false, error: "Unable to generate enough valid questions for this exact topic. Please try again." });

    // Update memory (keep last 50 questions per topic)
    recentQuizByTopic.set(
      topic,
      [...prevQs, ...questions.map((q) => q.question)].slice(-50)
    );

    const token = "QZ" + Math.random().toString(36).slice(2, 10).toUpperCase();
    sessions.set(token, {
      type: "quiz",
      topic,
      idx: 0,
      score: 0,
      questions,
      createdAt: Date.now(),
    });
    const q = questions[0];
    res.json({
      ok: true,
      token,
      idx: 1,
      total: 5,
      question: q.question,
      options: q.options,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/quiz/answer", (req, res) => {
  try {
    const { token, choice } = req.body ?? {};
    const s = sessions.get(token);
    if (!s || s.type !== "quiz")
      return res.status(400).json({ ok: false, error: "Session not found/expired." });
    const q = s.questions[s.idx];
    const correct = Number(choice) === Number(q.answerIndex);
    if (correct) s.score += 1;
    const explanation = q.explanation || "";
    s.idx += 1;
    const done = s.idx >= 5;
    if (done) {
      sessions.delete(token);
      return res.json({
        ok: true,
        done: true,
        correct,
        explanation,
        score: s.score,
        total: 5,
        message:
          s.score >= 4
            ? `🎉 Winner! You scored ${s.score}/5`
            : `😢 Failed! You scored ${s.score}/5`,
      });
    }
    const next = s.questions[s.idx];
    res.json({
      ok: true,
      done: false,
      correct,
      explanation,
      next: {
        idx: s.idx + 1,
        total: 5,
        question: next.question,
        options: next.options,
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================
   Game 3: Agentic Find the Character — Player vs AI Detective
======================== */
async function judgeCharacterGuess(secretName, guess) {
  if (!guess || !String(guess).trim()) return { correct: false, reason: "No guess submitted." };
  try {
    const raw = await chatCompletion(PROMPTS.characterGuessJudge({ secretName, guess: String(guess).trim() }), 0, 180);
    const parsed = JSON.parse(raw);
    return { correct: Boolean(parsed.correct), reason: String(parsed.reason || "") };
  } catch {
    const normalize = (v) => String(v).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    return { correct: normalize(secretName) === normalize(guess), reason: "Exact-name fallback comparison." };
  }
}

async function runCharacterAgent(s, round) {
  const history = (s.agent.history || []).map((h, i) => `Round ${i + 1} Agent Question: ${h.q}\nPrivate Game Master Answer: ${h.a}`).join("\n");
  const clues = (s.clues || []).map((c, i) => `Round ${i + 8} clue: ${c}`).join("\n");
  const previousGuesses = (s.agent.guesses || []).map((g) => `${g.guess} (${g.correct ? "correct" : "wrong"})`).join(", ");
  try {
    const raw = await chatCompletion(PROMPTS.characterAgent({ topic: s.topic, history, clues, round, previousGuesses }), 0.35, 300);
    const parsed = JSON.parse(raw);
    return {
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
      shouldGuess: Boolean(parsed.shouldGuess),
      guess: typeof parsed.guess === "string" && parsed.guess.trim() ? parsed.guess.trim() : null,
      status: typeof parsed.status === "string" && parsed.status.trim() ? parsed.status.trim() : "Investigating the evidence...",
      analysis: typeof parsed.analysis === "string" ? parsed.analysis.trim() : "",
      topCandidates: Array.isArray(parsed.topCandidates) ? parsed.topCandidates.slice(0,3) : [],
      question: typeof parsed.question === "string" && parsed.question.trim() ? parsed.question.trim() : null
    };
  } catch (err) {
    console.error("Character agent failed:", err.message);
    return { confidence: 0, shouldGuess: false, guess: null, status: "Investigating the evidence...", analysis:"", topCandidates:[], question: null };
  }
}

app.post("/api/character/start", async (req, res) => {
  try {
    const { topic = "General" } = req.body ?? {};
    const exclude = recentByTopic.get(topic) || [];
    let candidates = [];
    try {
      const parsed = JSON.parse(await chatCompletion(PROMPTS.characterCandidates(topic, exclude), 0.7, 220));
      if (Array.isArray(parsed.candidates)) candidates = parsed.candidates;
    } catch {}
    const valid = candidates.map((c) => String(c).trim()).filter(Boolean);
    if (!valid.length) return res.status(500).json({ ok:false, error:"Unable to find characters directly related to this topic. Please try again." });
    const lowerRecent = exclude.map((x) => x.toLowerCase());
    const name = valid.find((c) => !lowerRecent.includes(c.toLowerCase())) || valid[0];
    recentByTopic.set(topic, [name, ...exclude].slice(0, 20));
    const id = makeId();
    sessions.set(id, { type:"character", topic, name, rounds:0, history:[], clues:[], createdAt:Date.now(), agent:{ guesses:[], history:[], confidence:0, status:"Ready to investigate", analysis:"", topCandidates:[] } });
    res.json({ ok:true, sessionId:id, message:"You are competing against an AI Detective. Both of you investigate the same public evidence. The first correct early guess wins. After round 10, both submit final guesses; if both are correct, it is a draw." });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.post("/api/character/turn", async (req, res) => {
  try {
    const { sessionId, text } = req.body ?? {};
    const s = sessions.get(sessionId);
    if (!s || s.type !== "character") return res.status(400).json({ ok:false, error:"Session not found." });
    if (s.rounds >= 10) return res.status(400).json({ ok:false, error:"All 10 rounds are complete. Submit your final guess." });
    const qa = s.history.map((h,i)=>`Q${i+1}: ${h.q}\nA${i+1}: ${h.a}`).join("\n");
    let parsed={answer:"Okay.",isGuess:false,guessedName:"",hints:[]};
    try { parsed=JSON.parse(await chatCompletion(PROMPTS.characterTurn({name:s.name,qa,round:s.rounds+1,text}),0.4,280)); } catch {}
    s.rounds += 1;
    s.history.push({q:text||"",a:parsed.answer||""});
    const roundNow=s.rounds;
    let hintsOut=[];
    if (roundNow>=8) {
      const arr=Array.isArray(parsed.hints)?parsed.hints.filter(h=>typeof h==="string"&&h.trim()):[];
      if(arr.length) hintsOut=[arr[0].trim()];
      if(!hintsOut.length){ try { const hp=JSON.parse(await chatCompletion(PROMPTS.characterHint({name:s.name,topic:s.topic,round:roundNow}),0.4,150)); if(hp?.hint?.trim()) hintsOut=[hp.hint.trim()]; } catch{} }
      if(!hintsOut.length) hintsOut=[`This character has a strong and direct connection to the topic: ${s.topic}.`];
      s.clues.push(hintsOut[0]);
    }

    // Player can win immediately with a correct natural-language guess.
    if(parsed.isGuess && parsed.guessedName){
      const playerJudge=await judgeCharacterGuess(s.name,parsed.guessedName);
      if(playerJudge.correct){ sessions.delete(sessionId); return res.json({ok:true,done:true,winner:"player",win:true,name:s.name,answer:parsed.answer,hints:hintsOut,message:`🏆 You beat the AI Detective and solved it in round ${roundNow}!`,agent:{confidence:s.agent.confidence,status:s.agent.status}}); }
    }

    // Agent gets its own private turn. It never receives the player's Q/A.
    const decision=await runCharacterAgent(s,roundNow);
    s.agent.confidence=decision.confidence; s.agent.status=decision.status; s.agent.analysis=decision.analysis; s.agent.topCandidates=decision.topCandidates;
    let agentQuestion = decision.question || null;
    if (roundNow < 10 && agentQuestion) {
      let agentPrivateAnswer = "";
      try {
        const agentQa = (s.agent.history || []).map((h,i)=>`Q${i+1}: ${h.q}\nA${i+1}: ${h.a}`).join("\n");
        const agentParsed = JSON.parse(await chatCompletion(PROMPTS.characterTurn({name:s.name,qa:agentQa,round:roundNow,text:agentQuestion}),0.3,180));
        agentPrivateAnswer = String(agentParsed.answer || "").trim();
      } catch {}
      if (agentPrivateAnswer) s.agent.history.push({q:agentQuestion,a:agentPrivateAnswer});
    }
    if(roundNow<10 && decision.shouldGuess && decision.guess && !s.agent.guesses.some(g=>g.guess.toLowerCase()===decision.guess.toLowerCase())){
      const judged=await judgeCharacterGuess(s.name,decision.guess);
      s.agent.guesses.push({round:roundNow,guess:decision.guess,correct:judged.correct});
      if(judged.correct){ sessions.delete(sessionId); return res.json({ok:true,done:true,winner:"agent",win:false,name:s.name,answer:parsed.answer,hints:hintsOut,message:`🤖 AI Detective solved the mystery in round ${roundNow}!`,agent:{confidence:decision.confidence,status:"Solved the mystery!",guess:decision.guess}}); }
    }

    res.json({ok:true,done:false,answer:parsed.answer,hints:hintsOut,round:roundNow,roundsLeft:10-roundNow,finalRoundReady:roundNow>=10,agent:{confidence:s.agent.confidence,status:s.agent.status,question:agentQuestion}});
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post("/api/character/final-guess", async (req,res)=>{
  try {
    const {sessionId,playerGuess}=req.body??{};
    const s=sessions.get(sessionId);
    if(!s||s.type!=="character") return res.status(400).json({ok:false,error:"Session not found."});
    if(s.rounds<10) return res.status(400).json({ok:false,error:"Final guesses unlock after round 10."});
    const agentDecision=await runCharacterAgent(s,10);
    const agentGuess=agentDecision.guess || "No valid guess";
    const [playerResult,agentResult]=await Promise.all([judgeCharacterGuess(s.name,playerGuess),judgeCharacterGuess(s.name,agentGuess)]);
    let winner="draw";
    if(playerResult.correct&&!agentResult.correct) winner="player";
    else if(!playerResult.correct&&agentResult.correct) winner="agent";
    // both correct and both wrong are draws
    const message=winner==="player"?"🏆 You beat the AI Detective!":winner==="agent"?"🤖 The AI Detective wins this round.":playerResult.correct&&agentResult.correct?"🤝 Draw! Both you and the AI Detective identified the character correctly.":"🤝 Draw! Neither side identified the character correctly.";
    const payload={ok:true,done:true,winner,win:winner==="player",name:s.name,message,player:{guess:playerGuess||"",correct:playerResult.correct},agent:{guess:agentGuess,correct:agentResult.correct,confidence:agentDecision.confidence}};
    sessions.delete(sessionId); res.json(payload);
  } catch(e){res.status(500).json({ok:false,error:e.message});}
});

/* ========================
   Game 4: Find the Healthy-Diet
======================== */
app.post("/api/healthy/start", async (_req, res) => {
  try {
    // Default 10
    let questions = [
      "What is your age range (e.g., 18–24, 25–34, 35–44, 45+)?",
      "What is your sex assigned at birth?",
      "What is your typical activity level (sedentary, light, moderate, high)?",
      "Do you follow a dietary pattern (veg/vegan/omnivore/other)?",
      "Any allergies or intolerances (e.g., dairy, nuts, gluten)?",
      "Your primary goal (lose/maintain/gain/energy/other)?",
      "What’s your typical daily schedule & preferred meal frequency?",
      "Any cuisine preferences or foods you enjoy/avoid?",
      "Any medical conditions or medications to consider? (Optional non-diagnostic)",
      "How many meals do you prefer at home vs outside?",
    ];
    try {
      const raw = await chatCompletion(PROMPTS.healthyQuestions(), 0.4, 280);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.questions) && parsed.questions.length === 10) {
        questions = parsed.questions;
      }
    } catch {
      // keep defaults
    }
    const token = "HD" + Math.random().toString(36).slice(2, 10).toUpperCase();
    sessions.set(token, { type: "healthy", questions, createdAt: Date.now() });
    res.json({ ok: true, token, questions });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/healthy/plan", async (req, res) => {
  try {
    const { token, answers } = req.body ?? {};
    const s = sessions.get(token);
    if (!s || s.type !== "healthy")
      return res.status(400).json({ ok: false, error: "Session not found/expired." });
    if (!Array.isArray(answers) || answers.length < 8) {
      return res.status(400).json({ ok: false, error: "Please provide at least 8 answers." });
    }
    const msgs = PROMPTS.healthyPlan({ questions: s.questions, answers });
    const content = await chatCompletion(msgs, 0.6, 1400);
    sessions.delete(token);
    res.json({ ok: true, plan: content });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================
   Game 5: Future Price Prediction  (Hardened)
======================== */
function safeParseJSON(raw, fallback) {
  try { return JSON.parse(raw); } catch { return fallback; }
}
function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

app.post("/api/fpp/start", async (req, res) => {
  try {
    const { category } = req.body ?? {};

    // 1) Product + current price (robust fallback)
    let suggestion = {
      product: "Wireless Earbuds",
      price: 3999,
      currency: "INR",
      reason: "Popular mid-range pick",
    };

    try {
      const raw = await chatCompletion(PROMPTS.priceProduct(category), 0.6, 260);
      const parsed = safeParseJSON(raw, null);
      if (parsed && parsed.product && parsed.price && parsed.currency) {
        suggestion = {
          product: String(parsed.product).slice(0, 80),
          price: Number(parsed.price) || 0,
          currency: String(parsed.currency).toUpperCase(),
          reason: String(parsed.reason || "Popular pick").slice(0, 120),
        };
      }
    } catch {
      // keep local fallback
    }

    // fallback if price is unusable
    if (!Number.isFinite(suggestion.price) || suggestion.price <= 0) {
      suggestion.price = suggestion.currency === "INR" ? 1999 : 49;
    }

    // 2) Ten yes/no questions (robust fallback)
    let questions = [
      "Will new features significantly improve this product in 5 years?",
      "Will raw material costs rise substantially?",
      "Will competition intensify in this category?",
      "Will regulations add compliance costs?",
      "Will the brand move more upmarket (premium)?",
      "Will manufacturing become cheaper via scale or automation?",
      "Will demand grow among young consumers?",
      "Will substitutes (e.g., a new tech) reduce demand?",
      "Will after-sales/service bundles become standard?",
      "Will import/export duties increase?",
    ];
    try {
      const rawQ = await chatCompletion(PROMPTS.priceQuestions(suggestion.product), 0.4, 320);
      const parsedQ = safeParseJSON(rawQ, null);
      if (Array.isArray(parsedQ?.questions) && parsedQ.questions.length === 10) {
        questions = parsedQ.questions.map(q => String(q).slice(0, 140));
      }
    } catch {
      // keep fallback
    }

    const token = "FP" + Math.random().toString(36).slice(2, 10).toUpperCase();
    sessions.set(token, {
      type: "fpp",
      product: suggestion.product,
      currency: suggestion.currency,
      currentPrice: Number(suggestion.price) || 0,
      questions,
      answers: [],
      predictedPrice: null,
      explanation: "",
      createdAt: Date.now(),
    });

    res.json({
      ok: true,
      token,
      product: suggestion.product,
      currentPrice: suggestion.price,
      currency: suggestion.currency,
      reason: suggestion.reason,
      questions,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/fpp/answers", async (req, res) => {
  try {
    const { token, answers } = req.body ?? {};
    const s = sessions.get(token);
    if (!s || s.type !== "fpp")
      return res.status(400).json({ ok: false, error: "Session not found/expired." });
    if (!Array.isArray(answers) || answers.length !== 10) {
      return res.status(400).json({ ok: false, error: "Send an array of 10 booleans for answers." });
    }

    s.answers = answers.map(a => !!a);
    const qa = s.questions.map((q, i) => ({ q, a: s.answers[i] }));

    // Default predicted price if model fails
    const base = s.currentPrice > 0 ? s.currentPrice : (s.currency === "INR" ? 1999 : 49);
    let predicted = {
      predictedPrice: Math.round(base * 1.2),
      explanation: "Baseline estimate with modest growth given mixed conditions.",
    };

    try {
      const raw = await chatCompletion(
        PROMPTS.priceForecast({
          product: s.product,
          currency: s.currency,
          currentPrice: s.currentPrice,
          qa,
        }),
        0.5,
        640
      );
      const parsed = safeParseJSON(raw, null);

      let aiPrice = Number(parsed?.predictedPrice);
      if (!Number.isFinite(aiPrice) || aiPrice <= 0) {
        aiPrice = predicted.predictedPrice;
      }

      // Clamp AI price to a sane range vs current (0.25× to 4×)
      const lo = Math.max(1, Math.round(base * 0.25));
      const hi = Math.max(lo + 1, Math.round(base * 4));
      aiPrice = clamp(Math.round(aiPrice), lo, hi);

      predicted.predictedPrice = aiPrice;
      if (typeof parsed?.explanation === "string" && parsed.explanation.trim()) {
        predicted.explanation = parsed.explanation.trim().slice(0, 400);
      }
    } catch {
      // keep baseline
    }

    s.predictedPrice = Number(predicted.predictedPrice);
    s.explanation = predicted.explanation;

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reveal AI price after player's guess (robust)
app.post("/api/fpp/guess", (req, res) => {
  try {
    const { token, guess } = req.body ?? {};
    const s = sessions.get(token);
    if (!s || s.type !== "fpp")
      return res.status(400).json({ ok: false, error: "Session not found/expired." });

    let ai = Number(s.predictedPrice);
    if (!Number.isFinite(ai) || ai <= 0) {
      // As a last resort, derive from current price
      const base = s.currentPrice > 0 ? s.currentPrice : (s.currency === "INR" ? 1999 : 49);
      ai = Math.round(base * 1.2);
    }

    const playerGuess = Number(guess);
    if (!Number.isFinite(playerGuess)) {
      return res.status(400).json({ ok: false, error: "Invalid guess." });
    }

    if (playerGuess <= 0) return res.status(400).json({ ok: false, error: "Please enter a valid positive price." });
    const difference = Math.abs(playerGuess - ai);
    const accuracy = Math.max(0, 1 - difference / ai) * 100;
    const win = accuracy >= 80;

    const payload = {
      ok: true,
      win,
      accuracy: Math.round(accuracy * 100) / 100,
      requiredAccuracy: 80,
      currency: s.currency,
      playerGuess,
      aiPrice: ai,
      explanation: s.explanation || "Playful estimate based on scenarios.",
      product: s.product,
      currentPrice: s.currentPrice,
    };
    sessions.delete(token);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================
   Game 6: Budget Glam Builder (updated)
======================== */

// ---------- Synthetic fallback (brand-like names) ----------
function pick(arr){ return arr[Math.floor(Math.random()*arr.length)] }
function randInt(lo, hi){ return Math.floor(lo + Math.random()*(hi-lo+1)) }
function sentenceCap(s){ return (s||'').replace(/\s+/g,' ').trim().replace(/^\w/, c=>c.toUpperCase()) }

function synthItems30(gender, budget){
  const cats = [
    "Cleanser","Moisturizer","Sunscreen","Serum","Exfoliant","Toner","Eye Cream","Mask",
    "Lip Care","Body Lotion","Hair Care","Primer","Spot Treatment"
  ];
  const nameSeeds = {
    Cleanser: ["Hydrating Gel Cleanser","Gentle Foam Wash","Rice Water Cleanser","Amino Acid Face Wash","Ceramide Cleanser"],
    Moisturizer: ["Barrier Repair Cream","Oil-Free Gel Moisturizer","Nourishing Day Cream","Lightweight Milk Lotion","Ceramide+HA Cream"],
    Sunscreen: ["Matte Sunscreen SPF50 PA+++","Hybrid Sunscreen SPF40","Mineral Sunscreen SPF50","Aqua Gel SPF50","Daily Shield SPF30"],
    Serum: ["Vitamin C 10% Serum","Niacinamide 5% Serum","Hyaluronic Booster","Retinal Night Serum","Peptide Firming Serum"],
    Exfoliant: ["Mandelic 5% Exfoliant","Lactic 10% Resurfacer","PHA Gentle Peel","Salicylic 2% Clarifying Liquid","Enzyme Polish"],
    Toner: ["Balancing Toner","Rice Essence","Soothing Green Tea Toner","BHA Pore Toner","Hydrating Mist"],
    "Eye Cream": ["Caffeine Eye Gel","Ceramide Eye Cream","Peptide Eye Balm","Brightening Eye Serum","Cooling Eye Roll-On"],
    Mask: ["Clay Detox Mask","Overnight Sleeping Mask","Hydrogel Sheet Mask","Brightening Wash-Off Mask","Calming Oat Mask"],
    "Lip Care": ["Lip Butter Balm","SPF Lip Shield","Nourishing Lip Mask","Tinted Lip Balm","Ceramide Lip Treatment"],
    "Body Lotion": ["Urea 5% Body Lotion","Shea Softening Lotion","Ceramide Body Milk","AHA Body Smoother","Lightweight Body Gel"],
    "Hair Care": ["Nourish Shampoo","Scalp Care Shampoo","Bond Repair Conditioner","Leave-in Hair Serum","Heat Protect Spray"],
    Primer: ["Pore Smoothing Primer","Hydrating Makeup Base","Matte Control Primer","Glow Enhancing Primer","Grip Primer"],
    "Spot Treatment": ["BHA Spot Gel","Sulfur Treatment","Azelaic Rapid Gel","Cica Calming Gel","Retinoid Spot Serum"],
  };
  const descSeeds = [
    "Lightweight texture; layers well under makeup.",
    "Fragrance-free formula for sensitive skin.",
    "Hydrates without heaviness; quick-absorbing finish.",
    "Balances oil and shine through the day.",
    "Brightens dullness for a fresh look.",
    "Soothes redness; calms irritated skin.",
    "Strengthens barrier; reduces tightness.",
    "Leaves a soft, matte finish.",
    "Packed with antioxidants for daily defense.",
    "Smooth, non-sticky feel; everyday essential."
  ];
  const priceBands = { budget: [199, 699], mid: [700, 1499], upper: [1500, 2499] };
  const ecoChance = (c)=> ["Sunscreen","Body Lotion","Cleanser","Moisturizer"].includes(c) ? 0.4 : 0.25;
  const tagsPool = {
    common: ["fragrance-free","non-comedogenic","dermatologist-tested","cruelty-free","vegan"],
    Sunscreen: ["SPF50","PA+++","UVB/UVA","water-resistant","no white cast"],
    Serum: ["vitamin C","niacinamide","hyaluronic acid","retinal","peptides"],
    Cleanser: ["low pH","sulfate-free","foam","gel"],
    Moisturizer: ["ceramides","glycerin","squalane","oil-free"],
    Exfoliant: ["AHA","BHA","PHA","weekly"],
  };
  const [lo, hi] = budget >= 20000 ? priceBands.upper : budget >= 14000 ? priceBands.mid : priceBands.budget;
  const brands = ["DermaSoft","HydraGlow","PureRoots","SkinLab","EverCare","AquaVeda","DailyFix","CalmSkin","BrightLab","Nutriskin"];

  const items = [];
  for(let i=0;i<30;i++){
    const cat = cats[i % cats.length];
    const name = `${pick(brands)} ${pick(nameSeeds[cat])}`;
    const price = randInt(lo, hi);
    const ecoFriendly = Math.random() < ecoChance(cat);
    const desc = sentenceCap(pick(descSeeds));
    const baseTags = (tagsPool[cat] || []).slice(0,2);
    const plus = Math.random()<0.5 ? [pick(tagsPool.common)] : [];
    const tags = [...baseTags, ...plus].filter(Boolean);
    items.push({ name, price, description: desc, category: cat, ecoFriendly, tags });
  }
  return items;
}

// ---------- Glam: Start ----------
app.post("/api/glam/start", async (req, res) => {
  try {
    const { gender = "Unisex", budgetInr } = req.body ?? {};
    const budget = Math.max(10000, Number(budgetInr) || 15000); // minimum ₹10,000

    // Start with rich synthetic fallback (realistic names)
    let items = synthItems30(gender, budget);

    // Try LLM (up to twice); sanitize and merge or keep synthetic
    const tryLLM = async () => {
      try {
        const raw = await chatCompletion(PROMPTS.glamSuggest({ gender, budgetInr: budget }), 0.5, 2000);
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed?.items) || parsed.items.length < 20) return null;

        const cleaned = parsed.items.slice(0, 30).map((it, i) => {
          const name = String(it.name || "").trim();
          const badName = !name || /starter item|sample product|basic|product\s*\d+/i.test(name);
          return {
            name: badName ? items[i]?.name || `Refined Item ${i+1}` : name.slice(0, 80),
            price: Math.max(50, Number(it.price) || items[i]?.price || 399),
            description: String(it.description || items[i]?.description || "Lightweight, everyday formula.").slice(0, 120),
            category: String(it.category || items[i]?.category || "Other").slice(0, 40),
            ecoFriendly: !!it.ecoFriendly,
            tags: Array.isArray(it.tags) ? it.tags.slice(0,5).map(t=>String(t).slice(0,20)) : (items[i]?.tags || [])
          };
        });

        while (cleaned.length < 30) cleaned.push(synthItems30(gender, budget)[0]);
        return cleaned;
      } catch { return null; }
    };

    const llm1 = await tryLLM();
    if (llm1) items = llm1; else {
      const llm2 = await tryLLM();
      if (llm2) items = llm2;
    }

    const token = "GB" + Math.random().toString(36).slice(2, 10).toUpperCase();
    sessions.set(token, {
      type: "glam",
      gender,
      budgetInr: budget,
      items,
      createdAt: Date.now()
    });

    res.json({ ok: true, token, gender, budgetInr: budget, items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------- Glam: Score ----------
app.post("/api/glam/score", async (req, res) => {
  try {
    const { token, selectedIndices, timeTaken } = req.body ?? {};
    const s = sessions.get(token);
    if (!s || s.type !== "glam")
      return res.status(400).json({ ok: false, error: "Session not found/expired." });

    const idxs = Array.isArray(selectedIndices) ? selectedIndices : [];
    const uniqueIdxs = [...new Set(idxs)].filter(i => Number.isInteger(i) && i >= 0 && i < s.items.length);

    const selected = uniqueIdxs.map(i => s.items[i]);
    const total = selected.reduce((sum, it) => sum + Number(it.price || 0), 0);
    const secs = Math.max(0, Number(timeTaken) || 0);

    // If < 12 picks, auto-fail but provide structured response
    if (selected.length < 12) {
      sessions.delete(token);
      return res.json({
        ok: true,
        done: true,
        win: false,
        autoFinished: secs >= 180,
        score: Math.max(0, Math.min(60, Math.round(selected.length * 5))), // courtesy score
        summary: "You must pick at least 12 products for a complete kit.",
        budgetInr: s.budgetInr,
        totalSpend: total,
        timeTaken: secs,
        positives: selected.length ? ["Some useful picks made"] : [],
        negatives: ["Picked fewer than 12 products"]
      });
    }

    // Score with AI
    let scored = { score: 0, positives: [], negatives: [], summary: "No summary." };
    try {
      const raw = await chatCompletion(PROMPTS.glamScore({
        budgetInr: s.budgetInr,
        selected,
        timeTaken: secs
      }), 0.4, 1300);
      const parsed = JSON.parse(raw);
      if (typeof parsed.score === "number") scored.score = Math.max(0, Math.min(100, parsed.score));
      if (Array.isArray(parsed.positives)) scored.positives = parsed.positives.slice(0, 6);
      if (Array.isArray(parsed.negatives)) scored.negatives = parsed.negatives.slice(0, 6);
      if (typeof parsed.summary === "string") scored.summary = parsed.summary;
    } catch {
      // simple fallback scoring if model fails
      const ecoShare = selected.filter(x=>x.ecoFriendly).length / selected.length;
      const spendRatio = Math.min(1, total / Math.max(1, s.budgetInr));
      scored.score = Math.round(60 * spendRatio + 20 * ecoShare + Math.min(20, selected.length));
      scored.summary = "Fallback scoring applied.";
    }

    // Server-side budget guard (soft penalty + negative note)
    const overBudget = total > s.budgetInr;
    if (overBudget) {
      scored.negatives = ['Total spend exceeded the budget', ...(scored.negatives || [])].slice(0,6);
      scored.score = Math.max(0, Math.min(100, Math.round(scored.score * 0.85))); // 15% penalty
    }

    sessions.delete(token);

    const win = scored.score >= 75;
    res.json({
      ok: true,
      done: true,
      win,
      score: scored.score,
      summary: scored.summary,
      positives: scored.positives,
      negatives: scored.negatives,
      budgetInr: s.budgetInr,
      totalSpend: total,
      timeTaken: secs,
      message: win
        ? `🎉 Great build! Score ${scored.score}/100`
        : `😢 Failed! Try again. Score ${scored.score}/100`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================
   Healthcheck
======================== */
app.get("/healthz", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
