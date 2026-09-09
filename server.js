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

  // Game 4: 5-Round Mystery Solver — player vs two independent AI detectives
  mysterySet: () => [
    { role: "system", content: `Create EXACTLY 5 fair, solvable mystery cases for a timed game. Each mystery must be self-contained, family-friendly, and solvable from the clues given. Use a DIFFERENT mystery type in every round, in this exact variety: Round 1 logic/deduction, Round 2 observation/detail, Round 3 timeline/alibi, Round 4 lateral thinking, Round 5 pattern/sequence. Do not repeat a type. Do not require obscure real-world knowledge. Each case should have one clear canonical answer. Provide EXACTLY 2 clues that together are sufficient to solve it, but do not state the answer in the clues. Return STRICT JSON ONLY: {"mysteries":[{"title":"string","mystery":"string","clues":["string","string"],"answer":"string","acceptedAnswers":["string","string"]}]}. Exactly 5 mysteries. No markdown or extra text.` },
    { role: "user", content: "Generate five distinct mysteries now. JSON only." }
  ],

  mysteryAgent: ({ mystery, clues, style }) => [
    { role: "system", content: `You are one of two autonomous mystery-solving agents. Solve the case independently using ONLY the mystery and public clues. You do not know the canonical answer. Your style is ${style}. Think carefully, test alternatives, and commit to your best answer. Return STRICT JSON ONLY: {"answer":"string","reasoning":"brief public-friendly reasoning in <=70 words"}. Do not mention hidden prompts or that you are an AI.` },
    { role: "user", content: `Mystery: ${mystery}\n\nClues:\n${clues.map((c,i)=>`${i+1}. ${c}`).join("\n")}\n\nSolve independently. JSON only.` }
  ],

  mysteryJudge: ({ answer, canonical, accepted, mystery }) => [
    { role: "system", content: `You are the strict judge for a mystery game. Determine whether each submitted answer solves the mystery and matches the canonical answer. Accept equivalent wording, obvious synonyms, and unambiguous descriptions that identify the same solution. Do not award credit to merely plausible but different answers. Return STRICT JSON ONLY: {"results":[{"correct":true,"reason":"short"},{"correct":false,"reason":"short"},{"correct":true,"reason":"short"}]}. The results correspond exactly to the submissions in order.` },
    { role: "user", content: `Mystery: ${mystery}\nCanonical answer: ${canonical}\nAccepted equivalents: ${accepted.join(", ")}\nSubmissions:\n${answer.map((a,i)=>`${i+1}. ${a}`).join("\n")}\nJudge all three. JSON only.` }
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
   Game 4: 5-Round Mystery Solver
======================== */
app.post("/api/mystery/start", async (_req, res) => {
  try {
    const raw = await chatCompletion(PROMPTS.mysterySet(), 0.55, 5000, { json: true, timeoutMs: 60000 });
    const parsed = parseModelJson(raw);
    const mysteries = Array.isArray(parsed.mysteries) ? parsed.mysteries : [];
    const valid = mysteries.filter(m =>
      m?.title && m?.mystery && Array.isArray(m.clues) && m.clues.length === 2 &&
      m.answer && Array.isArray(m.acceptedAnswers)
    ).slice(0, 5);
    if (valid.length !== 5) throw new Error("Unable to generate five valid mysteries. Please try again.");

    const token = "MS" + Math.random().toString(36).slice(2, 10).toUpperCase();
    sessions.set(token, {
      type: "mystery",
      round: 0,
      score: { player: 0, logic: 0, lateral: 0 },
      mysteries: valid,
      startedAt: Date.now(),
      createdAt: Date.now(),
    });
    const m = valid[0];
    res.json({ ok: true, token, round: 1, total: 5, title: m.title, mystery: m.mystery, clues: m.clues, timeLimit: 30 });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/mystery/resolve", async (req, res) => {
  try {
    const { token, answer = "" } = req.body ?? {};
    const s = sessions.get(token);
    if (!s || s.type !== "mystery") return res.status(400).json({ ok: false, error: "Session not found/expired." });
    const elapsed = Date.now() - s.startedAt;
    if (elapsed < 29500) return res.status(400).json({ ok: false, error: "Round is still active. Please wait for the 30-second timer to finish." });

    const m = s.mysteries[s.round];
    const cleanAnswer = String(answer || "").trim().slice(0, 500);
    // GPT-OSS reasoning can consume completion tokens before emitting the final JSON.
    // Give each detective enough room and fail soft so one bad generation cannot break the round.
    const safeMysteryAgent = async (style) => {
      try {
        return await chatCompletion(
          PROMPTS.mysteryAgent({ mystery: m.mystery, clues: m.clues, style }),
          style.startsWith("lateral") ? 0.7 : 0.3,
          1200,
          { json: true, timeoutMs: 45000 }
        );
      } catch {
        return JSON.stringify({ answer: "No answer", reasoning: "The detective could not complete its response." });
      }
    };

    const [logicRaw, lateralRaw] = await Promise.all([
      safeMysteryAgent("methodical, evidence-first logic and timeline analysis"),
      safeMysteryAgent("lateral, creative pattern recognition while checking every clue")
    ]);
    const logic = parseModelJson(logicRaw);
    const lateral = parseModelJson(lateralRaw);
    const submissions = [cleanAnswer || "No answer", String(logic?.answer || "No answer").slice(0, 500), String(lateral?.answer || "No answer").slice(0, 500)];

    let judged;
    try {
      const judgeRaw = await chatCompletion(PROMPTS.mysteryJudge({ answer: submissions, canonical: m.answer, accepted: m.acceptedAnswers, mystery: m.mystery }), 0.1, 900, { json: true, timeoutMs: 45000 });
      judged = parseModelJson(judgeRaw);
    } catch {
      const normalize = v => String(v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const acceptable = [m.answer, ...m.acceptedAnswers].map(normalize);
      judged = { results: submissions.map(v => ({ correct: acceptable.some(a => normalize(v) === a), reason: "Matched against accepted solutions." })) };
    }
    const results = Array.isArray(judged.results) ? judged.results.slice(0, 3) : [];
    while (results.length < 3) results.push({ correct: false, reason: "Not solved." });
    if (results[0].correct) s.score.player += 1;
    if (results[1].correct) s.score.logic += 1;
    if (results[2].correct) s.score.lateral += 1;

    const currentRound = s.round + 1;
    s.round += 1;
    const done = s.round >= 5;
    let next = null;
    if (!done) {
      s.startedAt = Date.now();
      const nm = s.mysteries[s.round];
      next = { round: s.round + 1, total: 5, title: nm.title, mystery: nm.mystery, clues: nm.clues, timeLimit: 30 };
    }

    const payload = {
      ok: true,
      round: currentRound,
      result: {
        player: { answer: submissions[0], correct: !!results[0].correct, reason: results[0].reason },
        logic: { answer: submissions[1], correct: !!results[1].correct, reason: results[1].reason },
        lateral: { answer: submissions[2], correct: !!results[2].correct, reason: results[2].reason },
        canonicalAnswer: m.answer,
      },
      score: s.score,
      done,
    };
    if (done) {
      const entries = Object.entries(s.score);
      const max = Math.max(...entries.map(([,v]) => v));
      const winners = entries.filter(([,v]) => v === max).map(([k]) => k);
      payload.winner = winners.length === 1 ? winners[0] : "tie";
      sessions.delete(token);
    } else payload.next = next;
    res.json(payload);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// -----------------------------------------------------------------------------
// AI Cricket Auction Arena - open-ended auction with 3-second auctioneer close
// -----------------------------------------------------------------------------
const AUCTION_POOL_ORDER = ["Batsmen", "Wicket Keepers", "Bowlers", "All Rounders"];
const AUCTION_POOL_COUNTS = {"Batsmen":6,"Wicket Keepers":3,"Bowlers":6,"All Rounders":5};
const AUCTION_PHASES = ["main", "unsold"];
const AUCTION_CLOSE_WAIT_MS = 5000;
const AUCTION_AI_MIN_DELAY_MS = 1400;
const AUCTION_AI_MAX_DELAY_MS = 3200;
const AUCTION_PLAYER_RESPONSE_MS = 2200;
const AUCTION_MAX_SQUAD = 6;
const AUCTION_MIN_SQUAD = 5;
const AUCTION_REQUIRED_ROLES = ["Batsmen","Bowlers","Wicket Keepers"];
const AUCTION_START_PURSE = 100;
const AUCTION_MIN_BUY_PRICE = 2;
const auctionSessions = new Map();
const auctionId = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10);

function auctionFallbackPlayers() {
  return [
    {name:"Ruturaj Gaikwad",pool:"Batsmen",base:7,rating:88,tag:"Aggressive Strokeplayer"},
    {name:"Shubman Gill",pool:"Batsmen",base:8,rating:90,tag:"Classical Opener"},
    {name:"Virat Kohli",pool:"Batsmen",base:10,rating:96,tag:"Chase Master"},
    {name:"Yashasvi Jaiswal",pool:"Batsmen",base:7,rating:91,tag:"Explosive Opener"},
    {name:"Suryakumar Yadav",pool:"Batsmen",base:9,rating:94,tag:"360 Degree Batter"},
    {name:"Rinku Singh",pool:"Batsmen",base:5,rating:84,tag:"Finisher"},
    {name:"Rishabh Pant",pool:"Wicket Keepers",base:9,rating:92,tag:"Attacking Keeper"},
    {name:"KL Rahul",pool:"Wicket Keepers",base:8,rating:89,tag:"Keeper Batter"},
    {name:"Sanju Samson",pool:"Wicket Keepers",base:8,rating:90,tag:"Explosive Keeper"},
    {name:"Jasprit Bumrah",pool:"Bowlers",base:10,rating:97,tag:"Elite Pacer"},
    {name:"Mohammed Shami",pool:"Bowlers",base:8,rating:91,tag:"Seam Leader"},
    {name:"Kuldeep Yadav",pool:"Bowlers",base:6,rating:88,tag:"Wrist Spinner"},
    {name:"Arshdeep Singh",pool:"Bowlers",base:7,rating:86,tag:"Death Bowler"},
    {name:"Rashid Khan",pool:"Bowlers",base:9,rating:94,tag:"Strike Spinner"},
    {name:"Yuzvendra Chahal",pool:"Bowlers",base:6,rating:87,tag:"Wicket Taker"},
    {name:"Hardik Pandya",pool:"All Rounders",base:9,rating:93,tag:"Power All-Rounder"},
    {name:"Ravindra Jadeja",pool:"All Rounders",base:9,rating:92,tag:"Complete All-Rounder"},
    {name:"Axar Patel",pool:"All Rounders",base:7,rating:88,tag:"Utility All-Rounder"},
    {name:"Andre Russell",pool:"All Rounders",base:8,rating:90,tag:"Power Hitter"},
    {name:"Liam Livingstone",pool:"All Rounders",base:7,rating:87,tag:"Dynamic All-Rounder"}
  ];
}

const auctionPlayerPoolsPrompt = () => [
  { role: "system", content: `You are creating a fresh IPL-style cricket auction player list using REAL, well-known professional cricketers. Return STRICT JSON ONLY: {"players":[...]}. Exactly 20 UNIQUE real cricketers, in this exact pool order and distribution: 6 "Batsmen", 3 "Wicket Keepers", 6 "Bowlers", 5 "All Rounders". Each object: {"name":"real full name","pool":"Batsmen|Bowlers|All Rounders|Wicket Keepers","base":number,"rating":number,"tag":"string"}. Base price 2-10 in 0.5 increments. Rating 78-97. Make ratings and prices varied enough for strategic bidding. Do not invent fictional names. No markdown.` },
  { role: "user", content: "Create a fresh balanced 20-player auction pool now. JSON only." }
];

async function generateAuctionPlayers(){
  // Add a per-game nonce so every new auction asks the model for a genuinely fresh pool.
  const gameNonce = `${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
  try {
    const raw = await chatCompletion([...auctionPlayerPoolsPrompt(), { role: "user", content: `Game nonce: ${gameNonce}. Do not reuse a predictable list; choose a fresh set of real cricketers for this game.` }], 0.85, 2200, {json:true, timeoutMs:30000});
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const players = Array.isArray(parsed?.players) ? parsed.players : [];
    const counts = {...AUCTION_POOL_COUNTS};
    const cleaned = [];
    const seen = new Set();
    for (const x of players) {
      if(!x || !AUCTION_POOL_ORDER.includes(x.pool) || counts[x.pool]<=0 || !x.name || seen.has(x.name.toLowerCase())) continue;
      const base = Math.max(2, Math.min(10, Math.round(Number(x.base)*2)/2));
      const rating = Math.max(78, Math.min(97, Math.round(Number(x.rating))));
      const defaults = {"Batsmen":"Aggressive Strokeplayer","Bowlers":"Fast","All Rounders":"Balanced All-Rounder","Wicket Keepers":"Reliable Keeper"};
      cleaned.push({id:`p-${cleaned.length+1}`,name:String(x.name),pool:x.pool,base,rating,tag:String(x.tag||defaults[x.pool])});
      counts[x.pool]--; seen.add(x.name.toLowerCase());
    }
    if(cleaned.length===20 && Object.values(counts).every(v=>v===0)) return AUCTION_POOL_ORDER.flatMap(pool=>cleaned.filter(p=>p.pool===pool));
  } catch (e) { console.error("Auction AI pool generation failed:", e.message); }
  return auctionFallbackPlayers().map((x,i)=>({...x,id:`fallback-${i+1}`}));
}

function roundHalf(n){ return Math.round(Number(n)*2)/2; }
function publicAuction(s){
  const p=s.players[s.index];
  const done=!!s.done || (s.phase==='unsold' && s.index>=s.players.length);
  return {
    ok:true,sessionId:s.id,current:p||null,index:s.index,total:s.players.length,
    auctionClosed:!!s.auctionClosed,teams:s.teams,logs:s.logs.slice(-18),
    currentBid:s.highest?.amount||0,currentBidder:s.highest?.bidder||null,
    done,poolName:s.phase==='unsold'?'Unsold Players':(p?.pool||null),phase:s.phase,
    unsoldCount:s.unsoldPlayers?.length||0,poolCounts:AUCTION_POOL_COUNTS,
    waitingForClose:s.waitingForClose,closeAt:s.closeAt||null,finalChance:!!s.finalChance,closeReady:!!s.closeReady,teamSignals:s.teamSignals||{},
    rules:{minSquad:AUCTION_MIN_SQUAD,maxSquad:AUCTION_MAX_SQUAD,requiredRoles:AUCTION_REQUIRED_ROLES,closeWaitSeconds:AUCTION_CLOSE_WAIT_MS/1000,unsoldReauction:true,allTeamsComplete:Object.values(s.teams||{}).every(t=>t.squad.length>=AUCTION_MAX_SQUAD)}
  };
}
function teamRoleCounts(team){
  return AUCTION_POOL_ORDER.reduce((acc,role)=>{acc[role]=team.squad.filter(x=>x.pool===role).length;return acc;},{});
}
function missingCoreRoles(team){
  const roles=teamRoleCounts(team);
  return AUCTION_REQUIRED_ROLES.filter(r=>roles[r]===0);
}
function futurePlayers(s){ return s.players.slice(s.index+1); }
function reserveForFive(team,s,extraPlayer=null){
  const extra=extraPlayer?1:0;
  const needed=Math.max(0,AUCTION_MIN_SQUAD-(team.squad.length+extra));
  if(needed===0)return 0;
  const hypotheticalRoles=teamRoleCounts(team);
  if(extraPlayer) hypotheticalRoles[extraPlayer.pool]=(hypotheticalRoles[extraPlayer.pool]||0)+1;
  const missing=AUCTION_REQUIRED_ROLES.filter(r=>hypotheticalRoles[r]===0);
  const future=futurePlayers(s).slice();
  const chosen=[];
  for(const role of missing){
    const candidate=future.filter(p=>p.pool===role).sort((a,b)=>a.base-b.base)[0];
    if(candidate) { chosen.push(candidate); future.splice(future.indexOf(candidate),1); }
  }
  while(chosen.length<needed && future.length){
    future.sort((a,b)=>a.base-b.base);
    chosen.push(future.shift());
  }
  if(chosen.length<needed) return Number.POSITIVE_INFINITY;
  return chosen.reduce((sum,p)=>sum+p.base,0);
}
function playerValue(p){
  const ratingValue=(p.rating-75)*0.45;
  const premium=p.rating>=94?2.8:p.rating>=91?1.7:p.rating>=88?0.7:0;
  const baseEfficiency=p.base<=5.5?1.6:p.base<=7?0.8:0;
  const roleScarcity=p.pool==='Wicket Keepers'?3.8:(p.pool==='Bowlers'?1.25:0);
  return p.base+ratingValue+premium+baseEfficiency+roleScarcity;
}
function aiState(team,s,p){
  const roles=teamRoleCounts(team);
  const missing=missingCoreRoles(team);
  const left=futurePlayers(s);
  const futureCore={};
  for(const r of AUCTION_REQUIRED_ROLES) futureCore[r]=left.filter(x=>x.pool===r).length;
  const sameRoleLeft=left.filter(x=>x.pool===p.pool).length;
  const roleUrgency=missing.includes(p.pool)?(futureCore[p.pool]<=1?2.15:1.35):1;
  const scarcity=p.pool==='Wicket Keepers' ? (futureCore[p.pool]===0?1.45:1.25) : (futureCore[p.pool]<=1?1.12:1);
  const quality=Math.max(0,Math.min(1,(p.rating-78)/19));
  const value=Math.max(0,playerValue(p));
  const reserve=reserveForFive(team,s,p);
  const safePurse=Number.isFinite(reserve)?Math.max(0,team.purse-reserve):0;
  const mustBuy=team.squad.length<AUCTION_MIN_SQUAD && missing.includes(p.pool) && futureCore[p.pool]<=1;
  const canFill=team.squad.length<AUCTION_MIN_SQUAD && Number.isFinite(reserve);
  const targetMax=roundHalf(Math.min(safePurse,value*(0.74+quality*0.38)*roleUrgency*scarcity + (mustBuy?2:0)));
  return {roles,missing,futureCore,sameRoleLeft,quality,value,reserve,safePurse,mustBuy,canFill,targetMax};
}
function aiShouldBid(team,s,p,currentAmount){
  if(team.squad.length>=AUCTION_MAX_SQUAD || team.purse<0.5)return {bid:false,reason:'squad/purse limit'};
  const st=aiState(team,s,p);
  const next=roundHalf(currentAmount+0.5);
  if(!Number.isFinite(st.reserve) || next>st.safePurse || next>st.targetMax)return {bid:false,reason:'protecting purse'};

  // Tactical bidding: never buy simply because a player is available.
  // AI first asks whether this player improves the legal squad and final score.
  const overpay=next/Math.max(1,st.value);
  const quality=st.quality;
  const roleNeed=st.missing.includes(p.pool);
  const scarce=st.futureCore[p.pool] <= 1;
  const cheap=overpay <= 0.88;
  const fair=overpay <= 1.02;
  const premiumPlayer=p.rating>=92;

  // Hard stop: preserve enough purse for a legal 5-player squad.
  if(!Number.isFinite(st.reserve) || team.purse-next<st.reserve)
    return {bid:false,reason:'keeping a reserve for a legal squad'};
  if(!roleNeed && !premiumPlayer && !cheap)
    return {bid:false,reason:'does not improve the current squad plan'};
  if(overpay>1.16 && !(roleNeed && scarce && p.rating>=88))
    return {bid:false,reason:'price has crossed value'};

  // Different personalities, but both remain disciplined.
  const aggression=team.strategy==='aggressive' ? 0.18 : 0.06;
  const urgency=roleNeed ? (scarce?0.42:0.24) : 0;
  const qualityBoost=quality*0.20 + (premiumPlayer?0.10:0);
  const valueBoost=cheap?0.18:(fair?0.08:-0.08);
  const budgetPenalty=team.purse<30?0.22:(team.purse<45?0.10:0);
  const mustBuy=team.squad.length<AUCTION_MIN_SQUAD && roleNeed && scarce;
  const score=Math.max(0.05, Math.min(0.88, 0.12+aggression+urgency+qualityBoost+valueBoost-budgetPenalty));
  const bid=mustBuy || Math.random()<score;
  return {bid,max:st.targetMax,state:st,reason:bid?'':'waiting for better value'};
}
function scheduleNextAgentDecision(s, minMs=AUCTION_AI_MIN_DELAY_MS){
  const jitter=Math.floor(Math.random()*(AUCTION_AI_MAX_DELAY_MS-minMs+1));
  s.nextAgentDecisionAt=Date.now()+minMs+jitter;
}
function placeBid(s,bidder,amount,enforceReserve=true){
  const t=s.teams[bidder],p=s.players[s.index];
  const fromFinalCall=!!s.finalChance;
  if(!t||!p||s.auctionClosed||t.squad.length>=AUCTION_MAX_SQUAD||t.purse<amount)return false;
  // During Final Call the player is allowed one last bid even if the AI-style
  // reserve calculation would otherwise reject it. The human only needs enough
  // purse for the actual bid; AI bids still respect their strategic reserve.
  if(amount<=s.highest.amount)return false;
  const reserve=reserveForFive(t,s,p);
  if(enforceReserve && (!Number.isFinite(reserve)||t.purse-amount<reserve))return false;
  s.highest={bidder,amount};
  s.waitingForClose=true;
  s.closeReady=false;
  s.finalChance=false;
  if(bidder==='player' && fromFinalCall) s.playerFinalBidMade=true;
  else if(bidder!=='player') s.playerFinalBidMade=false;
  s.closeAt=Date.now()+AUCTION_CLOSE_WAIT_MS;
  s.lastBidAt=Date.now();
  s.teamSignals=s.teamSignals||{};
  s.teamSignals[bidder]={type:'bid',text:`💰 BID ₹${amount} Cr`,at:Date.now()};
  // Every accepted bid gives the other teams a fresh 5-second chance to respond.
  scheduleNextAgentDecision(s, bidder==='player' ? 1200 : 900);
  s.logs.push(`${t.name} bids ₹${amount} Cr for ${p.name}`);
  return true;
}
function runAgents(s){
  const p=s.players[s.index]; if(!p||s.auctionClosed||s.finalChance)return;
  const now=Date.now();
  if(now<(s.nextAgentDecisionAt||0))return;
  if(now-(s.lastAgentDecisionAt||0)<700)return;
  s.lastAgentDecisionAt=now;

  // AI agents respond only after the player is the highest bidder. If an AI takes
  // the lead, the other AI may challenge it, while the player gets the normal
  // chance to raise through the UI.
  const order=Math.random()<0.5?['agent1','agent2']:['agent2','agent1'];
  for(const key of order){
    const t=s.teams[key];
    if(s.highest.bidder===key) continue;
    const decision=aiShouldBid(t,s,p,s.highest.amount);
    if(decision.bid){
      const next=roundHalf(s.highest.amount+0.5);
      if(next<=decision.max && placeBid(s,key,next)){
        s.logs.push(`${t.name}: BID — responding to the current highest bid for ${p.name}.`);
        return;
      }
    }
    s.agentInterestLogged=s.agentInterestLogged||{};
    if(!s.agentInterestLogged[key] || s.highest.bidder==='player'){
      s.agentInterestLogged[key]=true;
      s.teamSignals[key]={type:'pass',text:'🚫 NO INTEREST',at:Date.now()};
      s.logs.push(`${t.name}: NO INTEREST — ${decision.reason||'not raising the current bid'}.`);
    }
  }
  // Keep checking so an AI can change its mind within the 5-second response window.
  s.nextAgentDecisionAt=Date.now()+900;
}

function settleCurrentPlayer(s){
  if(s.auctionClosed)return;
  const p=s.players[s.index]; if(!p)return;
  if(s.highest.bidder){
    const t=s.teams[s.highest.bidder];
    if(t&&t.purse>=s.highest.amount){
      t.purse=roundHalf(t.purse-s.highest.amount);
      t.squad.push({...p,price:s.highest.amount});
      s.logs.push(`SOLD! ${p.name} → ${t.name} for ₹${s.highest.amount} Cr`);
    }
  } else {
    s.unsoldPlayers=s.unsoldPlayers||[];
    // Keep the original player id/details so the same player can return in the Unsold Players pool.
    s.unsoldPlayers.push({...p});
    s.logs.push(`UNSOLD: ${p.name} — no team was interested. Added to the Unsold Players re-auction pool.`);
  }
  s.auctionClosed=true;
  s.waitingForClose=false;
  s.finalChance=false;
  s.closeAt=null;
}

function evaluateTeam(t){
  const roles=teamRoleCounts(t),squadSize=t.squad.length;
  const avgRating=squadSize?t.squad.reduce((a,p)=>a+p.rating,0)/squadSize:0;
  const roleTypes=AUCTION_POOL_ORDER.filter(r=>roles[r]>0).length;
  const coreRoles=AUCTION_REQUIRED_ROLES.filter(r=>roles[r]>0).length;
  const spent=roundHalf(AUCTION_START_PURSE-t.purse),avgPrice=squadSize?spent/squadSize:0;
  const ratingScore=Math.min(25,(avgRating/100)*25);
  const varietyScore=(roleTypes/4)*20;
  const roleAvailabilityScore=(coreRoles/3)*20;
  const squadCompleteness=squadSize>=AUCTION_MIN_SQUAD&&squadSize<=AUCTION_MAX_SQUAD?10:0;
  const avgValue=squadSize?t.squad.reduce((a,p)=>a+playerValue(p),0)/squadSize:0;
  const spendingEfficiency=squadSize?Math.min(1,avgValue/Math.max(1,avgPrice)):0;
  const purseDiscipline=squadSize?Math.max(0,1-Math.abs(t.purse-35)/65):0;
  const spendingScore=Math.round((spendingEfficiency*0.7+purseDiscipline*0.3)*15);
  const ratingSpread=squadSize?Math.min(1,new Set(t.squad.map(p=>p.tag)).size/4):0;
  const roleBalance=Math.min(1,roleTypes/4);
  const strategyFit=Math.round((roleBalance*0.55+ratingSpread*0.25+(avgRating>=86?0.20:0))*10);
  const valid=squadSize>=AUCTION_MIN_SQUAD&&squadSize<=AUCTION_MAX_SQUAD&&coreRoles===3;
  const reasons=[];
  if(coreRoles<3)reasons.push(`missing ${AUCTION_REQUIRED_ROLES.filter(r=>!roles[r]).join(', ')}`);
  if(squadSize<AUCTION_MIN_SQUAD)reasons.push(`only ${squadSize} buys (minimum ${AUCTION_MIN_SQUAD})`);
  if(squadSize>AUCTION_MAX_SQUAD)reasons.push(`more than ${AUCTION_MAX_SQUAD} buys`);
  const score=Math.max(0,Math.min(100,Math.round(ratingScore+varietyScore+roleAvailabilityScore+squadCompleteness+spendingScore+strategyFit)));
  return {valid,score,avgRating:Math.round(avgRating*10)/10,roleCounts:roles,roleTypes,spent,remaining:roundHalf(t.purse),avgPrice:roundHalf(avgPrice),breakdown:{rating:Math.round(ratingScore),variety:Math.round(varietyScore),roleAvailability:Math.round(roleAvailabilityScore),squadCompleteness,spendingTactic:spendingScore,strategyFit},reasons};
}

app.post('/api/auction/start', async (req,res)=>{
  try{
    const players=await generateAuctionPlayers(),id=auctionId();
    const teams={
      player:{name:req.body.teamName||'Your Team',purse:100,squad:[],strategy:'player'},
      agent1:{name:'AI Titans',purse:100,squad:[],strategy:'balanced'},
      agent2:{name:'AI Warriors',purse:100,squad:[],strategy:'aggressive'}
    };
    const s={id,players,index:0,phase:'main',unsoldPlayers:[],done:false,teams,highest:{bidder:null,amount:players[0].base},auctionClosed:false,waitingForClose:false,finalChance:false,closeAt:null,lastBidAt:0,lastAgentDecisionAt:0,nextAgentDecisionAt:Date.now()+1800,agentInterestLogged:{},teamSignals:{},playerFinalBidMade:false,logs:[`Pool: ${players[0].pool} | Auctioneer opens ${players[0].name} at ₹${players[0].base} Cr. No countdown — bid, skip or wait for the AI agents.`]};
    auctionSessions.set(id,s);res.json(publicAuction(s));
  }catch(e){res.status(500).json({ok:false,error:e.message||'Unable to start auction'});}
});

app.post('/api/auction/bid',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);
  if(!s||s.index>=s.players.length)return res.status(400).json({ok:false,error:'Auction session not found or complete'});
  if(s.auctionClosed)return res.status(400).json({ok:false,error:'This player has already been sold or passed.'});
  const next=roundHalf(s.highest.amount+0.5),team=s.teams.player,p=s.players[s.index];
  if(team.squad.length>=AUCTION_MAX_SQUAD)return res.status(400).json({ok:false,error:`Your Team squad is complete at ${AUCTION_MAX_SQUAD} players. Bidding is disabled for your team.`});
  if(team.squad.length>=AUCTION_MAX_SQUAD)return res.status(400).json({ok:false,error:`Your Team already has the maximum ${AUCTION_MAX_SQUAD} players.`});
  if(team.purse<next)return res.status(400).json({ok:false,error:'Not enough purse for this bid.'});
  // Human bids are accepted whenever the actual purse/increment is valid,
  // including during Final Call. Human bidding does not use the AI reserve rule.
  if(!placeBid(s,'player',next,false))return res.status(409).json({ok:false,error:'That bid is no longer valid. Please try again.'});
  s.logs.push(`Auctioneer: Bid accepted from ${team.name}. Waiting 5 seconds for any higher AI bid.`);
  res.json(publicAuction(s));
});

app.post('/api/auction/skip',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);
  if(!s||s.index>=s.players.length)return res.status(400).json({ok:false,error:'Auction session not found or complete'});
  if(s.auctionClosed)return res.status(400).json({ok:false,error:'This player is already closed.'});
  const p=s.players[s.index];
  s.playerSkipped=true;
  s.finalChance=false;
  s.closeReady=false;
  s.waitingForClose=false;
  s.closeAt=null;
  s.teamSignals=s.teamSignals||{};
  s.teamSignals.player={type:'pass',text:'🚫 NO INTEREST',at:Date.now()};
  if(s.highest.bidder){
    s.logs.push(`Your Team: NO INTEREST in ${p.name}. The existing highest bidder remains in contention.`);
    // If an AI already wants the player, the player can safely skip; the AI wins.
    settleCurrentPlayer(s);
  } else {
    s.logs.push(`Your Team: SKIPPED ${p.name}. No team is interested — player is UNSOLD.`);
    settleCurrentPlayer(s);
  }
  res.json(publicAuction(s));
});

app.post('/api/auction/tick',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);
  if(!s)return res.status(404).json({ok:false,error:'Session not found'});
  if(s.index<s.players.length&&!s.auctionClosed){
    const now=Date.now();
    if(!s.finalChance) runAgents(s);
    if(s.waitingForClose && now>=s.closeAt){
      s.waitingForClose=false;
      const p=s.players[s.index];
      if(s.playerFinalBidMade){
        // The player already used the Final Call. After another 5 seconds with
        // no AI raise, the auctioneer may close and sell to the player team.
        s.closeReady=true;
        s.finalChance=false;
        s.logs.push(`Auctioneer: 5-second response window ended for ${p.name}. No higher AI bid was received. Auctioneer may now close and sell to ${s.teams[s.highest.bidder]?.name||'the highest bidder'}.`);
      } else {
        // No final-call player bid was made yet: give the player the last chance
        // to bid or explicitly choose No Interest.
        s.closeReady=false;
        s.finalChance=true;
        s.logs.push(`Auctioneer: Final Call for ${p.name}. Player Team may BID once more or choose NO INTEREST.`);
      }
    }
  }
  res.json(publicAuction(s));
});

app.post('/api/auction/close',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);
  if(!s||s.index>=s.players.length)return res.status(400).json({ok:false,error:'Auction session not found or complete'});
  if(s.auctionClosed)return res.json(publicAuction(s));
  if(!s.closeReady)return res.status(409).json({ok:false,error:'The 5-second response window is still active.'});
  const p=s.players[s.index];
  s.finalChance=false;
  s.closeReady=false;
  s.waitingForClose=false;
  s.logs.push(`Auctioneer: CLOSED — ${p.name} goes to ${s.highest.bidder?s.teams[s.highest.bidder].name:'UNSOLD'} at ${s.highest.bidder?`₹${s.highest.amount} Cr`:'no bid'}.`);
  settleCurrentPlayer(s);
  res.json(publicAuction(s));
});

app.post('/api/auction/next',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);if(!s)return res.status(404).json({ok:false,error:'Session not found'});
  if(!s.auctionClosed)return res.status(400).json({ok:false,error:'Current auction is still open. Wait for the auctioneer to close it.'});
  s.index++;

  // After all 20 original players, reopen every unsold player in a dedicated final pool.
  if(s.phase==='main' && s.index>=s.players.length){
    s.phase='unsold';
    s.players=(s.unsoldPlayers||[]).map(x=>({...x}));
    s.index=0;
    s.unsoldPlayers=[];
    s.auctionClosed=false;s.waitingForClose=false;s.finalChance=false;s.closeReady=false;s.closeAt=null;s.lastBidAt=0;s.lastAgentDecisionAt=0;s.nextAgentDecisionAt=Date.now()+1800;s.agentInterestLogged={};s.playerSkipped=false;s.playerFinalBidMade=false;
    if(s.players.length){
      const n=s.players[0];
      s.highest={bidder:null,amount:n.base};
      s.logs.push(`🔁 UNSOLD PLAYERS POOL: ${s.players.length} players get a second chance. Auctioneer reopens ${n.name} at ₹${n.base} Cr.`);
    } else {
      s.done=true;
      s.highest={bidder:null,amount:0};
      s.logs.push('🔁 UNSOLD PLAYERS POOL: Empty — all original players were sold. Auction complete.');
    }
  } else if(s.index<s.players.length){
    const n=s.players[s.index];
    s.highest={bidder:null,amount:n.base};s.auctionClosed=false;s.waitingForClose=false;s.finalChance=false;s.closeReady=false;s.closeAt=null;s.lastBidAt=0;s.lastAgentDecisionAt=0;s.nextAgentDecisionAt=Date.now()+1800;s.agentInterestLogged={};s.playerSkipped=false;s.playerFinalBidMade=false;
    s.logs.push(`Auctioneer: Next ${s.phase==='unsold'?'unsold-pool player':'player'} — ${n.name}, ${n.pool}, base ₹${n.base} Cr.`);
  } else if(s.phase==='unsold'){
    s.done=true;
    s.highest={bidder:null,amount:0};
    s.logs.push('Auctioneer: Unsold Players pool complete. Auction finished.');
  }
  res.json(publicAuction(s));
});

app.post('/api/auction/finish',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);
  if(!s)return res.status(404).json({ok:false,error:'Session not found'});
  const allComplete=Object.values(s.teams||{}).every(t=>t.squad.length>=AUCTION_MAX_SQUAD);
  if(!allComplete)return res.status(409).json({ok:false,error:`All 3 teams must complete their ${AUCTION_MAX_SQUAD}-player squads before finishing early.`});
  s.done=true;
  s.auctionClosed=true;
  s.waitingForClose=false;
  s.finalChance=false;
  s.closeReady=false;
  s.closeAt=null;
  s.logs.push('🏁 Auction finished early — all 3 teams have completed their 6-player squads.');
  res.json(publicAuction(s));
});

app.post('/api/auction/results',(req,res)=>{
  const s=auctionSessions.get(req.body.sessionId);if(!s)return res.status(404).json({ok:false,error:'Session not found'});
  if(!s.done)return res.status(400).json({ok:false,error:'Finish the main auction and the Unsold Players re-auction pool first.'});
  const ranked=Object.entries(s.teams).map(([id,t])=>{const ev=evaluateTeam(t);return {id,name:t.name,score:ev.valid?ev.score:0,disqualified:!ev.valid,spent:ev.spent,remaining:ev.remaining,squad:t.squad,analysis:ev};}).sort((a,b)=>{if(a.disqualified!==b.disqualified)return a.disqualified?1:-1;return b.score-a.score;});
  const winner=ranked.find(x=>!x.disqualified)||ranked[0];
  res.json({ok:true,ranked,winner,criteria:{rating:25,variety:20,roleAvailability:20,squadCompleteness:10,spendingTactic:15,strategyFit:10},timing:{auctionSeconds:null,bidAcceptanceDelaySeconds:0,auctioneerCloseWaitSeconds:3}});
});
