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
app.use("/api/", rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { ok: false, error: "Too many requests. Please wait a moment and try again." },
}));

// In-memory store (simple demo)
const sessions = new Map();
const recentByTopic = new Map();        // Character game: avoid repeats per topic (last 5)
const recentQuizByTopic = new Map();    // Quiz game: avoid repeating questions per topic (keep last 50 Qs)
const MAX_CHARACTER_ROUNDS = 5;
const makeId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 10);

/* ------------------------
   Prompt templates
------------------------- */
const PROMPTS = {
  // Game 1: 5-Round Quiz (HARD)
  quiz: (topic, bannedQuestions = []) => [
    { role: "system", content: `You are an expert quiz generator. Create EXACTLY 5 difficult multiple-choice questions STRICTLY and DIRECTLY related to the exact topic provided. Do not broaden, reinterpret, or substitute the topic. Every question must test knowledge specifically about that topic. Exactly 4 options per question, exactly one correct answer, answerIndex 1-4. Avoid these previous questions: ${bannedQuestions.join(" | ") || "(none)"}. Return STRICT JSON ONLY: {"questions":[{"question":"string","options":["string","string","string","string"],"answerIndex":1,"explanation":"string"}]}. No markdown or extra text.` },
    { role: "user", content: `Exact topic: "${topic}". Generate questions ONLY about this exact topic. JSON only.` },
  ],

  // Game 2: Guess the Character (hard)
  characterCandidates: (topic, excludeList = []) => [
    { role: "system", content: `You are curating a HARD Guess the Character game. Select EXACTLY 8 distinct people or fictional characters directly and unmistakably related to the exact topic. Prefer medium-hard or hard choices: important but not the most obvious first answer. Avoid random celebrities, loosely related names, generic figures, and repeated characters. Preserve the exact topic scope. Never repeat any name or alter ego from this exclusion list: ${excludeList.join(", ") || "(none)"}. Return STRICT JSON ONLY: {"candidates":["name1","name2","name3","name4","name5","name6","name7","name8"]}. No extra text.` },
    { role: "user", content: `Exact topic: "${topic}". Select hard, non-repetitive candidates ONLY directly related to this exact topic. JSON only.` },
  ],

  characterTurn: ({ name, qa, round, text }) => [
    { role: "system", content: `You are running a hard 5-round Guess the Character game. Secret character: "${name}". Answer naturally and briefly without revealing the name. Detect direct guesses. Return STRICT JSON: {"answer":"string","isGuess":true,"guessedName":"string","hints":[]}. Never include a hint in your answer. A separate public hint is generated only after both sides finish round 5. No markdown or extra text.` },
    { role: "user", content: `Previous Q&A:
${qa}
Current Round: ${round}
User message: ${text}` },
  ],

  characterHint: ({ name, topic, round }) => [
    { role: "system", content: `Generate exactly one strong but fair FINAL-ROUND public clue for a hard Guess the Character game. Secret: "${name}". Topic: "${topic}". Round: ${round}. Do not mention the secret name or any exact alias. The clue should meaningfully narrow the possibilities without making the answer trivial. Max 30 words. Return STRICT JSON ONLY: {"hint":"string"}.` },
    { role: "user", content: "Generate the clue. JSON only." },
  ],

  // Agentic detective: private reasoning, candidate ranking and its own question. The secret name is never sent here.
  characterAgent: ({ topic, history, clues, round, previousGuesses }) => [
    { role: "system", content: `You are an autonomous expert detective competing in a HARD 5-round Guess the Character game. You DO NOT know the secret name. You may use ONLY your own private Q&A history, public clues, the exact topic, and your previous guesses. Never use the player's private questions or answers. Analyze evidence deeply: track constraints, eliminate candidates that contradict evidence, maintain a ranked shortlist, and ask the single most information-rich next question. Return STRICT JSON ONLY: {"analysis":"private concise reasoning","topCandidates":[{"name":"string","confidence":0},{"name":"string","confidence":0},{"name":"string","confidence":0}],"confidence":0,"question":"string or null","shouldGuess":false,"guess":null,"status":"short public status"}. Rules: exactly 3 plausible ranked candidates whenever evidence allows; confidence 0-100; never guess randomly; rounds 1-2 investigate; rounds 3-4 may make an early guess only at confidence >=85; round 5 should ask one final discriminating question and wait for the public final-round hint; the final answer is submitted separately after round 5. Do not reveal private analysis or candidate names in status; ask a question that can discriminate between leading candidates. No markdown.` },
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
function parseModelJson(raw) {
  if (typeof raw !== "string") throw new Error("Model returned an empty response.");
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) text = text.slice(first, last + 1);
  return JSON.parse(text);
}

async function chatCompletion(messages, temperature = 0.7, max_tokens = 256, options = {}) {
  if (!GROQ_API_KEY) throw new Error("Groq API key is missing. Set GROQ_API_KEY or QROQ_API_KEY in .env.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 45000);

  try {
    const body = {
      model: GROQ_MODEL,
      messages,
      temperature,
      max_tokens,
    };
    if (options.json) body.response_format = { type: "json_object" };

    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Groq API ${res.status}: ${t.slice(0, 500)}`);
    }

    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) throw new Error("Groq returned an empty completion.");
    return content;
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("Groq request timed out. Please try again.");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/* ========================
   Game 1: 5-Round Quiz (hard, no-repeat per topic)
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
    const raw = await chatCompletion(PROMPTS.characterGuessJudge({ secretName, guess: String(guess).trim() }), 0, 300, { json: true });
    const parsed = parseModelJson(raw);
    return { correct: Boolean(parsed.correct), reason: String(parsed.reason || "") };
  } catch {
    const normalize = (v) => String(v).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
    return { correct: normalize(secretName) === normalize(guess), reason: "Exact-name fallback comparison." };
  }
}

async function runCharacterAgent(s, round) {
  const history = (s.agent.history || []).map((h, i) => `Round ${i + 1} Agent Question: ${h.q}\nPrivate Game Master Answer: ${h.a}`).join("\n");
  const clues = (s.clues || []).map((c) => `Final-round public clue: ${c}`).join("\n");
  const previousGuesses = (s.agent.guesses || []).map((g) => `${g.guess} (${g.correct ? "correct" : "wrong"})`).join(", ");
  try {
    const raw = await chatCompletion(PROMPTS.characterAgent({ topic: s.topic, history, clues, round, previousGuesses }), 0.25, 900, { json: true });
    const parsed = parseModelJson(raw);
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
    const topic = String(req.body?.topic || "").trim();
    if (topic.length < 2) return res.status(400).json({ ok:false, error:"Please enter a valid topic." });
    if (topic.length > 120) return res.status(400).json({ ok:false, error:"Topic is too long." });

    const topicKey = topic.toLowerCase();
    const exclude = recentByTopic.get(topicKey) || [];
    let candidates = [];
    let lastError = null;

    // Retry once because structured output can occasionally fail on reasoning models.
    for (let attempt = 0; attempt < 2 && candidates.length === 0; attempt++) {
      try {
        const raw = await chatCompletion(
          PROMPTS.characterCandidates(topic, exclude),
          0.55,
          1000,
          { json: true, timeoutMs: 60000 }
        );
        const parsed = parseModelJson(raw);
        if (Array.isArray(parsed.candidates)) {
          candidates = parsed.candidates
            .map(c => String(c || "").trim())
            .filter(c => c.length >= 2 && c.length <= 100);
        }
      } catch (err) {
        lastError = err;
        console.error("Character candidate generation attempt failed:", err.message);
      }
    }

    const unique = [...new Map(candidates.map(c => [c.toLowerCase(), c])).values()];
    const lowerRecent = new Set(exclude.map(x => String(x).toLowerCase()));
    const fresh = unique.filter(c => !lowerRecent.has(c.toLowerCase()));
    const valid = fresh.length ? fresh : unique;

    if (!valid.length) {
      return res.status(502).json({
        ok:false,
        error: lastError?.message || "Groq could not generate a valid character list. Please try again."
      });
    }

    const name = valid[Math.floor(Math.random() * valid.length)];
    recentByTopic.set(topicKey, [name, ...exclude.filter(x => String(x).toLowerCase() !== name.toLowerCase())].slice(0, 30));

    const id = makeId();
    sessions.set(id, {
      type:"character", topic, name, rounds:0, history:[], clues:[], createdAt:Date.now(),
      agent:{ guesses:[], history:[], confidence:0, status:"Ready to investigate", analysis:"", topCandidates:[] }
    });

    res.json({ ok:true, sessionId:id, message:"Battle started." });
  } catch (e) {
    console.error("Character start failed:", e);
    res.status(500).json({ ok:false, error:e.message || "Unable to start the battle." });
  }
});

app.post("/api/character/turn", async (req, res) => {
  try {
    const { sessionId, text } = req.body ?? {};
    const s = sessions.get(sessionId);
    if (!s || s.type !== "character") return res.status(400).json({ ok:false, error:"Session not found." });
    if (s.rounds >= MAX_CHARACTER_ROUNDS) return res.status(400).json({ ok:false, error:`All ${MAX_CHARACTER_ROUNDS} rounds are complete. Submit your final guess.` });

    const qa = s.history.map((h,i)=>`Q${i+1}: ${h.q}\nA${i+1}: ${h.a}`).join("\n");
    let parsed={answer:"Okay.",isGuess:false,guessedName:"",hints:[]};
    try {
      parsed=parseModelJson(await chatCompletion(
        PROMPTS.characterTurn({name:s.name,qa,round:s.rounds+1,text}),0.3,700,{json:true}
      ));
    } catch (err) {
      console.error("Character turn parse failed:", err.message);
    }

    s.rounds += 1;
    const roundNow=s.rounds;
    s.history.push({q:text||"",a:parsed.answer||""});

    // Player can win immediately only before the final simultaneous-guess stage.
    if(parsed.isGuess && parsed.guessedName && roundNow < MAX_CHARACTER_ROUNDS){
      const playerJudge=await judgeCharacterGuess(s.name,parsed.guessedName);
      if(playerJudge.correct){
        sessions.delete(sessionId);
        return res.json({
          ok:true,done:true,winner:"player",win:true,name:s.name,answer:parsed.answer,hints:[],
          message:`🏆 You beat the AI Detective and solved it in round ${roundNow}!`,
          agent:{confidence:s.agent.confidence,status:s.agent.status}
        });
      }
    }

    // Agent gets its own private turn. It never receives the player's Q/A or answers.
    const decision=await runCharacterAgent(s,roundNow);
    s.agent.confidence=decision.confidence;
    s.agent.status=decision.status;
    s.agent.analysis=decision.analysis;
    s.agent.topCandidates=decision.topCandidates;

    let agentQuestion = decision.question || null;
    if (agentQuestion) {
      let agentPrivateAnswer = "";
      try {
        const agentQa = (s.agent.history || []).map((h,i)=>`Q${i+1}: ${h.q}\nA${i+1}: ${h.a}`).join("\n");
        const agentParsed = parseModelJson(await chatCompletion(
          PROMPTS.characterTurn({name:s.name,qa:agentQa,round:roundNow,text:agentQuestion}),0.2,500,{json:true}
        ));
        agentPrivateAnswer = String(agentParsed.answer || "").trim();
      } catch (err) {
        console.error("Agent private question failed:", err.message);
      }
      if (agentPrivateAnswer) s.agent.history.push({q:agentQuestion,a:agentPrivateAnswer});
    }

    // The detective may win early in rounds 1-4. Round 5 is reserved for simultaneous final guesses.
    if(roundNow < MAX_CHARACTER_ROUNDS && decision.shouldGuess && decision.guess && !s.agent.guesses.some(g=>g.guess.toLowerCase()===decision.guess.toLowerCase())){
      const judged=await judgeCharacterGuess(s.name,decision.guess);
      s.agent.guesses.push({round:roundNow,guess:decision.guess,correct:judged.correct});
      if(judged.correct){
        sessions.delete(sessionId);
        return res.json({
          ok:true,done:true,winner:"agent",win:false,name:s.name,answer:parsed.answer,hints:[],
          message:`🤖 AI Detective solved the mystery in round ${roundNow}!`,
          agent:{confidence:decision.confidence,status:"Solved the mystery!",guess:decision.guess}
        });
      }
    }

    // Only after both the player and agent have completed round 5 do we reveal the public clue.
    let hintsOut=[];
    if (roundNow === MAX_CHARACTER_ROUNDS) {
      try {
        const hp=parseModelJson(await chatCompletion(
          PROMPTS.characterHint({name:s.name,topic:s.topic,round:roundNow}),0.3,350,{json:true}
        ));
        if(hp?.hint?.trim()) hintsOut=[hp.hint.trim()];
      } catch(err){
        console.error("Final character hint failed:", err.message);
      }
      if(!hintsOut.length) hintsOut=[`Focus on a distinctive role, achievement, setting, or relationship that strongly connects this character to ${s.topic}.`];
      s.clues.push(hintsOut[0]);
    }

    res.json({
      ok:true,done:false,answer:parsed.answer,hints:hintsOut,round:roundNow,
      roundsLeft:Math.max(0,MAX_CHARACTER_ROUNDS-roundNow),
      finalRoundReady:roundNow===MAX_CHARACTER_ROUNDS,
      agent:{confidence:s.agent.confidence,status:s.agent.status,question:agentQuestion}
    });
  } catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

app.post("/api/character/final-guess", async (req,res)=>{
  try {
    const {sessionId,playerGuess}=req.body??{};
    const s=sessions.get(sessionId);
    if(!s||s.type!=="character") return res.status(400).json({ok:false,error:"Session not found."});
    if(s.rounds<MAX_CHARACTER_ROUNDS) return res.status(400).json({ok:false,error:`Final guesses unlock after round ${MAX_CHARACTER_ROUNDS}.`});

    // The public final clue is now available to the agent too, but the player still cannot see agent private answers.
    const agentDecision=await runCharacterAgent(s,MAX_CHARACTER_ROUNDS);
    const agentGuess=agentDecision.guess || (Array.isArray(agentDecision.topCandidates) && agentDecision.topCandidates[0]?.name) || "No valid guess";
    const [playerResult,agentResult]=await Promise.all([
      judgeCharacterGuess(s.name,playerGuess),
      judgeCharacterGuess(s.name,agentGuess)
    ]);

    let winner="draw";
    if(playerResult.correct&&!agentResult.correct) winner="player";
    else if(!playerResult.correct&&agentResult.correct) winner="agent";
    // both correct and both wrong are draws

    const message=winner==="player"
      ? "🏆 You beat the AI Detective!"
      : winner==="agent"
        ? "🤖 The AI Detective wins this battle."
        : playerResult.correct&&agentResult.correct
          ? "🤝 Draw! Both you and the AI Detective identified the character correctly."
          : "🤝 Draw! Neither side identified the character correctly.";

    const payload={
      ok:true,done:true,winner,win:winner==="player",name:s.name,message,
      player:{guess:playerGuess||"",correct:playerResult.correct},
      agent:{guess:agentGuess,correct:agentResult.correct,confidence:agentDecision.confidence}
    };
    sessions.delete(sessionId);
    res.json(payload);
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

/* ------------------------
   AI Cricket Auction Arena
------------------------- */
/* ========================
   AI Cricket Auction Arena
======================== */
const AUCTION_POOL_ORDER = ["Batsmen", "Bowlers", "All Rounders", "Wicket Keepers"];
const AUCTION_POOL_COUNTS = {"Batsmen":6,"Bowlers":6,"All Rounders":5,"Wicket Keepers":3};
const AUCTION_DURATION_MS = 15000;
const AUCTION_BID_DELAY_MS = 2000;
const AUCTION_MAX_SQUAD = 6;
const AUCTION_MIN_SQUAD = 5;
const AUCTION_REQUIRED_ROLES = ["Batsmen","Bowlers","Wicket Keepers"];
const AUCTION_START_PURSE = 100;
const AUCTION_MIN_BUY_PRICE = 2;
const auctionSessions = new Map();
const auctionId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

function auctionFallbackPlayers() {
  return [
    {name:"Suryakumar Yadav",pool:"Batsmen",base:8,rating:92,tag:"All-Format Aggressor"},
    {name:"Ruturaj Gaikwad",pool:"Batsmen",base:7,rating:88,tag:"Aggressive Strokeplayer"},
    {name:"Rinku Singh",pool:"Batsmen",base:6,rating:89,tag:"Finisher"},
    {name:"Travis Head",pool:"Batsmen",base:9,rating:91,tag:"Power-Hitter"},
    {name:"Shubman Gill",pool:"Batsmen",base:8,rating:90,tag:"Aggressive Strokeplayer"},
    {name:"Yashasvi Jaiswal",pool:"Batsmen",base:7.5,rating:90,tag:"Power-Hitter"},
    {name:"Jasprit Bumrah",pool:"Bowlers",base:10,rating:96,tag:"Fast"},
    {name:"Mohammed Shami",pool:"Bowlers",base:8,rating:90,tag:"Fast"},
    {name:"Kuldeep Yadav",pool:"Bowlers",base:7,rating:89,tag:"Spinner"},
    {name:"Trent Boult",pool:"Bowlers",base:8,rating:91,tag:"Swing Bowler"},
    {name:"Rashid Khan",pool:"Bowlers",base:9,rating:94,tag:"Spinner"},
    {name:"Arshdeep Singh",pool:"Bowlers",base:6.5,rating:87,tag:"Swing Bowler"},
    {name:"Hardik Pandya",pool:"All Rounders",base:9,rating:91,tag:"Power All-Rounder"},
    {name:"Ravindra Jadeja",pool:"All Rounders",base:9,rating:93,tag:"Spin All-Rounder"},
    {name:"Andre Russell",pool:"All Rounders",base:8,rating:90,tag:"Power All-Rounder"},
    {name:"Axar Patel",pool:"All Rounders",base:7,rating:88,tag:"Spin All-Rounder"},
    {name:"Liam Livingstone",pool:"All Rounders",base:7.5,rating:89,tag:"Power All-Rounder"},
    {name:"Sanju Samson",pool:"Wicket Keepers",base:8,rating:90,tag:"Aggressive Keeper"},
    {name:"Ishan Kishan",pool:"Wicket Keepers",base:7,rating:88,tag:"Power-Hitting Keeper"},
    {name:"Rishabh Pant",pool:"Wicket Keepers",base:9,rating:92,tag:"Finisher Keeper"}
  ];
}

const auctionPlayerPoolsPrompt = () => [
  { role: "system", content: `You are creating a fresh IPL-style cricket auction player list using REAL, well-known professional cricketers. Return STRICT JSON ONLY: {"players":[...]}. Exactly 20 UNIQUE real cricketers, in this exact distribution: 6 "Batsmen", 6 "Bowlers", 5 "All Rounders", 3 "Wicket Keepers". Each object: {"name":"real full name","pool":"Batsmen|Bowlers|All Rounders|Wicket Keepers","base":number,"rating":number,"tag":"string"}. Base price 2-10 in 0.5 increments. Rating 78-97. Make ratings and prices varied enough for strategic bidding. Do not invent fictional names. No markdown.` },
  { role: "user", content: "Create a fresh balanced 20-player auction pool now. JSON only." }
];

async function generateAuctionPlayers(){
  try {
    const raw = await chatCompletion(auctionPlayerPoolsPrompt(), 0.75, 2200, {json:true, timeoutMs:30000});
    const parsed = parseModelJson(raw);
    const players = Array.isArray(parsed?.players) ? parsed.players : [];
    const counts = {...AUCTION_POOL_COUNTS};
    const seen = new Set();
    const cleaned = [];
    for (const x of players) {
      const name = String(x?.name||"").trim();
      const pool = String(x?.pool||"").trim();
      if (!name || !(pool in counts) || seen.has(name.toLowerCase()) || counts[pool] <= 0) continue;
      seen.add(name.toLowerCase()); counts[pool]--;
      const baseRaw = Number(x.base);
      const base = Number.isFinite(baseRaw) ? Math.min(10,Math.max(2,Math.round(baseRaw*2)/2)) : 5;
      const rating = Math.min(97,Math.max(78,Math.round(Number(x.rating)||85)));
      const defaults = {"Batsmen":"Aggressive Strokeplayer","Bowlers":"Fast","All Rounders":"Balanced All-Rounder","Wicket Keepers":"Reliable Keeper"};
      const tag = String(x.tag||"").trim() || defaults[pool];
      cleaned.push({id:`${pool.replace(/\s+/g,'-')}-${cleaned.length+1}`,name,pool,base,rating,tag});
    }
    if (Object.values(counts).every(v=>v===0) && cleaned.length===20) {
      return AUCTION_POOL_ORDER.flatMap(pool=>cleaned.filter(p=>p.pool===pool));
    }
  } catch (e) { console.error("Auction AI pool generation failed:", e.message); }
  return auctionFallbackPlayers().map((x,i)=>({...x,id:`fallback-${i+1}`}));
}

function roundHalf(n){ return Math.round(n*2)/2; }
function nextBidAmount(s){
  const pendingMax = (s.pendingBids||[]).reduce((m,b)=>Math.max(m,b.amount), s.highest.amount);
  return roundHalf(pendingMax+0.5);
}
function publicAuction(s){
  const p=s.players[s.index];
  const pending=s.pendingBids||[];
  return {
    ok:true,sessionId:s.id,current:p||null,index:s.index,total:s.players.length,
    roundEndsAt:s.roundEndsAt,auctionClosed:!!s.auctionClosed,
    teams:s.teams,logs:s.logs.slice(-14),currentBid:s.highest.amount,
    currentBidder:s.highest.bidder,pendingBid:pending[0]?{bidder:pending[0].bidder,amount:pending[0].amount,acceptAt:pending[0].acceptAt}:null,
    done:s.index>=s.players.length,poolName:p?.pool||null,
    poolCounts:AUCTION_POOL_COUNTS,auctionDurationSeconds:AUCTION_DURATION_MS/1000,bidAcceptanceDelaySeconds:AUCTION_BID_DELAY_MS/1000,
    rules:{minSquad:AUCTION_MIN_SQUAD,maxSquad:AUCTION_MAX_SQUAD,requiredRoles:AUCTION_REQUIRED_ROLES}
  };
}

function teamRoleCounts(team){
  return AUCTION_POOL_ORDER.reduce((acc,role)=>{acc[role]=team.squad.filter(x=>x.pool===role).length;return acc;},{});
}
function missingCoreRoles(team){
  const roles=teamRoleCounts(team);
  return AUCTION_REQUIRED_ROLES.filter(r=>roles[r]===0);
}
function remainingBuyReserve(team, additional=0){
  const needed=Math.max(0,AUCTION_MIN_SQUAD-(team.squad.length+additional));
  return needed*AUCTION_MIN_BUY_PRICE;
}
function teamNeeds(team,p){
  if (team.squad.length>=AUCTION_MAX_SQUAD) return false;
  const missing=missingCoreRoles(team);
  if (missing.includes(p.pool)) return true;
  const roles=teamRoleCounts(team);
  return roles[p.pool]===0 && team.squad.length<AUCTION_MIN_SQUAD;
}

function playerValue(p){
  const ratingValue=(p.rating-75)*0.45;
  const premium=p.rating>=93?2.5:p.rating>=90?1.5:0;
  const baseEfficiency=p.base<=6?1.5:p.base<=7.5?0.75:0;
  const roleScarcity=p.pool==='Wicket Keepers'?3.2:(p.pool==='Bowlers'?1.2:0);
  return p.base+ratingValue+premium+baseEfficiency+roleScarcity;
}
function aiState(team,s,p){
  const roles=teamRoleCounts(team);
  const missing=missingCoreRoles(team);
  const squadSize=team.squad.length;
  const playersLeft=s.players.slice(s.index+1);
  const futureCore={
    'Batsmen':playersLeft.filter(x=>x.pool==='Batsmen').length,
    'Bowlers':playersLeft.filter(x=>x.pool==='Bowlers').length,
    'Wicket Keepers':playersLeft.filter(x=>x.pool==='Wicket Keepers').length
  };
  const futureRoleChance=futureCore[p.pool]||0;
  const roleUrgency=missing.includes(p.pool)?(futureRoleChance<=1?2.0:1.35):1;
  const scarceBonus=p.pool==='Wicket Keepers' ? 1.35 : (p.pool==='Bowlers' ? 1.08 : 1);
  const quality=(p.rating-78)/19;
  const value=Math.max(0,playerValue(p));
  const budgetFactor=Math.min(1.18,Math.max(0.72,team.purse/65));
  const reserve=remainingBuyReserve(team,1);
  const safePurse=Math.max(0,team.purse-reserve);
  const maxByQuality=value*(0.72+quality*0.32)*roleUrgency*scarceBonus*budgetFactor;
  const mustBuy= squadSize<AUCTION_MIN_SQUAD && (missing.includes(p.pool) || futureRoleChance<=1);
  const max=roundHalf(Math.min(safePurse,maxByQuality + (mustBuy?1.5:0)));
  return {roles,missing,futureCore,futureRoleChance,roleUrgency,quality,value,budgetFactor,reserve,max,mustBuy};
}
function aiShouldBid(team,s,p,currentAmount){
  if(team.squad.length>=AUCTION_MAX_SQUAD || team.purse<0.5) return {bid:false,max:0};
  const st=aiState(team,s,p);
  const next=roundHalf(currentAmount+0.5);
  if(next>st.max || next>team.purse-st.reserve) return {bid:false,max:st.max};

  // Smart AI behavior: protect mandatory roles, value ratings, track scarcity,
  // avoid bidding wars, and keep a reserve for the minimum five-player squad.
  const overpayRatio=next/Math.max(1,st.value);
  if(overpayRatio>1.16 && !st.mustBuy) return {bid:false,max:st.max};
  const qualityPressure=st.quality>0.72?0.15:st.quality>0.5?0.04:-0.05;
  const urgencyPressure=st.missing.includes(p.pool)?0.28:0;
  const scarcityPressure=st.futureRoleChance<=1?0.22:st.futureRoleChance===2?0.08:0;
  const budgetPressure=team.purse<25?-0.18:team.purse>65?0.05:0;
  const personality=team.strategy==='aggressive'?0.08:team.strategy==='balanced'?0.02:-0.04;
  const score=0.42+qualityPressure+urgencyPressure+scarcityPressure+budgetPressure+personality-(overpayRatio>1.0?0.16:0);
  return {bid:st.mustBuy || Math.random()<Math.max(0.08,Math.min(0.9,score)),max:st.max,state:st};
}
function queueBid(s,bidder,amount){
  s.pendingBids=s.pendingBids||[];
  if(s.pendingBids.some(b=>b.bidder===bidder)) return false;
  s.pendingBids.push({bidder,amount,requestedAt:Date.now(),acceptAt:Date.now()+AUCTION_BID_DELAY_MS});
  s.pendingBids.sort((a,b)=>a.requestedAt-b.requestedAt);
  return true;
}
function acceptPendingBids(s){
  if(!s.pendingBids?.length)return;
  const now=Date.now();
  const due=s.pendingBids.filter(b=>b.acceptAt<=now);
  s.pendingBids=s.pendingBids.filter(b=>b.acceptAt>now);
  for(const b of due){
    const t=s.teams[b.bidder];
    if(!t || t.squad.length>=AUCTION_MAX_SQUAD || t.purse<b.amount) continue;
    if(b.amount<=s.highest.amount) continue;
    const p=s.players[s.index];
    s.highest={bidder:b.bidder,amount:b.amount};
    s.logs.push(`ACCEPTED: ${t.name} bids ₹${b.amount} Cr for ${p.name}`);
  }
}
function runAgents(s){
  const p=s.players[s.index]; if(!p || s.auctionClosed)return;
  // Never create a new bid after the 15-second bidding cutoff.
  if(Date.now()>=s.roundEndsAt)return;
  for(const key of ['agent1','agent2']){
    const t=s.teams[key];
    if(s.pendingBids?.some(b=>b.bidder===key))continue;
    const current=Math.max(s.highest.amount,(s.pendingBids||[]).reduce((m,b)=>Math.max(m,b.amount),0));
    const decision=aiShouldBid(t,s,p,current);
    if(decision.bid){
      const next=roundHalf(current+0.5);
      if(next<=decision.max && next<=t.purse-remainingBuyReserve(t,1) && queueBid(s,key,next)){
        s.logs.push(`${t.name} is considering ₹${next} Cr for ${p.name} (accepted in 2s)`);
      }
    }
  }
}
function settleCurrentPlayer(s){
  if(s.auctionClosed)return;
  acceptPendingBids(s);
  const p=s.players[s.index]; if(!p)return;
  if(s.pendingBids?.length){
    // A final bid may still be inside the 2-second acceptance window.
    s.logs.push('Auctioneer: Final bids are being accepted...');
    return;
  }
  if(s.highest.bidder){
    const t=s.teams[s.highest.bidder];
    if(t && t.purse>=s.highest.amount){
      t.purse=roundHalf(t.purse-s.highest.amount);
      t.squad.push({...p,price:s.highest.amount});
      s.logs.push(`SOLD! ${p.name} → ${t.name} for ₹${s.highest.amount} Cr`);
    }
  } else s.logs.push(`UNSOLD: ${p.name} (no bids)`);
  s.auctionClosed=true;
}

function evaluateTeam(t){
  const roles=teamRoleCounts(t);
  const squadSize=t.squad.length;
  const avgRating=squadSize?t.squad.reduce((a,p)=>a+p.rating,0)/squadSize:0;
  const roleTypes=AUCTION_POOL_ORDER.filter(r=>roles[r]>0).length;
  const coreRoles=AUCTION_REQUIRED_ROLES.filter(r=>roles[r]>0).length;
  const spent=roundHalf(AUCTION_START_PURSE-t.purse);
  const avgPrice=squadSize?spent/squadSize:0;
  const ratingScore=Math.min(25,(avgRating/100)*25);
  const varietyScore=(roleTypes/4)*20;
  const roleAvailabilityScore=(coreRoles/3)*20;
  const squadCompleteness=squadSize>=AUCTION_MIN_SQUAD&&squadSize<=AUCTION_MAX_SQUAD?10:0;
  const valuePoints=squadSize?Math.min(1,avgRating/Math.max(1,avgPrice*12)):0;
  const purseDiscipline=squadSize?Math.max(0,1-Math.abs(t.purse-35)/65):0;
  const spendingScore=Math.round((valuePoints*0.65+purseDiscipline*0.35)*15);
  const uniqueTags=squadSize?new Set(t.squad.map(p=>p.tag)).size:0;
  const ratingSpread=squadSize?Math.min(1,Math.max(0,uniqueTags/4)):0;
  const strategyFit=Math.min(10,(roleTypes/4)*5+ratingSpread*5);
  const valid=squadSize>=AUCTION_MIN_SQUAD&&squadSize<=AUCTION_MAX_SQUAD&&coreRoles===3;
  const reasons=[];
  if(coreRoles<3)reasons.push(`missing ${AUCTION_REQUIRED_ROLES.filter(r=>!roles[r]).join(', ')}`);
  if(squadSize<AUCTION_MIN_SQUAD)reasons.push(`only ${squadSize} buys (minimum ${AUCTION_MIN_SQUAD})`);
  if(squadSize>AUCTION_MAX_SQUAD)reasons.push(`more than ${AUCTION_MAX_SQUAD} buys`);
  const score=Math.max(0,Math.min(100,Math.round(ratingScore+varietyScore+roleAvailabilityScore+squadCompleteness+spendingScore+strategyFit)));
  return {valid,score,avgRating:Math.round(avgRating*10)/10,roleCounts:roles,roleTypes,spent,remaining:roundHalf(t.purse),avgPrice:roundHalf(avgPrice),breakdown:{rating:Math.round(ratingScore),variety:Math.round(varietyScore),roleAvailability:Math.round(roleAvailabilityScore),squadCompleteness,spendingTactic:spendingScore,strategyFit},reasons};
}

app.post('/api/auction/start', async (req,res)=>{
  try {
    const players=await generateAuctionPlayers();
    const id=auctionId();
    const teams={
      player:{name:req.body.teamName||'Your Team',purse:100,squad:[],strategy:'player'},
      agent1:{name:'AI Titans',purse:100,squad:[],strategy:'balanced'},
      agent2:{name:'AI Warriors',purse:100,squad:[],strategy:'aggressive'}
    };
    const s={id,players,index:0,teams,highest:{bidder:null,amount:players[0].base},pendingBids:[],auctionClosed:false,lastAuctioneerCall:'',roundEndsAt:Date.now()+AUCTION_DURATION_MS,logs:[`Pool: ${players[0].pool} | Auction starts: ${players[0].name} at ₹${players[0].base} Cr`],lastAgentDecisionAt:0};
    auctionSessions.set(id,s); res.json(publicAuction(s));
  } catch(e){res.status(500).json({ok:false,error:e.message||'Unable to start auction'});}
});

app.post('/api/auction/bid',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);
  if(!s||s.index>=s.players.length)return res.status(400).json({ok:false,error:'Auction session not found or complete'});
  acceptPendingBids(s);
  if(s.auctionClosed||Date.now()>=s.roundEndsAt)return res.status(400).json({ok:false,error:'This player auction has closed.'});
  const team=s.teams.player;
  if(team.squad.length>=AUCTION_MAX_SQUAD)return res.status(400).json({ok:false,error:`Your Team already has the maximum ${AUCTION_MAX_SQUAD} players.`});
  if(s.pendingBids.some(b=>b.bidder==='player'))return res.status(409).json({ok:false,error:'Your previous bid is waiting for 2-second auctioneer acceptance.'});
  const next=nextBidAmount(s);
  if(team.purse<next || team.purse-remainingBuyReserve(team,1)<next)return res.status(400).json({ok:false,error:'That bid would leave too little purse to complete the minimum five-player squad.'});
  const p=s.players[s.index];
  queueBid(s,'player',next);
  s.logs.push(`${team.name} bids ₹${next} Cr for ${p.name} (accepting in 2s)`);
  runAgents(s);
  res.json(publicAuction(s));
});

app.post('/api/auction/tick',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId); if(!s)return res.status(404).json({ok:false,error:'Session not found'});
  if(s.index<s.players.length&&!s.auctionClosed){
    acceptPendingBids(s);
    const now=Date.now();
    if(now<s.roundEndsAt){
      // Agent decisions are throttled so they feel deliberate rather than spammy.
      if(now-(s.lastAgentDecisionAt||0)>=700){s.lastAgentDecisionAt=now;runAgents(s);}
      const remaining=Math.ceil((s.roundEndsAt-now)/1000);
      if(remaining<=3&&s.lastAuctioneerCall!==String(remaining)){
        s.lastAuctioneerCall=String(remaining);
        s.logs.push(remaining===3?'Auctioneer: Three seconds remaining!':remaining===2?'Auctioneer: Going once... final bids?':'Auctioneer: Last second!');
      }
    } else {
      // Give any bid submitted before the cutoff its full 2-second acceptance window.
      if(s.pendingBids.length===0)settleCurrentPlayer(s);
      else if(s.pendingBids.some(b=>b.acceptAt<=now))settleCurrentPlayer(s);
    }
  }
  res.json(publicAuction(s));
});

app.post('/api/auction/next',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId); if(!s)return res.status(404).json({ok:false,error:'Session not found'});
  if(!s.auctionClosed)return res.status(400).json({ok:false,error:'Current auction is still live'});
  s.index++;
  if(s.index<s.players.length){
    const n=s.players[s.index];
    s.highest={bidder:null,amount:n.base}; s.pendingBids=[]; s.auctionClosed=false; s.lastAuctioneerCall=''; s.lastAgentDecisionAt=0; s.roundEndsAt=Date.now()+AUCTION_DURATION_MS;
    s.logs.push(`Auctioneer: Next player, ${n.name}, enters from the ${n.pool} pool at ₹${n.base} Cr.`);
  }
  res.json(publicAuction(s));
});

app.post('/api/auction/results',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId); if(!s)return res.status(404).json({ok:false,error:'Session not found'});
  if(s.index<s.players.length)return res.status(400).json({ok:false,error:'Finish all 20 player auctions first.'});
  const ranked=Object.entries(s.teams).map(([id,t])=>{const ev=evaluateTeam(t);return {id,name:t.name,score:ev.valid?ev.score:0,disqualified:!ev.valid,spent:ev.spent,remaining:ev.remaining,squad:t.squad,analysis:ev};}).sort((a,b)=>{if(a.disqualified!==b.disqualified)return a.disqualified?1:-1;return b.score-a.score;});
  const winner=ranked.find(x=>!x.disqualified)||ranked[0];
  res.json({ok:true,ranked,winner,criteria:{rating:25,variety:20,roleAvailability:20,squadCompleteness:10,spendingTactic:15,strategyFit:10},timing:{auctionSeconds:15,bidAcceptanceDelaySeconds:2}});
});
