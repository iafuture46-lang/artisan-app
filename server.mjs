import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number.parseInt(process.env.PORT || '4173', 10);
const deepSeekKey = process.env.DEEPSEEK_API_KEY || '';
const deepSeekModel = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const imageApiKey = process.env.OPENAI_IMAGE_API_KEY || '';
const imageModel = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-sunburst';
const configuredPhotoLimit = Number.parseInt(process.env.MAX_PHOTO_BYTES || '8388608', 10);
const maxPhotoBytes = Number.isFinite(configuredPhotoLimit)
  ? Math.min(Math.max(configuredPhotoLimit, 1024 * 1024), 20 * 1024 * 1024)
  : 8 * 1024 * 1024;
const requestCounts = new Map();
const ALLOWED_UNITS = new Set(['m2', 'ml', 'u', 'forfait']);
const MIME_TYPES = { '.html': 'text/html; charset=utf-8' };

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer'
  });
  response.end(JSON.stringify(value));
}

function fail(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function readBody(request, limitBytes) {
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > limitBytes) throw fail(413, 'La requête dépasse la taille autorisée.');
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limitBytes) throw fail(413, 'La requête dépasse la taille autorisée.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(request, limitBytes = 64 * 1024) {
  const body = await readBody(request, limitBytes);
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw fail(400, 'Le contenu JSON est invalide.'); }
}

function enforceSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); }
  catch { throw fail(403, 'Origine de requête refusée.'); }
  if (parsedOrigin.host !== request.headers.host) throw fail(403, 'Origine de requête refusée.');
}

function enforceRateLimit(request, scope, limit, windowMs) {
  const key = `${request.socket.remoteAddress || 'local'}:${scope}`;
  const now = Date.now();
  const existing = requestCounts.get(key);
  if (!existing || now - existing.startedAt >= windowMs) {
    requestCounts.set(key, { startedAt: now, count: 1 });
    return;
  }
  existing.count += 1;
  if (existing.count > limit) throw fail(429, 'Trop de requêtes. Réessayez dans une minute.');
}

async function callDeepSeek(messages, responseFormat) {
  if (!deepSeekKey) throw fail(503, 'Agnès n’est pas configurée : DEEPSEEK_API_KEY manque côté serveur.');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${deepSeekKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: deepSeekModel,
      messages,
      temperature: 0.2,
      max_tokens: 1600,
      ...(responseFormat ? { response_format: { type: 'json_object' } } : {})
    }),
    signal: AbortSignal.timeout(60_000)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw fail(502, 'Le fournisseur Agnès a refusé la configuration serveur.');
    if (response.status === 429) throw fail(503, 'Agnès est temporairement limitée par son fournisseur.');
    throw fail(502, 'Le service Agnès est momentanément indisponible.');
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw fail(502, 'Agnès n’a pas renvoyé de réponse exploitable.');
  return content;
}

function parseQuoteLines(content) {
  let parsed;
  try { parsed = JSON.parse(content); }
  catch { throw fail(502, 'Agnès a renvoyé un format de devis invalide.'); }
  const lines = Array.isArray(parsed) ? parsed : parsed?.lines;
  if (!Array.isArray(lines) || lines.length > 80) throw fail(502, 'Agnès a renvoyé une liste de prestations invalide.');
  return lines.map((line) => {
    const designation = typeof line?.designation === 'string' ? line.designation.trim().slice(0, 240) : '';
    const quantity = Number(line?.quantite);
    const unit = String(line?.unite || 'forfait').toLowerCase();
    if (!designation || !Number.isFinite(quantity) || quantity < 0 || quantity > 1_000_000 || !ALLOWED_UNITS.has(unit)) {
      throw fail(502, 'Une ligne proposée par Agnès ne respecte pas le format attendu.');
    }
    return { code: 'custom', d: designation, q: quantity, u: unit, pu: 0, puBase: 0 };
  });
}

function imageInfo(bytes, mimeType) {
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), mimeType };
  }
  if (mimeType !== 'image/jpeg' || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    const segmentLength = bytes.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + segmentLength + 2 > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7), mimeType };
    }
    offset += segmentLength + 2;
  }
  return null;
}

async function editPhoto(request) {
  const declaredLength = Number(request.headers['content-length'] || 0);
  if (declaredLength > maxPhotoBytes + 256 * 1024) throw fail(413, 'La photo dépasse la limite autorisée.');
  const rawBody = await readBody(request, maxPhotoBytes + 256 * 1024);
  const formRequest = new Request(`http://localhost${request.url}`, {
    method: 'POST',
    headers: request.headers,
    body: rawBody
  });
  let form;
  try { form = await formRequest.formData(); }
  catch { throw fail(400, 'Le formulaire photo est invalide.'); }
  const photo = form.get('photo');
  const requestText = String(form.get('instructions') || '').trim();
  if (!(photo instanceof File) || !photo.size || photo.size > maxPhotoBytes) throw fail(400, 'Choisissez une photo PNG ou JPEG de taille autorisée.');
  if (!['image/png', 'image/jpeg'].includes(photo.type)) throw fail(415, 'Formats acceptés : PNG et JPEG.');
  if (!requestText || requestText.length > 2000) throw fail(400, 'Décrivez la retouche (2 000 caractères maximum).');
  const photoBytes = Buffer.from(await photo.arrayBuffer());
  const dimensions = imageInfo(photoBytes, photo.type);
  if (!dimensions || !dimensions.width || !dimensions.height) throw fail(415, 'Le fichier ne contient pas une image PNG/JPEG lisible.');
  if (dimensions.width > 4096 || dimensions.height > 4096 || dimensions.width * dimensions.height > 16_000_000) {
    throw fail(413, 'La photo dépasse les dimensions autorisées (4 096 px par côté, 16 mégapixels).');
  }
  if (!deepSeekKey) throw fail(503, 'Agnès n’est pas configurée : DEEPSEEK_API_KEY manque côté serveur.');
  if (!imageApiKey) throw fail(503, 'La retouche photo n’est pas configurée : OPENAI_IMAGE_API_KEY manque côté serveur.');

  const prompt = await callDeepSeek([
    { role: 'system', content: 'Tu es Agnès, assistante pour artisans du bâtiment. Reformule la demande en instruction d’édition d’image claire et concise. Préserve autant que possible la scène et les éléments non visés. N’ajoute aucun fait. Réponds uniquement par l’instruction finale.' },
    { role: 'user', content: requestText }
  ]);
  const imageForm = new FormData();
  imageForm.set('model', imageModel);
  imageForm.set('prompt', prompt.slice(0, 4000));
  imageForm.append('image[]', new File([photoBytes], photo.type === 'image/jpeg' ? 'chantier.jpg' : 'chantier.png', { type: photo.type }));
  imageForm.set('output_format', 'png');
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${imageApiKey}` },
    body: imageForm,
    signal: AbortSignal.timeout(180_000)
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw fail(502, 'Le fournisseur de retouche a refusé la configuration serveur.');
    if (response.status === 429) throw fail(503, 'Le service de retouche est limité ou indisponible.');
    throw fail(502, 'La retouche photo n’a pas abouti. Vérifiez l’accès et la compatibilité du fournisseur.');
  }
  const result = await response.json();
  const base64 = result?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64.length || base64.length > 32 * 1024 * 1024) throw fail(502, 'Le fournisseur n’a pas renvoyé une image exploitable.');
  const outputBytes = Buffer.from(base64, 'base64');
  if (outputBytes.length < 24 || !outputBytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw fail(502, 'Le fournisseur n’a pas renvoyé une image PNG valide.');
  }
  return { mimeType: 'image/png', base64, instructions: prompt.slice(0, 4000) };
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && request.method === 'GET') {
    return sendJson(response, 200, {
      agnesConfigured: Boolean(deepSeekKey),
      photoEditConfigured: Boolean(deepSeekKey && imageApiKey),
      authConfigured: false
    });
  }
  if (request.method !== 'POST') throw fail(405, 'Méthode non autorisée.');
  enforceSameOrigin(request);
  enforceRateLimit(request, url.pathname, url.pathname === '/api/photos/edit' ? 4 : 20, 60_000);
  if (url.pathname === '/api/agnes/chat') {
    const payload = await readJson(request);
    if (!Array.isArray(payload.messages) || payload.messages.length > 20) throw fail(400, 'La conversation est invalide.');
    const messages = payload.messages.map((message) => {
      if (!['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 4000) {
        throw fail(400, 'Un message est invalide.');
      }
      return { role: message.role, content: message.content.trim() };
    });
    const answer = await callDeepSeek([
      { role: 'system', content: 'Tu es Agnès, une assistante claire et prudente pour les artisans du bâtiment. Aide à organiser les informations, expliquer les tâches et reformuler des descriptions. Ne prétends pas connaître des prix vérifiés, des règles fiscales ou techniques certaines si elles ne sont pas fournies. Pour toute modification d’un devis ou d’une facture, propose une suggestion et laisse toujours l’utilisateur confirmer dans l’application.' },
      ...messages
    ]);
    return sendJson(response, 200, { message: answer });
  }
  if (url.pathname === '/api/agnes/quote') {
    const payload = await readJson(request, 32 * 1024);
    const description = typeof payload.description === 'string' ? payload.description.trim() : '';
    if (!description || description.length > 5000) throw fail(400, 'Décrivez les travaux (5 000 caractères maximum).');
    const content = await callDeepSeek([
      { role: 'system', content: 'Tu prépares des lignes candidates de devis pour un artisan. Renvoie uniquement un objet JSON avec une propriété lines, tableau d’objets {designation, quantite, unite}. N’invente jamais de prix, ne donne que les quantités explicitement déductibles; si une quantité manque, utilise 0. Unité obligatoirement m2, ml, u ou forfait. Le professionnel doit vérifier les propositions.' },
      { role: 'user', content: description }
    ], true);
    return sendJson(response, 200, { lines: parseQuoteLines(content) });
  }
  if (url.pathname === '/api/photos/edit') {
    const result = await editPhoto(request);
    return sendJson(response, 200, result);
  }
  throw fail(404, 'Route inconnue.');
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') throw fail(405, 'Méthode non autorisée.');
    if (!['/', '/index.html'].includes(url.pathname)) throw fail(404, 'Fichier introuvable.');
    const html = await readFile(join(projectRoot, 'index.html'));
    response.writeHead(200, {
      'content-type': MIME_TYPES['.html'],
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin'
    });
    response.end(request.method === 'HEAD' ? undefined : html);
  } catch (error) {
    if (response.headersSent) return response.destroy();
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
    if (statusCode >= 500) console.error(`[server] ${url.pathname}: ${error.message}`);
    sendJson(response, statusCode, { error: statusCode === 500 ? 'Erreur serveur inattendue.' : error.message });
  }
}

createServer(handleRequest).listen(port, host, () => {
  console.log(`ArtisanApp listening at http://${host}:${port}`);
  if (!deepSeekKey) console.log('Agnès is unavailable until DEEPSEEK_API_KEY is configured server-side.');
  if (!imageApiKey) console.log('Photo editing is unavailable until OPENAI_IMAGE_API_KEY is configured server-side.');
  console.log('This development server has no user authentication and must not be exposed to the public internet.');
});
