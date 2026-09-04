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

async function characters() {
  try {
    const rows = await sb('/rest/v1/characters?select=id,name,profile,personality,appearance,current_mood,current_activity,status&status=eq.active&limit=20', { headers: { Accept: 'application/json' } }, true);
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

const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');


async function route(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname).replace(/\/+$/, '') || '/';
  console.log(`[request] ${req.method} ${pathname}`);

  // Keep diagnostics before all other API routes. These endpoints do not expose secrets.
  if (req.method === 'GET' && (pathname === '/api/health' || pathname === '/health')) {
    return send(res, 200, { ok: true, service: 'cozy-dating', version: '34.1.0', path: pathname });
  }
  if (req.method === 'GET' && pathname === '/api/config-status') {
    return send(res, 200, {
      ok: true,
      supabase: !!SUPABASE_URL && !!SUPABASE_PUBLISHABLE_KEY && !!SUPABASE_SECRET_KEY,
      gemini: !!GEMINI_API_KEY,
      model: GEMINI_MODEL,
      node: process.version
    });
  }
  if (req.method === 'GET' && pathname === '/api/debug') {
    return send(res, 200, { ok: true, method: req.method, pathname, host: req.headers.host || null });
  }
  if (req.method === 'POST' && /^\/api\/auth\/(signup|signin)$/.test(pathname)) {
    try { const b = await parseBody(req); if (!b.email || !b.password) return send(res, 400, { error: 'Email và mật khẩu là bắt buộc.' }); const action = pathname.endsWith('signup') ? 'signup' : 'token?grant_type=password'; const data = await sb(`/auth/v1/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: b.email, password: b.password }) }); return send(res, 200, { access_token: data.access_token, refresh_token: data.refresh_token, user: data.user }); } catch(e) { return send(res, e.status || 500, { error: e.message }); }
  }
  if (req.method === 'POST' && pathname === '/api/characters') {
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
  if (req.method === 'GET' && pathname === '/api/characters') { try { const u = await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i,'')); if (!u) return send(res, 401, { error:'Unauthorized' }); return send(res,200,{characters:await characters()}); } catch(e){return send(res,e.status||500,{error:e.message})} }
  if (req.method === 'POST' && pathname === '/api/chat/history') { try { const u=await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i,'')); if(!u)return send(res,401,{error:'Unauthorized'}); const b=await parseBody(req); return send(res,200,{messages:await history(u.id,b.character_id)}); }catch(e){return send(res,e.status||500,{error:e.message})} }
  if (req.method === 'POST' && pathname === '/api/chat') { try { const u=await currentUser(req.headers.authorization?.replace(/^Bearer\s+/i,'')); if(!u)return send(res,401,{error:'Unauthorized'}); const b=await parseBody(req); if(!b.message)return send(res,400,{error:'Message is required'}); const cs=await characters(); const c=cs.find(x=>x.id===b.character_id); if(!c)return send(res,404,{error:'Character not found'}); const h=await history(u.id,c.id); const context=`Character: ${c.name}. Profile: ${JSON.stringify(c.profile||{})}. Personality: ${JSON.stringify(c.personality||{})}. Current mood: ${c.current_mood||'calm'}. Current activity: ${c.current_activity||'free time'}. User message: ${b.message}`; const reply=await gemini(context,h); await saveMessage(u.id,c.id,'user',b.message); await saveMessage(u.id,c.id,'assistant',reply); return send(res,200,{reply}); }catch(e){return send(res,e.status||500,{error:e.message})} }
  if (req.method === 'GET') { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); return res.end(html); }
  if (pathname.startsWith('/api')) return send(res,404,{error:'API route not found', method:req.method, path:pathname});
  send(res,404,{error:'Not found'});
}

http.createServer((req,res)=>route(req,res).catch(e=>{
  console.error('[request-error]', e);
  if (!res.headersSent) send(res,500,{error:e.message||'Server error'});
  else res.end();
})).listen(PORT,'0.0.0.0',()=>console.log(`CozyDating 34.1 listening on 0.0.0.0:${PORT}`));
