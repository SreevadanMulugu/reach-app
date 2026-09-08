import { SHARED_GEMINI_KEY, SHARED_GROQ_KEY } from '../google-config';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_OPENAI_BASE = 'http://localhost:3001/v1';

function getKey(cfg) {
  return (cfg?.geminiKey?.trim() && cfg.geminiKey !== 'YOUR_GEMINI_KEY_HERE')
    ? cfg.geminiKey.trim()
    : SHARED_GEMINI_KEY;
}

const TONE_POOL = [
  'casual peer energy — like emailing a founder you met once at a meetup. lowercase subject. start mid-thought, not with a greeting.',
  'direct and a little bold — get to the point in sentence one. no pleasantries. end with a yes/no question they can answer in 2 seconds.',
  'warm but brief — sounds like you genuinely looked them up and something specific caught your attention. one real observation, one real ask.',
  'slightly informal — like a WhatsApp message that got formatted into an email. short bursts. not corporate at all.',
  'confident without being pushy — you know your stuff, you think there could be a fit, you are asking simply. no selling, just connecting.',
];

const FONT_VARIANTS = [
  'font-family:Georgia,serif;font-size:15px;line-height:1.75;color:#1a1a1a',
  'font-family:Arial,sans-serif;font-size:14px;line-height:1.7;color:#222',
  'font-family:Helvetica,sans-serif;font-size:15px;line-height:1.65;color:#111',
];

function bodyToHtml(text) {
  const style = FONT_VARIANTS[Math.floor(Math.random() * FONT_VARIANTS.length)];
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = esc.replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>');
  return `<div style="${style};max-width:580px"><p>${fmt}</p></div>`;
}

async function callGemini(prompt, apiKey) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // AQ. keys use Authorization header; AIza keys use ?key= query param
      const isAuthKey = apiKey.startsWith('AQ.');
      const url = isAuthKey ? GEMINI_URL : `${GEMINI_URL}?key=${apiKey}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(isAuthKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.75, maxOutputTokens: 1000 },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 429 || r.status === 503) return null; // quota hit — caller tries Groq
      if (!r.ok) { if (attempt < 2) { await new Promise(res => setTimeout(res, 3000)); continue; } return null; }
      const d = await r.json();
      return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
    } catch { if (attempt < 2) await new Promise(res => setTimeout(res, 3000)); }
  }
  return null;
}

// OpenAI-compatible endpoint (freellmapi, OpenRouter, LM Studio, Ollama, etc.)
async function callOpenAICompat(prompt, baseUrl, apiKey) {
  if (!apiKey || !baseUrl) return null;
  try {
    const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.75, max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) { console.log('[openai-compat] status', r.status); return null; }
    const d = await r.json();
    return (d.choices?.[0]?.message?.content || '').trim() || null;
  } catch (e) { console.log('[openai-compat] err:', e.message); return null; }
}

// Groq fallback — Llama 3.3 70B (no thinking mode, strong instruction following)
async function callGroq(prompt, groqKey) {
  if (!groqKey || groqKey === 'YOUR_GROQ_KEY_HERE') return '';
  try {
    const r = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.75, max_tokens: 1200,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) return '';
    const d = await r.json();
    return (d.choices?.[0]?.message?.content || '').trim();
  } catch { return ''; }
}

export async function callAI(prompt, cfg) {
  // 1. User's own OpenAI-compatible key (freellmapi, OpenRouter, LM Studio, Ollama, etc.)
  const openAiKey = cfg?.openAiApiKey?.trim();
  if (openAiKey) {
    const base = (cfg?.openAiBaseUrl?.trim() || DEFAULT_OPENAI_BASE);
    const result = await callOpenAICompat(prompt, base, openAiKey);
    if (result) return result;
  }
  // 2. Try user's own Gemini key if provided
  const userGeminiKey = cfg?.geminiKey?.trim();
  if (userGeminiKey && userGeminiKey !== 'YOUR_GEMINI_KEY_HERE') {
    const result = await callGemini(prompt, userGeminiKey);
    if (result) return result;
  }
  // 3. Groq (shared key) — free fallback
  const groqKey = cfg?.groqKey?.trim() || SHARED_GROQ_KEY;
  const groqResult = await callGroq(prompt, groqKey);
  if (groqResult) return groqResult;
  // 4. Shared Gemini key last resort
  return callGemini(prompt, SHARED_GEMINI_KEY);
}

// Fetch company homepage for personalization context
async function fetchCompanyContext(domain) {
  try {
    const r = await fetch(`https://${domain}`, { signal: AbortSignal.timeout(7000) });
    if (!r.ok) return '';
    const h = await r.text();
    return h.replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, 500);
  } catch { return ''; }
}

// Fetch recent news headlines for the company — makes emails timely and specific
async function fetchCompanyNews(company) {
  const q = encodeURIComponent(company);
  // Try Google News RSS first
  try {
    const r = await fetch(
      `https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`,
      { signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const xml = await r.text();
      const titles = [...xml.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
        .map(m => m[1].trim())
        .filter(t => !t.toLowerCase().includes('google news') && t.length > 20)
        .slice(0, 2);
      if (titles.length) return titles.join(' | ');
    }
  } catch {}
  // Bing News RSS fallback
  try {
    const r = await fetch(
      `https://www.bing.com/news/search?q=${q}&format=rss`,
      { signal: AbortSignal.timeout(7000) }
    );
    if (r.ok) {
      const xml = await r.text();
      const titles = [...xml.matchAll(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/g)]
        .map(m => m[1].trim())
        .filter(t => t.length > 20)
        .slice(0, 2);
      if (titles.length) return titles.join(' | ');
    }
  } catch {}
  return '';
}

const BAD_BODY = ['[your name]','[name]','[company]','[company name]','[recipient]',
  "couldn't produce","as an ai","i'm sorry","i cannot","api error"];

function isGoodBody(text) {
  if (!text || text.trim().length < 300) return false;
  const lower = text.toLowerCase();
  return !BAD_BODY.some(p => lower.includes(p));
}

// Quality gate — AI reviews the email before it goes out
async function qualityCheck(subject, body, contact, cfg) {
  const company = contact.company || '';
  const prompt =
    `Score this cold job application email 1-10 on genuine human quality.\n\n` +
    `SUBJECT: ${subject}\nBODY:\n${body}\n\n` +
    `8-10: Real person wrote it — contains actual company names, real technologies, concrete numbers, natural rhythm, professional structure (Hi → background → skills → closing)\n` +
    `5-7: Okay but has vague claims, generic phrases, or missing specific real details from experience\n` +
    `1-4: AI-sounding — buzzwords, invented specifics, template filler, no concrete detail, wrong role focus\n\n` +
    `Auto-score 2 if: "passionate", "leverage", "synergy", "I hope this finds you", "I wanted to reach out", "I am writing to", or no real company/tech names mentioned\n\n` +
    `Reply with ONLY a number 1-10.`;
  try {
    const result = await callAI(prompt, cfg);
    const score = parseInt((result || '').trim());
    return isNaN(score) ? 6 : score;
  } catch { return 6; }
}

export async function generateEmail(contact, cfg) {
  const domain  = contact.domain || contact.email.split('@')[1] || '';
  const company = contact.company || domain.split('.')[0] || 'the company';
  const name    = contact.name || 'Hiring Manager';
  const context = await fetchCompanyContext(domain);

  const firstName = name.split(' ')[0] || '';
  const greeting  = firstName ? `Hi ${firstName},` : 'Hi,';

  const personContext = contact.personContext || '';
  const targetTitle  = contact.targetTitle  || '';
  const role = cfg.targetRole || 'software engineer';

  const prompt =
    `Write a cold job application email from ${cfg.senderName} to ${firstName || 'the hiring manager'}${targetTitle ? ` (${targetTitle})` : ''} at ${company}.\n\n` +
    `ROLE APPLYING FOR: ${role}\n\n` +
    `SENDER'S RESUME — use ONLY details relevant to "${role}". Ignore anything unrelated to this role:\n${(cfg.resumeText || '').slice(0, 700)}\n\n` +
    (cfg.additionalNotes?.trim() ? `ADDITIONAL CONTEXT (weave in if relevant):\n${cfg.additionalNotes.trim().slice(0, 300)}\n\n` : '') +
    (context ? `ABOUT ${company} (brief background on what they do — used to understand the company, not to invent specific claims):\n${context.slice(0, 250)}\n\n` : '') +
    `WRITE THIS EMAIL following this EXACT structure and length (model after the famous Soham Parekh cold email style):\n\n` +
    `${greeting}\n\n` +
    `[Para 1 — 1-2 sentences: "Really loved what [company] is doing and wanted to reach out to see if there are any openings for [role]." Direct, honest, no invented product claims.]\n\n` +
    `[Para 2 — 2-3 sentences: "I have X years of relevant experience [type of work] at [Company1], [Company2], [Company3] as a part of their early/core teams where I helped [specific achievement with real number or outcome]." Use REAL company names from resume. Full detail — do not abbreviate.]\n\n` +
    `[Para 3 — 3-5 sentences: Deep technical paragraph. "One of my strongest strengths has been [skill area]. I have built [specific systems/projects] at the intersection of [Tech1], [Tech2], [Tech3], [Tech4] — name every relevant technology from the resume. Include one or two specific project names or outcomes.]\n\n` +
    `[Para 4 — 1-2 sentences: "I would love to be a part of the team at [company] and [aspiration]. Looking forward to hearing from you soon!"]\n\n` +
    `Best,\n${cfg.senderName}\n\n` +
    `RULES:\n` +
    `- Subject line: "${role} at ${company}" — simple, direct, no hype\n` +
    `- ONLY use real facts from the resume — real company names, real tech stack, real numbers. Never invent.\n` +
    `- Para 3 should name ALL relevant technologies from the resume for this role (e.g. "React, Next.js, Python, Node, Go, GraphQL, AWS, K8s") — be thorough\n` +
    `- Do NOT reference news, tweets, or specific product features\n` +
    `- Do NOT limit the email to the domain the person is in (e.g. if resume has tech support, pick only the tech skills relevant to ${role})\n` +
    `- BANNED words: passionate, excited, leverage, synergy, innovative, keen, eager, thrilled, seasoned, proven, results-driven\n` +
    `- BANNED phrases: "I hope this finds you", "I am writing to", "I wanted to reach out", "circle back", "touch base"\n` +
    `- Full length: each paragraph should be complete and substantive — no truncation, no cutting short\n` +
    `- ZERO placeholder text like [name] or [company] in the output\n\n` +
    `Reply EXACTLY:\n` +
    `SUBJECT: [subject]\n` +
    `BODY:\n[body]`;

  let best = null, bestScore = 0;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = await callAI(prompt, cfg);
    console.log(`[gen] attempt ${attempt} raw (${out?.length ?? 'null'} chars):`, out?.slice(0, 80));
    if (!out) continue;
    const subject = (out.match(/\*{0,2}SUBJECT:\*{0,2}\s*(.+)/i)?.[1] || 'quick intro').trim().replace(/\*+/g, '');
    // Body: prefer explicit BODY: label; fallback = everything after the subject line
    let body = out.match(/\*{0,2}BODY:\*{0,2}\s*([\s\S]+)/i)?.[1]?.trim() || '';
    if (!body) {
      const afterSubject = out.replace(/\*{0,2}SUBJECT:\*{0,2}[^\n]+/i, '').trim();
      if (afterSubject.length > 50) body = afterSubject;
    }
    if (!body) body = out;
    console.log(`[gen] body len=${body.length} goodBody=${isGoodBody(body)}`);
    if (!isGoodBody(body)) continue;

    // Quality gate — must score 5+ to send on first pass, 4+ on retries
    const score = await qualityCheck(subject, body, contact, cfg);
    console.log(`Email quality score: ${score}/10 (attempt ${attempt})`);
    const threshold = attempt === 1 ? 5 : 4;
    if (score >= threshold) {
      return { subject, bodyText: body, bodyHtml: bodyToHtml(body), qualityScore: score };
    }
    if (score > bestScore) { bestScore = score; best = { subject, bodyText: body, bodyHtml: bodyToHtml(body), qualityScore: score }; }
  }

  // Send best attempt if it scored at least 3
  if (bestScore >= 3) return best;
  console.log(`[gen] all attempts failed — bestScore=${bestScore} for ${contact.company}`);
  return null;
}

export async function generateFollowup(sentRow, cfg, followupNum) {
  const firstName = (sentRow.name || '').split(' ')[0] || '';
  const greeting = firstName ? `Hi ${firstName},` : 'Hi,';
  const prompt = followupNum === 1
    ? `Write a 2-sentence follow-up to a cold job application email.\n` +
      `Original subject: "${sentRow.subject}"\nCompany: ${sentRow.company || sentRow.domain}\n` +
      `Sender: ${cfg.senderName}, applying for ${cfg.targetRole || 'a role'}.\n\n` +
      `Rules: start with "${greeting}", casually ask if they had a chance to look, mention you're happy to share more, end with "?" question. No buzzwords. Under 40 words total.\n` +
      `Output only the email body.`
    : `Write a 1-sentence final follow-up to a cold job application email.\n` +
      `Original subject: "${sentRow.subject}"\nCompany: ${sentRow.company || sentRow.domain}\n` +
      `Sender: ${cfg.senderName}.\n\n` +
      `Rules: start with "${greeting}", say this is your last note and you respect their time, leave door open. Under 25 words total.\n` +
      `Output only the email body.`;
  return callAI(prompt, cfg);
}

export async function suggestReply(fromName, company, preview, cfg) {
  const firstName = fromName.split(' ')[0] || fromName;
  const prompt =
    `You are ${cfg.senderName}. You cold-emailed ${firstName} at ${company} about a ${cfg.targetRole || 'role'}.\n` +
    `They replied: "${preview}"\n\n` +
    `Write a reply. 2–3 sentences. Casual, warm, peer-to-peer energy — not corporate.\n` +
    `If they are open: suggest a specific short call, keep it easy to say yes to.\n` +
    `If not hiring now: thank genuinely (1 line), ask softly if they know anyone at other companies who might be a fit.\n` +
    `Rules: no "I hope this finds you well", no buzzwords, sign as "${cfg.senderName}" only.\n` +
    `Output only the email body — no subject line, no labels.`;
  return callAI(prompt, cfg);
}
