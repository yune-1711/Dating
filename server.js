const http = require('http');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 10000);
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';

const headers = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store'
};

function send(res, status, body, extra = {}) {
  res.writeHead(status, { ...headers, ...extra });
  res.end(JSON.stringify(body));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

async function sb(path, options = {}, useSecret = false) {
  const key = useSecret ? SUPABASE_SECRET_KEY : SUPABASE_PUBLISHABLE_KEY;
  if (!SUPABASE_URL || !key) throw new Error('Supabase is not configured');
  const h = { apikey: key, ...(options.headers || {}) };
  const r = await fetch(`${SUPABASE_URL}${path}`, { ...options, headers: h });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) { const e = new Error(data?.msg || data?.message || data?.error_description || 'Supabase request failed'); e.status = r.status; throw e; }
  return data;
}

async function currentUser(token) {
  if (!token) return null;
  try {
    const u = await sb('/auth/v1/user', { headers: { Authorization: `Bearer ${token}` } });
    return u && u.id ? u : null;
  } catch { return null; }
}

async function gemini(prompt, history = []) {
  if (!GEMINI_API_KEY) throw new Error('Gemini is not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const contents = [...history.slice(-20).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: String(m.content || '') }] })), { role: 'user', parts: [{ text: prompt }] }];
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: 'You are the character in a cozy fictional dating app. Stay in character. Be warm, natural, concise, emotionally believable. Never write the user\'s thoughts, feelings, dialogue, or actions. You may use short messages, emojis, kaomoji, and pauses. Do not become controlling or possessive.' }] }, generationConfig: { responseMimeType: 'text/plain' } }) });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || 'Gemini request failed');
  return data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('')?.trim() || '...';
}

async function geminiJson(prompt) {
  if (!GEMINI_API_KEY) throw new Error('Gemini is not configured');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.9 }
  };
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  const data = await r.json().catch(()=>({}));
  if (!r.ok) throw new Error(data?.error?.message || 'Gemini request failed');
  const raw = data?.candidates?.[0]?.content?.parts?.map(p=>p.text||'').join('').trim();
  if (!raw) throw new Error('Gemini returned empty character data');
  try { return JSON.parse(raw); } catch { throw new Error('Gemini returned invalid JSON'); }
}

async function characters(userId) {
  if (!userId) return [];
  const q = `/rest/v1/characters?owner_id=eq.${encodeURIComponent(userId)}&select=id,name,profile,personality,background,preferences,appearance,current_mood,current_activity,status&status=eq.active&order=created_at.asc&limit=20`;
  try {
    const rows = await sb(q, { headers:{Accept:'application/json'} }, true);
    return rows || [];
  } catch { return []; }
}


async function saveMessage(userId, characterId, role, content) {
  if (!SUPABASE_SECRET_KEY || !characterId) return;
  let conv = await sb(`/rest/v1/conversations?user_id=eq.${encodeURIComponent(userId)}&character_id=eq.${encodeURIComponent(characterId)}&select=id&limit=1`, { headers: { Accept: 'application/json' } }, true);
  let conversationId = conv?.[0]?.id;
  if (!conversationId) {
    const created = await sb('/rest/v1/conversations', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' }, body: JSON.stringify({ user_id: userId, character_id: characterId }) }, true);
    conversationId = created?.[0]?.id;
  }
  if (conversationId) await sb('/rest/v1/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ conversation_id: conversationId, sender_type: role === 'user' ? 'user' : 'character', content }) }, true);
}

async function history(userId, characterId) {
  if (!SUPABASE_SECRET_KEY || !characterId) return [];
  const conv = await sb(`/rest/v1/conversations?user_id=eq.${encodeURIComponent(userId)}&character_id=eq.${encodeURIComponent(characterId)}&select=id&limit=1`, { headers: { Accept: 'application/json' } }, true);
  if (!conv?.[0]) return [];
  const rows = await sb(`/rest/v1/messages?conversation_id=eq.${encodeURIComponent(conv[0].id)}&select=sender_type,content,created_at&order=created_at.asc&limit=20`, { headers: { Accept: 'application/json' } }, true);
  return (rows || []).map(x => ({ role: x.sender_type === 'user' ? 'user' : 'assistant', content: x.content }));
}


async function generateCharacters(userId, prefs = {}) {
  const prompt = `Create 6 distinct fictional adult AI dating characters for a cozy realistic social/dating app. The app is responsible for creating the initial roster automatically; the user should discover them, not manually author them. User preferences may be empty on first launch. If preferences are empty, create a balanced, varied starter roster with genuinely different adult personalities and life paths, then let compatibility emerge through interaction. Use these user preferences: ${JSON.stringify(prefs)}.
Return ONLY valid JSON: {"characters":[...]}.
Each character must have: name, age (adult 18+), gender, profile {bio, job}, personality {traits, communication, values, quirks}, background {life, goals, fears, secret}, preferences {likes, dislikes}, appearance {description}, current_mood {label}, current_activity {label}, opening_message.
Make all 6 meaningfully different in personality, life, communication style, and appearance. Keep them fictional, human, realistic, warm, and suitable for a dating/social game. Do not make them controlling or possessive. Do not reference the prompt or say they are AI.`;
  const parsed = await geminiJson(prompt);
  const list = Array.isArray(parsed?.characters) ? parsed.characters.slice(0, 6) : [];
  if (!list.length) throw new Error('AI did not generate characters');
  const rows = list.map(c => ({
    owner_id: userId,
    name: String(c.name || 'Một người mới').slice(0, 80),
    profile: { ...(c.profile || {}), age: Number(c.age) || 18, gender: c.gender || '', opening_message: c.opening_message || '' },
    personality: c.personality || {},
    background: c.background || {},
    preferences: c.preferences || {},
    appearance: c.appearance || {},
    status: 'active',
    current_mood: c.current_mood || { label: 'bình yên' },
    current_activity: c.current_activity || { label: 'đang sống một ngày bình thường' }
  }));
  return await sb('/rest/v1/characters', { method:'POST', headers:{'Content-Type':'application/json',Prefer:'return=representation'}, body:JSON.stringify(rows) }, true);
}

const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');


async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, service: 'cozy-dating', version: '35.2.0' });
  if (req.method === 'GET' && url.pathname === '/api/config-status') return send(res, 200, { supabase: !!SUPABASE_URL && !!SUPABASE_PUBLISHABLE_KEY && !!SUPABASE_SECRET_KEY, gemini: !!GEMINI_API_KEY, model: GEMINI_MODEL });
  if (req.method === 'POST' && /^\/api\/auth\/(signup|signin)$/.test(url.pathname)) {
    try { const b = await parseBody(req); if (!b.email || !b.password) return send(res, 400, { error: 'Email và mật khẩu là bắt buộc.' }); const action = url.pathname.endsWith('signup') ? 'signup' : 'token?grant_type=password'; const data = await sb(`/auth/v1/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: b.email, password: b.password }) }); return send(res, 200, { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user }); } catch(e) { return send(res, e.status || 500, { error: e.message }); }
  }
  if (req.method === 'POST' && url.pathname === '/api/characters') {
    try {
      const u = await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      const b = await parseBody(req);
      if (!b.name || !String(b.name).trim()) return send(res, 400, { error: 'Tên nhân vật là bắt buộc.' });
      const character = {
        owner_id: u.id,
        name: String(b.name).trim(),
        profile: b.profile || {},
        personality: b.personality || {},
        background: b.background || {},
        preferences: b.preferences || {},
        appearance: b.appearance || {},
        status: 'active',
        current_mood: b.current_mood || { label: 'bình yên' },
        current_activity: b.current_activity || { label: 'đang rảnh' }
      };
      const created = await sb('/rest/v1/characters', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
        body: JSON.stringify(character)
      }, true);
      return send(res, 201, { character: created?.[0] || null });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || 'Không thể tạo nhân vật.' });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/characters/generate') {
    try {
      const u = await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i, ''));
      if (!u) return send(res, 401, { error: 'Unauthorized' });
      const b = await parseBody(req);
      const existing = await sb(`/rest/v1/characters?owner_id=eq.${encodeURIComponent(u.id)}&select=id&limit=1`, { headers:{Accept:'application/json'} }, true);
      if (existing?.length) return send(res, 200, { characters: await characters(u.id), generated: false });
      const created = await generateCharacters(u.id, b.preferences || {});
      return send(res, 201, { characters: created || [], generated: true });
    } catch(e) { return send(res, e.status || 500, { error: e.message || 'Không thể tạo nhân vật bằng AI.' }); }
  }
  if (req.method === 'GET' && url.pathname === '/api/characters') { try { const u = await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i,'')); if (!u) return send(res, 401, { error:'Unauthorized' }); return send(res,200,{characters:await characters()}); } catch(e){return send(res,e.status||500,{error:e.message})} }
  if (req.method === 'POST' && url.pathname === '/api/chat/history') { try { const u=await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i,'')); if(!u)return send(res,401,{error:'Unauthorized'}); const b=await parseBody(req); return send(res,200,{messages:await history(u.id,b.character_id)}); }catch(e){return send(res,e.status||500,{error:e.message})} }
  if (req.method === 'POST' && url.pathname === '/api/chat') { try { const u=await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i,'')); if(!u)return send(res,401,{error:'Unauthorized'}); const b=await parseBody(req); if(!b.message)return send(res,400,{error:'Message is required'}); const cs=await characters(u.id); const c=cs.find(x=>x.id===b.character_id); if(!c)return send(res,404,{error:'Character not found'}); const h=await history(u.id,c.id); const context=`Character: ${c.name}. Profile: ${JSON.stringify(c.profile||{})}. Personality: ${JSON.stringify(c.personality||{})}. Current mood: ${c.current_mood||'calm'}. Current activity: ${c.current_activity||'free time'}. User message: ${b.message}`; const reply=await gemini(context,h); await saveMessage(u.id,c.id,'user',b.message); await saveMessage(u.id,c.id,'assistant',reply); return send(res,200,{reply}); }catch(e){return send(res,e.status||500,{error:e.message})} }
  if (req.method === 'GET') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(html); }
  send(res,404,{error:'Not found'});
}

http.createServer((req,res)=>route(req,res).catch(e=>send(res,500,{error:e.message||'Server error'}))).listen(PORT,'0.0.0.0',()=>console.log(`CozyDating 35.2 listening on 0.0.0.0:${PORT}`));
