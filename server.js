
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

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.use("/api/", rateLimit({ windowMs: 60 * 1000, max: 30 }));

// In-memory store (simple demo)
const sessions = new Map();
const recentByTopic = new Map();
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
        "You are a funny fortune teller. Create playful, positive predictions in 2-3 sentences. Use the inputs naturally. Keep it light; no health, death, or lottery claims.",
    },
    {
      role: "user",
      content: `Make a humorous future prediction for:
Name: ${name}
Birth month: ${birthMonth}
Favorite place: ${favoritePlace}`,
    },
  ],

  // Game 2: 5-Round Quiz
  quiz: (topic) => [
    {
      role: "system",
      content:
        "Create a 5 Hard level question multiple-choice quiz for the given topic. For EACH question, provide exactly 4 options and indicate the correct option index. Return STRICT JSON with shape: { questions: [ { question: string, options: string[4], answerIndex: 1|2|3|4, explanation: string } x5 ] }. Keep questions clear, fair, and varied difficulty. Do NOT include any extra text.",
    },
    { role: "user", content: `Topic: ${topic}. Return JSON only.` },
  ],

  // Game 3: Guess the Character
  characterCandidates: (topic) => [
    {
      role: "system",
      content:
        "Return STRICT JSON {candidates: string[]} of 5 well-known medium level difficulty to find out people or fictional characters related to the topic. No other text.",
    },
    { role: "user", content: `Topic: ${topic}. JSON only.` },
  ],

  characterTurn: ({ name, qa, round, text }) => [
    {
      role: "system",
      content: `You are running a 20-questions style game. The secret answer is "${name}".
Respond to the user's message as a short yes/no style answer (<= 15 words), without revealing the name.
Also determine if the user is explicitly making a guess of the character's name.
Return strict JSON with keys:
- answer: string
- isGuess: boolean
- guessedName: string
- hint: string (empty if no hint this turn)
If current round is >= 8, include a helpful different hints that makes the game easier but does not reveal the name.
Do NOT include extra text.`,
    },
    {
      role: "user",
      content: `Previous Q&A:\n${qa}\nCurrent Round: ${round}\nUser message: ${text}`,
    },
  ],

  // Game 4: Healthy Diet — generate the 8 questions
  healthyQuestions: () => [
    {
      role: "system",
      content:
        "Generate exactly 8 short, clear questions needed to draft a safe, practical diet plan. Return STRICT JSON: { \"questions\": string[8] }. No extra text.",
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
       glamSuggest: ({ gender, budgetInr }) => [
    {
      role: "system",
      content: `Suggest 30 skincare/beauty products appropriate for the specified gender (or unisex).
Rules:
- Currency: INR
- Each item price should be reasonable for Indian market; can vary widely but keep realistic.
- Cover diverse uses: cleanser, moisturizer, SPF/sunscreen, serum, exfoliant, toner/essence, face mask, lip care, hand/body care, hair care, spot treatment, eye cream, primer, etc.
- Include both everyday basics and a few extras; avoid duplicate names.
- Keep descriptions <= 15 words.
- Mark ecoFriendly=true for recyclable/mineral-filter/clean-formulation/refill options.

Return STRICT JSON:
{
  "items": [
    { "name": string, "price": number, "description": string, "category": string, "ecoFriendly": boolean }
    x30
  ]
}`
    },
    {
      role: "user",
      content: `Gender: ${gender || "Unisex"}
BudgetINR: ${budgetInr}
JSON only.`
    }
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
}`
    },
    {
      role: "user",
      content: `BudgetINR: ${budgetInr}
TimeTakenSeconds: ${timeTaken}

Selected Items (${selected.length}):
${selected.map((it,i)=>`#${i+1} ${it.name} — ₹${it.price} — ${it.category} — eco:${it.ecoFriendly}`).join("\n")}

TotalSpend: ₹${selected.reduce((s,x)=>s+Number(x.price||0),0)}
JSON only.`
    }
  ]
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
   Game 2: 5-Round Quiz
======================== */
app.post("/api/quiz/start", async (req, res) => {
  try {
    const { topic } = req.body ?? {};
    const messages = PROMPTS.quiz(topic);
    let parsed = { questions: [] };
    try {
      const raw = await chatCompletion(messages, 0.5, 900);
      parsed = JSON.parse(raw);
    } catch {}
    const questions = Array.isArray(parsed.questions) ? parsed.questions.slice(0, 5) : [];
    while (questions.length < 5) {
      questions.push({
        question: `Placeholder Q${questions.length + 1} about ${topic}?`,
        options: ["Option A", "Option B", "Option C", "Option D"],
        answerIndex: 1,
        explanation:
          "This is a placeholder. Regenerate with a clearer topic for a better quiz.",
      });
    }
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

/* Game 3: Conversational Character */
app.post("/api/character/start", async (req, res) => {
  try {
    const { topic } = req.body ?? {};
    const chooseMessages = PROMPTS.characterCandidates(topic);
    let candidates = ["Albert Einstein", "Iron Man", "Taylor Swift", "Narendra Modi", "Sherlock Holmes"];
    try {
      const raw = await chatCompletion(chooseMessages, 0.7, 120);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.candidates) && parsed.candidates.length) candidates = parsed.candidates;
    } catch {}
    const rec = recentByTopic.get(topic) || [];
    let name =
      candidates.find((c) => !rec.map((x) => x.toLowerCase()).includes(c.toLowerCase())) ||
      candidates[0];
    recentByTopic.set(topic, [name, ...rec].slice(0, 5));
    const id = makeId();
    sessions.set(id, { type: "character", topic, name, rounds: 0, history: [], createdAt: Date.now() });
    res.json({
      ok: true,
      sessionId: id,
      message: "Ask yes/no questions about the secret character. You have 10 rounds. Natural guesses are accepted.",
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

    let parsed = { answer: "Okay.", isGuess: false, guessedName: "", hint: "" };
    try {
      const raw = await chatCompletion(messages, 0.4, 160);
      parsed = JSON.parse(raw);
    } catch {}

    s.rounds += 1;
    s.history.push({ q: text || "", a: parsed.answer || "" });

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
          hint: parsed.hint || "",
        });
      }
    }

    if (s.rounds >= 10) {
      const reveal = `Out of rounds! The character was: ${s.name}.`;
      sessions.delete(sessionId);
      return res.json({
        ok: true,
        done: true,
        win: false,
        name: s.name,
        answer: parsed.answer,
        hint: parsed.hint || "",
        message: reveal,
      });
    }

    const showHint = s.rounds >= 8 && (parsed.hint || "").trim().length;
    res.json({
      ok: true,
      done: false,
      answer: parsed.answer,
      hint: showHint ? parsed.hint : "",
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
    let questions = [
      "What is your age range (e.g., 18–24, 25–34, 35–44, 45+)?",
      "What is your sex assigned at birth?",
      "What is your typical activity level (sedentary, light, moderate, high)?",
      "Do you follow a dietary pattern (veg/vegan/omnivore/other)?",
      "Any allergies or intolerances (e.g., dairy, nuts, gluten)?",
      "Your primary goal (lose/maintain/gain/energy/other)?",
      "What’s your typical daily schedule & preferred meal frequency?",
      "Any cuisine preferences or foods you enjoy/avoid?",
    ];
    try {
      const raw = await chatCompletion(PROMPTS.healthyQuestions(), 0.4, 220);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.questions) && parsed.questions.length === 8) {
        questions = parsed.questions;
      }
    } catch {}
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
    if (!Array.isArray(answers) || answers.length !== 8) {
      return res.status(400).json({ ok: false, error: "Please provide all 8 answers." });
    }
    const messages = PROMPTS.healthyPlan({ questions: s.questions, answers });
    const content = await chatCompletion(messages, 0.6, 1200);
    sessions.delete(token);
    res.json({ ok: true, plan: content });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================
   Game 5: Future Price Prediction
======================== */
app.post("/api/fpp/start", async (req, res) => {
  try {
    const { category } = req.body ?? {};
    // 1) Get product + current price
    let suggestion = {
      product: "Wireless Earbuds",
      price: 3999,
      currency: "INR",
      reason: "Popular mid-range pick",
    };
    try {
      const raw = await chatCompletion(PROMPTS.priceProduct(category), 0.6, 220);
      const parsed = JSON.parse(raw);
      if (parsed?.product && parsed?.price && parsed?.currency) suggestion = parsed;
    } catch {}

    // 2) Get 10 yes/no questions
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
      const rawQ = await chatCompletion(PROMPTS.priceQuestions(suggestion.product), 0.4, 280);
      const parsedQ = JSON.parse(rawQ);
      if (Array.isArray(parsedQ?.questions) && parsedQ.questions.length === 10)
        questions = parsedQ.questions;
    } catch {}

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

    s.answers = answers.map((a) => !!a);
    const qa = s.questions.map((q, i) => ({ q, a: s.answers[i] }));

    // Ask AI to forecast price (but do NOT return it here)
    let predicted = {
      predictedPrice: Math.max(1, s.currentPrice * 1.2),
      explanation: "Baseline estimate with modest growth.",
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
        500
      );
      const parsed = JSON.parse(raw);
      if (typeof parsed?.predictedPrice === "number" && isFinite(parsed.predictedPrice)) {
        predicted.predictedPrice = parsed.predictedPrice;
      }
      if (typeof parsed?.explanation === "string") {
        predicted.explanation = parsed.explanation;
      }
    } catch {}

    s.predictedPrice = Number(predicted.predictedPrice);
    s.explanation = predicted.explanation || "";

    // Hide the AI price until the guess step
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ========================
   Game 6: Budget Glam Builder
   - Start: min budget ₹10,000, 30 items
   - Score: min selection 12, timer 180s
======================== */
app.post("/api/glam/start", async (req, res) => {
  try {
    const { gender = "Unisex", budgetInr } = req.body ?? {};
    const budget = Math.max(10000, Number(budgetInr) || 15000); // new minimum ₹10,000

    // Fallback list if model JSON fails (30 items)
    let items = Array.from({ length: 30 }).map((_, i) => ({
      name: `Starter Item ${i + 1}`,
      price: Math.floor(250 + Math.random() * 1500),
      description: "A practical everyday pick.",
      category: ["Cleanser","Moisturizer","Sunscreen","Serum","Lip Care","Body","Hair","Mask","Toner","Eye Cream","Primer","Exfoliant"][i % 12],
      ecoFriendly: i % 3 === 0
    }));

    try {
      const raw = await chatCompletion(PROMPTS.glamSuggest({ gender, budgetInr: budget }), 0.5, 1600);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.items) && parsed.items.length >= 20) {
        items = parsed.items
          .slice(0, 30)
          .map(it => ({
            name: String(it.name || "").slice(0, 80),
            price: Math.max(50, Number(it.price) || 0),
            description: String(it.description || "").slice(0, 120),
            category: String(it.category || "Other").slice(0, 40),
            ecoFriendly: !!it.ecoFriendly
          }));
        // Pad to exactly 30 if LLM returned < 30
        while (items.length < 30) {
          items.push({
            name: `Extra Item ${items.length + 1}`,
            price: Math.floor(300 + Math.random() * 1200),
            description: "Useful addition.",
            category: "Other",
            ecoFriendly: Math.random() < 0.3
          });
        }
      }
    } catch {}

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

    // New minimum picks: 12
    if (selected.length < 12) {
      sessions.delete(token);
      return res.json({
        ok: true,
        done: true,
        win: false,
        autoFinished: secs >= 180,
        score: 0,
        summary: "You must pick at least 12 products.",
        budgetInr: s.budgetInr,
        totalSpend: total,
        timeTaken: secs,
        positives: [],
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
      }), 0.4, 1200);
      const parsed = JSON.parse(raw);
      if (typeof parsed.score === "number") scored.score = Math.max(0, Math.min(100, parsed.score));
      if (Array.isArray(parsed.positives)) scored.positives = parsed.positives.slice(0, 6);
      if (Array.isArray(parsed.negatives)) scored.negatives = parsed.negatives.slice(0, 6);
      if (typeof parsed.summary === "string") scored.summary = parsed.summary;
    } catch {}

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
        : `❌ Try again. Score ${scored.score}/100`
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
