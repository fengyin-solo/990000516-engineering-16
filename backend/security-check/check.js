#!/usr/bin/env node
/**
 * 数据归属安全 —— 可重复的本地开发检查环境
 *
 * 覆盖场景：
 *   S1 未登录（无 Authorization 头）
 *   S2 无有效令牌（Bearer 空串 / 乱码 / 非 Bearer 头）
 *   S3 过期令牌（由本服务 JWT_SECRET 签发的已过期 token）
 *   S4 跨账号读取（读他人看板的列、列内卡片）
 *   S5 移动卡片到他人列
 *   S6 删除他人看板
 * 另含「正常用户操作」回归，保证接口路径、错误状态码和正常流程不被破坏。
 *
 * 隔离与可重复性：
 *   - 每次运行在 os.tmpdir() 下创建唯一目录，DB_PATH 指向其中的全新 SQLite 文件，
 *     绝不触碰 backend/data/taskboard.db（开发/种子数据）。
 *   - 服务监听随机端口（PORT=0）。
 *   - 结束（无论成功/失败/Ctrl-C）都会关闭服务并递归删除临时目录，
 *     重复执行不创建残留数据。调试可用 --keep-db 保留现场。
 *
 * 用法：
 *   node security-check/check.js            # 在任意工作目录均可运行（脚本自行定位后端路径）
 *   node security-check/check.js --keep-db  # 失败时保留临时数据库以便排查
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_DIR = path.join(__dirname, '..');

// ---- 隔离环境变量：必须在 require 任何后端模块（server.js -> db/init.js）之前设置 ----
// 否则 db/init.js 会在模块加载时把默认开发库路径固定下来，且 require 缓存使其不再生效。
const keepDbFlag = process.argv.includes('--keep-db');
const TMP_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'taskboard-sec-check-'));
const SEC_DB_PATH = path.join(TMP_DIR, 'taskboard.security.db');

// 硬性安全闸：检查用数据库必须位于系统临时目录，且绝不允许指向仓库内的开发数据库。
const devDbPath = path.resolve(path.join(BACKEND_DIR, 'data', 'taskboard.db'));
if (path.resolve(SEC_DB_PATH) === devDbPath ||
    !path.resolve(TMP_DIR).startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) {
  console.error('安全闸失败：检查数据库路径不在临时目录，拒绝启动以防污染开发数据。');
  process.exit(2);
}

process.env.DB_PATH = SEC_DB_PATH;
process.env.PORT = '0';

// 任何退出路径（含依赖阶段崩溃/Ctrl-C）都尽力清理临时目录
function cleanupTmp() {
  if (!keepDbFlag) {
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* 忽略清理错误 */ }
  }
}
process.on('exit', cleanupTmp);
process.on('SIGINT', () => {
  console.log('\n收到中断信号，正在清理临时环境…');
  cleanupTmp();
  process.exit(130);
});
process.on('SIGTERM', () => { cleanupTmp(); process.exit(143); });
process.on('uncaughtException', (err) => {
  console.error('未捕获异常：', err);
  cleanupTmp();
  process.exit(1);
});

// ---- 输出工具 -------------------------------------------------------------

const useColor = process.stdout.isColorEnabled
  ? process.stdout.isColorEnabled()
  : (process.env.FORCE_COLOR || (!process.env.NO_COLOR && process.stdout.isTTY));

const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = (s) => c('1', s);
const red = (s) => c('31', s);
const green = (s) => c('32', s);
const yellow = (s) => c('33', s);
const cyan = (s) => c('36', s);

let passed = 0;
let failed = 0;
const failures = [];

function stageHeader(n, title) {
  console.log(`\n${bold(cyan(`━━ 阶段 ${n}：${title} ━━`))}`);
}

function section(title) {
  console.log(`\n${bold(title)}`);
}

/**
 * 断言一个检查点。
 * @param {string} id       场景/检查点编号，例如 S1.1
 * @param {boolean} cond
 * @param {string} desc     描述
 * @param {string} [detail] 失败时的具体信息（实际值等）
 */
function check(id, cond, desc, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ${green('✓')} ${id}  ${desc}`);
  } else {
    failed += 1;
    failures.push({ id, desc, detail });
    console.log(`  ${red('✗')} ${id}  ${desc}`);
    if (detail) console.log(`      ${red('实际：')}${detail}`);
  }
}

function fatal(stage, err) {
  console.log(`\n${red(bold(`✗ 在阶段「${stage}」中止：`))}${err && err.message ? err.message : err}`);
  if (err && err.stack && process.env.DEBUG) console.log(err.stack);
  process.exitCode = 2;
  if (err && typeof err === 'object') err.__reported = true;
  throw err;
}

// ---- 阶段 1：环境与依赖检查 -----------------------------------------------

function loadDependencies() {
  const stage = '1 环境与依赖检查';
  stageHeader(1, '环境与依赖检查');

  const major = Number(process.versions.node.split('.')[0]);
  check('E1', major >= 18, `Node.js 版本 >= 18（当前 ${process.versions.node}）`);
  if (major < 18) {
    fatal(stage, new Error('需要 Node.js 18 或更高版本（脚本使用全局 fetch）。'));
  }

  const required = [
    ['express', 'Web 框架'],
    ['better-sqlite3', 'SQLite 驱动（原生模块）'],
    ['jsonwebtoken', 'JWT 签发/校验'],
    ['bcryptjs', '密码哈希']
  ];

  const loaded = {};
  for (const [pkg, purpose] of required) {
    try {
      loaded[pkg] = require(pkg);
      check(`E2-${pkg}`, true, `${pkg} 已安装（${purpose}）`);
    } catch (err) {
      check(`E2-${pkg}`, false, `${pkg} 已安装（${purpose}）`);
      fatal(
        stage,
        new Error(
          `缺少依赖「${pkg}」（${purpose}）。\n` +
          `      请在该阶段修复：cd ${BACKEND_DIR} && npm install\n` +
          `      原始错误：${err.message}`
        )
      );
    }
  }

  // 应用自身模块（路径/语法问题会在这一阶段暴露）
  let serverMod;
  let authMod;
  try {
    serverMod = require(path.join(BACKEND_DIR, 'server.js'));
    authMod = require(path.join(BACKEND_DIR, 'middleware/auth.js'));
    check('E3', true, '应用模块（server.js、middleware/auth.js）可正常加载');
  } catch (err) {
    check('E3', false, '应用模块（server.js、middleware/auth.js）可正常加载');
    fatal(stage, new Error(`应用模块加载失败：${err.message}`));
  }

  if (typeof serverMod.start !== 'function') {
    fatal(stage, new Error('server.js 未导出 start()，请确认改动已保存。'));
  }

  return { serverMod, jwt: loaded.jsonwebtoken, JWT_SECRET: authMod.JWT_SECRET };
}

// ---- 数据库文件快照（用于断言开发库未被写入） ------------------------------

function snapshotDbFiles(dbFile) {
  const snap = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbFile + suffix;
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      snap[p] = `${st.size}:${st.mtimeMs}`;
    }
  }
  return snap;
}

function sameSnapshot(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

// 响应体应为数组时的防御性取值（异常形状不会让检查脚本自己崩溃）
function asArray(x) {
  return Array.isArray(x) ? x : [];
}

// ---- HTTP 辅助 ------------------------------------------------------------

function makeRequest(baseUrl) {
  /**
 * @param {string} method
 * @param {string} urlPath
 * @param {object} [opts]
 * @param {object} [opts.body]
 * @param {'none'|'token'|'raw'|'expired'} [opts.auth='none']
 *        none=不带 Authorization；token=Bearer <jwt>；raw=使用 rawToken 原样发送
 * @param {string} [opts.token]
 * @param {string} [opts.rawToken]
 */
  return async function request(method, urlPath, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    const auth = opts.auth || 'none';
    if (auth === 'token') {
      if (!opts.token) throw new Error('auth=token 但未提供 token');
      headers.Authorization = `Bearer ${opts.token}`;
    } else if (auth === 'raw') {
      if (opts.rawToken === undefined) throw new Error('auth=raw 但未提供 rawToken');
      if (opts.rawToken !== null) headers.Authorization = opts.rawToken;
    }
    // auth === 'none' 或 'expired' 时下面按需覆盖

    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
    });

    let body = null;
    const text = await res.text();
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return { status: res.status, body };
  };
}

async function waitForServer(baseUrl, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`服务在 ${timeoutMs}ms 内未就绪（${baseUrl}/api/health）：${lastErr && lastErr.message}`);
}

// ---- 主流程 ---------------------------------------------------------------

async function main() {
  const keepDb = keepDbFlag;

  console.log(bold(cyan('数据归属安全检查（本地开发可重复环境）')));
  console.log(`时间：${new Date().toISOString()}`);
  console.log(`后端目录：${BACKEND_DIR}`);

  // 阶段 1：依赖（此时 DB_PATH 已指向隔离目录，require 应用模块是安全的）
  const { serverMod, jwt, JWT_SECRET } = loadDependencies();

  // 阶段 2：确认隔离的临时数据库
  stageHeader(2, '创建隔离的临时数据库');
  const tmpDir = TMP_DIR;
  const dbPath = SEC_DB_PATH;

  check(
    'E4',
    path.resolve(dbPath) !== devDbPath,
    '检查用数据库与开发数据库（backend/data/taskboard.db）相互独立'
  );
  check('E5', path.resolve(tmpDir).startsWith(fs.realpathSync(os.tmpdir()) + path.sep), `临时目录位于系统临时目录下：${tmpDir}`);
  console.log(`  数据库文件：${dbPath}`);

  // 记录开发数据库当前状态，稍后断言其未被写入
  const devDbBefore = snapshotDbFiles(devDbPath);

  // 阶段 3：随机端口启动真实 HTTP 服务
  stageHeader(3, '在隔离环境中启动服务（随机端口）');

  let instance;
  try {
    instance = serverMod.start(0);
  } catch (err) {
    fatal('3 启动服务', new Error(`server.start() 抛错（常见于 better-sqlite3 ABI 不匹配，请尝试 npm rebuild better-sqlite3）：${err.message}`));
  }

  await new Promise((resolve, reject) => {
    instance.server.once('listening', resolve);
    instance.server.once('error', reject);
  });

  const port = instance.server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 拆除逻辑（阶段 7）收敛为一处：任何阶段中止都必须关闭服务并清理临时目录，
  // 否则监听中的 HTTP 服务会让进程挂起。
  let tornDown = false;
  const teardown = async () => {
    if (tornDown) return;
    tornDown = true;
    stageHeader(7, '拆除检查环境');
    try {
      await instance.stop();
      check('C1', true, 'HTTP 服务已关闭，数据库连接已释放');
    } catch (err) {
      check('C1', false, 'HTTP 服务已关闭，数据库连接已释放', err.message);
    }

    if (keepDb) {
      console.log(yellow(`  --keep-db 已指定，保留临时目录：${tmpDir}`));
    } else {
      try {
        await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        const stillThere = fs.existsSync(tmpDir);
        check('C2', !stillThere, '临时数据库目录已删除（重复执行不残留数据）', stillThere ? tmpDir : undefined);
      } catch (err) {
        check('C2', false, '临时数据库目录已删除（重复执行不残留数据）', `${tmpDir}：${err.message}`);
      }
    }
  };

  try {
    await waitForServer(baseUrl);
    check('E6', true, `服务已启动并通过健康检查（${baseUrl}/api/health）`);
  } catch (err) {
    check('E6', false, '服务已启动并通过健康检查');
    await teardown();
    fatal('3 启动服务', err);
  }

  const request = makeRequest(baseUrl);

  // 阶段 4：准备测试夹具（两个互不相识的账号及各自资源）
  let fixtures;
  try {
    stageHeader(4, '准备测试夹具（两个独立账号）');

    // 未登录也能访问健康检查（放在服务就绪后复验一次）
    const health = await request('GET', '/api/health', { auth: 'none' });
    check('F0', health.status === 200, 'GET /api/health 无需登录可访问（保持公开）', `HTTP ${health.status}`);

    const stamp = `${Date.now()}`;
    const aliceName = `alice_${stamp}`;
    const bobName = `bob_${stamp}`;
    const password = 'SecCheck!2026';

    const aliceReg = await request('POST', '/api/auth/register', {
      auth: 'none', body: { username: aliceName, password }
    });
    if (aliceReg.status !== 201) {
      fatal('4 准备夹具', new Error(`注册用户 Alice 失败：HTTP ${aliceReg.status} ${JSON.stringify(aliceReg.body)}`));
    }
    const aliceToken = aliceReg.body.token;

    const bobReg = await request('POST', '/api/auth/register', {
      auth: 'none', body: { username: bobName, password }
    });
    if (bobReg.status !== 201) {
      fatal('4 准备夹具', new Error(`注册用户 Bob 失败：HTTP ${bobReg.status} ${JSON.stringify(bobReg.body)}`));
    }
    const bobToken = bobReg.body.token;
    check('F1', true, `注册两个独立账号：${aliceName}、${bobName}`);

    // Alice 登录（回归）并建看板（建板自动生成 To Do / In Progress / Done 三列）
    const bobLogin = await request('POST', '/api/auth/login', {
      auth: 'none', body: { username: bobName, password }
    });
    check('F2', bobLogin.status === 200 && !!bobLogin.body.token, '账号可正常登录并拿到 JWT（正常操作回归）',
      `HTTP ${bobLogin.status}`);

    const boardRes = await request('POST', '/api/boards', {
      auth: 'token', token: aliceToken,
      body: { name: 'Alice 私有看板', description: '归属安全检查夹具' }
    });
    if (boardRes.status !== 201) {
      fatal('4 准备夹具', new Error(`Alice 创建看板失败：HTTP ${boardRes.status} ${JSON.stringify(boardRes.body)}`));
    }
    const aliceBoardId = boardRes.body.id;

    const colsRes = await request('GET', `/api/boards/${aliceBoardId}/columns`, {
      auth: 'token', token: aliceToken
    });
    if (colsRes.status !== 200 || !Array.isArray(colsRes.body) || colsRes.body.length === 0) {
      fatal('4 准备夹具', new Error(`读取 Alice 看板列失败：HTTP ${colsRes.status} ${JSON.stringify(colsRes.body)}`));
    }
    const columns = colsRes.body;
    const aliceColumnId = columns[0].id;
    const aliceOtherColumnId = columns[1].id;

    const cardRes = await request('POST', `/api/columns/${aliceColumnId}/cards`, {
      auth: 'token', token: aliceToken,
      body: { title: 'Alice 的私有卡片', description: 'secret', priority: 'high' }
    });
    if (cardRes.status !== 201) {
      fatal('4 准备夹具', new Error(`Alice 创建卡片失败：HTTP ${cardRes.status} ${JSON.stringify(cardRes.body)}`));
    }
    const aliceCardId = cardRes.body.id;

    // Bob 自己的看板与卡片（S5 需要一个 Bob 合法拥有的目标列）
    const bobBoardRes = await request('POST', '/api/boards', {
      auth: 'token', token: bobToken, body: { name: 'Bob 私有看板' }
    });
    if (bobBoardRes.status !== 201) {
      fatal('4 准备夹具', new Error(`Bob 创建看板失败：HTTP ${bobBoardRes.status} ${JSON.stringify(bobBoardRes.body)}`));
    }
    const bobBoardId = bobBoardRes.body.id;
    const bobColsRes = await request('GET', `/api/boards/${bobBoardId}/columns`, {
      auth: 'token', token: bobToken
    });
    const bobColumnId = bobColsRes.body[0].id;

    // 一个“已不存在”的资源 ID，用于不存在目标的 404 对照
    const ghostId = aliceBoardId + 100000;

    check('F3', true, `夹具就绪：Alice 看板 #${aliceBoardId} / 列 #${aliceColumnId} / 卡片 #${aliceCardId}；Bob 看板 #${bobBoardId} / 列 #${bobColumnId}`);

    // 开发数据库未被本次检查写入（WAL 模式下主库与 -wal/-shm 一并比对）
    const devDbAfter = snapshotDbFiles(devDbPath);
    check('F4', sameSnapshot(devDbBefore, devDbAfter),
      '开发数据库（backend/data/taskboard.db）未被本次检查写入',
      JSON.stringify({ before: devDbBefore, after: devDbAfter }));

    fixtures = {
      aliceToken, bobToken,
      aliceBoardId, aliceColumnId, aliceOtherColumnId, aliceCardId,
      bobBoardId, bobColumnId, ghostId
    };
  } catch (err) {
    await teardown();
    if (process.exitCode !== 2) fatal('4 准备夹具', err);
    throw err;
  }

  const f = fixtures;

  // 阶段 5：数据归属安全场景
  try {
    stageHeader(5, '数据归属安全场景检查');

    // ---- S1 未登录 -------------------------------------------------------
    section('S1 未登录（无 Authorization 头）应一律 401');
    {
      const probes = [
        ['GET', '/api/boards', undefined],
        ['POST', '/api/boards', { name: 'x' }],
        ['DELETE', `/api/boards/${f.aliceBoardId}`, undefined],
        ['GET', `/api/boards/${f.aliceBoardId}/columns`, undefined],
        ['POST', `/api/boards/${f.aliceBoardId}/columns`, { name: 'x' }],
        ['PUT', `/api/columns/${f.aliceColumnId}`, { name: 'x' }],
        ['DELETE', `/api/columns/${f.aliceColumnId}`, undefined],
        ['GET', `/api/columns/${f.aliceColumnId}/cards`, undefined],
        ['POST', `/api/columns/${f.aliceColumnId}/cards`, { title: 'x' }],
        ['PUT', `/api/cards/${f.aliceCardId}`, { title: 'x' }],
        ['DELETE', `/api/cards/${f.aliceCardId}`, undefined],
        ['PUT', `/api/cards/${f.aliceCardId}/move`, { columnId: f.aliceOtherColumnId }]
      ];
      let idx = 0;
      for (const [method, p, body] of probes) {
        const res = await request(method, p, { auth: 'none', body });
        check(
          `S1.${++idx}`,
          res.status === 401,
          `${method} ${p.replace(/\/\d+/g, '/:id')} → 401`,
          `HTTP ${res.status} ${typeof res.body === 'object' ? JSON.stringify(res.body) : res.body}`
        );
      }
      const res = await request('GET', '/api/boards', { auth: 'none' });
      check('S1.13', res.body && res.body.error === 'Authorization token required',
        '错误信息保持契约：「Authorization token required」', JSON.stringify(res.body));
    }

    // ---- S2 无有效令牌 ---------------------------------------------------
    section('S2 无有效令牌（空 Bearer / 乱码 / 非 Bearer 头）应一律 401');
    {
      const variants = [
        ['S2.1', 'Bearer ', 'Bearer 后为空字符串'],
        ['S2.2', 'Bearer not-a-jwt', 'Bearer 乱码字符串'],
        ['S2.3', 'Basic YWxpY2U6cHc=', '非 Bearer 认证头'],
        ['S2.4', 'Bearer aaa.bbb.ccc', '结构正确但签名非法的 JWT'],
        ['S2.5', '', '空的 Authorization 头'],
        ['S2.6', 'Bearer eyJhbGciOiJub25lIn0.eyJpZCI6MX0.', 'alg=none 的伪造令牌']
      ];
      for (const [id, raw, desc] of variants) {
        const res = await request('GET', '/api/boards', { auth: 'raw', rawToken: raw });
        check(id, res.status === 401, `${desc} → 401`,
          `HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      const res = await request('GET', '/api/boards', { auth: 'raw', rawToken: 'Bearer not-a-jwt' });
      check('S2.7', res.body && res.body.error === 'Invalid or expired token',
        '错误信息保持契约：「Invalid or expired token」', JSON.stringify(res.body));
    }

    // ---- S3 过期令牌 -----------------------------------------------------
    section('S3 过期令牌应被拒绝（401）');
    {
      const expiredToken = jwt.sign({ id: 1, username: 'ghost' }, JWT_SECRET, { expiresIn: -10 });
      check('S3.0', jwt.decode(expiredToken).exp < Math.floor(Date.now() / 1000),
        '检查夹具本身确实是已过期的 JWT（exp 早于当前时间）');

      const probes = [
        ['S3.1', 'GET', '/api/boards'],
        ['S3.2', 'DELETE', `/api/boards/${f.aliceBoardId}`],
        ['S3.3', 'GET', `/api/boards/${f.aliceBoardId}/columns`],
        ['S3.4', 'PUT', `/api/cards/${f.aliceCardId}/move`]
      ];
      for (const [id, method, p] of probes) {
        const res = await request(method, p, {
          auth: 'raw',
          rawToken: `Bearer ${expiredToken}`,
          body: method === 'PUT' ? { columnId: f.aliceOtherColumnId } : undefined
        });
        check(id, res.status === 401, `${method} ${p.replace(/\/\d+/g, '/:id')} + 过期令牌 → 401`,
          `HTTP ${res.status} ${JSON.stringify(res.body)}`);
      }
      const res = await request('GET', '/api/boards', { auth: 'raw', rawToken: `Bearer ${expiredToken}` });
      check('S3.5', res.body && res.body.error === 'Invalid or expired token',
        '过期令牌错误信息保持契约', JSON.stringify(res.body));
    }

    // ---- S4 跨账号读取 ---------------------------------------------------
    section('S4 跨账号读取他人资源应返回 404 且不泄露数据');
    {
      let res = await request('GET', `/api/boards/${f.aliceBoardId}/columns`, {
        auth: 'token', token: f.bobToken
      });
      check('S4.1', res.status === 404,
        'Bob 读取 Alice 看板的列 → 404（不暴露看板归属）', `HTTP ${res.status} ${JSON.stringify(res.body)}`);
      check('S4.2', !Array.isArray(res.body), '响应不包含列数据', JSON.stringify(res.body));

      res = await request('GET', `/api/columns/${f.aliceColumnId}/cards`, {
        auth: 'token', token: f.bobToken
      });
      check('S4.3', res.status === 404,
        'Bob 读取 Alice 列内卡片 → 404', `HTTP ${res.status} ${JSON.stringify(res.body)}`);
      check('S4.4', !(res.body && JSON.stringify(res.body).includes('Alice 的私有卡片')),
        '响应中不泄露 Alice 的卡片标题/内容', JSON.stringify(res.body));

      // 对照：资源确实存在（属主可读），证明 404 来自归属校验而非 ID 无效
      res = await request('GET', `/api/boards/${f.aliceBoardId}/columns`, {
        auth: 'token', token: f.aliceToken
      });
      check('S4.5', res.status === 200 && asArray(res.body).some((col) => col.id === f.aliceColumnId),
        '对照：Alice 本人读取同一看板 → 200，资源真实存在', `HTTP ${res.status}`);

      // Bob 的看板列表中不得出现 Alice 的看板
      res = await request('GET', '/api/boards', { auth: 'token', token: f.bobToken });
      check('S4.6', res.status === 200 && !asArray(res.body).some((b) => b.id === f.aliceBoardId),
        'Bob 的看板列表不包含 Alice 的看板', `HTTP ${res.status}`);

      // 写路径同样要挡：给他人看板加列
      res = await request('POST', `/api/boards/${f.aliceBoardId}/columns`, {
        auth: 'token', token: f.bobToken, body: { name: 'Bob 偷建的列' }
      });
      check('S4.7', res.status === 404,
        'Bob 向 Alice 看板添加列 → 404', `HTTP ${res.status} ${JSON.stringify(res.body)}`);

      // 不存在的资源：属主访问也是同样的 404（避免响应差异可枚举）
      res = await request('GET', `/api/boards/${f.ghostId}/columns`, {
        auth: 'token', token: f.aliceToken
      });
      check('S4.8', res.status === 404,
        '对照：访问不存在的看板 ID 同样 404（跨账号与不存在行为一致）', `HTTP ${res.status}`);
    }

    // ---- S5 移动卡片到他人列 ---------------------------------------------
    section('S5 移动卡片到他人列应被拒绝（404），卡片原地不动');
    {
      // 移动 Alice 的卡片到 Bob 的列（Bob 发起）—— 先在卡片归属上就被挡住
      let res = await request('PUT', `/api/cards/${f.aliceCardId}/move`, {
        auth: 'token', token: f.bobToken,
        body: { columnId: f.bobColumnId, position: 0 }
      });
      check('S5.1', res.status === 404,
        'Bob 把 Alice 的卡片移到 Bob 的列 → 404', `HTTP ${res.status} ${JSON.stringify(res.body)}`);

      // Alice 把自己的卡片移到 Bob 的列（目标列不属于同板/本人）
      res = await request('PUT', `/api/cards/${f.aliceCardId}/move`, {
        auth: 'token', token: f.aliceToken,
        body: { columnId: f.bobColumnId, position: 0 }
      });
      check('S5.2', res.status === 404,
        'Alice 把自己的卡片移到 Bob 的列 → 404', `HTTP ${res.status} ${JSON.stringify(res.body)}`);

      // 目标列不存在
      res = await request('PUT', `/api/cards/${f.aliceCardId}/move`, {
        auth: 'token', token: f.aliceToken,
        body: { columnId: f.ghostId, position: 0 }
      });
      check('S5.3', res.status === 404,
        '移动到不存在的列 → 404', `HTTP ${res.status} ${JSON.stringify(res.body)}`);

      // 数据完整性：卡片仍在原列
      const cards = await request('GET', `/api/columns/${f.aliceColumnId}/cards`, {
        auth: 'token', token: f.aliceToken
      });
      check('S5.4', cards.status === 200 && asArray(cards.body).some((card) => card.id === f.aliceCardId),
        '拒绝后 Alice 的卡片仍在原列（未被移动）', `HTTP ${cards.status}`);

      const bobCards = await request('GET', `/api/columns/${f.bobColumnId}/cards`, {
        auth: 'token', token: f.bobToken
      });
      check('S5.5', !asArray(bobCards.body).some((card) => card.id === f.aliceCardId),
        'Alice 的卡片没有出现在 Bob 的列中（无越权写入）');

      // 对照：同账号同看板内移动是正常功能，必须成功
      res = await request('PUT', `/api/cards/${f.aliceCardId}/move`, {
        auth: 'token', token: f.aliceToken,
        body: { columnId: f.aliceOtherColumnId, position: 0 }
      });
      check('S5.6', res.status === 200 && res.body.column_id === f.aliceOtherColumnId,
        '对照：Alice 在自己看板内移动卡片 → 200（正常功能不受影响）', `HTTP ${res.status}`);
      // 移回原列，保持夹具稳定
      await request('PUT', `/api/cards/${f.aliceCardId}/move`, {
        auth: 'token', token: f.aliceToken,
        body: { columnId: f.aliceColumnId, position: 0 }
      });
    }

    // ---- S6 删除他人看板 -------------------------------------------------
    section('S6 删除他人看板应被拒绝（404），看板保持完好');
    {
      const res = await request('DELETE', `/api/boards/${f.aliceBoardId}`, {
        auth: 'token', token: f.bobToken
      });
      check('S6.1', res.status === 404,
        'Bob 删除 Alice 的看板 → 404', `HTTP ${res.status} ${JSON.stringify(res.body)}`);
      check('S6.2', res.body && res.body.error === 'Board not found',
        '错误信息保持契约：「Board not found」', JSON.stringify(res.body));

      // 数据完整性：看板、列、卡片都还在
      const boardCols = await request('GET', `/api/boards/${f.aliceBoardId}/columns`, {
        auth: 'token', token: f.aliceToken
      });
      check('S6.3', boardCols.status === 200 && asArray(boardCols.body).length >= 3,
        '拒绝后 Alice 看板的列依然存在（删除被拒绝）',
        `HTTP ${boardCols.status}，列数 ${Array.isArray(boardCols.body) ? boardCols.body.length : 'n/a'}`);

      const cards = await request('GET', `/api/columns/${f.aliceColumnId}/cards`, {
        auth: 'token', token: f.aliceToken
      });
      check('S6.4', asArray(cards.body).some((card) => card.id === f.aliceCardId),
        '拒绝后看板内卡片依然存在（无级联破坏）');

      const aliceBoards = await request('GET', '/api/boards', { auth: 'token', token: f.aliceToken });
      check('S6.5', asArray(aliceBoards.body).some((b) => b.id === f.aliceBoardId),
        'Alice 的看板列表中该看板依然存在');

      const bobBoards = await request('GET', '/api/boards', { auth: 'token', token: f.bobToken });
      check('S6.6', !asArray(bobBoards.body).some((b) => b.id === f.aliceBoardId),
        'Bob 的看板列表中从未出现 Alice 的看板');
    }

    // ---- 阶段 6：正常用户操作回归 -----------------------------------------
    stageHeader(6, '正常用户操作与既有错误状态回归');

    section('R1 认证与校验类状态码保持不变');
    {
      let res = await request('POST', '/api/auth/login', {
        auth: 'none', body: { username: 'nobody', password: 'wrong' }
      });
      check('R1.1', res.status === 401, '错误密码/未知用户登录 → 401', `HTTP ${res.status}`);

      res = await request('POST', '/api/auth/register', {
        auth: 'none', body: { username: 'x', password: 'p' }
      });
      check('R1.2', res.status === 400, '注册不满足长度要求 → 400', `HTTP ${res.status}`);

      res = await request('POST', '/api/auth/register', {
        auth: 'none', body: { username: `alice_${Date.now()}`, password: 'SecCheck!2026' }
      });
      // 用确定的已注册用户名复测 409
      res = await request('POST', '/api/auth/register', {
        auth: 'none', body: { username: 'alice_dup', password: 'SecCheck!2026' }
      });
      if (res.status === 201) {
        res = await request('POST', '/api/auth/register', {
          auth: 'none', body: { username: 'alice_dup', password: 'SecCheck!2026' }
        });
      }
      check('R1.3', res.status === 409, '重复用户名注册 → 409', `HTTP ${res.status}`);

      res = await request('POST', '/api/boards', { auth: 'token', token: f.aliceToken, body: {} });
      check('R1.4', res.status === 400, '创建看板缺少名称 → 400', `HTTP ${res.status}`);

      res = await request('PUT', `/api/cards/${f.aliceCardId}/move`, {
        auth: 'token', token: f.aliceToken, body: {}
      });
      check('R1.5', res.status === 400, '移动卡片缺少目标列 → 400', `HTTP ${res.status}`);
    }

    section('R2 资源完整生命周期（注册→建板→列→卡片→移动→删除）路径不变');
    {
      const t = `${Date.now()}`;
      const reg = await request('POST', '/api/auth/register', {
        auth: 'none', body: { username: `reg_${t}`, password: 'SecCheck!2026' }
      });
      check('R2.1', reg.status === 201 && !!reg.body.token, '注册 → 201 + JWT', `HTTP ${reg.status}`);
      const token = reg.body.token;

      const boards0 = await request('GET', '/api/boards', { auth: 'token', token });
      check('R2.2', boards0.status === 200 && Array.isArray(boards0.body), '看板列表 → 200 数组', `HTTP ${boards0.status}`);

      const board = await request('POST', '/api/boards', {
        auth: 'token', token, body: { name: '回归看板', description: 'd' }
      });
      check('R2.3', board.status === 201, '创建看板 → 201', `HTTP ${board.status}`);
      const bid = board.body.id;

      const cols = await request('GET', `/api/boards/${bid}/columns`, { auth: 'token', token });
      check('R2.4', cols.status === 200 && asArray(cols.body).length === 3,
        '新看板自动含 3 个默认列', `HTTP ${cols.status}，数量 ${Array.isArray(cols.body) ? cols.body.length : 'n/a'}`);
      const c0 = cols.body[0].id;
      const c1 = cols.body[1].id;

      const addCol = await request('POST', `/api/boards/${bid}/columns`, {
        auth: 'token', token, body: { name: '额外列' }
      });
      check('R2.5', addCol.status === 201, '新增列 → 201', `HTTP ${addCol.status}`);

      const card = await request('POST', `/api/columns/${c0}/cards`, {
        auth: 'token', token,
        body: { title: '回归卡片', description: 'desc', priority: 'low', due_date: '2026-12-31' }
      });
      check('R2.6', card.status === 201, '新增卡片 → 201', `HTTP ${card.status}`);
      const cardId = card.body.id;

      const upd = await request('PUT', `/api/cards/${cardId}`, {
        auth: 'token', token, body: { title: '回归卡片-改', priority: 'high' }
      });
      check('R2.7', upd.status === 200 && upd.body.title === '回归卡片-改' && upd.body.priority === 'high',
        '更新卡片 → 200 且内容生效', `HTTP ${upd.status}`);

      const moved = await request('PUT', `/api/cards/${cardId}/move`, {
        auth: 'token', token, body: { columnId: c1, position: 0 }
      });
      check('R2.8', moved.status === 200 && moved.body.column_id === c1,
        '同账号移动卡片 → 200 且归属列更新', `HTTP ${moved.status}`);

      const delCard = await request('DELETE', `/api/cards/${cardId}`, { auth: 'token', token });
      check('R2.9', delCard.status === 200, '删除卡片 → 200', `HTTP ${delCard.status}`);

      const rename = await request('PUT', `/api/columns/${c0}`, {
        auth: 'token', token, body: { name: 'To Do 改名' }
      });
      check('R2.10', rename.status === 200 && rename.body.name === 'To Do 改名',
        '列重命名 → 200 且生效', `HTTP ${rename.status}`);

      const delCol = await request('DELETE', `/api/columns/${c0}`, { auth: 'token', token });
      check('R2.11', delCol.status === 200, '删除列 → 200', `HTTP ${delCol.status}`);

      const delBoard = await request('DELETE', `/api/boards/${bid}`, { auth: 'token', token });
      check('R2.12', delBoard.status === 200, '属主删除自己的看板 → 200', `HTTP ${delBoard.status}`);

      const gone = await request('GET', `/api/boards/${bid}/columns`, { auth: 'token', token });
      check('R2.13', gone.status === 404, '删除后再访问该看板 → 404', `HTTP ${gone.status}`);
    }

    section('R3 其它归属写操作的越权回归（同 404 契约）');
    {
      let res = await request('PUT', `/api/columns/${f.aliceColumnId}`, {
        auth: 'token', token: f.bobToken, body: { name: '被 Bob 改名' }
      });
      check('R3.1', res.status === 404, 'Bob 重命名 Alice 的列 → 404', `HTTP ${res.status}`);

      res = await request('DELETE', `/api/columns/${f.aliceColumnId}`, {
        auth: 'token', token: f.bobToken
      });
      check('R3.2', res.status === 404, 'Bob 删除 Alice 的列 → 404', `HTTP ${res.status}`);

      res = await request('POST', `/api/columns/${f.aliceColumnId}/cards`, {
        auth: 'token', token: f.bobToken, body: { title: 'Bob 偷建卡片' }
      });
      check('R3.3', res.status === 404, 'Bob 在 Alice 的列中建卡片 → 404', `HTTP ${res.status}`);

      res = await request('PUT', `/api/cards/${f.aliceCardId}`, {
        auth: 'token', token: f.bobToken, body: { title: 'hacked' }
      });
      check('R3.4', res.status === 404, 'Bob 修改 Alice 的卡片 → 404', `HTTP ${res.status}`);

      res = await request('DELETE', `/api/cards/${f.aliceCardId}`, {
        auth: 'token', token: f.bobToken
      });
      check('R3.5', res.status === 404, 'Bob 删除 Alice 的卡片 → 404', `HTTP ${res.status}`);

      // 夹具完整性最后复验
      const cards = await request('GET', `/api/columns/${f.aliceColumnId}/cards`, {
        auth: 'token', token: f.aliceToken
      });
      check('R3.6', asArray(cards.body).some((card) => card.id === f.aliceCardId && card.title === 'Alice 的私有卡片'),
        '全部越权尝试后 Alice 的夹具数据保持原样');
    }
  } finally {
    // ---- 阶段 7：拆除环境 -------------------------------------------------
    await teardown();
  }

  // ---- 汇总 ---------------------------------------------------------------
  console.log(`\n${bold('━━ 检查结果汇总 ━━')}`);
  console.log(`  ${green(`${passed} 通过`)}，${failed ? red(`${failed} 失败`) : `${failed} 失败`}`);
  if (failures.length) {
    console.log(`\n${red(bold('失败明细：'))}`);
    for (const { id, desc, detail } of failures) {
      console.log(`  ${red('✗')} ${id} ${desc}${detail ? `\n      ${red('实际：')}${detail}` : ''}`);
    }
    console.log(`\n${yellow('提示：可用 --keep-db 保留临时数据库以便排查。')}`);
    process.exitCode = 1;
  } else {
    console.log(`  ${green(bold('全部检查通过：六个归属安全场景均被正确拦截，正常用户操作与既有错误状态保持兼容。'))}`);
  }
}

main().catch((err) => {
  if (!process.exitCode) process.exitCode = 1;
  if (!err || !err.__reported) {
    console.error(red('未预期的失败：'), err);
  }
  if (failures.length) {
    console.log(`\n${red(bold('中断前已记录的失败明细：'))}`);
    for (const { id, desc, detail } of failures) {
      console.log(`  ${red('✗')} ${id} ${desc}${detail ? `\n      ${red('实际：')}${detail}` : ''}`);
    }
  }
});
