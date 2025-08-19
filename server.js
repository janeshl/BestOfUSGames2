import express from "express";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import { customAlphabet } from "nanoid";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "llama3-70b-8192";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

if (!GROQ_API_KEY) console.warn("⚠️  GROQ_API_KEY not set.");

// Middleware
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, max: 30 }));

// In-memory store (simple demo)
const sessions = new Map();
const recentByTopic = new Map();        // Character game: avoid repeats per topic (last 5)
const recentQuizByTopic = new Map();    // Quiz game: avoid repeating questions per topic (keep last 50 Qs)
// --- Riddle Quest memory (avoid repeats across sessions) ---
const recentRiddleTexts = new Set(); // store last ~100 riddle texts

function pushRecentRiddle(text) {
  recentRiddleTexts.add(text.toLowerCase());
  // keep size in check
  if (recentRiddleTexts.size > 100) {
    const first = recentRiddleTexts.values().next().value;
    recentRiddleTexts.delete(first);
  }
}

function normalizeAnswer(s) {
  return String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
}

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
    {
      role: "system",
      content:
        `Create a 5-question Very **hard** multiple-choice quiz for the topic.
Rules:
- EXACTLY 5 questions.
- EACH question has EXACTLY 4 options.
- Indicate the correct option index (1-4).
- Avoid these questions (case-insensitive): ${bannedQuestions.join(" | ") || "(none)"}.
- Return STRICT JSON ONLY with shape:
{
  "questions": [
    { "question": string, "options": string[4], "answerIndex": 1|2|3|4, "explanation": string }
    x5
  ]
}
No extra text.`,
    },
    { role: "user", content: `Topic: ${topic}. JSON only.` },
  ],

  // Game 3: Guess the Character (hard)
  characterCandidates: (topic, excludeList = []) => [
    {
      role: "system",
      content:
        `Return STRICT JSON {"candidates": string[]} of 5 **hard-level** people or fictional characters related to the topic.
Avoid these (case-insensitive): ${excludeList.join(", ") || "(none)"}.
No other text.`,
    },
    { role: "user", content: `Topic: ${topic}. JSON only.` },
  ],

  // Multi-hints array (we'll show only one per round from 8–10)
  characterTurn: ({ name, qa, round, text }) => [
    {
      role: "system",
      content: `You are running a 20-questions style game. The secret answer is "${name}".
Respond to the user's message as a short yes/no style answer (<= 15 words), without revealing the name.
Detect if the user is explicitly guessing the exact name.

Return strict JSON with keys:
- answer: string
- isGuess: boolean
- guessedName: string
- hints: string[]   // empty or multiple hints; if round >= 8 provide 2–3 progressively stronger hints without revealing

No extra text.`,
    },
    {
      role: "user",
      content: `Previous Q&A:
${qa}
Current Round: ${round}
User message: ${text}`,
    },
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
  // --- Riddle Quest: generate 5 unique riddles as strict JSON ---
  riddlePack: ({ theme, banned }) => [
    {
      role: "system",
      content:
`You create fair, funny, original riddles (no copyrighted lines), non-repetitive.
Return STRICT JSON only:
{
  "riddles": [
    {
      "text": string,                 // <= 140 chars
      "answers": string[],            // 3-6 accepted answers, lowercase
      "hint": string,                 // <= 10 words
      "explanation": string           // <= 20 words
    } x5
  ]
}
Rules:
- EXACTLY 5 riddles.
- All different from each other and from banned list (case-insensitive).
- Keep answers short, common, and lowercase (e.g., "keyboard", "river").`
    },
    {
      role: "user",
      content:
`Theme (optional): ${theme || "general"}
Avoid riddles containing any of these texts (case-insensitive):
${(banned || []).join("\n") || "(none)"}

JSON only.`
    }
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

    // Fallback if the model returned too few fresh questions
    while (questions.length < 5) {
      const i = questions.length + 1;
      questions.push({
        question: `Challenging placeholder Q${i} about ${topic}?`,
        options: ["Option A", "Option B", "Option C", "Option D"],
        answerIndex: 1,
        explanation:
          "This is a placeholder. Regenerate with a clearer topic for a better quiz.",
      });
    }

    // Trim to exactly 5
    questions = questions.slice(0, 5);

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
   Game 3: Conversational Character (hard + single hint on 8/9/10)
======================== */
app.post("/api/character/start", async (req, res) => {
  try {
    const { topic = "General" } = req.body ?? {};
    const exclude = recentByTopic.get(topic) || [];
    const chooseMessages = PROMPTS.characterCandidates(topic, exclude);

    let candidates = ["Ada Lovelace", "Miyamoto Musashi", "Hedy Lamarr", "Sisyphus", "Alan Turing"];
    try {
      const raw = await chatCompletion(chooseMessages, 0.7, 200);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.candidates) && parsed.candidates.length) candidates = parsed.candidates;
    } catch {
      // fallback list above
    }

    const lowerRecent = exclude.map((x) => x.toLowerCase());
    const name = candidates.find((c) => !lowerRecent.includes(String(c).toLowerCase())) || candidates[0];

    // Update recent (store last 5 per topic)
    recentByTopic.set(topic, [name, ...exclude].slice(0, 5));

    const id = makeId();
    sessions.set(id, { type: "character", topic, name, rounds: 0, history: [], createdAt: Date.now() });
    res.json({
      ok: true,
      sessionId: id,
      message: "Ask questions about the secret Person/Character. You have 10 rounds. Natural guesses are accepted.",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/character/turn", async (req, res) => {
  try {
    const { sessionId, text } = req.body ?? {};
    const s = sessions.get(sessionId);
    if (!s) return res.status(400).json({ ok: false, error: "Session not found." });

    const qa = s.history.map((h, i) => `Q${i + 1}: ${h.q}\nA${i + 1}: ${h.a}`).join("\n");
    const messages = PROMPTS.characterTurn({ name: s.name, qa, round: s.rounds + 1, text });

    let parsed = { answer: "Okay.", isGuess: false, guessedName: "", hints: [] };
    try {
      const raw = await chatCompletion(messages, 0.4, 260);
      parsed = JSON.parse(raw);
    } catch {
      // keep defaults
    }

    s.rounds += 1;
    s.history.push({ q: text || "", a: parsed.answer || "" });

    // Did the user guess correctly?
    if (parsed.isGuess && parsed.guessedName) {
      const correct = parsed.guessedName.trim().toLowerCase() === s.name.trim().toLowerCase();
      if (correct) {
        sessions.delete(sessionId);
        return res.json({
          ok: true,
          done: true,
          win: true,
          name: s.name,
          answer: parsed.answer,
          hints: [], // stop hints on win
          message: `🎉 Brilliant! You figured it out — ${s.name}!`,
        });
      }
    }

    // Out of rounds?
    if (s.rounds >= 10) {
      const reveal = `Sorry Out of rounds! The character was: ${s.name}.`;
      sessions.delete(sessionId);
      return res.json({
        ok: true,
        done: true,
        win: false,
        name: s.name,
        answer: parsed.answer,
        hints: [],
        message: reveal,
      });
    }

    // Provide at most ONE hint per round (only for rounds 8, 9, 10)
    const roundNow = s.rounds;
    let hintsOut = [];
    if (roundNow >= 8) {
      const arr = Array.isArray(parsed.hints) ? parsed.hints : [];
      if (arr.length) hintsOut = [arr[0]];
    }

    res.json({
      ok: true,
      done: false,
      answer: parsed.answer,
      hints: hintsOut,
      roundsLeft: 10 - s.rounds,
    });
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

    const win = Math.abs(playerGuess - ai) <= 0.75 * ai; // within 60%

    const payload = {
      ok: true,
      win,
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

// ===== REPLACE your existing /api/riddle/answer endpoint with this =====
app.post("/api/riddle/answer", (req, res) => {
  try {
    const { token, guess } = req.body ?? {};
    const s = sessions.get(token);
    if (!s || s.type !== "riddle")
      return res.status(400).json({ ok: false, error: "Session not found/expired." });

    const round = s.rounds[s.idx];
    if (!round) return res.status(400).json({ ok: false, error: "Round not found." });

    const correctAnswer = String(round.answers?.[0] || "").trim();
    let correct = false;

    if (guess !== "__SKIP__") {
      const norm = (x) => String(x || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "");
      const g = norm(guess);
      for (const a of (round.answers || [])) {
        if (norm(a) === g) { correct = true; break; }
      }
    }

    if (correct) s.score += 1;

    // Build a unified explanation that always reveals the answer.
    const explanationOut =
      `Answer: ${correctAnswer || "(n/a)"}${round.explanation ? `. ${round.explanation}` : ""}`;

    // advance to next round
    s.idx += 1;
    s.usedHintForRound = false; // reset hint for next round

    const done = s.idx >= s.rounds.length;
    if (done) {
      const win = s.score >= 4;
      sessions.delete(token);
      return res.json({
        ok: true,
        done: true,
        score: s.score,
        total: 5,
        win,
        correct,
        explanation: explanationOut
      });
    }

    const next = s.rounds[s.idx];
    return res.json({
      ok: true,
      done: false,
      correct,
      explanation: explanationOut,
      next: {
        token,
        idx: s.idx + 1,
        total: 5,
        score: s.score,
        hintUsed: false,
        riddle: next.text,
      }
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
