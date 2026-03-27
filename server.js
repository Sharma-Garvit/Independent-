const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT || 8787;
const NOTION_TOKEN = process.env.NOTION_TOKEN || '';
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID || '';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:3b';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const OPENAI_RESEARCH_MODEL = process.env.OPENAI_RESEARCH_MODEL || 'gpt-4.1';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const localYtDlpPath = path.join(__dirname, '..', 'extractor', 'yt-dlp.exe');
const YT_DLP_PATH = process.env.YT_DLP_PATH || (fs.existsSync(localYtDlpPath) ? localYtDlpPath : 'yt-dlp');
const IS_HOSTED_RUNTIME = Boolean(process.env.RENDER || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL);

let transcriberPromise = null;
let wavefileModulePromise = null;

function requireEnv(name, value) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, code, error, detail = '') {
  return sendJson(res, status, { ok: false, code, error, detail });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function ensureString(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function ensureArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

function ensureNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeStatus(value) {
  const allowed = new Set(['New', 'Reviewed', 'Applied', 'Needs Manual Context']);
  return allowed.has(value) ? value : 'New';
}

function normalizeConfidence(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num > 1) return Math.max(0, Math.min(1, num / 10));
  return Math.max(0, Math.min(1, num));
}

function normalizeScore(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  if (num <= 1) return Math.round(num * 100);
  return Math.max(0, Math.min(100, Math.round(num)));
}

function classifyAnalysisQuality({ status, summary, confidence, action_items, websites, knowledge_card }) {
  if (normalizeStatus(status) === 'Needs Manual Context') return 'needs-manual-context';
  const summaryCount = ensureArray(summary).length;
  const actionCount = ensureArray(action_items).length;
  const websiteCount = ensureArray(websites).length;
  const confidenceScore = normalizeScore(confidence);
  const hasOverview = Boolean(ensureString(knowledge_card?.reel_overview));
  if (confidenceScore >= 65 && summaryCount >= 4 && actionCount >= 1 && (websiteCount >= 1 || hasOverview)) {
    return 'strong';
  }
  return 'partial';
}

function joinBullets(items) {
  return ensureArray(items)
    .map(item => ensureString(item))
    .filter(Boolean)
    .join(' | ');
}

function normalizeKnowledgeCard(card = {}) {
  return {
    reel_overview: ensureString(card.reel_overview),
    exact_topic: ensureString(card.exact_topic),
    who_it_is_for: ensureString(card.who_it_is_for),
    why_it_matters: ensureString(card.why_it_matters),
    creator_claims: ensureArray(card.creator_claims).slice(0, 6),
    core_points: ensureArray(card.core_points).slice(0, 6),
    steps: ensureArray(card.steps).slice(0, 6),
    tools_and_resources: ensureArray(card.tools_and_resources).slice(0, 6),
    use_cases: ensureArray(card.use_cases).slice(0, 5),
    cautions: ensureArray(card.cautions).slice(0, 4),
    research_notes: ensureArray(card.research_notes).slice(0, 4),
  };
}

function formatKnowledgeCard(card = {}) {
  const safe = normalizeKnowledgeCard(card);
  const sections = [
    ['What Was Said', safe.reel_overview],
    ['Exact Topic', safe.exact_topic],
    ['Who This Is For', safe.who_it_is_for],
    ['Why It Matters', safe.why_it_matters],
    ['Creator Claims', safe.creator_claims],
    ['Core Points', safe.core_points],
    ['Steps To Apply', safe.steps],
    ['Tools And Resources', safe.tools_and_resources],
    ['Best Use Cases', safe.use_cases],
    ['Cautions', safe.cautions],
    ['Research Notes', safe.research_notes],
  ];

  return sections
    .filter(([, value]) => Array.isArray(value) ? value.length : ensureString(value))
    .map(([label, value]) => Array.isArray(value)
      ? `${label}:\n- ${value.join('\n- ')}`
      : `${label}:\n${value}`)
    .join('\n\n')
    .slice(0, 1800);
}

function cleanLink(raw) {
  return raw.replace(/[),.;]+$/g, '');
}

function extractLinks(text) {
  const matches = text.match(/(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[\w\-./?%&=+#]*)?/g) || [];
  return [...new Set(matches.map(cleanLink).filter(link => link.includes('.')))];
}

function extractSectionForQuality(text, sectionName) {
  const source = ensureString(text);
  if (!source) return '';
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}:\\n([\\s\\S]*?)(?:\\n\\n[A-Z][^\\n]+:|$)`));
  return ensureString(match?.[1]?.replace(/^- /gm, '').trim());
}

function splitSentences(text) {
  return ensureString(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map(part => part.trim())
    .filter(part => part.length > 24);
}

function extractNamedTools(text) {
  const catalog = [
    'Notion', 'Canva', 'CapCut', 'Figma', 'ChatGPT', 'OpenAI', 'Midjourney', 'Google Docs',
    'Google Drive', 'Google Sheets', 'Excel', 'Slack', 'Telegram', 'WhatsApp', 'YouTube',
    'Instagram', 'Pinterest', 'Shopify', 'Gumroad', 'Substack', 'Zapier', 'n8n', 'Airtable',
    'Trello', 'Asana', 'Supabase', 'Framer', 'Webflow', 'VS Code', 'Claude', 'Cursor'
  ];
  const haystack = ensureString(text);
  return catalog.filter(name => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(haystack));
}

function fallbackOverview(input) {
  const sentences = splitSentences([input.transcript, input.description, input.raw_text].filter(Boolean).join(' '));
  return sentences.slice(0, 2).join(' ').slice(0, 320);
}

function fallbackBullets(input, max = 5) {
  return splitSentences([input.transcript, input.description, input.raw_text].filter(Boolean).join(' '))
    .slice(0, max)
    .map(sentence => sentence.replace(/\s+/g, ' ').trim());
}

function buildFallbackExtraction(url, raw = {}) {
  const safeUrl = ensureString(url);
  const rawText = ensureString(raw.raw_text);
  const note = ensureString(raw.user_note);
  const description = [rawText, note].filter(Boolean).join('\n\n');
  return {
    title: 'Instagram save',
    description,
    uploader: '',
    duration: null,
    transcript: rawText,
    transcriptSource: rawText ? 'user-context' : 'metadata-fallback',
    websites: extractLinks([safeUrl, rawText].filter(Boolean).join(' ')),
    combinedText: [description, safeUrl].filter(Boolean).join(' '),
    originalUrl: safeUrl,
  };
}

function pickTitle(input) {
  return ensureString(input.media_title)
    || ensureString(input.uploader && `Video by ${input.uploader}`)
    || 'Instagram save';
}

function inferTagsFromText(text) {
  const tokens = ensureString(text)
    .toLowerCase()
    .match(/\b[a-z][a-z0-9+-]{2,}\b/g) || [];
  const stopWords = new Set([
    'this', 'that', 'with', 'from', 'have', 'your', 'about', 'what', 'when', 'where',
    'which', 'there', 'their', 'would', 'could', 'should', 'into', 'while', 'after',
    'before', 'because', 'using', 'used', 'make', 'makes', 'made', 'more', 'most',
    'very', 'than', 'then', 'them', 'they', 'the', 'and', 'for', 'are', 'was', 'were',
    'you', 'how', 'why', 'not', 'too', 'can', 'will', 'just', 'like', 'need', 'want',
    'save', 'reel', 'post', 'instagram'
  ]);
  const counts = new Map();
  for (const token of tokens) {
    if (stopWords.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([token]) => token);
}

function buildHeuristicCard(input, reason = '') {
  const combined = [input.transcript, input.description, input.raw_text, input.user_note].filter(Boolean).join(' ');
  const bullets = fallbackBullets(input, 6);
  const resources = [...new Set([
    ...ensureArray(input.websites),
    ...extractNamedTools(combined),
    ...extractLinks(combined)
  ])].slice(0, 6);
  const overview = fallbackOverview(input) || 'This save was captured without full AI analysis, so the card is based on visible metadata, caption text, and any notes you added.';
  const title = pickTitle(input);
  const caution = reason
    ? `AI was unavailable during capture: ${reason}`
    : 'AI was unavailable during capture, so this card may miss nuance from the full reel audio.';
  const steps = [];
  if (ensureString(input.user_note)) steps.push(`Revisit this because: ${ensureString(input.user_note)}`);
  if (resources.length) steps.push(`Check these mentioned tools or links: ${resources.join(', ')}`);
  if (!steps.length) steps.push('Review the summary and decide whether this save is worth revisiting manually.');

  const knowledgeCard = normalizeKnowledgeCard({
    reel_overview: overview,
    exact_topic: bullets[0] || ensureString(input.description).slice(0, 140),
    who_it_is_for: ensureString(input.user_note) ? 'Useful for the reason noted by the user.' : 'Likely useful to someone researching this topic further.',
    why_it_matters: bullets[1] || 'This was saved because it likely contains a reusable idea, workflow, or reference.',
    creator_claims: bullets.slice(0, 4),
    core_points: bullets.slice(0, 5),
    steps,
    tools_and_resources: resources,
    use_cases: ensureString(input.user_note) ? [ensureString(input.user_note)] : [],
    cautions: [caution],
    research_notes: ['Reprocess later when AI is available for a deeper breakdown.'],
  });

  const summary = bullets.length
    ? bullets.slice(0, 6)
    : [
        'The reel was saved successfully, but AI analysis was unavailable at the time.',
        'This summary is based on available caption text, links, and any note you added.',
        'Use the card as a lightweight reminder and reprocess later for a richer breakdown.',
        resources.length ? `Mentioned tools or links: ${resources.join(', ')}` : 'No clear tool or website could be extracted automatically.'
      ];

  const result = {
    title,
    type: ensureString(input.source_type, 'Unknown'),
    summary,
    key_takeaway: bullets[0] || 'Saved for later review with a lightweight fallback summary.',
    action_items: steps,
    tags: inferTagsFromText(combined),
    websites: resources,
    status: 'Needs Manual Context',
    actionability_score: resources.length || ensureString(input.user_note) ? 42 : 28,
    confidence: 0.34,
    knowledge_card: knowledgeCard,
  };
  result.analysis_quality = 'partial';
  return result;
}

function parseVtt(content) {
  return content
    .split(/\r?\n/)
    .filter(line => line && !line.startsWith('WEBVTT') && !line.includes('-->') && !/^\d+$/.test(line.trim()))
    .map(line => line.replace(/<[^>]+>/g, '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} failed (${code}): ${stderr || stdout}`));
    });
  });
}

async function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny.en');
    })();
  }
  return transcriberPromise;
}

async function getWavefileModule() {
  if (!wavefileModulePromise) {
    wavefileModulePromise = import('wavefile').then(mod => mod.default?.WaveFile || mod.WaveFile || mod.default);
  }
  return wavefileModulePromise;
}

async function transcribeWav(wavPath) {
  const [transcriber, WaveFile] = await Promise.all([getTranscriber(), getWavefileModule()]);
  const buffer = await fsp.readFile(wavPath);
  let wav = new WaveFile(buffer);
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);
  let audioData = wav.getSamples();
  if (Array.isArray(audioData)) {
    audioData = audioData[0];
  }
  const result = await transcriber(audioData);
  return ensureString(result.text);
}

async function getPrimarySubtitle(tempDir) {
  const entries = await fsp.readdir(tempDir, { withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name);
  const vttFiles = files.filter(name => name.endsWith('.vtt')).sort();
  if (!vttFiles.length) return '';
  const best = vttFiles.sort((a, b) => b.length - a.length)[0];
  const content = await fsp.readFile(path.join(tempDir, best), 'utf8');
  return parseVtt(content);
}

async function getDownloadedAudioFile(tempDir) {
  const entries = await fsp.readdir(tempDir, { withFileTypes: true });
  const files = entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(tempDir, entry.name))
    .filter(file => !file.endsWith('.vtt') && !file.endsWith('.json') && !file.endsWith('.part'));
  return files[0] || null;
}

async function extractInstagramContent(url) {
  if (YT_DLP_PATH !== 'yt-dlp' && !fs.existsSync(YT_DLP_PATH)) {
    throw new Error(`yt-dlp executable not found at ${YT_DLP_PATH}`);
  }

  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'save-to-action-'));
  try {
    const infoResult = await runCommand(YT_DLP_PATH, ['--dump-single-json', '--no-warnings', '--no-playlist', url]);
    const info = JSON.parse(infoResult.stdout);
    const outputTemplate = path.join(tempDir, 'asset.%(ext)s');

    let transcript = '';
    let transcriptSource = '';

    try {
      await runCommand(YT_DLP_PATH, [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', 'en,en-US,en-GB,hi',
        '--sub-format', 'vtt',
        '--no-playlist',
        '--output', outputTemplate,
        url,
      ]);
      transcript = await getPrimarySubtitle(tempDir);
      if (transcript) transcriptSource = 'captions';
    } catch {
      transcript = '';
    }

    if (!transcript && !IS_HOSTED_RUNTIME) {
      await runCommand(YT_DLP_PATH, [
        '-f', 'bestaudio/best',
        '--no-playlist',
        '--output', outputTemplate,
        url,
      ]);
      const audioFile = await getDownloadedAudioFile(tempDir);
      if (audioFile) {
        const wavPath = path.join(tempDir, 'audio.wav');
        await runCommand(ffmpegPath, ['-y', '-i', audioFile, '-ar', '16000', '-ac', '1', wavPath]);
        transcript = await transcribeWav(wavPath);
        if (transcript) transcriptSource = 'whisper';
      }
    }

    if (!transcript && IS_HOSTED_RUNTIME) {
      transcriptSource = 'metadata-fallback';
    }

    const description = ensureString(info.description);
    const title = ensureString(info.title, 'Instagram save');
    const uploader = ensureString(info.uploader || info.channel || info.creator);
    const combinedText = [title, description, transcript].filter(Boolean).join(' ');
    const websites = extractLinks([info.webpage_url, description, transcript].filter(Boolean).join(' '));

    return {
      title,
      description,
      uploader,
      duration: info.duration || null,
      transcript,
      transcriptSource,
      websites,
      combinedText,
      originalUrl: ensureString(info.webpage_url, url),
    };
  } finally {
    try {
      await fsp.rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

function validateInstagramUrl(url) {
  const value = ensureString(url);
  if (!value) throw new Error('Please provide an Instagram Reel or Post link.');
  if (!/^https?:\/\/(?:www\.|m\.)?instagram\.com\/(?:reel|p)\//i.test(value)) {
    throw new Error('Use a full Instagram Reel or Post link.');
  }
  return value;
}

async function notionQuery() {
  requireEnv('NOTION_TOKEN', NOTION_TOKEN);
  requireEnv('NOTION_DATABASE_ID', NOTION_DATABASE_ID);
  const resp = await fetch(`https://api.notion.com/v1/databases/${NOTION_DATABASE_ID}/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ page_size: 100, sorts: [{ timestamp: 'created_time', direction: 'descending' }] })
  });
  if (!resp.ok) throw new Error(`Notion query failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

function mapNotionItem(page) {
  const props = page.properties || {};
  const item = {
    page_id: page.id,
    title: props.Title?.title?.[0]?.plain_text || 'Untitled',
    url: props.URL?.url || '',
    status: props.Status?.select?.name || 'New',
    type: props.Type?.select?.name || 'Unknown',
    tags: (props.Tags?.multi_select || []).map(t => t.name),
    summary: props.Summary?.rich_text?.[0]?.plain_text || '',
    key_takeaway: props['Key Takeaway']?.rich_text?.[0]?.plain_text || '',
    action_items: props['Action Items']?.rich_text?.[0]?.plain_text || '',
    websites: props.Websites?.rich_text?.[0]?.plain_text || '',
    source_text: props['Source Text']?.rich_text?.[0]?.plain_text || '',
    saved_note: props['Saved Note']?.rich_text?.[0]?.plain_text || '',
    actionability_score: props['Actionability Score']?.number ?? 0,
    confidence: props.Confidence?.number ?? 0
  };
  item.analysis_quality = classifyAnalysisQuality({
    status: item.status,
    summary: ensureArray(item.summary),
    confidence: item.confidence,
    action_items: ensureArray(item.action_items),
    websites: ensureArray(item.websites),
    knowledge_card: { reel_overview: extractSectionForQuality(item.source_text, 'What Was Said') }
  });
  return item;
}

async function createNotionPage(item) {
  requireEnv('NOTION_TOKEN', NOTION_TOKEN);
  requireEnv('NOTION_DATABASE_ID', NOTION_DATABASE_ID);
  const resp = await fetch('https://api.notion.com/v1/pages', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: {
        Title: { title: [{ text: { content: ensureString(item.title, 'Instagram save') } }] },
        URL: { url: item.url },
        Type: { select: { name: ensureString(item.type, 'Unknown') } },
        Summary: { rich_text: [{ text: { content: joinBullets(item.summary).slice(0, 1800) } }] },
        'Key Takeaway': { rich_text: [{ text: { content: ensureString(item.key_takeaway, 'Review this saved item later.') } }] },
        'Action Items': { rich_text: [{ text: { content: joinBullets(item.action_items).slice(0, 1800) } }] },
        'Saved Note': { rich_text: [{ text: { content: ensureString(item.user_note, '') } }] },
        Status: { select: { name: normalizeStatus(ensureString(item.status, 'Needs Manual Context')) } },
        'Actionability Score': { number: normalizeScore(item.actionability_score) },
        Confidence: { number: normalizeConfidence(item.confidence) },
        'Source Text': { rich_text: [{ text: { content: ensureString(item.source_text, '').slice(0, 1800) } }] },
        Websites: { rich_text: [{ text: { content: ensureArray(item.websites).join(' | ').slice(0, 1800) } }] },
        Tags: { multi_select: ensureArray(item.tags).slice(0, 6).map(name => ({ name: ensureString(name) })) }
      }
    })
  });
  if (!resp.ok) throw new Error(`Notion create failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function updateNotionStatus(pageId, status) {
  requireEnv('NOTION_TOKEN', NOTION_TOKEN);
  const resp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ properties: { Status: { select: { name: normalizeStatus(status) } } } })
  });
  if (!resp.ok) throw new Error(`Notion status update failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function updateNotionAnalysis(pageId, item) {
  requireEnv('NOTION_TOKEN', NOTION_TOKEN);
  const resp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      properties: {
        Title: { title: [{ text: { content: ensureString(item.title, 'Instagram save') } }] },
        URL: { url: item.url },
        Type: { select: { name: ensureString(item.type, 'Unknown') } },
        Summary: { rich_text: [{ text: { content: joinBullets(item.summary).slice(0, 1800) } }] },
        'Key Takeaway': { rich_text: [{ text: { content: ensureString(item.key_takeaway, 'Review this saved item later.') } }] },
        'Action Items': { rich_text: [{ text: { content: joinBullets(item.action_items).slice(0, 1800) } }] },
        'Saved Note': { rich_text: [{ text: { content: ensureString(item.user_note, '') } }] },
        Status: { select: { name: normalizeStatus(ensureString(item.status, 'Needs Manual Context')) } },
        'Actionability Score': { number: normalizeScore(item.actionability_score) },
        Confidence: { number: normalizeConfidence(item.confidence) },
        'Source Text': { rich_text: [{ text: { content: ensureString(item.source_text, '').slice(0, 1800) } }] },
        Websites: { rich_text: [{ text: { content: ensureArray(item.websites).join(' | ').slice(0, 1800) } }] },
        Tags: { multi_select: ensureArray(item.tags).slice(0, 6).map(name => ({ name: ensureString(name) })) }
      }
    })
  });
  if (!resp.ok) throw new Error(`Notion update failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

function buildAiPrompt(input) {
  return `You convert saved Instagram content into a high-signal knowledge card so the user does not need to rewatch the reel.
Return JSON only.
Allowed status values: New or Needs Manual Context.
Use the websites field for any named app, website, tool, platform, or product mentioned in the reel. If a full link is available, use it. If only a name is known, return the name.
Keep tags short and lowercase.
Be concrete and exact. Prefer named methods, steps, tools, and frameworks over vague summaries.
If the reel is weak or incomplete, say so in cautions instead of inventing details.

Required keys:
{
  "title": string,
  "type": "Reel" | "Post" | "Unknown",
  "summary": string[],
  "key_takeaway": string,
  "action_items": string[],
  "tags": string[],
  "websites": string[],
  "status": "New" | "Needs Manual Context",
  "actionability_score": number,
  "confidence": number,
  "knowledge_card": {
    "reel_overview": string,
    "exact_topic": string,
    "who_it_is_for": string,
    "why_it_matters": string,
    "creator_claims": string[],
    "core_points": string[],
    "steps": string[],
    "tools_and_resources": string[],
    "use_cases": string[],
    "cautions": string[],
    "research_notes": string[]
  }
}

Rules:
- summary should be 4 to 7 dense bullets, each useful on its own.
- summary must capture what the creator actually said, not just your interpretation.
- reel_overview must be a short paragraph explaining the reel in plain language.
- action_items should be real next steps the user can do.
- research_notes should only add short clarifications that help the user apply or understand the topic better.
- steps should capture the creator's method in the right order when possible.
- tools_and_resources should include websites, apps, software, platforms, or named methods.
- cautions should mention assumptions, missing context, or potential limits.
- If the creator mentions an app or website, include it in both websites and tools_and_resources.

Instagram URL: ${input.url}
Detected type: ${input.source_type}
Video title: ${input.media_title}
Uploader: ${input.uploader}
Description/caption: ${input.description}
Transcript source: ${input.transcript_source}
Transcript: ${input.transcript}
Detected websites: ${ensureArray(input.websites).join(', ')}
Why user saved this: ${input.user_note}
Extra raw text: ${input.raw_text}`;
}

function buildResearchPrompt(input) {
  return `You are enriching an Instagram reel knowledge card with careful web research.
Return JSON only.
Stay tightly anchored to the extracted reel content. Do not drift into unrelated web results.
Use web search only to clarify names, tools, methods, websites, products, or concepts that are strongly suggested by the content.
If the reel is too ambiguous, keep research_notes conservative.

Required keys:
{
  "title": string,
  "type": "Reel" | "Post" | "Unknown",
  "summary": string[],
  "key_takeaway": string,
  "action_items": string[],
  "tags": string[],
  "websites": string[],
  "status": "New" | "Needs Manual Context",
  "actionability_score": number,
  "confidence": number,
  "knowledge_card": {
    "reel_overview": string,
    "exact_topic": string,
    "who_it_is_for": string,
    "why_it_matters": string,
    "creator_claims": string[],
    "core_points": string[],
    "steps": string[],
    "tools_and_resources": string[],
    "use_cases": string[],
    "cautions": string[],
    "research_notes": string[]
  }
}

Content to analyze:
- URL: ${input.url}
- Type: ${input.source_type}
- Title: ${input.media_title}
- Uploader: ${input.uploader}
- Description: ${input.description}
- Transcript source: ${input.transcript_source}
- Transcript: ${input.transcript}
- Existing websites: ${ensureArray(input.websites).join(', ')}
- User note: ${input.user_note}
- Extra text: ${input.raw_text}`;
}

async function generateAiWithOpenAI(prompt) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You return valid JSON only.' },
        { role: 'user', content: prompt }
      ]
    })
  });

  if (!resp.ok) throw new Error(`OpenAI failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

async function generateAiWithOllama(prompt) {
  const resp = await fetch(`${OLLAMA_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: OLLAMA_MODEL, stream: false, format: 'json', prompt })
  });

  if (!resp.ok) throw new Error(`Ollama failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return JSON.parse(data.response || '{}');
}

async function generateAiWithOpenAIResearch(input) {
  const resp = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: OPENAI_RESEARCH_MODEL,
      tools: [{ type: 'web_search' }],
      input: buildResearchPrompt(input)
    })
  });

  if (!resp.ok) throw new Error(`OpenAI research failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const text = ensureString(data.output_text);
  return JSON.parse(text || '{}');
}

async function generateAi(input) {
  const prompt = buildAiPrompt(input);
  let parsed;

  if (OPENAI_API_KEY) {
    try {
      parsed = await generateAiWithOpenAIResearch(input);
    } catch (researchError) {
      try {
        parsed = await generateAiWithOpenAI(prompt);
      } catch (openAiError) {
        return buildHeuristicCard(input, ensureString(openAiError.message || researchError.message, 'OpenAI quota or processing failed.'));
      }
    }
  } else {
    if (IS_HOSTED_RUNTIME) {
      return buildHeuristicCard(input, 'No hosted AI provider is configured.');
    }
    try {
      parsed = await generateAiWithOllama(prompt);
    } catch (ollamaError) {
      return buildHeuristicCard(input, ensureString(ollamaError.message, 'Local AI processing failed.'));
    }
  }

  const knowledgeCard = normalizeKnowledgeCard(parsed.knowledge_card);
  const inferredTools = extractNamedTools([input.transcript, input.description, input.raw_text].filter(Boolean).join(' '));
  const mergedResources = [...new Set([
    ...ensureArray(parsed.websites),
    ...ensureArray(input.websites),
    ...inferredTools
  ])].slice(0, 8);

  if (!knowledgeCard.reel_overview) {
    knowledgeCard.reel_overview = fallbackOverview(input) || 'The reel did not expose enough clear spoken content to create a stronger overview.';
  }

  if (!knowledgeCard.creator_claims.length) {
    knowledgeCard.creator_claims = fallbackBullets(input, 4);
  }

  if (!knowledgeCard.core_points.length) {
    knowledgeCard.core_points = fallbackBullets(input, 5);
  }

  if (!knowledgeCard.steps.length) {
    knowledgeCard.steps = ensureArray(parsed.action_items).slice(0, 5);
  }

  if (!knowledgeCard.tools_and_resources.length) {
    knowledgeCard.tools_and_resources = mergedResources.slice(0, 6);
  }

  const summary = ensureArray(parsed.summary).slice(0, 7);
  if (summary.length < 4) {
    const fallback = fallbackBullets(input, 6).filter(item => !summary.includes(item));
    summary.push(...fallback.slice(0, 4 - summary.length));
  }

  const actionItems = ensureArray(parsed.action_items).slice(0, 6);
  if (!actionItems.length && knowledgeCard.steps.length) {
    actionItems.push(...knowledgeCard.steps.slice(0, 4));
  }

  const result = {
    title: ensureString(parsed.title, input.media_title || 'Instagram save'),
    type: ensureString(parsed.type, input.source_type || 'Unknown'),
    summary,
    key_takeaway: ensureString(parsed.key_takeaway, 'Review this saved item later.'),
    action_items: actionItems,
    tags: ensureArray(parsed.tags),
    websites: mergedResources,
    status: normalizeStatus(ensureString(parsed.status, input.transcript ? 'New' : 'Needs Manual Context')),
    actionability_score: normalizeScore(parsed.actionability_score),
    confidence: normalizeConfidence(parsed.confidence),
    knowledge_card: knowledgeCard,
  };
  result.analysis_quality = classifyAnalysisQuality({
    status: result.status,
    summary: result.summary,
    confidence: result.confidence,
    action_items: result.action_items,
    websites: result.websites,
    knowledge_card: result.knowledge_card,
  });
  return result;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'OPTIONS') return sendJson(res, 200, { ok: true });

  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'save-to-action-backend-unofficial',
        ai_provider: OPENAI_API_KEY ? 'openai' : 'ollama',
        yt_dlp_path: YT_DLP_PATH
      });
    }

    if (req.method === 'GET' && url.pathname === '/instagram-items') {
      const notion = await notionQuery();
      return sendJson(res, 200, { ok: true, items: (notion.results || []).map(mapNotionItem) });
    }

    if (req.method === 'POST' && url.pathname === '/instagram-status') {
      const body = await parseBody(req);
      await updateNotionStatus(body.page_id, body.status || 'Reviewed');
      return sendJson(res, 200, { ok: true, page_id: body.page_id, status: normalizeStatus(body.status || 'Reviewed') });
    }

    if (req.method === 'POST' && url.pathname === '/instagram-save') {
      const body = await parseBody(req);
      const safeUrl = validateInstagramUrl(body.url || '');
      const sourceType = body.source_type && body.source_type !== 'Unknown'
        ? body.source_type
        : (safeUrl.includes('/reel/') ? 'Reel' : (safeUrl.includes('/p/') ? 'Post' : 'Unknown'));

      let extracted;
      try {
        extracted = await extractInstagramContent(safeUrl);
      } catch (error) {
        if (!IS_HOSTED_RUNTIME) {
          throw new Error(`Could not extract the Instagram content. ${error.message}`);
        }
        extracted = buildFallbackExtraction(safeUrl, body);
      }
      const ai = await generateAi({
        url: safeUrl,
        source_type: sourceType,
        user_note: ensureString(body.user_note),
        raw_text: ensureString(body.raw_text),
        media_title: extracted.title,
        uploader: extracted.uploader,
        description: extracted.description,
        transcript_source: extracted.transcriptSource,
        transcript: extracted.transcript,
        websites: extracted.websites,
      });

      const created = await createNotionPage({
        ...ai,
        url: safeUrl || extracted.originalUrl,
        user_note: ensureString(body.user_note),
        source_text: formatKnowledgeCard(ai.knowledge_card),
      });

      return sendJson(res, 200, {
        ok: true,
        status: ai.status,
        page_id: created.id,
        title: ai.title,
        summary: ai.summary,
        key_takeaway: ai.key_takeaway,
        action_items: ai.action_items,
        tags: ai.tags,
        websites: ai.websites,
        knowledge_card: ai.knowledge_card,
        knowledge_card_text: formatKnowledgeCard(ai.knowledge_card),
        transcript_source: extracted.transcriptSource,
        actionability_score: ai.actionability_score,
        confidence: ai.confidence,
        analysis_quality: ai.analysis_quality,
      });
    }

    if (req.method === 'POST' && url.pathname === '/instagram-reprocess') {
      const body = await parseBody(req);
      const pageId = ensureString(body.page_id);
      if (!pageId) return sendError(res, 400, 'missing_page_id', 'A page_id is required to reprocess a saved card.');
      const safeUrl = validateInstagramUrl(body.url || '');
      const sourceType = safeUrl.includes('/reel/') ? 'Reel' : (safeUrl.includes('/p/') ? 'Post' : 'Unknown');

      let extracted;
      try {
        extracted = await extractInstagramContent(safeUrl);
      } catch (error) {
        if (!IS_HOSTED_RUNTIME) {
          throw new Error(`Could not extract the Instagram content. ${error.message}`);
        }
        extracted = buildFallbackExtraction(safeUrl, body);
      }

      const ai = await generateAi({
        url: safeUrl,
        source_type: sourceType,
        user_note: ensureString(body.user_note),
        raw_text: ensureString(body.raw_text),
        media_title: extracted.title,
        uploader: extracted.uploader,
        description: extracted.description,
        transcript_source: extracted.transcriptSource,
        transcript: extracted.transcript,
        websites: extracted.websites,
      });

      await updateNotionAnalysis(pageId, {
        ...ai,
        url: safeUrl || extracted.originalUrl,
        user_note: ensureString(body.user_note),
        source_text: formatKnowledgeCard(ai.knowledge_card),
      });

      return sendJson(res, 200, {
        ok: true,
        page_id: pageId,
        title: ai.title,
        summary: ai.summary,
        key_takeaway: ai.key_takeaway,
        action_items: ai.action_items,
        tags: ai.tags,
        websites: ai.websites,
        knowledge_card: ai.knowledge_card,
        knowledge_card_text: formatKnowledgeCard(ai.knowledge_card),
        transcript_source: extracted.transcriptSource,
        actionability_score: ai.actionability_score,
        confidence: ai.confidence,
        analysis_quality: ai.analysis_quality,
        status: ai.status,
      });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const message = ensureString(error.message, 'Unexpected backend error.');
    const lower = message.toLowerCase();
    if (lower.includes('provide an instagram') || lower.includes('use a full instagram')) {
      return sendError(res, 400, 'invalid_instagram_url', message);
    }
    if (lower.includes('took too long') || lower.includes('timed out')) {
      return sendError(res, 504, 'timeout', 'The backend took too long to finish this request.');
    }
    if (lower.includes('extract')) {
      return sendError(res, 422, 'extract_failed', message);
    }
    if (lower.includes('openai')) {
      return sendError(res, 502, 'ai_failed', 'The AI step failed while building your study card.', message);
    }
    if (lower.includes('notion')) {
      return sendError(res, 502, 'notion_failed', 'The save succeeded locally but Notion rejected the update.', message);
    }
    if (lower.includes('yt-dlp')) {
      return sendError(res, 500, 'downloader_unavailable', 'The media extractor is not available on the backend.', message);
    }
    return sendError(res, 500, 'server_error', message);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Save-to-Action backend running on port ${PORT}`);
});
