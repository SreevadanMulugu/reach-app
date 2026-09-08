const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// ── crt.sh: certificate transparency logs — company emails in SSL certs ──
async function crtshEmails(domain) {
  try {
    const r = await fetch(
      `https://crt.sh/?q=%25%40${encodeURIComponent(domain)}&output=json`,
      { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return [];
    const rows = await r.json();
    const emails = new Set();
    for (const row of (rows || []).slice(0, 30)) {
      const name = (row.name_value || '') + ' ' + (row.common_name || '');
      const found = name.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
      found.forEach(e => emails.add(e.toLowerCase()));
    }
    return [...emails].filter(e => isValidEmail(e) && !isBadEmail(e));
  } catch { return []; }
}

// ── PGP Keyserver: people register real personal emails with work domain ──
async function pgpKeyEmails(domain) {
  try {
    const r = await fetch(
      `https://keys.openpgp.org/vks/v1/search?q=${encodeURIComponent(domain)}`,
      { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return [];
    const d = await r.json();
    const results = [];
    for (const key of (d.keys || []).slice(0, 20)) {
      for (const uid of (key.userids || [])) {
        const m = uid.name ? uid.email : null;
        const email = uid.email?.toLowerCase()?.trim();
        const name  = uid.name?.trim() || '';
        if (email && isValidEmail(email) && !isBadEmail(email) && isPersonEmail(email)) {
          results.push({ email, name });
        }
      }
    }
    return results;
  } catch { return []; }
}

// ── Wayback Machine CDX: find real archived paths first, then fetch ──────────
async function waybackEmails(domain) {
  try {
    // CDX tells us which paths were actually crawled (no guessing)
    const cdx = await fetch(
      `https://web.archive.org/cdx/search/cdx?url=${domain}/*&output=json&limit=20&fl=timestamp,original&filter=statuscode:200&collapse=urlkey`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!cdx.ok) return [];
    const rows = await cdx.json();
    const emails = new Set();
    // Filter to contact/about/team paths
    const contactRows = (rows || []).slice(1).filter(([, orig]) =>
      /\/(contact|about|team|people|leadership|company)/i.test(orig)
    ).slice(0, 4);
    for (const [ts, orig] of contactRows) {
      try {
        const snap = await fetch(
          `https://web.archive.org/web/${ts}/${orig}`,
          { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
        );
        if (!snap.ok) continue;
        const html = await snap.text();
        const found = html.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g) || [];
        found.forEach(e => { if (e.toLowerCase().includes(domain.split('.')[0])) emails.add(e.toLowerCase()); });
      } catch {}
    }
    // archive.today as second archived source
    if (emails.size === 0) {
      for (const path of ['contact', 'about', 'team']) {
        try {
          const ar = await fetch(`https://archive.ph/newest/https://${domain}/${path}`,
            { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
          if (!ar.ok) continue;
          const arHtml = await ar.text();
          const found = arHtml.match(/\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g) || [];
          found.forEach(e => { if (e.toLowerCase().includes(domain.split('.')[0])) emails.add(e.toLowerCase()); });
          if (emails.size > 0) break;
        } catch {}
      }
    }
    return [...emails].filter(e => isValidEmail(e) && !isBadEmail(e));
  } catch { return []; }
}

// ── Crunchbase: freely readable org pages list founders/executives ──────────
async function crunchbaseFounderName(company) {
  const base = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const slugs = [base, base.replace(/-/g, ''), `the-${base}`, base.replace(/^the-/, '')];
  for (const slug of [...new Set(slugs)]) {
    try {
      const r = await fetch(
        `https://www.crunchbase.com/organization/${slug}/people`,
        { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000) }
      );
      if (!r.ok) continue;
      const h = await r.text();
      const nameMatch = h.match(/"full_name"\s*:\s*"([^"]{5,50})"/);
      if (nameMatch) return nameMatch[1].trim();
      const metaMatch = h.match(/<title>([^|<]+)\s*\|/);
      if (metaMatch) {
        const title = metaMatch[1].trim();
        if (title.split(' ').length >= 2 && title.length < 50) return title;
      }
    } catch {}
  }
  return null;
}

// ── URLScan.io: emails found in live page scans ──────────────────────────
async function urlscanEmails(domain) {
  try {
    const r = await fetch(
      `https://urlscan.io/api/v1/search/?q=page.domain:${encodeURIComponent(domain)}&size=5`,
      { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return [];
    const d = await r.json();
    const emails = new Set();
    for (const result of (d.results || [])) {
      const txt = JSON.stringify(result);
      const found = txt.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g) || [];
      found.forEach(e => { if (!e.includes('urlscan') && !e.includes('example')) emails.add(e.toLowerCase()); });
    }
    return [...emails].filter(e => isValidEmail(e) && !isBadEmail(e));
  } catch { return []; }
}

// ── YC company list: all YC companies, free JSON, many India startups ────────
let YC_CACHE = null;
async function ycIndiaContacts(inds, titles) {
  try {
    if (!YC_CACHE) {
      const r = await fetch('https://yc-oss.github.io/api/batch/all.json', { signal: AbortSignal.timeout(12000) });
      if (!r.ok) return [];
      YC_CACHE = await r.json();
    }
    const indLower = inds.map(i => i.toLowerCase());
    return (YC_CACHE || []).filter(co => {
      if (!co.website) return false;
      const loc = (co.country || co.city || '').toLowerCase();
      const tags = ((co.tags || []).join(' ') + ' ' + (co.one_liner || '')).toLowerCase();
      const isIndia = loc.includes('india') || loc.includes('bangalore') || loc.includes('mumbai') ||
                      loc.includes('delhi') || loc.includes('hyderabad') || loc.includes('chennai') ||
                      loc.includes('pune') || loc.includes('kolkata');
      const matchesInd = indLower.length === 0 || indLower.some(i => tags.includes(i));
      return isIndia && matchesInd;
    }).map(co => ({
      company: co.name,
      domain: co.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0],
      founderNames: (co.founders || []).map(f => f.name).filter(Boolean),
    })).filter(co => co.domain);
  } catch { return []; }
}

// ── ProductHunt RSS: recent launches with maker names ─────────────────────
async function productHuntContacts(ind) {
  try {
    const r = await fetch('https://www.producthunt.com/feed', {
      headers: { 'User-Agent': UA, Accept: 'application/rss+xml,text/xml' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return [];
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    return items
      .filter(item => !ind || item.toLowerCase().includes(ind.toLowerCase()))
      .map(item => {
        const title = item.match(/<title><!\[CDATA\[([^\]]+)\]\]><\/title>/)?.[1] || '';
        const link  = item.match(/<link>(https?:\/\/[^<]+)<\/link>/)?.[1] || '';
        const maker = item.match(/by ([A-Z][a-z]+ [A-Z][a-z]+)/)?.[1] || '';
        return { title, link, maker };
      }).filter(i => i.link && i.maker);
  } catch { return []; }
}

// ── GitHub commits: extract real author emails from public commits ────────
async function githubCommitEmails(username) {
  try {
    const reposR = await fetch(
      `https://api.github.com/users/${username}/repos?per_page=5&sort=pushed`,
      { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
    );
    if (!reposR.ok) return [];
    const repos = await reposR.json();
    for (const repo of repos.slice(0, 3)) {
      const commitsR = await fetch(
        `https://api.github.com/repos/${username}/${repo.name}/commits?per_page=3`,
        { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
      );
      if (!commitsR.ok) continue;
      const commits = await commitsR.json();
      for (const c of commits) {
        const email = c.commit?.author?.email || c.commit?.committer?.email;
        if (email && isValidEmail(email) && !isBadEmail(email) &&
            !email.includes('noreply') && !email.includes('github')) {
          return [email];
        }
      }
    }
    return [];
  } catch { return []; }
}

// ── GitHub people search (free, no key needed for public data) ────────────
// Founders/CTOs at Indian tech startups often have GitHub profiles with public emails.

async function githubSearchUsers(query) {
  try {
    const r = await fetch(
      `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=10`,
      { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': UA }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return [];
    const d = await r.json();
    return (d.items || []).map(u => u.login);
  } catch { return []; }
}

async function githubGetUserEmail(login) {
  try {
    const r = await fetch(
      `https://api.github.com/users/${login}`,
      { headers: { Accept: 'application/vnd.github.v3+json', 'User-Agent': UA }, signal: AbortSignal.timeout(8000) }
    );
    if (!r.ok) return null;
    const u = await r.json();
    // Try profile email first; fallback to commit email (real personal email)
    let email = u.email?.trim();
    if (!email || !isValidEmail(email) || isBadEmail(email)) {
      const commitEmails = await githubCommitEmails(login);
      email = commitEmails[0] || null;
    }
    if (!email || !isValidEmail(email) || isBadEmail(email)) return null;
    return {
      email,
      name: u.name || login,
      title: u.bio?.slice(0, 80) || '',
      domain: email.split('@')[1] || '',
      company: (u.company || email.split('@')[1]?.split('.')[0] || login).replace(/^@/, ''),
    };
  } catch { return null; }
}

const TECH_KEYWORDS = ['engineer','developer','software','tech','cto','sde','devops','data','ml','ai','saas','product'];

function isTechField(cfg) {
  const text = [(cfg.targetIndustries||[]).join(' '), cfg.targetRole||'', cfg.resumeText||''].join(' ').toLowerCase();
  return TECH_KEYWORDS.some(k => text.includes(k));
}

async function githubFindContacts(cfg, onProgress, targetTitles) {
  if (!isTechField(cfg)) return []; // skip GitHub for non-tech fields
  const city    = (cfg.targetCities || [])[0] || '';
  const inds    = (cfg.targetIndustries || ['software']).slice(0, 2);
  const title0  = (targetTitles?.[0] || 'developer').replace(/"/g, '');
  const queries = [];

  for (const ind of inds) {
    if (city) queries.push(`location:${city} ${ind} ${title0} type:user`);
    queries.push(`${ind} ${title0} type:user`);
  }
  queries.push(`location:${city} ${title0} type:user`);

  const seenEmails = new Set(), contacts = [];

  for (const q of queries.slice(0, 4)) {
    const logins = await githubSearchUsers(q);
    for (const login of logins) {
      const c = await githubGetUserEmail(login);
      if (!c || seenEmails.has(c.email)) continue;
      if (!await hasMx(c.email)) continue;
      seenEmails.add(c.email);
      onProgress?.(`Found ${c.name} on GitHub (${c.company})`);
      const personContext = `GitHub user @${login}. ${c.title || ''}`.trim();
      contacts.push({ ...c, personContext, targetTitle: targetTitles?.[0] || title0 });
      if (contacts.length >= 5) break;
    }
    if (contacts.length >= 5) break;
    await new Promise(res => setTimeout(res, 800));
  }
  return contacts;
}

const PLATFORM_DOMAINS = new Set([
  // Job boards
  'naukri.com','indeed.com','glassdoor.com','linkedin.com','monster.com',
  'timesjobs.com','shine.com','apna.co','wellfound.com','instahyre.com',
  'freshersworld.com','hirist.com','iimjobs.com','foundit.in',
  // Contact intelligence / aggregators
  'rocketreach.co','zoominfo.com','apollo.io','hunter.io','clearbit.com',
  'contactout.com','lusha.com','snov.io','adapt.io','seamless.ai',
  'leadfeeder.com','crunchbase.com','owler.com','tracxn.com','pitchbook.com',
  'f6s.com','angellist.com','startupindia.gov.in','startupindia.in',
  // Bug bounty / security
  'hackerone.com','bugcrowd.com','intigriti.com',
  // Status / infra pages
  'statuspage.io','status.io',
  // Generic big platforms
  'google.com','facebook.com','twitter.com','x.com','wikipedia.org','youtube.com',
  'amazon.com','instagram.com','reddit.com','quora.com','medium.com',
  'substack.com','notion.so','airtable.com','hubspot.com','mailchimp.com',
  // Search engines
  'duckduckgo.com','bing.com','yahoo.com','baidu.com',
]);

// ── AI: decide who/where to search based on the user's resume ────────────

export async function resolveTargetTitles(cfg, callAI) {
  const prompt =
    `A job seeker wants to cold-email the person who would directly hire them.\n\n` +
    `The role they are applying for: "${cfg.targetRole || 'software engineer'}"\n\n` +
    `Who is the most likely hiring decision-maker for someone applying for this specific role?\n` +
    `Focus ONLY on the role name above. Ignore any background context.\n` +
    `Give 4 job titles of people who hire for this role, most direct first.\n` +
    `Reply ONLY with 4 titles comma-separated. No explanations.`;
  try {
    const result = await callAI(prompt);
    if (!result) return null;
    return result.split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean).slice(0, 4);
  } catch { return null; }
}

export async function resolveTargetContext(cfg, callAI) {
  if (cfg.targetIndustries?.length && cfg.targetCities?.length) {
    return { industries: cfg.targetIndustries, city: cfg.targetCities[0] };
  }
  const prompt =
    `A job seeker is applying for: "${cfg.targetRole || 'software engineer'}"\n\n` +
    `Which 2 industry sectors have the most companies that hire for this role?\n` +
    `Focus ONLY on the role name. Do NOT use their resume background to pick the industry.\n` +
    `Return ONLY valid JSON: {"industries":["industry1","industry2"]}\n` +
    `Example: role "software engineer" → ["SaaS","fintech"], role "sales executive" → ["B2B software","retail"]`;
  try {
    const raw = await callAI(prompt);
    const j = JSON.parse(raw?.match(/\{[\s\S]*\}/)?.[0] || '{}');
    return {
      industries: j.industries?.length ? j.industries : (cfg.targetIndustries || ['business']),
      city:       cfg.targetCities?.[0] || '',   // never infer city — user must set it or we search all
    };
  } catch {
    return {
      industries: cfg.targetIndustries || ['business'],
      city:       cfg.targetCities?.[0] || '',
    };
  }
}

// ── Search for a specific person (name + title) publicly ─────────────────

export async function findPersonContext(name, company, title) {
  if (!name) return '';
  const query = `"${name}" "${company}" ${title}`;
  try {
    const r = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000) }
    );
    if (!r.ok) return '';
    const h = await r.text();
    // Pull text from result snippets — no JS, no Cloudflare
    const snippets = [...h.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
      .map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(s => s.length > 20)
      .slice(0, 3)
      .join(' ');
    return snippets.slice(0, 400);
  } catch { return ''; }
}

// ── SearXNG: self-hosted meta search engine — aggregates DDG+Bing+Brave+Google ──
// Returns { urls, snippetEmails } same shape as DDG/Bing/Brave
// baseUrl: user's Tailscale/LAN/public instance e.g. http://100.x.x.x:8888
// Public fallback instances (community hosted, may have rate limits):
// Mac Mini custom proxy (auto-tried first; times out silently on mobile data)
const MAC_MINI_PROXY = 'http://192.168.10.117:8889';
const PUBLIC_SEARXNG = [
  'https://searx.be',
  'https://search.inetol.net',
  'https://searxng.world',
  'https://priv.au',
  'https://opnxng.com',
  'https://search.unlockopen.com',
];

async function searxngSearch(query) {
  // Mac Mini proxy only — public SearXNG instances removed (quality too inconsistent)
  try {
    const r = await fetch(
      `${MAC_MINI_PROXY}/search?q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (r.ok) {
      const d = await r.json();
      const urls = (d.results || []).map(x => x.url).filter(Boolean);
      const emails = (d.emails || []).filter(e => isValidEmail(e) && !isBadEmail(e));
      if (urls.length >= 3) return { urls, snippetEmails: emails };
    }
  } catch {}
  return { urls: [], snippetEmails: [] };
}

// ── Search engines ────────────────────────────────────────────────────────

// Extract emails directly from search result HTML (snippets sometimes contain them)
function extractEmailsFromHtml(html) {
  const rx = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
  return [...new Set(html.match(rx) || [])].filter(e => isValidEmail(e) && !isBadEmail(e));
}

async function ddgSearch(query) {
  try {
    const r = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(18000) }
    );
    if (!r.ok) { console.log('DDG', r.status); return { urls: [], snippetEmails: [] }; }
    const h = await r.text();
    const urls = [...h.matchAll(/uddg=([^"&\s]+)/g)]
      .map(m => { try { return decodeURIComponent(m[1]); } catch { return ''; } })
      .filter(u => u.startsWith('http'));
    return { urls, snippetEmails: extractEmailsFromHtml(h) };
  } catch (e) { console.log('DDG err:', e.message); return { urls: [], snippetEmails: [] }; }
}

async function braveSearch(query) {
  try {
    const r = await fetch(
      `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
      { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(18000) }
    );
    if (!r.ok) { console.log('Brave', r.status); return { urls: [], snippetEmails: [] }; }
    const h = await r.text();
    const urls = [...new Set([
      ...[...h.matchAll(/data-url="(https?:\/\/[^"]+)"/g)].map(m => m[1]),
      ...[...h.matchAll(/href="(https?:\/\/[^"]+)"/g)].map(m => m[1]),
    ])].filter(u => !u.includes('brave.com'));
    return { urls, snippetEmails: extractEmailsFromHtml(h) };
  } catch (e) { console.log('Brave err:', e.message); return { urls: [], snippetEmails: [] }; }
}


async function bingSearch(query) {
  try {
    const r = await fetch(
      `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=10&mkt=en-IN`,
      { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-IN,en;q=0.9' }, signal: AbortSignal.timeout(18000) }
    );
    if (!r.ok) { console.log('Bing', r.status); return { urls: [], snippetEmails: [] }; }
    const h = await r.text();
    const cites = [...h.matchAll(/<cite[^>]*>(https?:\/\/[^<]+)<\/cite>/g)].map(m => m[1].split('/').slice(0,3).join('/'));
    const qs = [...h.matchAll(/\/url\?q=(https?[^&"]+)/g)].map(m => { try { return decodeURIComponent(m[1]); } catch { return ''; } }).filter(Boolean);
    return { urls: [...new Set([...cites, ...qs])], snippetEmails: extractEmailsFromHtml(h) };
  } catch (e) { console.log('Bing err:', e.message); return { urls: [], snippetEmails: [] }; }
}

// Detect email pattern from a known email at a company
function detectPattern(email) {
  const local = email.split('@')[0].toLowerCase();
  // Match known patterns by structure
  if (/^[a-z]+$/.test(local)) return 'first';
  if (/^[a-z]+\.[a-z]+$/.test(local)) return 'first.last';
  if (/^[a-z]+[a-z]$/.test(local) && local.length <= 7) return 'firstl';
  if (/^[a-z][a-z]+$/.test(local)) return 'flast';
  return 'first';
}

// Search for any real email at this domain to infer the company's naming convention
async function discoverPattern(domain) {
  const { snippetEmails } = await searchAll(`"@${domain}"`);
  const hit = snippetEmails.find(e =>
    e.endsWith(`@${domain}`) && isPersonEmail(e) && !isBadEmail(e)
  );
  return hit ? detectPattern(hit) : null;
}

// Try to discover the actual pattern first via web search, then fall back to all 4
async function verifyBestEmail(name, domain) {
  // Step 1: find a real email at this domain to learn the naming convention
  const pattern = await discoverPattern(domain);
  if (pattern) {
    const guessed = applyPattern(name, pattern, domain);
    if (await hasMx(guessed)) return guessed;
  }
  // Step 2: try all 4 patterns — DISIFY picks whichever actually exists
  const candidates = guessEmails(name, domain);
  for (const email of candidates) {
    if (await hasMx(email)) return email;
  }
  return candidates[0] || null;
}

// Apply a detected pattern to produce a guessed email for a person
function applyPattern(name, pattern, domain) {
  const parts = name.trim().toLowerCase().split(/\s+/);
  if (parts.length < 2) return `${parts[0]}@${domain}`;
  const [first, last] = [parts[0], parts[parts.length - 1]];
  switch (pattern) {
    case 'first.last': return `${first}.${last}@${domain}`;
    case 'flast':      return `${first[0]}${last}@${domain}`;
    case 'firstl':     return `${first}${last[0]}@${domain}`;
    default:           return `${first}@${domain}`;
  }
}

// Common email patterns to try when we know a person's name and domain
function guessEmails(name, domain) {
  if (!name || !domain) return [];
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return [`${parts[0].toLowerCase()}@${domain}`];
  const [first, last] = [parts[0].toLowerCase(), parts[parts.length - 1].toLowerCase()];
  return [
    `${first}@${domain}`,
    `${first}.${last}@${domain}`,
    `${first[0]}${last}@${domain}`,
    `${first}${last[0]}@${domain}`,
  ];
}

async function searchAll(query) {
  // Mac Mini proxy + public SearXNG first
  const sx = await searxngSearch(query);
  if (sx.urls.length >= 3) return sx;

  // Fall back to direct engine scraping
  const ddgResult = await ddgSearch(query);
  let urls = [...new Set([...sx.urls, ...ddgResult.urls])];
  let snippetEmails = [...new Set([...sx.snippetEmails, ...ddgResult.snippetEmails])];
  if (urls.length < 3) {
    const b = await braveSearch(query);
    urls = [...new Set([...urls, ...b.urls])];
    snippetEmails = [...new Set([...snippetEmails, ...b.snippetEmails])];
  }
  if (urls.length < 3) {
    const bi = await bingSearch(query);
    urls = [...new Set([...urls, ...bi.urls])];
    snippetEmails = [...new Set([...snippetEmails, ...bi.snippetEmails])];
  }

  return { urls, snippetEmails };
}

// ── Email extraction from pages ───────────────────────────────────────────

const BAD_LOCALS = new Set([
  'noreply','donotreply','bounce','mailer','postmaster','admin','webmaster',
  'support','help','helpdesk','billing','abuse','spam','security','privacy',
  'legal','press','media','investor','jobs','careers','recruitment','hiring',
  'humanresources','talent','feedback','complaints','test','demo',
  // These are generic bulk aliases — not targeted enough for outreach
  'info','contact','hello','team','general','enquiry','enquiries','office','query',
]);

function isValidEmail(e) {
  return e && e.length >= 6 && e.length <= 80 &&
    /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(e);
}

function isBadEmail(email) {
  const local = email.split('@')[0].toLowerCase().replace(/[.\-_]/g, '');
  return BAD_LOCALS.has(local) || ['career','recruit','hiring','talent','fresher'].some(s => local.includes(s));
}

// Returns true if email looks like a real person's (not a generic company mailbox)
function isPersonEmail(email) {
  const local = email.split('@')[0].toLowerCase();
  // Generic mailboxes are filtered by BAD_LOCALS; here check it looks like a name
  // e.g. "john", "john.doe", "jdoe", "j.doe" — has at least 2 letters, no numbers only
  return /^[a-z]{2,}/.test(local) && !/^\d+$/.test(local);
}

function extractEmails(html, domainRoot) {
  const rx = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
  const obf = [...html.matchAll(/([A-Za-z0-9._%+\-]+)\s*[\[\(]?\s*(?:at|@)\s*[\]\)]?\s*([A-Za-z0-9.\-]+)\s*[\[\(]?\s*(?:dot|\.)\s*[\]\)]?\s*([A-Za-z]{2,})/gi)]
    .map(m => `${m[1]}@${m[2]}.${m[3]}`);
  return [...new Set([...(html.match(rx)||[]), ...obf])].filter(email => {
    if (!isValidEmail(email) || isBadEmail(email)) return false;
    if (email.includes('@example') || email.includes('.png')) return false;
    const dom = email.split('@')[1]?.toLowerCase() || '';
    const root = dom.split('.').slice(-2).join('.');
    return !domainRoot || root === domainRoot || ['gmail.com','yahoo.com','yahoo.co.in','outlook.com'].includes(dom);
  }).map(email => {
    const idx = html.indexOf(email);
    const ctx = html.slice(Math.max(0, idx-500), idx+100).replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');
    const name  = ctx.match(/([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})/)?.[1]?.trim() || '';
    const title = ctx.match(/\b(director|head of|chief|co.?founder|founder|lead|VP|manager|officer)\b[^,.\n]{0,40}/i)?.[0]?.trim() || '';
    return { email, name, title, domain: email.split('@')[1] };
  });
}

// DNS TXT reveals mail provider → better pattern guess
// Zoho → firstname@; Google Workspace → first.last@; Microsoft 365 → first.last@
const TXT_CACHE = new Map();
async function detectMailProvider(domain) {
  if (TXT_CACHE.has(domain)) return TXT_CACHE.get(domain);
  try {
    const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=TXT`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const txts = (d.Answer || []).map(a => (a.data || '').toLowerCase()).join(' ');
    let provider = 'unknown';
    if (txts.includes('zoho')) provider = 'zoho';
    else if (txts.includes('google') || txts.includes('_spf.google')) provider = 'google';
    else if (txts.includes('microsoft') || txts.includes('outlook') || txts.includes('protection.outlook')) provider = 'microsoft';
    TXT_CACHE.set(domain, provider);
    return provider;
  } catch { return 'unknown'; }
}

// Map mail provider to most common email pattern for that provider
function providerToPattern(provider) {
  if (provider === 'zoho') return 'first';           // Zoho defaults to firstname@
  if (provider === 'google') return 'first.last';    // Google Workspace defaults to first.last@
  if (provider === 'microsoft') return 'first.last'; // Microsoft 365 same
  return null; // unknown → use detected pattern from scraped emails
}

const MX_CACHE = new Map();
export async function hasMx(email) {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  if (MX_CACHE.has(domain)) return MX_CACHE.get(domain);
  // DISIFY: free no-key API — checks MX + deliverability + disposable in one call
  try {
    const r = await fetch(`https://disify.com/api/email/${encodeURIComponent(email)}`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) {
      const d = await r.json();
      const ok = !!(d.format && d.dns && !d.disposable);
      MX_CACHE.set(domain, ok);
      return ok;
    }
  } catch {}
  // Fallback to plain MX check
  try {
    const r = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=MX`, { signal: AbortSignal.timeout(6000) });
    const d = await r.json();
    const ok = (d.Answer?.length||0) > 0;
    MX_CACHE.set(domain, ok);
    return ok;
  } catch { MX_CACHE.set(domain, true); return true; }
}

// ── Main ──────────────────────────────────────────────────────────────────

const CONTACT_PATHS = ['/contact','/contact-us','/about','/about-us','/team','/people','/leadership','/company'];

export async function findContacts(cfg, onProgress, callAI, maxQueries = 12) {
  const ctx  = await resolveTargetContext(cfg, callAI);
  const city = ctx.city;
  const inds = ctx.industries.slice(0, 3);

  // Step 1: AI decides who to search for
  onProgress?.('Figuring out who to email…');
  const titles = (await resolveTargetTitles(cfg, callAI)) ||
    ['Founder', 'CEO', 'Director', 'Head of'];
  const titleQuery = titles.slice(0, 3).map(t => `"${t}"`).join(' OR ');
  console.log('Target titles:', titles);

  // Step 2a: GitHub (tech only) + YC India list + ProductHunt in parallel
  onProgress?.('Searching for contacts…');
  const [githubContacts, ycEntries, phItems] = await Promise.all([
    githubFindContacts(cfg, onProgress, titles),
    ycIndiaContacts(inds, titles),
    productHuntContacts(inds[0]),
  ]);
  console.log('[scraper] GitHub:', githubContacts.length, 'YC India:', ycEntries.length, 'PH:', phItems.length);

  // Build field-agnostic queries — large pool so each round picks different ones
  const t0 = titles[0] || 'manager';
  const t1 = titles[1] || titles[0] || 'director';
  const t2 = titles[2] || titles[0] || 'head';
  const allCities = cfg.targetCities?.length ? cfg.targetCities : city ? [city] : [];
  const queries = [];

  for (const ind of inds) {
    for (const c of allCities) {
      // Site-targeted queries — hit real company pages, not generic content
      queries.push(`site:crunchbase.com/organization "${ind}" "${c}"`);
      queries.push(`site:linkedin.com/in "${t0}" "${ind}" "${c}"`);
      queries.push(`site:linkedin.com/company "${ind}" "${c}"`);
      queries.push(`"${ind}" "${c}" "team" OR "about us" email`);
    }
    // Crunchbase org listings — best startup directory, public
    queries.push(`site:crunchbase.com/organization "${ind}"${city ? ` "${city}"` : ''}`);
    if (city) queries.push(`site:crunchbase.com/organization "${ind}" "${city}"`);
    // ProductHunt — startup pages with founder info
    queries.push(`site:producthunt.com "${ind}"${city ? ` "${city}"` : ''}`);
    // Press releases and bios — often have name + email
    const loc = city || ind;
    queries.push(`"${ind}" "${loc}" "${t0}" "press release" OR "bio" email`);
    queries.push(`"${ind}" "${loc}" "${t0}" filetype:pdf email`);
    // Personal blogs / interviews where founders mention contact
    queries.push(`"${ind}" "${t0}" "you can reach me" OR "email me at"`);
  }

  // City-specific Crunchbase + LinkedIn sweeps
  for (const c of allCities.slice(0, 3)) {
    queries.push(`site:crunchbase.com/organization "${c}"`);
    queries.push(`site:linkedin.com/in "${t0}" "${c}"`);
    queries.push(`site:linkedin.com/in "${t1}" "${c}" "${inds[0]}"`);
  }

  // Wide sweep — any company with public founder profile matching industry
  queries.push(`site:crunchbase.com/organization "${inds[0]}" founded`);
  queries.push(`site:producthunt.com ${city ? `"${city}"` : ''} "${inds[0]}" maker email`);
  queries.push(`"${inds[0]}" "${t0}" "contact" email site:quora.com OR site:reddit.com`);

  const seenEmails = new Set(githubContacts.map(c => c.email));
  const seenDomains = new Set(githubContacts.map(c => c.domain));
  const allContacts = [...githubContacts];
  // Each call shuffles and picks queries → different companies per round
  const shuffled = queries.sort(() => Math.random() - 0.5).slice(0, maxQueries);

  for (let qi = 0; qi < shuffled.length; qi++) {
    onProgress?.(`Searching… (${qi + 1}/${shuffled.length})`);

    const { urls: rawUrls, snippetEmails } = await searchAll(shuffled[qi]);

    // 2a. Use emails found directly in search snippets
    for (const email of snippetEmails) {
      if (seenEmails.has(email)) continue;
      const domain = email.split('@')[1];
      if (!domain || seenDomains.has(domain)) continue;
      if (PLATFORM_DOMAINS.has(domain.replace('www.',''))) continue;
      if (!await hasMx(email)) continue;
      seenEmails.add(email);
      seenDomains.add(domain);
      const company = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
      const personContext = await findPersonContext('', company, titles[0]);
      allContacts.push({ email, name: '', title: titles[0], domain, company, personContext, targetTitle: titles[0] });
      onProgress?.(`Found contact at ${company} (via snippet)`);
    }

    // 2b. Visit non-aggregator URLs and scrape contact pages
    const urls = rawUrls.filter(u => {
      try {
        const h = new URL(u).hostname.replace('www.','');
        return !PLATFORM_DOMAINS.has(h) &&
          !['google.','amazon.','facebook.','instagram.','twitter.','youtube.','bing.','duckduckgo.'].some(b => h.includes(b));
      } catch { return false; }
    }).slice(0, 12);

    for (const url of urls) {
      let domain = '';
      try { domain = new URL(url).hostname.replace('www.',''); } catch { continue; }
      if (seenDomains.has(domain)) continue;

      const company = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
      onProgress?.(`Looking up ${company}…`);

      const baseUrl = url.split('/').slice(0, 3).join('/');
      const domainRoot = domain.split('.').slice(-2).join('.');
      let contacts = [];

      for (const path of [url, ...CONTACT_PATHS.map(p => baseUrl + p)]) {
        try {
          const r = await fetch(path, { headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(10000) });
          if (!r.ok) continue;
          let html = await r.text();

          // Extract __NEXT_DATA__ JSON (Next.js SSR — contains team/about content not in static HTML)
          const nextData = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
          if (nextData) {
            try { html += ' ' + JSON.stringify(JSON.parse(nextData)); } catch {}
          }

          let found = extractEmails(html, domainRoot);

          // If static HTML found nothing (JS-rendered site), try Jina Reader (renders JS, returns text)
          if (!found.length) {
            try {
              const jinaR = await fetch(`https://r.jina.ai/${path}`, {
                headers: { Accept: 'text/plain', 'User-Agent': UA },
                signal: AbortSignal.timeout(12000),
              });
              if (jinaR.ok) {
                const jinaText = await jinaR.text();
                found = extractEmails(jinaText, domainRoot);
              }
            } catch {}
          }

          if (found.length) { contacts = found; break; }
        } catch { continue; }
      }

      // If website scrape found emails, use best person email OR apply pattern
      let domainPattern = null;
      for (const c of contacts) {
        if (!isPersonEmail(c.email)) continue;
        if (!domainPattern) domainPattern = detectPattern(c.email);
        if (seenEmails.has(c.email)) continue;
        if (!await hasMx(c.email)) continue;
        seenEmails.add(c.email);
        seenDomains.add(domain);
        const personContext = await findPersonContext(c.name, company, c.title);
        allContacts.push({ ...c, company, personContext, targetTitle: titles[0] });
        onProgress?.(`Found ${c.title || titles[0]} at ${company}`);
        break;
      }

      // Pattern trick: if we found emails but none were the target person,
      // search for the target person's name and construct their email
      if (!seenDomains.has(domain) && domainPattern) {
        const { snippetEmails: _, urls: targetUrls } = await searchAll(
          `"${company}" "${titles[0]}" site:linkedin.com OR "${titles[0]}" "${company}"`        );
        // Extract person name from search snippets (LinkedIn slugs often have name)
        const nameMatch = targetUrls
          .filter(u => u.includes('linkedin.com/in/'))
          .map(u => u.split('/in/')[1]?.split(/[/?#]/)[0]?.replace(/-[a-z0-9]+$/, '').replace(/-/g, ' ').trim())
          .find(n => n && n.split(' ').length >= 2);
        if (nameMatch) {
          const guessedEmail = applyPattern(nameMatch, domainPattern, domain);
          if (!seenEmails.has(guessedEmail) && await hasMx(guessedEmail)) {
            seenEmails.add(guessedEmail);
            seenDomains.add(domain);
            const personContext = await findPersonContext(nameMatch, company, titles[0]);
            allContacts.push({ email: guessedEmail, name: nameMatch, title: titles[0], domain, company, personContext, targetTitle: titles[0] });
            onProgress?.(`Pattern-matched ${titles[0]} at ${company}: ${guessedEmail}`);
          }
        }
      }

      // If no person email found on website, try open sources in parallel
      if (!seenDomains.has(domain)) {
        const [pgpFound, crtFound, usFound, wbFound] = await Promise.all([
          pgpKeyEmails(domain),
          crtshEmails(domain),
          urlscanEmails(domain),
          waybackEmails(domain),
        ]);
        const pgpHit = pgpFound.find(r => !seenEmails.has(r.email));
        if (pgpHit && await hasMx(pgpHit.email)) {
          seenEmails.add(pgpHit.email);
          seenDomains.add(domain);
          const personContext = await findPersonContext(pgpHit.name, company, titles[0]);
          allContacts.push({ email: pgpHit.email, name: pgpHit.name, title: titles[0], domain, company, personContext, targetTitle: titles[0] });
          onProgress?.(`Found ${pgpHit.name || 'contact'} at ${company} (PGP keyserver)`);
        } else {
          const deepEmails = [...crtFound, ...usFound, ...wbFound].filter(e => !seenEmails.has(e) && isPersonEmail(e));
          const email = deepEmails[0];
          if (email && await hasMx(email)) {
            seenEmails.add(email);
            seenDomains.add(domain);
            const personContext = await findPersonContext('', company, titles[0]);
            allContacts.push({ email, name: '', title: titles[0], domain, company, personContext, targetTitle: titles[0] });
            onProgress?.(`Found contact at ${company} (deep lookup)`);
          }
        }
      }

      // Crunchbase: get founder name → apply email pattern (scraped or DNS TXT provider)
      if (!seenDomains.has(domain)) {
        const founderName = await crunchbaseFounderName(company);
        if (founderName) {
          // Try all 4 patterns — DISIFY picks the real one
          const guessedEmail = await verifyBestEmail(founderName, domain);
          if (guessedEmail && !seenEmails.has(guessedEmail)) {
            seenEmails.add(guessedEmail);
            seenDomains.add(domain);
            const personContext = await findPersonContext(founderName, company, titles[0]);
            allContacts.push({ email: guessedEmail, name: founderName, title: titles[0], domain, company, personContext, targetTitle: titles[0] });
            onProgress?.(`Found ${founderName} at ${company} (Crunchbase + pattern)`);
          }
        }
      }


      // Also: targeted DDG search for "@domain" to catch forum/PDF indexed emails
      if (!seenDomains.has(domain)) {
        const { snippetEmails: domainSnippets } = await searchAll(`"@${domain}" "${company}"`);
        const personSnippets = domainSnippets.filter(e => e.endsWith(`@${domain}`) && isPersonEmail(e) && !seenEmails.has(e));
        const email = personSnippets[0];
        if (email && await hasMx(email)) {
          seenEmails.add(email);
          seenDomains.add(domain);
          allContacts.push({ email, name: '', title: titles[0], domain, company, personContext: '', targetTitle: titles[0] });
          onProgress?.(`Found contact at ${company} (domain search)`);
        }
      }

      // Last resort: guess email patterns — name-based if we found a name, role-based otherwise
      if (!seenDomains.has(domain)) {
        // Try to find person name from any snippet on the company page
        let foundName = '';
        try {
          const r2 = await fetch(`https://${domain}/about`, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
          if (r2.ok) {
            const h2 = await r2.text();
            foundName = h2.replace(/<[^>]+>/g,' ').match(/([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})/)?.[1]?.trim() || '';
          }
        } catch {}
        const guesses = foundName
          ? guessEmails(foundName, domain)
          : ['ceo', 'founder', 'cto', 'director', 'md'].map(r => `${r}@${domain}`);
        for (const email of guesses) {
          if (seenEmails.has(email)) continue;
          if (await hasMx(email)) {
            seenEmails.add(email);
            seenDomains.add(domain);
            const gname = foundName || '';
            allContacts.push({ email, name: gname, title: titles[0], domain, company, personContext: '', targetTitle: titles[0] });
            onProgress?.(`Guessed contact at ${company}: ${email}`);
            break;
          }
        }
      }
    }

    await new Promise(res => setTimeout(res, 900 + Math.random() * 1300));
  }

  // Process YC India companies — structured data: domain + founder names
  onProgress?.('Checking YC India companies…');
  for (const entry of ycEntries.slice(0, 20)) {
    if (seenDomains.has(entry.domain)) continue;
    for (const founderName of entry.founderNames.slice(0, 2)) {
      const email = await verifyBestEmail(founderName, entry.domain);
      if (!email || seenEmails.has(email)) continue;
      seenEmails.add(email);
      seenDomains.add(entry.domain);
      const personContext = await findPersonContext(founderName, entry.company, titles[0]);
      allContacts.push({ email, name: founderName, title: titles[0], domain: entry.domain, company: entry.company, personContext, targetTitle: titles[0] });
      onProgress?.(`Found ${founderName} at ${entry.company} (YC)`);
      break;
    }
    if (allContacts.length >= (cfg.dailyLimit || 15)) break;
  }

  // Process ProductHunt items — recent launches with maker name
  for (const item of phItems.slice(0, 10)) {
    let domain = '';
    try { domain = new URL(item.link).hostname.replace('www.', ''); } catch { continue; }
    if (!domain || seenDomains.has(domain) || PLATFORM_DOMAINS.has(domain)) continue;
    const company = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
    const email = await verifyBestEmail(item.maker, domain);
    if (!email || seenEmails.has(email)) continue;
    seenEmails.add(email);
    seenDomains.add(domain);
    const personContext = await findPersonContext(item.maker, company, titles[0]);
    allContacts.push({ email, name: item.maker, title: 'Maker', domain, company, personContext, targetTitle: titles[0] });
    onProgress?.(`Found ${item.maker} at ${company} (ProductHunt)`);
    if (allContacts.length >= (cfg.dailyLimit || 15)) break;
  }

  return allContacts;
}
