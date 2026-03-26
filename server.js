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
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const localYtDlpPath = path.join(__dirname, '..', 'extractor', 'yt-dlp.exe');
const YT_DLP_PATH = process.env.YT_DLP_PATH || (fs.existsSync(localYtDlpPath) ? localYtDlpPath : 'yt-dlp');

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

function cleanLink(raw) {
  return raw.replace(/[),.;]+$/g, '');
}

function extractLinks(text) {
  const matches = text.match(/(?:https?:\/\/)?(?:www\.)?[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(?:\/[\w\-./?%&=+#]*)?/g) || [];
  return [...new Set(matches.map(cleanLink).filter(link => link.includes('.')))];
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
  if (!fs.existsSync(YT_DLP_PATH)) {
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

    if (!transcript) {
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
  return {
    page_id: page.id,
    title: props.Title?.title?.[0]?.plain_text || 'Untitled',
    url: props.URL?.url || '',
    status: props.Status?.select?.name || 'New',
    type: props.Type?.select?.name || 'Unknown',
    tags: (props.Tags?.multi_select || []).map(t => t.name),
    summary: props.Summary?.rich_text?.[0]?.plain_text || '',
    key_takeaway: props['Key Takeaway']?.rich_text?.[0]?.plain_text || '',
    action_items: props['Action Items']?.rich_text?.[0]?.plain_text || '',
    websites: props.Websites?.rich_text?.[0]?.plain_text || ''
  };
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
        Summary: { rich_text: [{ text: { content: ensureArray(item.summary).join(' ') } }] },
        'Key Takeaway': { rich_text: [{ text: { content: ensureString(item.key_takeaway, 'Review this saved item later.') } }] },
        'Action Items': { rich_text: [{ text: { content: ensureArray(item.action_items).join(' | ') } }] },
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

function buildAiPrompt(input) {
  return `You convert saved Instagram content into practical notes for one user. Return JSON only.
Allowed status values: New or Needs Manual Context.
Use websites only when clearly present.
Keep tags short and lowercase.

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
  "confidence": number
}

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

async function generateAi(input) {
  const prompt = buildAiPrompt(input);
  const parsed = OPENAI_API_KEY
    ? await generateAiWithOpenAI(prompt)
    : await generateAiWithOllama(prompt);

  return {
    title: ensureString(parsed.title, input.media_title || 'Instagram save'),
    type: ensureString(parsed.type, input.source_type || 'Unknown'),
    summary: ensureArray(parsed.summary),
    key_takeaway: ensureString(parsed.key_takeaway, 'Review this saved item later.'),
    action_items: ensureArray(parsed.action_items),
    tags: ensureArray(parsed.tags),
    websites: [...new Set([...ensureArray(parsed.websites), ...ensureArray(input.websites)])],
    status: normalizeStatus(ensureString(parsed.status, input.transcript ? 'New' : 'Needs Manual Context')),
    actionability_score: normalizeScore(parsed.actionability_score),
    confidence: normalizeConfidence(parsed.confidence),
  };
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
      const sourceType = body.source_type && body.source_type !== 'Unknown'
        ? body.source_type
        : (body.url?.includes('/reel/') ? 'Reel' : (body.url?.includes('/p/') ? 'Post' : 'Unknown'));

      const extracted = await extractInstagramContent(body.url || '');
      const ai = await generateAi({
        url: body.url || '',
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
        url: body.url || extracted.originalUrl,
        user_note: ensureString(body.user_note),
        source_text: [ensureString(extracted.description), ensureString(extracted.transcript), ensureString(body.raw_text)].filter(Boolean).join(' ').slice(0, 1800),
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
        transcript_source: extracted.transcriptSource,
        actionability_score: ai.actionability_score,
        confidence: ai.confidence,
      });
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Save-to-Action backend running on port ${PORT}`);
});
