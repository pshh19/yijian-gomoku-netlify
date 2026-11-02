import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { getStore } from '@netlify/blobs';

const scrypt = promisify(scryptCallback);
const accounts = getStore('yijian-accounts');
const SESSION_TTL = 30 * 24 * 60 * 60;
const GATE_TTL = 20 * 60;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
}

function secret() {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) throw new Error('Netlify 环境变量 SESSION_SECRET 尚未配置为至少 32 个字符');
  return value;
}

function signSession(userId, userKey) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, uk: userKey, exp: Math.floor(Date.now() / 1000) + SESSION_TTL })).toString('base64url');
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function cookieValue(request, name) {
  const pair = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`));
  return pair ? pair.slice(name.length + 1) : '';
}

function sessionData(request) {
  try {
    const [payload, supplied] = cookieValue(request, 'yijian_session').split('.');
    if (!payload || !supplied) return null;
    const expected = createHmac('sha256', secret()).update(payload).digest();
    const actual = Buffer.from(supplied, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed.uid === 'string' && typeof parsed.uk === 'string' && parsed.exp > Date.now() / 1000
      ? { id: parsed.uid, key: parsed.uk }
      : null;
  } catch { return null; }
}

function sessionCookie(request, userId, userKey) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `yijian_session=${signSession(userId, userKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}${secure}`;
}

function clearCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `yijian_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`;
}

function gateCookie(request) {
  const payload = Buffer.from(JSON.stringify({ typ: 'account-gate', exp: Math.floor(Date.now() / 1000) + GATE_TTL })).toString('base64url');
  const signature = createHmac('sha256', secret()).update(payload).digest('base64url');
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `yijian_gate=${payload}.${signature}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${GATE_TTL}${secure}`;
}

function hasGateAccess(request) {
  try {
    const [payload, supplied] = cookieValue(request, 'yijian_gate').split('.');
    if (!payload || !supplied) return false;
    const expected = createHmac('sha256', secret()).update(payload).digest();
    const actual = Buffer.from(supplied, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return parsed.typ === 'account-gate' && parsed.exp > Date.now() / 1000;
  } catch { return false; }
}

function sameOrigin(request) {
  const origin = request.headers.get('origin');
  if (!origin) {
    const referer = request.headers.get('referer');
    if (!referer) return false;
    try { return new URL(referer).origin === new URL(request.url).origin; }
    catch { return false; }
  }
  try { return new URL(origin).origin === new URL(request.url).origin; }
  catch { return false; }
}

async function bodyJson(request) {
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > 256_000) throw Object.assign(new Error('请求内容过大'), { status: 413 });
  try { return JSON.parse(text || '{}'); }
  catch { throw Object.assign(new Error('请求格式无效'), { status: 400 }); }
}

function validCredentials(username, password) {
  return typeof username === 'string' && typeof password === 'string' && username.length > 0 &&
    Buffer.byteLength(username, 'utf8') <= 256 && !/[\u0000-\u001f\u007f]/.test(username) &&
    password.length > 0 && Buffer.byteLength(password, 'utf8') <= 1024;
}

function validRecord(data) {
  if (!data || !['你获胜', '电脑获胜', '平局'].includes(data.result) || !Array.isArray(data.moves) || data.moves.length < 9 || data.moves.length > 225) return false;
  const board = new Uint8Array(225);
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  const winsAt = (x, y, player) => directions.some(([dx, dy]) => {
    let count = 1;
    for (const sign of [-1, 1]) {
      let cx = x + dx * sign, cy = y + dy * sign;
      while (cx >= 0 && cx < 15 && cy >= 0 && cy < 15 && board[cy * 15 + cx] === player) {
        count++;
        cx += dx * sign;
        cy += dy * sign;
      }
    }
    return count >= 5;
  });
  for (let i = 0; i < data.moves.length; i++) {
    const move = data.moves[i];
    if (!move || !Number.isInteger(move.x) || move.x < 0 || move.x >= 15 || !Number.isInteger(move.y) || move.y < 0 || move.y >= 15) return false;
    const player = i % 2 === 0 ? 1 : 2;
    if (move.p !== player) return false;
    const cell = move.y * 15 + move.x;
    if (board[cell]) return false;
    board[cell] = player;
    if (winsAt(move.x, move.y, player)) {
      if (i !== data.moves.length - 1) return false;
      return data.result === (player === 1 ? '你获胜' : '电脑获胜');
    }
  }
  return data.moves.length === 225 && data.result === '平局';
}

async function currentUser(request) {
  const session = sessionData(request);
  if (!session) return null;
  const user = await accounts.get(session.key, { consistency: 'strong', type: 'json' });
  return user && user.id === session.id ? { ...user, key: session.key } : null;
}

export default async function handler(request, context) {
  try {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (method !== 'GET' && !sameOrigin(request)) return json({ error: '跨站请求已拒绝' }, 403);

    if (method === 'GET' && url.pathname === '/api/me') {
      const user = await currentUser(request);
      return json({ user: user ? { username: user.username } : null });
    }

    if (method === 'POST' && url.pathname === '/api/authorize') {
      try { secret(); }
      catch { return json({ error: '网站尚未完成会话配置，请联系站点管理员' }, 503); }
      const expectedPassword = process.env.ACCOUNT_GATE_PASSWORD;
      if (!expectedPassword) return json({ error: '网站尚未配置账号授权码，请联系站点管理员' }, 503);
      const data = await bodyJson(request);
      if (typeof data.password !== 'string') return json({ error: '请输入授权码' }, 400);
      const expected = Buffer.from(expectedPassword, 'utf8');
      const supplied = Buffer.from(data.password, 'utf8');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json({ error: '授权码不正确' }, 401);
      const user = await currentUser(request);
      return json({ authorized: true, user: user ? { username: user.username } : null }, 200, { 'Set-Cookie': gateCookie(request) });
    }

    if (method === 'POST' && (url.pathname === '/api/register' || url.pathname === '/api/login')) {
      if (!hasGateAccess(request)) return json({ error: '请先通过授权码验证' }, 403);
      const isRegister = url.pathname === '/api/register';
      try { secret(); }
      catch { return json({ error: '网站尚未完成会话配置，请联系站点管理员设置 SESSION_SECRET' }, 503); }
      const data = await bodyJson(request);
      if (!validCredentials(data.username, data.password)) return json({ error: '账号不能为空或过长；密码不能为空或超过 1024 字节' }, 400);
      const userKey = `users/${createHash('sha256').update(data.username, 'utf8').digest('hex')}`;
      const existing = await accounts.get(userKey, { consistency: 'strong', type: 'json' });
      if (isRegister) {
        if (existing) return json({ error: '该账号已注册，请登录或换一个账号' }, 409);
        const salt = randomBytes(16);
        const hash = await scrypt(data.password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
        const id = randomUUID();
        const created = await accounts.setJSON(userKey, {
          id,
          username: data.username,
          password_salt: salt.toString('hex'),
          password_hash: hash.toString('hex'),
          createdAt: new Date().toISOString(),
          records: [],
        }, { onlyIfNew: true });
        if (!created.modified) return json({ error: '该账号已注册，请登录或换一个账号' }, 409);
        return json({ user: { username: data.username } }, 201, { 'Set-Cookie': sessionCookie(request, id, userKey) });
      }
      const user = existing;
      if (!user) return json({ error: '账号或密码不正确' }, 401);
      const candidate = await scrypt(data.password, Buffer.from(user.password_salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const stored = Buffer.from(user.password_hash, 'hex');
      if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return json({ error: '账号或密码不正确' }, 401);
      return json({ user: { username: user.username } }, 200, { 'Set-Cookie': sessionCookie(request, user.id, userKey) });
    }

    if (method === 'POST' && url.pathname === '/api/logout') return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(request) });

    if (url.pathname === '/api/history' && method === 'GET') {
      const user = await currentUser(request);
      if (!user) return json({ error: '请先登录' }, 401);
      return json({ records: (user.records || []).map(r => ({ id: r.id, clientId: r.clientId || null, result: r.result, moves: r.moves, createdAt: r.createdAt })) });
    }

    if (url.pathname === '/api/history' && method === 'POST') {
      const user = await currentUser(request);
      if (!user) return json({ error: '请先登录' }, 401);
      const data = await bodyJson(request);
      if (!validRecord(data)) return json({ error: '棋谱数据无效' }, 400);
      const id = randomUUID();
      const clientId = typeof data.clientId === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(data.clientId) ? data.clientId : null;
      const moves = data.moves.map(m => ({ x: m.x, y: m.y, p: m.p }));
      const record = { id, clientId, result: data.result, moves, createdAt: new Date().toISOString() };
      for (let attempt = 0; attempt < 8; attempt++) {
        const latest = await accounts.getWithMetadata(user.key, { consistency: 'strong', type: 'json' });
        if (!latest?.data || latest.data.id !== user.id) return json({ error: '账号记录不存在，请重新登录' }, 401);
        const updated = { ...latest.data, records: [record, ...(latest.data.records || [])] };
        const saved = await accounts.setJSON(user.key, updated, { onlyIfMatch: latest.etag });
        if (saved.modified) return json({ record: { ...record, date: record.createdAt } }, 201);
      }
      return json({ error: '棋谱保存冲突，请稍后重试' }, 409);
    }

    return json({ error: '未找到接口' }, 404);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return json({ error: status === 500 ? '服务器暂时无法处理请求' : error.message }, status);
  }
}

export const config = { path: '/api/*' };

