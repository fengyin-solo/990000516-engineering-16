#!/usr/bin/env node
/**
 * Data-ownership security check suite (local, repeatable).
 *
 * Stages:
 *   1. Dependency check (Node version, backend packages)
 *   2. Start an isolated API server (random free port + temp SQLite DB)
 *   3. Prepare fixtures (two users with boards/columns/cards)
 *   4. Auth boundary checks (no login / no token / expired / forged token)
 *   5. Cross-account read protection
 *   6. Cross-account write protection (move card, delete board, ...)
 *   7. Normal-user compatibility (happy path must keep working)
 *   8. Cleanup (temp server stopped, temp DB deleted — no residue)
 *
 * Exit code 0 = all checks passed, 1 = a stage or check failed.
 * The developer database (backend/data/taskboard.db) is never touched.
 */

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const BACKEND_DIR = path.join(__dirname, '..');
const REQUIRED_PACKAGES = ['express', 'better-sqlite3', 'jsonwebtoken', 'bcryptjs', 'cors'];

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------
let stageNo = 0;
let currentStage = 0;
const results = []; // { stage, name, ok, error }

function stage(title) {
  stageNo += 1;
  currentStage = stageNo;
  console.log(`\n[阶段 ${stageNo}] ${title}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    results.push({ stage: currentStage, name, ok: true });
    console.log(`  ✓ ${name}${detail ? `（${detail}）` : ''}`);
  } catch (err) {
    results.push({ stage: currentStage, name, ok: false, error: err.message });
    console.log(`  ✗ ${name}`);
    console.log(`      ${err.message}`);
  }
}

function failStage(err, hint) {
  console.log(`  ✗ [阶段 ${currentStage}] 失败：${err.message}`);
  if (hint) console.log(`      排查建议：${hint}`);
}

// ---------------------------------------------------------------------------
// HTTP + assertion helpers
// ---------------------------------------------------------------------------
let BASE_URL = '';

async function api(method, apiPath, { token, body, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

function expectStatus(res, expected, what) {
  if (res.status !== expected) {
    throw new Error(`${what}：期望 HTTP ${expected}，实际 HTTP ${res.status}，响应 ${JSON.stringify(res.data)}`);
  }
}

// ---------------------------------------------------------------------------
// Isolated server lifecycle
// ---------------------------------------------------------------------------
let child = null;
let tmpDir = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port, getStderr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`服务进程提前退出（code ${child.exitCode}）：\n${getStderr()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`等待服务就绪超时（${timeoutMs}ms）。服务输出：\n${getStderr()}`);
}

async function cleanup() {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 300));
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    console.log(`  临时数据目录已删除：${tmpDir}`);
  }
}

process.on('SIGINT', () => { if (child) child.kill('SIGTERM'); process.exit(1); });
process.on('SIGTERM', () => { if (child) child.kill('SIGTERM'); process.exit(1); });

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('数据归属安全检查（本地可重复执行）');
  console.log('='.repeat(46));

  // --- Stage 1: dependencies -------------------------------------------------
  stage('依赖检查');
  try {
    const major = Number(process.versions.node.split('.')[0]);
    if (major < 18) {
      throw new Error(`需要 Node.js >= 18（内置 fetch），当前 ${process.version}`);
    }
    console.log(`  ✓ Node.js ${process.version}`);
    for (const pkg of REQUIRED_PACKAGES) {
      require.resolve(pkg, { paths: [BACKEND_DIR] });
    }
    console.log(`  ✓ 后端依赖已安装（${REQUIRED_PACKAGES.join(', ')}）`);
  } catch (err) {
    failStage(err, '请先执行：cd backend && npm install');
    process.exit(1);
  }

  // Lazy requires — only safe after the dependency check passed.
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware/auth');

  // --- Stage 2: isolated server ---------------------------------------------
  stage('启动隔离测试服务器（随机端口 + 临时数据库）');
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskboard-sec-check-'));
    const dbPath = path.join(tmpDir, 'check.db');
    const port = await getFreePort();
    let stderr = '';
    child = spawn(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
      cwd: BACKEND_DIR,
      env: { ...process.env, PORT: String(port), TASKBOARD_DB_PATH: dbPath },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr.on('data', d => { stderr += d; });
    await waitForHealth(port, () => stderr);
    BASE_URL = `http://127.0.0.1:${port}`;
    console.log(`  ✓ 测试服务器已就绪：${BASE_URL}（临时库 ${dbPath}）`);
    console.log('  ✓ 开发数据库 backend/data/taskboard.db 不受影响');
  } catch (err) {
    failStage(err, '确认 3002 以外的端口可用，且 better-sqlite3 原生模块正常（可尝试 npm rebuild）');
    await cleanup();
    process.exit(1);
  }

  // --- Stage 3: fixtures ------------------------------------------------------
  const fx = {};
  stage('准备测试数据（用户 A / 用户 B，各自看板、列、卡片）');
  try {
    const regA = await api('POST', '/api/auth/register', { body: { username: 'sec_user_a', password: 'pass-a-123' } });
    expectStatus(regA, 201, '注册用户 A');
    const regB = await api('POST', '/api/auth/register', { body: { username: 'sec_user_b', password: 'pass-b-123' } });
    expectStatus(regB, 201, '注册用户 B');
    fx.tokenA = regA.data.token;
    fx.tokenB = regB.data.token;
    fx.userA = regA.data.user;
    fx.userB = regB.data.user;

    const boardA = await api('POST', '/api/boards', { token: fx.tokenA, body: { name: 'A 的看板' } });
    expectStatus(boardA, 201, 'A 创建看板');
    fx.boardA = boardA.data;
    const boardB = await api('POST', '/api/boards', { token: fx.tokenB, body: { name: 'B 的看板' } });
    expectStatus(boardB, 201, 'B 创建看板');
    fx.boardB = boardB.data;

    const colsA = await api('GET', `/api/boards/${fx.boardA.id}/columns`, { token: fx.tokenA });
    expectStatus(colsA, 200, '读取 A 的列');
    fx.colA1 = colsA.data[0];
    fx.colA2 = colsA.data[1];
    const colsB = await api('GET', `/api/boards/${fx.boardB.id}/columns`, { token: fx.tokenB });
    expectStatus(colsB, 200, '读取 B 的列');
    fx.colB1 = colsB.data[0];

    const cardA = await api('POST', `/api/columns/${fx.colA1.id}/cards`, { token: fx.tokenA, body: { title: 'A 的卡片' } });
    expectStatus(cardA, 201, 'A 创建卡片');
    fx.cardA1 = cardA.data;
    const cardB = await api('POST', `/api/columns/${fx.colB1.id}/cards`, { token: fx.tokenB, body: { title: 'B 的卡片' } });
    expectStatus(cardB, 201, 'B 创建卡片');
    fx.cardB1 = cardB.data;

    console.log(`  ✓ 测试数据就绪（A: user=${fx.userA.id} board=${fx.boardA.id}，B: user=${fx.userB.id} board=${fx.boardB.id}）`);
  } catch (err) {
    failStage(err, '检查注册/看板/列/卡片接口是否正常');
    await cleanup();
    process.exit(1);
  }

  // --- Stage 4: auth boundary -------------------------------------------------
  stage('认证边界（未登录 / 无令牌 / 过期令牌 / 伪造令牌）');

  await check('未登录（无 Authorization 头）访问受保护接口 → 401', async () => {
    const res = await api('GET', '/api/boards');
    expectStatus(res, 401, '未登录访问');
    return `HTTP ${res.status}`;
  });

  await check('空令牌（Authorization: Bearer 无内容）→ 401', async () => {
    const res = await api('GET', '/api/boards', { headers: { Authorization: 'Bearer' } });
    expectStatus(res, 401, '空令牌');
    return `HTTP ${res.status}`;
  });

  await check('非 Bearer 方案（Authorization: Token xxx）→ 401', async () => {
    const res = await api('GET', '/api/boards', { headers: { Authorization: 'Token abc123' } });
    expectStatus(res, 401, '错误认证方案');
    return `HTTP ${res.status}`;
  });

  await check('过期令牌 → 401', async () => {
    const expired = jwt.sign(
      { id: fx.userA.id, username: fx.userA.username, exp: Math.floor(Date.now() / 1000) - 3600 },
      JWT_SECRET
    );
    const res = await api('GET', '/api/boards', { token: expired });
    expectStatus(res, 401, '过期令牌');
    return `HTTP ${res.status}`;
  });

  await check('伪造签名令牌（错误密钥）→ 401', async () => {
    const forged = jwt.sign({ id: fx.userA.id, username: fx.userA.username }, 'forged-secret');
    const res = await api('GET', '/api/boards', { token: forged });
    expectStatus(res, 401, '伪造令牌');
    return `HTTP ${res.status}`;
  });

  // --- Stage 5: cross-account reads -------------------------------------------
  stage('跨账号读取防护');

  await check('B 的看板列表不包含 A 的看板', async () => {
    const res = await api('GET', '/api/boards', { token: fx.tokenB });
    expectStatus(res, 200, 'B 读取看板列表');
    if (res.data.some(b => b.id === fx.boardA.id)) {
      throw new Error(`B 的看板列表泄露了 A 的看板（id=${fx.boardA.id}）`);
    }
    return `列表 ${res.data.length} 项，无越权数据`;
  });

  await check('B 读取 A 看板的列 → 404', async () => {
    const res = await api('GET', `/api/boards/${fx.boardA.id}/columns`, { token: fx.tokenB });
    expectStatus(res, 404, 'B 读取 A 的列');
    return `HTTP ${res.status}`;
  });

  await check('B 读取 A 列中的卡片 → 404', async () => {
    const res = await api('GET', `/api/columns/${fx.colA1.id}/cards`, { token: fx.tokenB });
    expectStatus(res, 404, 'B 读取 A 的卡片');
    return `HTTP ${res.status}`;
  });

  // --- Stage 6: cross-account writes ------------------------------------------
  stage('跨账号写入防护（移动卡片到他人列 / 删除他人看板等）');

  await check('B 将自己的卡片移动到 A 的列 → 404，且卡片仍在原列', async () => {
    const move = await api('PUT', `/api/cards/${fx.cardB1.id}/move`, {
      token: fx.tokenB,
      body: { columnId: fx.colA1.id, position: 0 },
    });
    expectStatus(move, 404, 'B 移动卡片到 A 的列');
    const cards = await api('GET', `/api/columns/${fx.colB1.id}/cards`, { token: fx.tokenB });
    expectStatus(cards, 200, '复查 B 的列');
    if (!cards.data.some(c => c.id === fx.cardB1.id)) {
      throw new Error('越权移动被拒绝后，B 的卡片不在原列中');
    }
    return `HTTP ${move.status}，卡片未移动`;
  });

  await check('A 将自己的卡片移动到 B 的列 → 404', async () => {
    const res = await api('PUT', `/api/cards/${fx.cardA1.id}/move`, {
      token: fx.tokenA,
      body: { columnId: fx.colB1.id, position: 0 },
    });
    expectStatus(res, 404, 'A 移动卡片到 B 的列');
    return `HTTP ${res.status}`;
  });

  await check('B 在 A 的看板中创建列 → 404', async () => {
    const res = await api('POST', `/api/boards/${fx.boardA.id}/columns`, {
      token: fx.tokenB,
      body: { name: '越权列' },
    });
    expectStatus(res, 404, 'B 在 A 的看板建列');
    return `HTTP ${res.status}`;
  });

  await check('B 删除 A 的看板 → 404，且看板仍存在', async () => {
    const del = await api('DELETE', `/api/boards/${fx.boardA.id}`, { token: fx.tokenB });
    expectStatus(del, 404, 'B 删除 A 的看板');
    const boards = await api('GET', '/api/boards', { token: fx.tokenA });
    expectStatus(boards, 200, '复查 A 的看板列表');
    if (!boards.data.some(b => b.id === fx.boardA.id)) {
      throw new Error('越权删除被拒绝后，A 的看板不存在了');
    }
    return `HTTP ${del.status}，看板未受影响`;
  });

  await check('B 删除 A 的卡片 → 404', async () => {
    const res = await api('DELETE', `/api/cards/${fx.cardA1.id}`, { token: fx.tokenB });
    expectStatus(res, 404, 'B 删除 A 的卡片');
    return `HTTP ${res.status}`;
  });

  // --- Stage 7: normal-user compatibility --------------------------------------
  stage('正常用户操作兼容性（防回归）');

  await check('健康检查无需令牌 → 200', async () => {
    const res = await api('GET', '/api/health');
    expectStatus(res, 200, '健康检查');
    return `HTTP ${res.status}`;
  });

  await check('A 正常登录 → 200 并返回令牌', async () => {
    const res = await api('POST', '/api/auth/login', { body: { username: 'sec_user_a', password: 'pass-a-123' } });
    expectStatus(res, 200, 'A 登录');
    if (!res.data.token) throw new Error('登录响应缺少 token');
    return `HTTP ${res.status}`;
  });

  await check('A 创建看板 → 201，且自动生成 3 个默认列', async () => {
    const board = await api('POST', '/api/boards', { token: fx.tokenA, body: { name: 'A 的临时看板' } });
    expectStatus(board, 201, 'A 创建看板');
    fx.boardATmp = board.data;
    const cols = await api('GET', `/api/boards/${fx.boardATmp.id}/columns`, { token: fx.tokenA });
    expectStatus(cols, 200, '读取新看板的列');
    if (cols.data.length !== 3) {
      throw new Error(`新看板应有 3 个默认列，实际 ${cols.data.length}`);
    }
    fx.colATmp1 = cols.data[0];
    fx.colATmp2 = cols.data[1];
    return `HTTP ${board.status}，默认列 ${cols.data.length} 个`;
  });

  await check('A 创建卡片并在自己的两列间移动 → 200/201', async () => {
    const card = await api('POST', `/api/columns/${fx.colATmp1.id}/cards`, { token: fx.tokenA, body: { title: '临时卡片' } });
    expectStatus(card, 201, 'A 创建卡片');
    const move = await api('PUT', `/api/cards/${card.data.id}/move`, {
      token: fx.tokenA,
      body: { columnId: fx.colATmp2.id, position: 0 },
    });
    expectStatus(move, 200, 'A 在自己看板内移动卡片');
    if (move.data.column_id !== fx.colATmp2.id) {
      throw new Error(`移动后 column_id 应为 ${fx.colATmp2.id}，实际 ${move.data.column_id}`);
    }
    return `HTTP ${move.status}，column_id=${move.data.column_id}`;
  });

  await check('A 删除自己的看板 → 200，且列表中消失', async () => {
    const del = await api('DELETE', `/api/boards/${fx.boardATmp.id}`, { token: fx.tokenA });
    expectStatus(del, 200, 'A 删除自己的看板');
    const boards = await api('GET', '/api/boards', { token: fx.tokenA });
    expectStatus(boards, 200, '复查 A 的看板列表');
    if (boards.data.some(b => b.id === fx.boardATmp.id)) {
      throw new Error('看板删除后仍出现在列表中');
    }
    return `HTTP ${del.status}`;
  });

  // --- Stage 8: cleanup ---------------------------------------------------------
  stage('清理临时数据');
  await cleanup();

  // --- Summary --------------------------------------------------------------------
  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(46));
  if (failed.length === 0) {
    console.log(`结果：全部通过（${results.length}/${results.length}），重复执行无残留数据`);
  } else {
    console.log(`结果：${results.length - failed.length}/${results.length} 通过，${failed.length} 项失败`);
    for (const f of failed) {
      console.log(`  ✗ [阶段 ${f.stage}] ${f.name}：${f.error}`);
    }
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch(async err => {
  console.error(`\n✗ 检查脚本自身异常：${err.stack || err}`);
  await cleanup();
  process.exit(1);
});
