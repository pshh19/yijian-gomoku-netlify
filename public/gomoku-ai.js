/*!
 * gomoku-ai.js — 弈间五子棋 · TOP 引擎（纯 JavaScript，零依赖，可直接放进 Web Worker）
 * ---------------------------------------------------------------------------------
 * 适用规则：15×15 棋盘，黑先手，双方连成五子或更多即胜，不使用禁手。
 * 通信格式（与现有页面完全兼容）：
 *   worker.postMessage({ board: <225 个 0/1/2 的数组，按行展开>, moves: [[x,y,棋子], ...] })
 *   引擎回传：
 *     { progress:true, depth, nodes, score, elapsed }   // 搜索过程中的进度（可多次）
 *     { x, y, score, depth, nodes, elapsed, ... }       // 最终落点
 * 可选字段：myColor（1 黑 2 白，默认按棋子数推断）、thinkMs（思考毫秒数）、level（0-3 难度）、config（覆盖默认权重）
 *
 * 算法分层（由强到弱依次尝试）：
 *   1) 开局库（空盘 / 白棋第一手）
 *   2) 立即成五 / 立即堵五点
 *   3) 带有时间、节点和候选点限制的 VCF 连续冲四搜索；找到强制线很有价值，未找到不等于证明不存在
 *   4) 迭代加深 PVS + 置换表 + 强制手延伸 + 四手静态搜索（quiescence）
 *   5) 防守层：检查对手是否有 VCF 强制胜，若有则换一个能躲开的落点
 * 评估采用增量维护的“点位威胁值”（每个空点四方向棋型 → 活四/冲四/活三/眠三…），
 * 每落一子只更新 32 个点的棋型，因此搜索速度可达每秒数十万个节点。
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) { module.exports = api; }
  var g = (typeof globalThis !== 'undefined') ? globalThis
    : (typeof self !== 'undefined') ? self
      : (typeof window !== 'undefined') ? window : null;
  if (g) { g.GomokuAI = api; }
  var inWorker = (typeof self !== 'undefined') && (typeof self.document === 'undefined') &&
    (typeof self.postMessage === 'function') && (typeof self.importScripts === 'function');
  if (inWorker) { api.attachWorker(self); }
})(function () {
  'use strict';

  /* ==================================================================================
   * 0. 常量
   * ================================================================================== */
  var N = 15, SZ = 225;
  var EMPTY = 0, BLACK = 1, WHITE = 2;

  var WIN = 100000000;      // 将杀分（越大越早将杀）
  var INF = 1000000000;
  var MATE_BOUND = WIN - 1000;

  var L_NONE = 0, L_ONE = 1, L_TWO = 2, L_OPEN2 = 3, L_THREE = 4, L_OPEN3 = 5,
    L_FOUR = 6, L_OPEN4 = 7, L_FIVE = 8;

  /* 棋型权重：既用于评估，也用于走法排序和“是不是冲四/成五”的判定。
   * 阈值安全性：4*L_OPEN3(12000) < L_FOUR(22000) < 3*L_OPEN4(480000) < L_FIVE(1e7)。 */
  var LEVEL_VAL = [0, 2, 12, 60, 320, 3000, 22000, 160000, 10000000];
  var FOUR_T = LEVEL_VAL[L_FOUR];
  var FIVE_T = LEVEL_VAL[L_FIVE];

  var EVAL_CAP = 60000;     // 单点贡献上限，防止评估被单个巨值点淹没

  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  /* ==================================================================================
   * 1. 配置
   * ================================================================================== */
  var CFG = {
    thinkMs: 6000,          // 默认思考时间（毫秒）
    maxDepth: 22,           // 迭代加深上限
    defense: 1.10,          // 对手威胁的权重（>1 表示偏防守）
    positionWeight: 3,      // 中心倾向权重
    vcfDepth: 18,           // VCF 最大深度（每层 = 我方一记冲四）
    vcfTimeRatio: 0.30,     // VCF 阶段可用时间比例
    vcfNodeCap: 400000,
    useBook: true,
    useDefense: true,
    /* —— 先手补偿（默认关闭，设为 0 时完全不改变棋力） —— */
    sharpBias: 0,           // 白方"求复杂"偏好，千分比；建议 80~300。正数=白棋主动找乱战
    whiteTimeBonus: 1,      // 白方思考时间倍数；如 1.5 表示白棋每步多想 50%
    swap2Band: 10000,       // Swap2 平衡带；低于该幅度时补两子，避免把很小的分值当成确定优势
    nodeLimits: null,       // 各深度候选宽度 [深1-2, 2-4, 4-6, 6-8, 8+]；null=用内置表
    levelThinkMs: [220, 900, 2600, 6000]
  };

  function configure(patch) {
    if (!patch) { return CFG; }
    for (var k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) { continue; }
      if (k === 'levelValues' && patch[k] && patch[k].length === 9) {
        LEVEL_VAL = patch[k].slice(0);
        FOUR_T = LEVEL_VAL[L_FOUR];
        FIVE_T = LEVEL_VAL[L_FIVE];
      } else if (k === 'levelThinkMs' && patch[k] && patch[k].length === 4) {
        CFG.levelThinkMs = patch[k].slice(0);
      } else if (k in CFG) {
        CFG[k] = patch[k];
      }
    }
    return CFG;
  }

  /* ==================================================================================
   * 2. 几何预计算
   * ================================================================================== */
  var DX = [1, 0, 1, 1], DY = [0, 1, 1, -1];
  var CX = new Int8Array(SZ), CY = new Int8Array(SZ);
  var LC = new Int16Array(SZ * 36);      // (c*4+d)*9 + (k+4) → 格子 id，-1 = 出界
  var CENT = new Int32Array(SZ);         // 中心倾向分
  var NEI = new Int16Array(SZ * 25);     // 切比雪夫距离 ≤2 的邻格
  var NEI_N = new Uint8Array(SZ);

  (function initGeometry() {
    var c, d, k, i, x0, y0, x, y, dx, dy, base, n, q, key, seen = new Int32Array(SZ);
    for (c = 0; c < SZ; c++) { CX[c] = c % N; CY[c] = (c / N) | 0; }
    for (c = 0; c < SZ; c++) {
      x0 = CX[c]; y0 = CY[c];
      CENT[c] = (14 - (Math.abs(x0 - 7) + Math.abs(y0 - 7))) * 3;
      for (d = 0; d < 4; d++) {
        dx = DX[d]; dy = DY[d];
        base = (c * 4 + d) * 9;
        for (k = -4; k <= 4; k++) {
          x = x0 + k * dx; y = y0 + k * dy;
          LC[base + k + 4] = (x >= 0 && x < N && y >= 0 && y < N) ? (y * N + x) : -1;
        }
      }
      // 邻格表（距离 ≤2，不含自身）
      n = 0; key = c * 25;
      for (dy = -2; dy <= 2; dy++) {
        for (dx = -2; dx <= 2; dx++) {
          if (dx === 0 && dy === 0) { continue; }
          x = x0 + dx; y = y0 + dy;
          if (x < 0 || x >= N || y < 0 || y >= N) { continue; }
          q = y * N + x;
          if (q === c) { continue; }
          NEI[key + n] = q; n++;
        }
      }
      NEI_N[c] = n;
      seen[c] = 0;
    }
  })();

  /* ==================================================================================
   * 3. 棋型分析（以某点落子为中心，9 格窗口 → 等级）
   * ================================================================================== */
  var TBL_B = new Uint8Array(1 << 18);   // 存 等级+1（0 表示未计算）
  var TBL_W = new Uint8Array(1 << 18);

  var OPEN3_PAT = { '011100': 1, '001110': 1, '010110': 1, '011010': 1 };

  function analyze(cv, side) {
    var s = '', i, v;
    for (i = 0; i < 9; i++) {
      v = (i === 4) ? side : ((cv >>> (i * 2)) & 3);
      s += (v === 0) ? '0' : (v === side ? '1' : '2');
    }
    // ① 成五：包含中心的连续同色 ≥5
    var l = 4, r = 4;
    while (l > 0 && s.charCodeAt(l - 1) === 49) { l--; }
    while (r < 8 && s.charCodeAt(r + 1) === 49) { r++; }
    if (r - l + 1 >= 5) { return L_FIVE; }

    var best = L_NONE, st, j, ch, ones, zeros, w;
    // ② 5 格窗口：判定冲四 / 眠三 / 二
    for (st = 0; st <= 4; st++) {
      ones = 0; zeros = 0;
      for (j = st; j < st + 5; j++) {
        ch = s.charCodeAt(j);
        if (ch === 49) { ones++; } else if (ch === 48) { zeros++; }
      }
      if (ones === 4 && zeros === 1) { if (best < L_FOUR) { best = L_FOUR; } } else
        if (ones === 3 && zeros === 2) { if (best < L_THREE) { best = L_THREE; } } else
          if (ones === 2 && zeros === 3) { if (best < L_TWO) { best = L_TWO; } } else
            if (ones === 1 && zeros === 4) { if (best < L_ONE) { best = L_ONE; } }
    }
    // ③ 6 格窗口：判定活四 / 活三 / 活二
    for (st = 0; st <= 3; st++) {
      w = s.substr(st, 6);
      if (w === '011110') { if (best < L_OPEN4) { best = L_OPEN4; } continue; }
      if (OPEN3_PAT[w]) { if (best < L_OPEN3) { best = L_OPEN3; } continue; }
      if (w.charCodeAt(0) === 48 && w.charCodeAt(5) === 48) {
        ones = 0;
        for (j = 0; j < 6; j++) { if (w.charCodeAt(j) === 49) { ones++; } }
        if (ones === 2) {
          var p1 = w.indexOf('1'), p2 = w.lastIndexOf('1');
          if (p2 - p1 <= 2 && best < L_OPEN2) { best = L_OPEN2; }
        }
      }
    }
    return best;
  }

  function levelOf(cv, side) {
    var t = side === BLACK ? TBL_B : TBL_W;
    var v = t[cv];
    if (v === 0) { v = t[cv] = analyze(cv, side) + 1; }
    return v - 1;
  }

  /* ==================================================================================
   * 4. 棋盘状态
   * ================================================================================== */
  var board = new Int8Array(SZ);
  var near = new Int16Array(SZ);         // 周围 2 格内的棋子数
  var code = new Int32Array(SZ * 4);     // 每格 4 个方向的 18 位棋型编码
  var levB = new Uint8Array(SZ * 4), levW = new Uint8Array(SZ * 4);
  var potB = new Int32Array(SZ), potW = new Int32Array(SZ);  // 点位价值（黑/白）
  var aggB = 0, aggW = 0;                // 空点价值总和（用于评估）
  var posScore = 0;                      // 中心倾向（黑正白负）
  var hash1 = 0, hash2 = 0;
  var stoneCount = 0;

  // Zobrist
  var Z1 = new Int32Array(SZ * 2), Z2 = new Int32Array(SZ * 2);
  (function initZobrist() {
    var seed = 0x6d2b79f5;
    function rnd() {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      return seed | 0;
    }
    for (var i = 0; i < Z1.length; i++) { Z1[i] = rnd(); Z2[i] = rnd(); }
  })();

  function capv(v) { return v > EVAL_CAP ? EVAL_CAP : v; }

  function buildCell(c) {
    var pb = 0, pw = 0, d, i, base, cv, q, v, lb, lw, ci;
    for (d = 0; d < 4; d++) {
      base = (c * 4 + d) * 9; cv = 0;
      for (i = 0; i < 9; i++) {
        q = LC[base + i];
        if (q < 0) { cv |= 3 << (i * 2); } else { v = board[q]; if (v) { cv |= v << (i * 2); } }
      }
      ci = c * 4 + d;
      code[ci] = cv;
      lb = levelOf(cv, BLACK); lw = levelOf(cv, WHITE);
      levB[ci] = lb; levW[ci] = lw;
      pb += LEVEL_VAL[lb]; pw += LEVEL_VAL[lw];
    }
    potB[c] = pb; potW[c] = pw;
  }

  function setPosition(boardArr, movesArr) {
    var i, c, m, n;
    for (i = 0; i < SZ; i++) { board[i] = 0; near[i] = 0; }
    stoneCount = 0;
    if (boardArr && boardArr.length >= SZ) {
      for (i = 0; i < SZ; i++) { board[i] = boardArr[i] | 0; }
    } else if (movesArr && movesArr.length) {
      for (i = 0; i < movesArr.length; i++) {
        m = movesArr[i];
        if (!m) { continue; }
        var mx = m.length ? m[0] : m.x, my = m.length ? m[1] : m.y, mp = m.length ? m[2] : m.p;
        if (mx >= 0 && mx < N && my >= 0 && my < N) { board[my * N + mx] = mp | 0; }
      }
    }
    hash1 = 0; hash2 = 0; posScore = 0;
    for (c = 0; c < SZ; c++) {
      if (!board[c]) { continue; }
      stoneCount++;
      hash1 ^= Z1[c * 2 + (board[c] - 1)];
      hash2 ^= Z2[c * 2 + (board[c] - 1)];
      posScore += (board[c] === BLACK ? 1 : -1) * CENT[c];
      n = NEI_N[c];
      for (i = 0; i < n; i++) { near[NEI[c * 25 + i]]++; }
    }
    aggB = 0; aggW = 0;
    for (c = 0; c < SZ; c++) {
      buildCell(c);
      if (!board[c]) { aggB += capv(potB[c]); aggW += capv(potW[c]); }
    }
  }

  function make(c, p) {
    var oB = potB[c], oW = potW[c];
    board[c] = p;
    aggB -= capv(oB); aggW -= capv(oW);
    potB[c] = 0; potW[c] = 0;
    hash1 ^= Z1[c * 2 + (p - 1)];
    hash2 ^= Z2[c * 2 + (p - 1)];
    posScore += (p === BLACK ? 1 : -1) * CENT[c];
    stoneCount++;

    var n = NEI_N[c], key = c * 25, i;
    for (i = 0; i < n; i++) { near[NEI[key + i]]++; }

    var d, k, base, q, ci, nc, lb, lw, pb, pw, b0, w0, b1, w1;
    for (d = 0; d < 4; d++) {
      base = (c * 4 + d) * 9;
      for (k = -4; k <= 4; k++) {
        if (k === 0) { continue; }
        q = LC[base + k + 4];
        if (q < 0 || board[q] !== 0) { continue; }
        ci = q * 4 + d;
        nc = code[ci] | (p << ((4 - k) * 2));
        code[ci] = nc;
        lb = levelOf(nc, BLACK); lw = levelOf(nc, WHITE);
        if (lb === levB[ci] && lw === levW[ci]) { continue; }
        pb = potB[q]; pw = potW[q];
        b0 = capv(pb); w0 = capv(pw);
        potB[q] = pb + LEVEL_VAL[lb] - LEVEL_VAL[levB[ci]];
        potW[q] = pw + LEVEL_VAL[lw] - LEVEL_VAL[levW[ci]];
        levB[ci] = lb; levW[ci] = lw;
        b1 = capv(potB[q]); w1 = capv(potW[q]);
        aggB += b1 - b0; aggW += w1 - w0;
      }
    }
  }

  function unmake(c, p) {
    board[c] = 0;
    hash1 ^= Z1[c * 2 + (p - 1)];
    hash2 ^= Z2[c * 2 + (p - 1)];
    posScore -= (p === BLACK ? 1 : -1) * CENT[c];
    stoneCount--;

    var n = NEI_N[c], key = c * 25, i;
    for (i = 0; i < n; i++) { near[NEI[key + i]]--; }

    var d, k, base, q, ci, nc, lb, lw, pb, pw, b0, w0, b1, w1;
    for (d = 0; d < 4; d++) {
      base = (c * 4 + d) * 9;
      for (k = -4; k <= 4; k++) {
        if (k === 0) { continue; }
        q = LC[base + k + 4];
        if (q < 0 || board[q] !== 0) { continue; }
        ci = q * 4 + d;
        nc = code[ci] & ~(3 << ((4 - k) * 2));
        code[ci] = nc;
        lb = levelOf(nc, BLACK); lw = levelOf(nc, WHITE);
        if (lb === levB[ci] && lw === levW[ci]) { continue; }
        pb = potB[q]; pw = potW[q];
        b0 = capv(pb); w0 = capv(pw);
        potB[q] = pb + LEVEL_VAL[lb] - LEVEL_VAL[levB[ci]];
        potW[q] = pw + LEVEL_VAL[lw] - LEVEL_VAL[levW[ci]];
        levB[ci] = lb; levW[ci] = lw;
        b1 = capv(potB[q]); w1 = capv(potW[q]);
        aggB += b1 - b0; aggW += w1 - w0;
      }
    }
    buildCell(c);
    aggB += capv(potB[c]); aggW += capv(potW[c]);
  }

  /* ==================================================================================
   * 5. 走法生成
   * ================================================================================== */
  var SLOTS = 80, SLOT_W = 64;
  var MB_ID = new Int32Array(SLOTS * SLOT_W);
  var MB_SC = new Int32Array(SLOTS * SLOT_W);
  var winA = new Int32Array(8), winACount = 0;
  var winB = new Int32Array(8), winBCount = 0;
  var moveCnt = 0;

  function gen(side, limit, slot) {
    var off = slot * SLOT_W;
    var pM = side === BLACK ? potB : potW;
    var pO = side === BLACK ? potW : potB;
    var cnt = 0, minIdx = limit - 1, c, pm, po, sc, i, v;
    winACount = 0; winBCount = 0;
    for (c = 0; c < SZ; c++) {
      if (board[c] !== 0 || near[c] === 0) { continue; }
      pm = pM[c]; po = pO[c];
      if (pm >= FIVE_T) { winA[0] = c; winACount = 1; moveCnt = 0; return; }
      if (po >= FIVE_T) { if (winBCount < 8) { winB[winBCount] = c; } winBCount++; }
      sc = (pm + (((po * 9) / 10) | 0)) | 0;
      if (cnt < limit) {
        i = cnt++;
        while (i > 0 && MB_SC[off + i - 1] < sc) {
          MB_SC[off + i] = MB_SC[off + i - 1]; MB_ID[off + i] = MB_ID[off + i - 1]; i--;
        }
        MB_SC[off + i] = sc; MB_ID[off + i] = c;
      } else if (sc > MB_SC[off + minIdx]) {
        i = minIdx;
        while (i > 0 && MB_SC[off + i - 1] < sc) {
          MB_SC[off + i] = MB_SC[off + i - 1]; MB_ID[off + i] = MB_ID[off + i - 1]; i--;
        }
        MB_SC[off + i] = sc; MB_ID[off + i] = c;
      }
      void v;
    }
    moveCnt = cnt;
  }

  function nodeLimit(depth) {
    var t = CFG.nodeLimits;
    if (t) {
      if (depth >= 8) { return t[4]; }
      if (depth >= 6) { return t[3]; }
      if (depth >= 4) { return t[2]; }
      if (depth >= 2) { return t[1]; }
      return t[0];
    }
    return depth >= 8 ? 7 : depth >= 6 ? 8 : depth >= 4 ? 10 : depth >= 2 ? 12 : 16;
  }

  /* ==================================================================================
   * 6. 评估
   * ================================================================================== */
  var EVAL_CLAMP = WIN * 0.25;

  function evaluate(side) {
    var e;
    if (side === BLACK) {
      e = aggB - aggW * CFG.defense + posScore * CFG.positionWeight;
    } else {
      e = aggW - aggB * CFG.defense - posScore * CFG.positionWeight;
    }
    /* 先手补偿：白方偏好"局面越乱越好"。
     * 注意：不能简单加常数——常数对 minimax 只是整体平移，选点完全不变。
     * 必须用"与局面相关"的项，这里用双方威胁总量（aggB+aggW）衡量混乱度：
     * 白方每多一分混乱度就多算一点分，黑方则相反 → 白棋主动求战、黑棋主动求稳。 */
    if (CFG.sharpBias) {
      var sharp = (aggB + aggW) * CFG.sharpBias / 1000;
      e += (side === WHITE ? sharp : -sharp);
    }
    if (e > EVAL_CLAMP) { e = EVAL_CLAMP; } else if (e < -EVAL_CLAMP) { e = -EVAL_CLAMP; }
    return e | 0;
  }

  /* ==================================================================================
   * 7. 置换表
   * ================================================================================== */
  var TT_BITS = 19, TT_SIZE = 1 << TT_BITS, TT_MASK = TT_SIZE - 1;
  var ttKey = new Int32Array(TT_SIZE);
  var ttScore = new Int32Array(TT_SIZE);
  var ttMove = new Int16Array(TT_SIZE);
  var ttDepth = new Int8Array(TT_SIZE);
  var ttFlag = new Uint8Array(TT_SIZE);   // 0 空 / 1 精确 / 2 下界 / 3 上界

  var SIDE_H1 = 0x9e3779b9 | 0, SIDE_H2 = 0x5bd1e995 | 0;

  function scoreToTT(s, ply) { return s > MATE_BOUND ? s + ply : (s < -MATE_BOUND ? s - ply : s); }
  function scoreFromTT(s, ply) { return s > MATE_BOUND ? s - ply : (s < -MATE_BOUND ? s + ply : s); }

  /* ==================================================================================
   * 8. 搜索
   * ================================================================================== */
  var nodes = 0, stopped = false, deadline = 0;
  var killer1 = new Int32Array(SLOTS), killer2 = new Int32Array(SLOTS);
  var hist = new Int32Array(SZ);
  var QDEPTH = 6;
  var MAX_PLY = 56;

  function search(depth, alpha, beta, side, ply) {
    if (stopped) { return 0; }
    nodes++;
    if ((nodes & 511) === 0 && nowMs() > deadline) { stopped = true; return 0; }
    if (ply >= MAX_PLY) { return evaluate(side); }

    var slot = ply & 63;
    gen(side, nodeLimit(depth), slot);
    if (winACount > 0) { return WIN - ply; }
    if (winBCount >= 2) { return -(WIN - ply - 1); }
    if (winBCount === 1) {
      var blk = winB[0];
      make(blk, side);
      var v0 = -search(depth, -beta, -alpha, 3 - side, ply + 1);
      unmake(blk, side);
      return v0;
    }
    if (depth <= 0) { return quiesce(alpha, beta, side, ply, QDEPTH, slot); }

    var n = moveCnt;
    if (n === 0) { return evaluate(side); }

    var k2 = (hash2 ^ (side === WHITE ? SIDE_H2 : 0)) | 0;
    var idx = ((hash1 ^ (side === WHITE ? SIDE_H1 : 0)) >>> 0) & TT_MASK;
    var hit = ttFlag[idx] !== 0 && ttKey[idx] === k2;
    var ttMv = -1;
    if (hit) {
      if (ttDepth[idx] >= depth) {
        var s = scoreFromTT(ttScore[idx], ply), f = ttFlag[idx];
        if (f === 1) { return s; }
        if (f === 2 && s >= beta) { return s; }
        if (f === 3 && s <= alpha) { return s; }
      }
      ttMv = ttMove[idx];
    }

    // 走法排序：置换表着法 > 杀手着法 > 启发式分值
    var base = slot * SLOT_W;
    var ids = MB_ID, scs = MB_SC;
    var i, j, c;
    if (ttMv >= 0) {
      for (i = 0; i < n; i++) {
        if (ids[base + i] === ttMv) {
          for (j = i; j > 0; j--) { ids[base + j] = ids[base + j - 1]; scs[base + j] = scs[base + j - 1]; }
          ids[base] = ttMv; scs[base] = 0x7fffffff;
          break;
        }
      }
    }
    var k1 = killer1[slot], kv2 = killer2[slot];
    for (i = 1; i < n; i++) {
      c = ids[base + i];
      if (c === k1 || c === kv2) {
        scs[base + i] += 1000000;
      } else if (hist[c] > 0) {
        scs[base + i] += hist[c] > 200000 ? 200000 : hist[c];
      }
    }
    // 简单插入排序（n 很小）
    for (i = 1; i < n; i++) {
      var sid = ids[base + i], ssc = scs[base + i];
      j = i - 1;
      while (j >= 0 && scs[base + j] < ssc) { ids[base + j + 1] = ids[base + j]; scs[base + j + 1] = scs[base + j]; j--; }
      ids[base + j + 1] = sid; scs[base + j + 1] = ssc;
    }

    var alpha0 = alpha, best = -INF, bestMove = -1, val;
    for (i = 0; i < n; i++) {
      c = ids[base + i];
      make(c, side);
      if (i === 0) {
        val = -search(depth - 1, -beta, -alpha, 3 - side, ply + 1);
      } else {
        val = -search(depth - 1, -alpha - 1, -alpha, 3 - side, ply + 1);
        if (!stopped && val > alpha && val < beta) {
          val = -search(depth - 1, -beta, -alpha, 3 - side, ply + 1);
        }
      }
      unmake(c, side);
      if (stopped) { return 0; }
      if (val > best) {
        best = val; bestMove = c;
        if (val > alpha) {
          alpha = val;
          if (alpha >= beta) {
            if (k1 !== c) { killer2[slot] = k1 === c ? kv2 : k1; killer1[slot] = c; }
            if (hist[c] < 100000) { hist[c] += depth * depth; }
            break;
          }
        }
      }
    }
    if (bestMove >= 0) {
      if (ttKey[idx] !== k2 || depth >= ttDepth[idx]) {
        ttKey[idx] = k2; ttDepth[idx] = depth; ttMove[idx] = bestMove;
        ttFlag[idx] = best <= alpha0 ? 3 : (best >= beta ? 2 : 1);
        ttScore[idx] = scoreToTT(best, ply);
      }
    }
    return best;
  }

  function quiesce(alpha, beta, side, ply, qd, slot) {
    if (stopped) { return 0; }
    nodes++;
    if ((nodes & 511) === 0 && nowMs() > deadline) { stopped = true; return 0; }
    if (ply >= MAX_PLY) { return evaluate(side); }

    var s2 = ply & 63;
    gen(side, 16, s2);
    if (winACount > 0) { return WIN - ply; }
    if (winBCount >= 2) { return -(WIN - ply - 1); }
    if (winBCount === 1) {
      var blk = winB[0];
      make(blk, side);
      var v0 = -quiesce(-beta, -alpha, 3 - side, ply + 1, qd, s2);
      unmake(blk, side);
      return v0;
    }
    var best = evaluate(side);
    if (best >= beta) { return best; }
    if (best > alpha) { alpha = best; }
    if (qd <= 0) { return best; }

    var base = s2 * SLOT_W, c, val;
    var pM = side === BLACK ? potB : potW;
    for (var i = 0; i < moveCnt; i++) {
      c = MB_ID[base + i];
      if (pM[c] < FOUR_T) { break; }
      make(c, side);
      val = -quiesce(-beta, -alpha, 3 - side, ply + 1, qd - 1, s2);
      unmake(c, side);
      if (stopped) { return 0; }
      if (val > best) {
        best = val;
        if (val > alpha) {
          alpha = val;
          if (alpha >= beta) { break; }
        }
      }
    }
    return best;
  }

  /* ==================================================================================
   * 9. VCF（连续冲四）——完全穷举，结论可证明
   * ================================================================================== */
  var vcfDeadline = 0, vcfCap = 0, vcfNodes = 0, vcfAborter = false;
  var VC_ID = new Int32Array((SLOTS) * SLOT_W);

  function vcfAttack(side, depth) {
    if (++vcfNodes > vcfCap) { vcfAborter = true; return false; }
    if ((vcfNodes & 127) === 0 && nowMs() > vcfDeadline) { vcfAborter = true; return false; }

    var slot = 32 + (depth % 24);
    gen(side, 24, slot);
    if (winACount > 0) { return true; }
    if (winBCount > 0) { return false; }
    if (depth <= 0) { return false; }

    var base = slot * SLOT_W, n = moveCnt, i, c;
    var pM = side === BLACK ? potB : potW;
    for (i = 0; i < n; i++) {
      c = MB_ID[base + i];
      if (pM[c] < FOUR_T) { break; }
      VC_ID[i] = c;
    }
    n = i;
    for (i = 0; i < n; i++) {
      c = VC_ID[i];
      make(c, side);
      var ok = vcfDefend(side, depth - 1);
      unmake(c, side);
      if (vcfAborter) { return false; }
      if (ok) { return true; }
    }
    return false;
  }

  function vcfDefend(side, depth) {
    if (++vcfNodes > vcfCap) { vcfAborter = true; return false; }
    if ((vcfNodes & 127) === 0 && nowMs() > vcfDeadline) { vcfAborter = true; return false; }

    var opp = 3 - side;
    gen(opp, 24, 62);
    if (winACount > 0) { return false; }
    if (winBCount >= 2) { return true; }
    if (winBCount === 1) {
      if (depth <= 0) { return false; }
      var blk = winB[0];
      make(blk, opp);
      var ok = vcfAttack(side, depth);
      unmake(blk, opp);
      return ok;
    }
    return false;
  }

  function vcfRoot(side, depth) {
    vcfNodes = 0; vcfAborter = false;
    gen(side, 32, 63);
    if (winACount > 0) { return winA[0]; }
    if (winBCount >= 2) { return -1; }
    var base = 63 * SLOT_W, n = moveCnt, i, c, list = [];
    var pM = side === BLACK ? potB : potW;
    for (i = 0; i < n; i++) {
      c = MB_ID[base + i];
      if (pM[c] < FOUR_T) { break; }
      list.push(c);
    }
    if (!list.length) { return -1; }
    for (i = 0; i < list.length; i++) {
      c = list[i];
      make(c, side);
      var ok = vcfDefend(side, depth - 1);
      unmake(c, side);
      if (vcfAborter) { return -1; }
      if (ok) { return c; }
    }
    return -1;
  }

  function vcfFind(side, maxDepth, timeMs, nodeCap) {
    vcfDeadline = nowMs() + timeMs;
    vcfCap = nodeCap;
    for (var d = 4; d <= maxDepth; d += 2) {
      var mv = vcfRoot(side, d);
      if (vcfAborter) { return -1; }
      if (mv >= 0) { return mv; }
      if (nowMs() > vcfDeadline) { return -1; }
    }
    return -1;
  }

  /* ==================================================================================
   * 10. 根节点搜索
   * ================================================================================== */
  var rootIds = new Int32Array(48), rootCount = 0, rootBest = -1, rootScore = 0;

  function buildRoot(side) {
    gen(side, 24, 62);
    rootCount = moveCnt;
    for (var i = 0; i < rootCount; i++) { rootIds[i] = MB_ID[62 * SLOT_W + i]; }
    // 交换式排序保留（gen 已排序）
  }

  function moveToFront(c) {
    for (var i = 0; i < rootCount; i++) {
      if (rootIds[i] === c) {
        for (var j = i; j > 0; j--) { rootIds[j] = rootIds[j - 1]; }
        rootIds[0] = c;
        return;
      }
    }
  }

  function searchRoot(depth, alphaIn, betaIn) {
    var alpha = alphaIn, beta = betaIn, best = -INF, bestMove = -1, v, c, i;
    for (i = 0; i < rootCount; i++) {
      c = rootIds[i];
      make(c, side);
      if (i === 0) {
        v = -search(depth - 1, -beta, -alpha, 3 - side, 1);
      } else {
        v = -search(depth - 1, -alpha - 1, -alpha, 3 - side, 1);
        if (!stopped && v > alpha && v < beta) { v = -search(depth - 1, -beta, -alpha, 3 - side, 1); }
      }
      unmake(c, side);
      if (stopped) { break; }
      if (v > best) {
        best = v; bestMove = c;
        if (v > alpha) { alpha = v; }
      }
    }
    if (bestMove >= 0) {
      rootBest = bestMove; rootScore = best;
      moveToFront(bestMove);
    }
    return best;
  }

  /* ==================================================================================
   * 11. 开局库
   * ================================================================================== */
  function bookMove(side) {
    if (!CFG.useBook) { return -1; }
    if (stoneCount === 0) { return 7 * N + 7; }               // 空盘：天元
    if (stoneCount === 1 && side === WHITE) {
      // 白棋对黑棋第一手：优先斜邻，其次离中心近
      var bc = -1, c;
      for (c = 0; c < SZ; c++) { if (board[c]) { bc = c; break; } }
      if (bc < 0) { return -1; }
      var bx = CX[bc], by = CY[bc], bestCell = -1, bestScore = -1e9;
      for (var dy = -1; dy <= 1; dy++) {
        for (var dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) { continue; }
          var x = bx + dx, y = by + dy;
          if (x < 0 || x >= N || y < 0 || y >= N) { continue; }
          var q = y * N + x;
          if (board[q]) { continue; }
          var sc = (Math.abs(dx) === Math.abs(dy) ? 6 : 0) - (Math.abs(x - 7) + Math.abs(y - 7));
          if (sc > bestScore) { bestScore = sc; bestCell = q; }
        }
      }
      return bestCell;
    }
    return -1;
  }

  /* ==================================================================================
   * 12. 主流程
   * ================================================================================== */
  var side = BLACK;
  var thinkStart = 0, thinkEnd = 0;

  function pack(cell, extra) {
    var r = {
      x: cell % N, y: (cell / N) | 0,
      score: rootScore | 0,
      depth: 0,
      nodes: 0,
      elapsed: Math.round(nowMs() - thinkStart)
    };
    if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) { r[k] = extra[k]; } } }
    return r;
  }

  function think(opt) {
    opt = opt || {};
    thinkStart = nowMs();
    var budget = opt.thinkMs > 0 ? opt.thinkMs : CFG.thinkMs;
    if (side === WHITE && CFG.whiteTimeBonus > 1) { budget = Math.round(budget * CFG.whiteTimeBonus); }
    var tEnd = thinkStart + budget;
    thinkEnd = tEnd;
    stopFlagOff();

    // ① 开局库
    var bk = bookMove(side);
    if (bk >= 0) { rootBest = bk; rootScore = 0; return pack(bk, { source: 'book', depth: 0, nodes: 0 }); }

    // ② 立即成五 / 立即堵
    gen(side, 32, 62);
    if (winACount > 0) { rootBest = winA[0]; rootScore = WIN; return pack(winA[0], { source: 'win' }); }
    if (winBCount === 1) {
      var blk = winB[0];
      rootBest = blk;
      // 仍要确认堵点本身不输（不太可能），直接返回
      return pack(blk, { source: 'block' });
    }
    if (winBCount >= 2) {
      // 已经必败：选分值最高的点，尽量拖延
      rootBest = moveCnt ? MB_ID[62 * SLOT_W] : winB[0];
      return pack(rootBest, { source: 'lost' });
    }
    if (moveCnt === 0) {
      // 空盘（理论上被开局库处理）
      for (var z = 0; z < SZ; z++) { if (!board[z]) { return pack(z, { source: 'fallback' }); } }
      return pack(112, { source: 'fallback' });
    }

    // ③ VCF 进攻
    var tVcfEnd = thinkStart + budget * CFG.vcfTimeRatio;
    var vcfMv = -1;
    if (tVcfEnd > nowMs()) {
      vcfMv = vcfFind(side, CFG.vcfDepth, Math.max(40, tVcfEnd - nowMs()), CFG.vcfNodeCap);
      if (vcfMv >= 0) {
        rootBest = vcfMv; rootScore = WIN - 2;
        return pack(vcfMv, { source: 'vcf', nodes: vcfNodes });
      }
    }

    // ④ 迭代加深主搜索
    buildRoot(side);
    var searchDeadline = thinkStart + budget * 0.86;
    if (searchDeadline < nowMs()) { searchDeadline = nowMs() + 20; }
    var d, depthDone = 0, best = rootIds[0], score = 0;
    rootBest = -1; rootScore = 0;
    for (d = 1; d <= CFG.maxDepth; d++) {
      deadline = searchDeadline;
      searchRoot(d, -INF, INF);
      if (stopped) { break; }
      depthDone = d;
      best = rootBest; score = rootScore;
      if (opt.onProgress) {
        opt.onProgress({ progress: true, depth: d, nodes: nodes, score: score, elapsed: Math.round(nowMs() - thinkStart) });
      }
      if (score > WIN - 1000) { break; }
      if (nowMs() > searchDeadline) { break; }
    }
    if (best < 0) { best = rootIds[0]; }
    rootBest = best; rootScore = score;

    // ⑤ 防守层：避免被对手 VCF
    if (CFG.useDefense && nowMs() < tEnd - 30 && oppHasFourThreat()) {
      best = defend(best, tEnd);
      rootBest = best;
    }

    var out = pack(best, { depth: depthDone, nodes: nodes });
    return out;
  }

  function stopFlagOff() { stopped = false; nodes = 0; }

  /* 对手现在有没有“一手成四”的点；没有的话，落子只会减少对手的选择，
   * 因此对手不可能形成 VCF，可以跳过防守层，省下大量时间。 */
  function oppHasFourThreat() {
    var pO = side === BLACK ? potW : potB;
    for (var c = 0; c < SZ; c++) {
      if (board[c] === 0 && near[c] !== 0 && pO[c] >= FOUR_T) { return true; }
    }
    return false;
  }

  function defend(primary, tEnd) {
    var opp = 3 - side;
    var remain = tEnd - nowMs();
    if (remain < 60) { return primary; }
    var cap = Math.min(180000, Math.max(15000, CFG.vcfNodeCap * 0.4));
    var depth = Math.min(CFG.vcfDepth, 14);

    // 先看当前局面（= 我还没走）对手是否有 VCF；没有就无需换招
    var threat = vcfFind(opp, depth, Math.min(remain * 0.35, 900), cap);
    if (threat < 0) { return primary; }

    // 有威胁：依次试候选，找能躲开的
    var cands = [];
    var i;
    cands.push(primary);
    for (i = 0; i < rootCount && cands.length < 8; i++) {
      if (rootIds[i] !== primary) { cands.push(rootIds[i]); }
    }
    for (i = 0; i < cands.length; i++) {
      if (nowMs() > tEnd - 40) { break; }
      var c = cands[i];
      make(c, side);
      var still = vcfFind(opp, depth, Math.min(700, Math.max(80, (tEnd - nowMs()) * 0.5)), cap);
      unmake(c, side);
      if (still < 0) { return c; }
    }
    return primary;
  }

  /* ==================================================================================
   * 13. 对外 API / Worker 适配
   * ================================================================================== */
  function sideToMove(boardArr, movesArr, myColor) {
    if (myColor === BLACK || myColor === WHITE) { return myColor; }
    var b = 0, w = 0, i;
    if (boardArr && boardArr.length >= SZ) {
      for (i = 0; i < SZ; i++) {
        var v = boardArr[i] | 0;
        if (v === BLACK) { b++; } else if (v === WHITE) { w++; }
      }
    } else if (movesArr) {
      b = (movesArr.length + 1) >> 1; w = movesArr.length >> 1;
    }
    return b === w ? BLACK : WHITE;
  }

  function handleRequest(data, onProgress) {
    data = data || {};
    if (data.config) { configure(data.config); }
    setPosition(data.board, data.moves);
    side = sideToMove(data.board, data.moves, data.myColor);
    var thinkMs = data.thinkMs > 0 ? data.thinkMs : CFG.thinkMs;
    if (data.level >= 0 && data.level <= 3 && !(data.thinkMs > 0)) {
      thinkMs = CFG.levelThinkMs[data.level | 0];
    }
    for (var i = 0; i < SLOTS; i++) { killer1[i] = -1; killer2[i] = -1; }
    for (i = 0; i < SZ; i++) { hist[i] = 0; }
    return think({ thinkMs: thinkMs, onProgress: onProgress });
  }

  function legalFallback(data) {
    var arr = (data && data.board) || null, i;
    if (arr && arr.length >= SZ) {
      for (i = 0; i < SZ; i++) { if (!(arr[i] | 0)) { return i; } }
    }
    for (i = 0; i < SZ; i++) { if (!board[i]) { return i; } }
    return 112;
  }

  /* ==================================================================================
   * 13.5 Swap2 开局决策（P2 视角）
   * 三子（黑·白·黑）摆完后，P2 可以：执白继续 / 执黑把回合交给对方 / 再加两子后让对方选色。
   * 做法：分别用引擎的评估值判断黑白哪边更好。
   *   · 黑方明显好 → 执黑（swap）
   *   · 黑方明显差 → 执白（accept）
   *   · 评估接近平衡 → 加两子（add2），把选择权交还对手
   * add2 时补的两子由引擎分别以白、黑身份各搜一步得到。
   * ================================================================================== */
  function swap2Decision(boardArr, movesArr, thinkMs) {
    var t0 = nowMs();
    var total = thinkMs > 0 ? thinkMs : Math.max(400, CFG.thinkMs * 0.5);
    setPosition(boardArr, movesArr);

    /* 关键：三子之后轮到白棋。无论 P2 选“执白”还是“执黑”，
     * 白棋都会先落下第 4 子，得到同一个 2黑2白、黑先走的局面。
     * 所以真正要比的不是当前三子局面，而是**白棋落完第 4 子之后**的局面。 */
    side = WHITE;
    stopFlagOff();
    var rW = think({ thinkMs: Math.max(150, total * 0.45) });
    var wCell = rW.y * N + rW.x;

    if (board[wCell]) {   // 保险
      return { type: 'swap2', option: 'accept', cells: [], score: 0, elapsed: Math.round(nowMs() - t0) };
    }
    make(wCell, WHITE);
    side = BLACK;
    stopFlagOff();
    var rB = think({ thinkMs: Math.max(150, total * 0.45) });
    var bCell = rB.y * N + rB.x;
    var sBlack = rB.score | 0;      // 黑方视角：正 = 黑好；这是有限搜索的启发式评估，不是胜率证明
    unmake(wCell, WHITE);

    var T = CFG.swap2Band > 0 ? CFG.swap2Band : 10000;
    if (sBlack > T) {
      return { type: 'swap2', option: 'swap', cells: [], score: sBlack, elapsed: Math.round(nowMs() - t0) };
    }
    if (sBlack < -T) {
      return { type: 'swap2', option: 'accept', cells: [], score: sBlack, elapsed: Math.round(nowMs() - t0) };
    }
    if (bCell === wCell || board[bCell]) {
      return { type: 'swap2', option: 'accept', cells: [], score: sBlack, elapsed: Math.round(nowMs() - t0) };
    }
    return {
      type: 'swap2', option: 'add2',
      cells: [{ x: wCell % N, y: (wCell / N) | 0 }, { x: bCell % N, y: (bCell / N) | 0 }],
      score: sBlack, elapsed: Math.round(nowMs() - t0)
    };
  }

  function attachWorker(scope) {
    scope.onmessage = function (e) {
      var data = e.data || {};
      if (data.type === 'config') { configure(data.config || data); return; }
      if (data.type === 'swap2') {
        try { scope.postMessage(swap2Decision(data.board, data.moves, data.thinkMs)); }
        catch (err) { scope.postMessage({ type: 'swap2', option: 'accept', cells: [], fallback: true, error: String((err && err.message) || err) }); }
        return;
      }
      var t0 = nowMs();
      try {
        var res = handleRequest(data, function (p) { scope.postMessage(p); });
        res.timeMs = Math.round(nowMs() - t0);
        scope.postMessage(res);
      } catch (err) {
        var f = legalFallback(data);
        scope.postMessage({
          x: f % N, y: (f / N) | 0,
          error: String((err && err.message) || err),
          timeMs: Math.round(nowMs() - t0)
        });
      }
    };
    scope.onerror = function () { };
  }

  return {
    version: '2.0.0',
    engine: 'GomokuTOP',
    N: N,
    WIN: WIN,
    attachWorker: attachWorker,
    handleRequest: handleRequest,
    swap2Decision: swap2Decision,
    think: think,
    setPosition: setPosition,
    configure: configure,
    config: CFG,
    /* 便于测试的内部接口 */
    _internal: {
      make: make, unmake: unmake, gen: gen, analyze: analyze, levelOf: levelOf,
      evaluate: evaluate, vcfFind: vcfFind, setSide: function (s) { side = s; },
      getSide: function () { return side; },
      pot: function (c, s) { return s === BLACK ? potB[c] : potW[c]; },
      agg: function () { return { b: aggB, w: aggW }; },
      vcf: vcfFind,
      board: board,
      FIVE_T: function () { return FIVE_T; },
      FOUR_T: function () { return FOUR_T; },
      LEVEL_VAL: function () { return LEVEL_VAL; }
    }
  };
});

