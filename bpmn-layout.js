// Layout automático e XML BPMN 2.0 do mapeamento da ARI.
//
// Recebe o grafo (nós + fluxos, ver bpmn-graph.js) e posiciona tudo em raias
// (layout em camadas) e roteia as setas em ângulo reto numa grade com
// ocupação exclusiva: nenhuma seta passa por cima de outra, por dentro de um
// nó ou por cima de um rótulo. Detalhes no bloco "Layout em camadas" abaixo.
// Garantia de não regressão: test/bpmn-layout.test.mjs (npm test).
// Script clássico: expõe window.AriBpmn (e globalThis.AriBpmn nos testes).
(function (root) {
  'use strict';

  var SIZE = {
    task: [100, 80], subProcess: [100, 80],
    startEvent: [36, 36], endEvent: [36, 36], timerEvent: [36, 36], boundaryTimer: [36, 36],
    exclusiveGateway: [50, 50], parallelGateway: [50, 50], inclusiveGateway: [50, 50]
  };
  var GATEWAYS = { exclusiveGateway: 1, parallelGateway: 1, inclusiveGateway: 1 };
  var ACTIVITIES = { task: 1, subProcess: 1 };
  var LANE_LABEL_W = 30, POOL_X = 160, POOL_Y = 80;
  var TASK_TAG = { user: 'userTask', service: 'serviceTask', manual: 'manualTask', send: 'sendTask', receive: 'receiveTask', script: 'scriptTask', businessRule: 'businessRuleTask' };
  // Tipos de início, fim e atividade (mesmos valores de bpmn-graph.js), com o
  // nome mostrado no painel "Tipos dos elementos".
  var TYPE_OPTIONS = {
    start: [['none', 'Simples (nenhum)'], ['message', 'Mensagem'], ['timer', 'Temporizador'], ['signal', 'Sinal'], ['conditional', 'Condicional']],
    end: [['none', 'Simples (nenhum)'], ['message', 'Mensagem'], ['terminate', 'Terminar'], ['error', 'Erro'], ['signal', 'Sinal'], ['escalation', 'Escalonamento']],
    task: [['user', 'Usuário'], ['manual', 'Manual'], ['service', 'Serviço'], ['send', 'Envio'], ['receive', 'Recebimento'], ['script', 'Script'], ['businessRule', 'Regra de negócio'], ['none', 'Genérica']]
  };
  var EVENT_DEF = {
    message: 'messageEventDefinition', timer: 'timerEventDefinition', signal: 'signalEventDefinition', conditional: 'conditionalEventDefinition',
    terminate: 'terminateEventDefinition', error: 'errorEventDefinition', escalation: 'escalationEventDefinition'
  };
  var allowed = function (list, v) { return list.some(function (o) { return o[0] === v; }); };
  // Tipo do evento de início/fim; aceita o formato antigo ("terminate": true).
  function eventTypeOf(n) {
    if (!n || (n.type !== 'startEvent' && n.type !== 'endEvent')) return 'none';
    var list = n.type === 'startEvent' ? TYPE_OPTIONS.start : TYPE_OPTIONS.end;
    if (allowed(list, n.eventType)) return n.eventType;
    return n.type === 'endEvent' && n.terminate === true ? 'terminate' : 'none';
  }
  // Filhos de um evento com definição. O evento condicional exige a condição
  // (vazia aqui) para abrir no bpmn-js, Camunda e Bizagi.
  function eventDefXml(type, id) {
    var tag = EVENT_DEF[type];
    if (!tag) return '';
    if (type === 'conditional') return '<' + tag + ' id="' + id + '_def"><condition xsi:type="tFormalExpression"/></' + tag + '>';
    return '<' + tag + ' id="' + id + '_def"/>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  // ids viram atributos XML (NCName): só letras, dígitos, _ - .
  function xmlId(id) { var s = String(id).replace(/[^A-Za-z0-9_.-]/g, '_'); return /^[A-Za-z_]/.test(s) ? s : 'n_' + s; }

  function textSize(text) {
    var words = String(text || '').split(/\s+/), lines = 1, used = 0;
    words.forEach(function (w) { if (used && used + w.length + 1 > 14) { lines++; used = 0; } lines += Math.floor(w.length / 15); used += w.length % 15 + 1; });
    return { w: 100, h: Math.max(28, lines * 15 + 6) };
  }

  // ---------------------------------------------------------------------------
  // Layout em camadas (Sugiyama) dentro das raias + roteamento ortogonal numa
  // grade regular de 16 px com ocupação exclusiva.
  //
  //   1. setas de volta (retrabalho) saem da ordenação (busca em profundidade);
  //   2. coluna = caminho mais longo desde o início; setas que pulam colunas
  //      ganham nós fantasmas em cada coluna intermediária;
  //   3. a ordem dentro de cada coluna/raia minimiza cruzamentos (baricentro em
  //      passadas alternadas + transposição) e as linhas são alinhadas para que
  //      o caminho principal fique reto;
  //   4. cada seta é roteada por A* na grade: cada aresta e cada vértice da
  //      grade pertencem a no máximo uma seta (só o cruzamento em X é aceito,
  //      com custo alto). Linhas da grade distam 16 px, então não existe
  //      sobreposição nem paralela a menos de 16 px; cada extremidade usa uma
  //      porta própria do nó (vértices/bordas do losango, pontos ao longo das
  //      faces da atividade), nunca um tronco compartilhado;
  //   5. rótulos dos fluxos ficam colados ao primeiro trecho livre da seta;
  //   6. faixas horizontais/verticais vazias são removidas (raias e colunas
  //      só com o espaço necessário).
  // O orçamento de busca é contado em expansões (determinístico). Se algo
  // falhar, cada seta cai num roteamento simples e buildXml nunca lança.
  var GRID = 16, CLEAR = 16, BEND = 40, CROSS = 6000, FOREIGN = 0.1;

  function snapUp(v, base) { return base + Math.ceil((v - base) / GRID - 1e-9) * GRID; }

  function nodeSize(n, degIn, degOut, dirNeed) {
    var sz = (SIZE[n.type] || SIZE.task).slice();
    var deg = (degIn || 0) + (degOut || 0);
    if (ACTIVITIES[n.type]) {
      var len = String(n.name || '').length;
      sz[0] = len > 35 ? 150 : 100;
      sz[1] = Math.max(80, 30 + Math.ceil(len / Math.floor((sz[0] - 16) / 6.5)) * 15);
      sz[1] = Math.max(sz[1], 24 + 16 * Math.max(degIn || 0, degOut || 0));
      sz[1] = 2 * Math.ceil(sz[1] / 2);
    }
    if (GATEWAYS[n.type]) {
      // Portas por lado: vértice + 2 por diagonal a cada 16 px + cima/baixo.
      var need = Math.max(degIn || 0, degOut || 0), k = Math.max(1, Math.ceil((need - 3) / 2), (dirNeed || 0) - 1);
      // a última porta diagonal fica a até 88% da meia altura (perto do
      // vértice de cima/baixo a saída horizontal pareceria "pelo lado errado")
      var h = Math.max(52, 32 * k + 20, 2 * Math.ceil(16 * k / 0.88) + 4); sz = [h - 2, h];
    }
    return sz;
  }
  function labelSize(text) {
    var sz = textSize(text);
    if (String(text).length < 14) { sz.w = Math.max(24, String(text).length * 7 + 6); sz.h = 20; }
    return sz;
  }

  // --- estrutura: setas de volta, colunas, raias ------------------------------
  function structure(graph) {
    var nodes = graph.nodes, flows = graph.flows || [], byId = {}, order = {};
    nodes.forEach(function (n, i) { if (n && n.id != null && !byId[n.id]) { byId[n.id] = n; order[n.id] = i; } });
    var attached = function (n) { return !!(n && n.type === 'boundaryTimer' && byId[n.attachedTo] && byId[n.attachedTo].type !== 'boundaryTimer'); };
    var hostOf = function (id) { return attached(byId[id]) ? byId[id].attachedTo : id; };
    var main = nodes.filter(function (n) { return byId[n.id] === n && !attached(n); });
    var degIn = {}, degOut = {};
    var edges = [];
    flows.forEach(function (f, i) {
      if (!f || !byId[f.from] || !byId[f.to]) return;
      degOut[f.from] = (degOut[f.from] || 0) + 1; degIn[f.to] = (degIn[f.to] || 0) + 1;
      var u = hostOf(f.from), v = hostOf(f.to);
      if (u !== v) edges.push({ i: i, u: u, v: v, boundary: u !== f.from });
    });
    var out = {};
    main.forEach(function (n) { out[n.id] = []; });
    edges.forEach(function (e) { out[e.u].push(e); });
    // Setas de volta: DFS iterativa a partir dos inícios.
    var state = {}, back = {};
    main.filter(function (n) { return n.type === 'startEvent'; }).concat(main).forEach(function (r) {
      if (state[r.id]) return;
      var stack = [[r.id, 0]]; state[r.id] = 1;
      while (stack.length) {
        var top = stack[stack.length - 1], list = out[top[0]];
        if (top[1] >= list.length) { state[top[0]] = 2; stack.pop(); continue; }
        var e = list[top[1]++];
        if (state[e.v] === 1) back[e.i] = true;
        else if (!state[e.v]) { state[e.v] = 1; stack.push([e.v, 0]); }
      }
    });
    // Colunas: caminho mais longo (Kahn) sem as setas de volta.
    var layer = {}, indeg = {}, topo = [];
    main.forEach(function (n) { layer[n.id] = 0; indeg[n.id] = 0; });
    edges.forEach(function (e) { if (!back[e.i]) indeg[e.v]++; });
    var queue = main.filter(function (n) { return !indeg[n.id]; }).map(function (n) { return n.id; });
    for (var qi = 0; qi < queue.length; qi++) {
      var id = queue[qi]; topo.push(id);
      out[id].forEach(function (e) {
        if (back[e.i]) return;
        if (layer[e.u] + 1 > layer[e.v]) layer[e.v] = layer[e.u] + 1;
        if (--indeg[e.v] === 0) queue.push(e.v);
      });
    }
    // Nó sem antecessor (que não seja início) fica logo antes do sucessor.
    var hasPred = {};
    edges.forEach(function (e) { if (!back[e.i]) hasPred[e.v] = true; });
    topo.slice().reverse().forEach(function (id) {
      if (hasPred[id] || byId[id].type === 'startEvent') return;
      var succ = out[id].filter(function (e) { return !back[e.i]; }).map(function (e) { return layer[e.v]; });
      if (succ.length) layer[id] = Math.max(layer[id], Math.min.apply(null, succ) - 1);
    });
    var lanes = (graph.lanes || []).slice();
    main.forEach(function (n) { if (lanes.indexOf(n.lane) < 0) lanes.push(n.lane); });
    if (!lanes.length) lanes.push('Processo');
    var laneIdx = {};
    main.forEach(function (n) { var l = lanes.indexOf(n.lane); laneIdx[n.id] = l < 0 ? 0 : l; });
    var maxCol = 0;
    main.forEach(function (n) { maxCol = Math.max(maxCol, layer[n.id]); });
    // Evento de borda vai para a borda de cima quando todos os destinos
    // estão em raias acima da atividade (a seta não cruza a saída dela).
    var boundaryTop = {};
    nodes.forEach(function (n) {
      if (!attached(n)) return;
      var outs = flows.filter(function (f) { return f && f.from === n.id && byId[f.to]; });
      if (outs.length && outs.every(function (f) { return laneIdx[hostOf(f.to)] < laneIdx[n.attachedTo]; })) boundaryTop[n.id] = true;
    });
    return { flows: flows, boundaryTop: boundaryTop, byId: byId, order: order, main: main, edges: edges, back: back, layer: layer, lanes: lanes, laneIdx: laneIdx, maxCol: maxCol, degIn: degIn, degOut: degOut, hostOf: hostOf, attached: attached };
  }

  // --- ordem dentro das colunas e linhas das raias -----------------------------
  function orderRows(S) {
    var item = {}, ids = [], cols = [];
    function add(id, col, lane, real) { item[id] = { id: id, col: col, lane: lane, real: real, preds: [], succs: [], idx: 0 }; ids.push(id); }
    S.main.forEach(function (n) { add(n.id, S.layer[n.id], S.laneIdx[n.id], true); });
    var oedges = [];
    var bsign = function (e) { return S.boundaryTop[S.flows[e.i].from] ? -0.5 : 0.5; };
    function link(u, v, boundary, bk) { var e = { u: u, v: v, b: boundary ? boundary : 0, bk: !!bk }; oedges.push(e); item[u].succs.push(e); item[v].preds.push(e); }
    S.edges.forEach(function (e) {
      // Seta de volta entra invertida (do destino para a origem); os
      // fantasmas dela não ocupam linha: só dizem por onde a volta passa.
      var bk = !!S.back[e.i] && S.layer[e.v] <= S.layer[e.u], from = bk ? e.v : e.u, to = bk ? e.u : e.v;
      var prev = from, c0 = S.layer[from], c1 = S.layer[to];
      if (c1 <= c0) return;
      for (var c = c0 + 1; c < c1; c++) {
        var id = '\u0001' + e.i + ':' + c;
        add(id, c, S.laneIdx[bk ? e.v : e.u], false); item[id].loop = bk; link(prev, id, e.boundary && prev === e.u ? bsign(e) : 0, bk); prev = id;
      }
      link(prev, to, e.boundary && prev === e.u ? bsign(e) : 0, bk);
    });
    // Ordem inicial: pré-ordem da DFS seguindo os fluxos na ordem do grafo.
    var rank = {}, counter = 0, roots = ids.filter(function (id) { return !item[id].preds.length; });
    roots.sort(function (a, b) { return item[a].col - item[b].col || (S.order[a] || 0) - (S.order[b] || 0); });
    roots.concat(ids).forEach(function (r) {
      if (rank[r] !== undefined) return;
      var stack = [r];
      while (stack.length) {
        var id = stack.pop(); if (rank[id] !== undefined) continue;
        rank[id] = counter++;
        var s = item[id].succs;
        for (var k = s.length - 1; k >= 0; k--) if (rank[s[k].v] === undefined) stack.push(s[k].v);
      }
    });
    var nl = S.lanes.length;
    for (var c = 0; c <= S.maxCol; c++) { cols.push([]); for (var l = 0; l < nl; l++) cols[c].push([]); }
    ids.forEach(function (id) { var it = item[id]; cols[it.col][it.lane].push(id); });
    var pos = {};
    function reindex(c) { cols[c].forEach(function (cell, l) { cell.forEach(function (id, k) { item[id].idx = k; pos[id] = l * 4096 + k; }); }); }
    for (c = 0; c <= S.maxCol; c++) { cols[c].forEach(function (cell) { cell.sort(function (a, b) { return rank[a] - rank[b]; }); }); reindex(c); }
    var byCol = cols.map(function () { return []; });
    oedges.forEach(function (e) { byCol[item[e.u].col].push(e); });
    function crossCol(c) {
      var list = byCol[c] || [], n = 0;
      for (var i = 0; i < list.length; i++) for (var j = i + 1; j < list.length; j++) {
        var a = list[i], b = list[j];
        if ((pos[a.u] - pos[b.u]) * (pos[a.v] - pos[b.v]) < 0) n += (a.bk ? 0.3 : 1) * (b.bk ? 0.3 : 1);
      }
      return n;
    }
    function crossAll() { var n = 0; for (var c = 0; c < S.maxCol; c++) n += crossCol(c); return n; }
    function sortCell(c, l, down) {
      var cell = cols[c][l]; if (cell.length < 2) return;
      var bary = {};
      cell.forEach(function (id) {
        var es = down ? item[id].preds : item[id].succs, s = 0;
        es.forEach(function (e) { s += pos[down ? e.u : e.v] + e.b; });
        bary[id] = es.length ? s / es.length : pos[id];
      });
      cell.sort(function (a, b) { return bary[a] - bary[b] || item[a].idx - item[b].idx; });
    }
    function pairCross(a, b) { // cruzamentos entre as setas de a e de b com a acima de b
      var n = 0;
      item[a].preds.forEach(function (x) { item[b].preds.forEach(function (y) { if (pos[x.u] + x.b > pos[y.u] + y.b) n += (x.bk ? 0.3 : 1) * (y.bk ? 0.3 : 1); }); });
      item[a].succs.forEach(function (x) { item[b].succs.forEach(function (y) { if (pos[x.v] > pos[y.v]) n += (x.bk ? 0.3 : 1) * (y.bk ? 0.3 : 1); }); });
      return n;
    }
    function transpose() {
      for (var round = 0; round < 3; round++) {
        var improved = false;
        for (var c = 0; c <= S.maxCol; c++) cols[c].forEach(function (cell, l) {
          for (var k = 0; k + 1 < cell.length; k++) {
            var a = cell[k], b = cell[k + 1];
            if (pairCross(b, a) < pairCross(a, b) - 1e-9) {
              cell[k] = b; cell[k + 1] = a; item[a].idx = k + 1; item[b].idx = k; pos[a] = l * 4096 + k + 1; pos[b] = l * 4096 + k; improved = true;
            }
          }
        });
        if (!improved) break;
      }
    }
    function snapshot() { return cols.map(function (col) { return col.map(function (cell) { return cell.slice(); }); }); }
    var best = crossAll(), bestCols = snapshot(), initial = snapshot();
    // Várias partidas (ordem da DFS, invertida e embaralhadas com semente fixa).
    var seed = 12345;
    var rnd = function () { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (var start = 0; start < 6 && best > 0; start++) {
      cols = initial.map(function (col) { return col.map(function (cell) {
        var c2 = cell.slice();
        if (start === 1) c2.reverse();
        else if (start > 1) for (var x = c2.length - 1; x > 0; x--) { var y = Math.floor(rnd() * (x + 1)), t = c2[x]; c2[x] = c2[y]; c2[y] = t; }
        return c2;
      }); });
      cols.forEach(function (col) { col.forEach(function (cell, l) { cell.forEach(function (id) { item[id].lane = l; }); }); });
      for (c = 0; c <= S.maxCol; c++) reindex(c);
      var stale = 0, local = crossAll();
      for (var it = 0; it < 16 && best > 0 && stale < 4; it++) {
        var down = it % 2 === 0;
        for (var k = 0; k <= S.maxCol; k++) {
          var cc = down ? k : S.maxCol - k;
          for (l = 0; l < nl; l++) sortCell(cc, l, down);
          reindex(cc);
        }
        transpose();
        var score = crossAll();
        if (score < local - 1e-9) { local = score; stale = 0; } else stale++;
        if (score < best - 1e-9) { best = score; bestCols = snapshot(); }
      }
    }
    cols = bestCols;
    cols.forEach(function (col) { col.forEach(function (cell, l) { cell.forEach(function (id) { item[id].lane = l; }); }); });
    // O ramo do evento de borda sai por baixo da atividade: fica depois dos
    // demais itens da célula (não toma a linha do fluxo normal).
    var bchain = {};
    for (c = 0; c <= S.maxCol; c++) cols[c].forEach(function (cell) {
      cell.forEach(function (id) { var ps = item[id].preds; if (ps.length && ps.every(function (e) { return e.b > 0 || bchain[e.u]; })) bchain[id] = true; });
      var a = cell.filter(function (id) { return !bchain[id]; }), b = cell.filter(function (id) { return bchain[id]; });
      a.concat(b).forEach(function (id, k) { cell[k] = id; });
    });
    for (c = 0; c <= S.maxCol; c++) reindex(c);
    // Linhas: mantêm a ordem de cada célula e alinham cada item com os
    // vizinhos da mesma raia (mediana), para o caminho principal ficar reto.
    var row = {};
    cols.forEach(function (col) { col.forEach(function (cell, l) { cols[cols.indexOf(col)][l] = cell.filter(function (id) { return !item[id].loop; }); }); });
    cols.forEach(function (col) { col.forEach(function (cell) { cell.forEach(function (id, k) { item[id].idx = k; }); }); });
    ids = ids.filter(function (id) { return !item[id].loop; });
    ids.forEach(function (id) { row[id] = item[id].idx; });
    function median(list) { list.sort(function (a, b) { return a - b; }); return list[(list.length - 1) >> 1]; }
    // Regressão isotônica L1 (pool adjacent violators): linhas estritamente
    // crescentes na célula, o mais perto possível das medianas desejadas.
    function isotonic(want) {
      var blocks = [];
      want.forEach(function (w, i) {
        blocks.push({ vals: [w - i], v: w - i });
        while (blocks.length > 1 && blocks[blocks.length - 2].v > blocks[blocks.length - 1].v) {
          var top = blocks.pop(), prev = blocks[blocks.length - 1];
          prev.vals = prev.vals.concat(top.vals); prev.v = median(prev.vals.slice());
        }
      });
      var out = [];
      blocks.forEach(function (b) { b.vals.forEach(function () { out.push(Math.max(0, b.v) + out.length); }); });
      return out;
    }
    for (var pass = 0; pass < 8; pass++) {
      for (var k = 0; k <= S.maxCol; k++) {
        var c = pass % 2 === 0 ? k : S.maxCol - k;
        cols[c].forEach(function (cell) {
          if (!cell.length) return;
          // Divisão: centro dos ramos; junção: centro das chegadas; senão,
          // mediana de todos os vizinhos da mesma raia.
          var want = cell.map(function (id) {
            var it = item[id], ps = [], ss = [];
            it.preds.forEach(function (e) { var o = item[e.u]; if (!e.bk && o.lane === it.lane && row[o.id] !== undefined) ps.push(row[o.id] + Math.sign(e.b)); });
            it.succs.forEach(function (e) { var o = item[e.v]; if (!e.bk && o.lane === it.lane && row[o.id] !== undefined) ss.push(row[o.id] - Math.sign(e.b)); });
            var rs = ss.length >= 2 && ps.length < 2 ? ss : ps.length >= 2 && ss.length < 2 ? ps : ps.concat(ss);
            return rs.length ? median(rs) : row[id];
          });
          isotonic(want).forEach(function (r, i) { row[cell[i]] = r; });
        });
      }
    }
    // Linhas vazias saem (renumeração monótona por raia).
    var used = S.lanes.map(function () { return {}; });
    ids.forEach(function (id) { used[item[id].lane][row[id]] = true; });
    var remap = used.map(function (u) { var m = {}, n = 0; Object.keys(u).map(Number).sort(function (a, b) { return a - b; }).forEach(function (r) { m[r] = n++; }); m.count = Math.max(1, n); return m; });
    ids.forEach(function (id) { row[id] = remap[item[id].lane][row[id]]; });
    S.item = item; S.ids = ids; S.row = row; S.rows = remap.map(function (m) { return m.count; }); S.oedges = oedges.filter(function (e) { return !e.bk && !item[e.u].loop && !item[e.v].loop && row[e.u] !== undefined && row[e.v] !== undefined; }); S.orderCross = best;
  }

  // --- coordenadas -------------------------------------------------------------
  function place(graph, S) {
    var nl = S.lanes.length, sizes = {}, item = S.item, row = S.row;
    // Demanda de portas por direção em cada gateway (acima/abaixo, saídas e
    // chegadas para frente; voltas usam cima/baixo também).
    var dirNeed = {}, gkey = function (id) { return S.laneIdx[id] * 4096 + row[id]; };
    S.main.forEach(function (n) {
      if (!GATEWAYS[n.type]) return;
      var c = { oa: 0, ob: 0, ia: 0, ib: 0, bk: 0 }, me = gkey(n.id);
      S.edges.forEach(function (e) {
        if (e.u !== n.id && e.v !== n.id) return;
        if (S.back[e.i]) { c.bk++; return; }
        var other = e.u === n.id ? e.v : e.u, k = gkey(other);
        if (k === me) return;
        c[(e.u === n.id ? 'o' : 'i') + (k < me ? 'a' : 'b')]++;
      });
      dirNeed[n.id] = Math.max(c.oa, c.ob, c.ia, c.ib) + (c.bk ? 1 : 0);
    });
    S.main.forEach(function (n) { sizes[n.id] = nodeSize(n, S.degIn[n.id], S.degOut[n.id], dirNeed[n.id]); });
    var labelOf = {};
    S.main.forEach(function (n) { if (!ACTIVITIES[n.type] && n.name) labelOf[n.id] = labelSize(n.name); });
    var hostBoundary = {};
    graph.nodes.forEach(function (n) { if (S.attached(n)) (hostBoundary[n.attachedTo] = hostBoundary[n.attachedTo] || []).push(n); });
    // Larguras das colunas e demanda dos corredores verticais.
    var colW = [], chan = [], vdem = [], labelNeed = [];
    for (var c = 0; c <= S.maxCol; c++) { colW[c] = 36; vdem[c] = 2; labelNeed[c] = 0; }
    S.main.forEach(function (n) { var c = S.layer[n.id]; colW[c] = Math.max(colW[c], sizes[n.id][0]); });
    S.oedges.forEach(function (e) {
      var a = item[e.u], b = item[e.v];
      if (a.lane !== b.lane || row[e.u] !== row[e.v]) vdem[a.col]++;
    });
    var backPerLane = S.lanes.map(function () { return 0; });
    S.edges.forEach(function (e) {
      var f = graph.flows[e.i];
      if (f.label) { var c = S.layer[S.hostOf(f.from)]; labelNeed[c] = Math.max(labelNeed[c], labelSize(f.label).w + 64); }
      if (!S.back[e.i]) return;
      var lu = S.laneIdx[e.u], lv = S.laneIdx[e.v];
      backPerLane[lu]++; if (lv !== lu) backPerLane[lv]++;
      var c0 = S.layer[e.v], c1 = S.layer[e.u];
      vdem[Math.max(0, c0 - 1)]++; vdem[c1]++;
    });
    graph.nodes.forEach(function (n) { if (S.attached(n)) vdem[S.layer[n.attachedTo]] += 2; });
    var gwLab = [];
    S.main.forEach(function (n) { if (GATEWAYS[n.type] && labelOf[n.id]) { var c = S.layer[n.id]; gwLab[c] = Math.max(gwLab[c] || 0, labelOf[n.id].w); } });
    var gx0 = POOL_X + LANE_LABEL_W + 8, gy0 = POOL_Y + 8;
    var colX = [], x = gx0 + 64 + colW[0] / 2;
    for (c = 0; c <= S.maxCol; c++) {
      colX[c] = snapUp(x, gx0);
      // rótulo do gateway seguinte fica no mesmo corredor, acima à esquerda
      chan[c] = Math.max(96, 48 + GRID * vdem[c], labelNeed[c] + (labelNeed[c] ? gwLab[c + 1] || 0 : 0));
      x = colX[c] + colW[c] / 2 + chan[c] + (colW[c + 1] || 0) / 2;
    }
    var poolW = Math.round(colX[S.maxCol] + colW[S.maxCol] / 2 + 96 - POOL_X);
    // Alturas: acima/abaixo do centro de cada linha.
    var above = [], below = [];
    for (var l = 0; l < nl; l++) { above.push([]); below.push([]); for (var r = 0; r < S.rows[l]; r++) { above[l][r] = 16; below[l][r] = 16; } }
    S.ids.forEach(function (id) {
      var it = item[id], l = it.lane, r = row[id];
      if (!it.real) return;
      var n = S.byId[id], sz = sizes[id], lab = labelOf[id];
      var a = sz[1] / 2 + 24, b = sz[1] / 2 + 24;
      if (lab && GATEWAYS[n.type]) a = Math.max(a, sz[1] / 2 + lab.h + 28);
      if (lab && !GATEWAYS[n.type]) b = Math.max(b, sz[1] / 2 + lab.h + 28);
      (hostBoundary[id] || []).forEach(function (bt) {
        var need = sz[1] / 2 + 18 + labelSize(bt.name || ' ').h + 40;
        if (S.boundaryTop[bt.id]) a = Math.max(a, need); else b = Math.max(b, need);
      });
      above[l][r] = Math.max(above[l][r], a); below[l][r] = Math.max(below[l][r], b);
    });
    graph.flows.forEach(function (f, i) {
      if (!f || !f.label || !S.byId[f.from]) return;
      var h = S.hostOf(f.from); if (!item[h]) return;
      var need = sizes[h][1] / 2 + labelSize(f.label).h + 24;
      above[item[h].lane][row[h]] = Math.max(above[item[h].lane][row[h]], need);
      below[item[h].lane][row[h]] = Math.max(below[item[h].lane][row[h]], need);
    });
    var laneTop = [], laneH = [], rowY = [], acc = POOL_Y;
    for (l = 0; l < nl; l++) {
      laneTop[l] = acc;
      var gap = 32 + GRID * Math.min(4, Math.ceil(backPerLane[l] / 2));
      var y = acc + gap;
      rowY.push([]);
      for (r = 0; r < S.rows[l]; r++) {
        rowY[l][r] = snapUp(y + above[l][r], gy0);
        y = rowY[l][r] + below[l][r] + gap;
      }
      var minH = Math.max(120, Math.min(220, String(S.lanes[l]).length * 7 + 24));
      var h = Math.max(minH, y - acc);
      h = GRID * Math.ceil(h / GRID);
      laneH[l] = h; acc += h;
    }
    var boxes = {};
    S.main.forEach(function (n) {
      var sz = sizes[n.id], l = S.laneIdx[n.id], r = row[n.id], c = S.layer[n.id];
      var cx = colX[c], cy = rowY[l][r];
      boxes[n.id] = { x: cx - sz[0] / 2, y: cy - sz[1] / 2, w: sz[0], h: sz[1], cx: cx, cy: cy, col: c, row: r, lane: l };
    });
    // Eventos de borda: na borda inferior da atividade, da direita para a esquerda.
    var perHost = {};
    graph.nodes.forEach(function (n) {
      if (!S.attached(n)) return;
      var h = boxes[n.attachedTo]; if (!h) return;
      var k = perHost[n.attachedTo] = (perHost[n.attachedTo] || 0) + 1;
      var bcx = snapUp(h.x + h.w - 22 - (k - 1) * 48 - 8, gx0), bcy = S.boundaryTop[n.id] ? h.y : h.y + h.h;
      if (bcx > h.x + h.w - 18) bcx -= GRID;
      boxes[n.id] = { x: bcx - 18, y: bcy - 18, w: 36, h: 36, cx: bcx, cy: bcy, col: h.col, row: h.row, lane: h.lane, boundary: true, top: !!S.boundaryTop[n.id] };
    });
    var L = { lanes: S.lanes, laneTop: laneTop, laneH: laneH, poolW: poolW, poolH: acc - POOL_Y, boxes: boxes, back: S.back, colX: colX };
    placeNodeLabels(graph, L, S);
    return L;
  }

  function rect(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }
  function overlaps(a, b, pad) { return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y; }
  // Segmento ortogonal a-b atravessa o retângulo r inflado por pad (interior)?
  function segHits(a, b, r, pad) {
    var x1 = r.x - pad, x2 = r.x + r.w + pad, y1 = r.y - pad, y2 = r.y + r.h + pad;
    return Math.max(a[0], b[0]) > x1 && Math.min(a[0], b[0]) < x2 && Math.max(a[1], b[1]) > y1 && Math.min(a[1], b[1]) < y2;
  }

  // Rótulos de nós (eventos e gateways), antes das setas: viram obstáculos.
  function placeNodeLabels(graph, L, S) {
    var boxes = L.boxes, labels = {}, ids = Object.keys(boxes);
    var X0 = POOL_X + LANE_LABEL_W;
    graph.nodes.forEach(function (n) {
      var b = boxes[n.id]; if (!b || ACTIVITIES[n.type] || !n.name || labels[n.id]) return;
      var sz = labelSize(n.name), deg = (S.degIn[n.id] || 0) + (S.degOut[n.id] || 0), list;
      var host = b.boundary ? boxes[n.attachedTo] : null;
      if (GATEWAYS[n.type]) list = [rect(b.x - sz.w - 6, b.y - sz.h - 6, sz.w, sz.h), rect(b.cx - sz.w - 10, b.y - sz.h - 16, sz.w, sz.h), rect(b.x + b.w + 6, b.y - sz.h - 6, sz.w, sz.h)];
      else if (b.boundary && b.top) list = [rect(b.x + b.w + 6, host.y - 6 - sz.h, sz.w, sz.h), rect(b.x - sz.w - 6, host.y - 6 - sz.h, sz.w, sz.h), rect(b.x + b.w + 6, b.y - 6 - sz.h, sz.w, sz.h)];
      else if (b.boundary) list = [rect(b.x + b.w + 6, host.y + host.h + 6, sz.w, sz.h), rect(b.x - sz.w - 6, host.y + host.h + 6, sz.w, sz.h), rect(b.x + b.w + 6, b.y + b.h + 6, sz.w, sz.h)];
      else if (deg >= 3) list = [rect(b.x + b.w + 2, b.y + b.h + 2, sz.w, sz.h), rect(b.x - sz.w - 2, b.y + b.h + 2, sz.w, sz.h), rect(b.cx - sz.w / 2, b.y + b.h + 6, sz.w, sz.h)];
      else list = [rect(b.cx - sz.w / 2, b.y + b.h + 6, sz.w, sz.h), rect(b.x + b.w + 2, b.y + b.h + 2, sz.w, sz.h), rect(b.cx - sz.w / 2, b.y - sz.h - 6, sz.w, sz.h)];
      var lt = L.laneTop[b.lane], lb = lt + L.laneH[b.lane];
      function free(r) {
        if (r.x < X0 + 4 || r.y < lt + 4 || r.y + r.h > lb - 4 || r.x + r.w > POOL_X + L.poolW - 4) return false;
        for (var k = 0; k < ids.length; k++) if (overlaps(r, boxes[ids[k]], ids[k] === n.id ? 2 : 6)) return false;
        for (var id in labels) if (overlaps(r, labels[id], 6)) return false;
        return true;
      }
      var pick = list.filter(free)[0] || list[0];
      labels[n.id] = rect(Math.round(pick.x), Math.round(pick.y), sz.w, sz.h);
    });
    L.nodeLabels = labels;
  }

  // --- roteamento -------------------------------------------------------------
  function routeGraph(graph, L, S) {
    var boxes = L.boxes, flows = graph.flows;
    var X0 = POOL_X + LANE_LABEL_W, X1 = POOL_X + L.poolW, Y0 = POOL_Y, Y1 = POOL_Y + L.poolH;
    var gx0 = X0 + 8, gy0 = Y0 + 8;
    var nx = Math.floor((X1 - 8 - gx0) / GRID) + 1, ny = Math.floor((Y1 - 8 - gy0) / GRID) + 1, count = nx * ny;
    var X = function (i) { return gx0 + i * GRID; }, Yc = function (j) { return gy0 + j * GRID; };
    var blocked = new Uint8Array(count);
    // Bordas do pool: as linhas mais externas ficam fora.
    for (var i = 0; i < nx; i++) for (var j = 0; j < ny; j++) {
      if (X(i) < X0 + 24 || X(i) > X1 - 24 || Yc(j) < Y0 + 16 || Yc(j) > Y1 - 16) blocked[j * nx + i] = 1;
    }
    var laneOfJ = new Int32Array(ny), nearBorder = new Uint8Array(ny);
    for (j = 0; j < ny; j++) {
      var y = Yc(j), l = 0;
      while (l + 1 < L.lanes.length && y > L.laneTop[l + 1]) l++;
      laneOfJ[j] = l;
      for (var k = 1; k < L.lanes.length; k++) if (Math.abs(y - L.laneTop[k]) < 12) nearBorder[j] = 1;
    }
    function block(r, pad) {
      var i0 = Math.max(0, Math.floor((r.x - pad - gx0) / GRID) + 1), i1 = Math.min(nx - 1, Math.ceil((r.x + r.w + pad - gx0) / GRID) - 1);
      var j0 = Math.max(0, Math.floor((r.y - pad - gy0) / GRID) + 1), j1 = Math.min(ny - 1, Math.ceil((r.y + r.h + pad - gy0) / GRID) - 1);
      for (var jj = j0; jj <= j1; jj++) for (var ii = i0; ii <= i1; ii++) blocked[jj * nx + ii] = 1;
    }
    var obstacles = [];
    Object.keys(boxes).forEach(function (id) { block(boxes[id], CLEAR - 0.01); obstacles.push({ id: id, r: boxes[id], pad: CLEAR - 0.01 }); });
    Object.keys(L.nodeLabels).forEach(function (id) { block(L.nodeLabels[id], 4); obstacles.push({ id: 'label:' + id, r: L.nodeLabels[id], pad: 4 }); });
    var vi = function (x, y) { var ii = Math.round((x - gx0) / GRID), jj = Math.round((y - gy0) / GRID); return ii >= 0 && ii < nx && jj >= 0 && jj < ny ? jj * nx + ii : -1; };

    // Portas: ponto na borda do nó + ponta do toco (vértice da grade fora da folga).
    var ports = {};
    graph.nodes.forEach(function (n) {
      var b = boxes[n.id]; if (!b) return;
      var list = [];
      function add(side, p, off) {
        var axis = side === 'l' || side === 'r' ? 0 : 1, sign = side === 'r' || side === 'b' ? 1 : -1, q;
        if (axis === 0) q = [sign > 0 ? snapUp(b.x + b.w + CLEAR, gx0) : gx0 + Math.floor((b.x - CLEAR - gx0) / GRID + 1e-9) * GRID, p[1]];
        else q = [p[0], sign > 0 ? snapUp(b.y + b.h + CLEAR, gy0) : gy0 + Math.floor((b.y - CLEAR - gy0) / GRID + 1e-9) * GRID];
        for (var step = 0; step < 4; step++) {
          var v = vi(q[0], q[1]);
          if (v < 0) return;
          if (!blocked[v]) {
            var a = p, c = q, ok = obstacles.every(function (o) { return o.id === n.id || !segHits(a, c, o.r, o.id.indexOf('label:') === 0 ? 2 : 4); });
            if (ok) { list.push({ node: n.id, side: side, p: p, q: v, axis: axis, sign: sign, off: off, len: Math.abs(q[0] - p[0]) + Math.abs(q[1] - p[1]) }); }
            return;
          }
          if (axis === 0) q = [q[0] + sign * GRID, q[1]]; else q = [q[0], q[1] + sign * GRID];
        }
      }
      if (b.boundary) { if (b.top) add('t', [b.cx, b.y], 0); else add('b', [b.cx, b.y + b.h], 0); ports[n.id] = list; return; }
      if (ACTIVITIES[n.type]) {
        var offs = function (half) { var o = [0]; for (var d = GRID; d <= half - 12; d += GRID) o.push(d, -d); return o; };
        offs(b.h / 2).forEach(function (d) { add('r', [b.x + b.w, b.cy + d], d); add('l', [b.x, b.cy + d], d); });
        offs(b.w / 2).forEach(function (d) { add('t', [b.cx + d, b.y], d); add('b', [b.cx + d, b.y + b.h], d); });
      } else if (GATEWAYS[n.type]) {
        add('r', [b.x + b.w, b.cy], 0); add('l', [b.x, b.cy], 0); add('t', [b.cx, b.y], 0); add('b', [b.cx, b.y + b.h], 0);
        for (var d = GRID; d <= Math.min(b.h / 2 - 8, 0.88 * b.h / 2); d += GRID) [d, -d].forEach(function (dy) {
          var dx = Math.round((b.w / 2) * (1 - Math.abs(dy) / (b.h / 2)) * 100) / 100;
          add('r', [b.cx + dx, b.cy + dy], dy); add('l', [b.cx - dx, b.cy + dy], dy);
        });
      } else {
        add('r', [b.x + b.w, b.cy], 0); add('l', [b.x, b.cy], 0); add('t', [b.cx, b.y], 0); add('b', [b.cx, b.y + b.h], 0);
      }
      ports[n.id] = list;
    });
    var portUsed = {};
    var pkey = function (p) { return p.node + '|' + p.side + '|' + p.off; };

    var occH = new Int32Array(count), occV = new Int32Array(count);
    var vUse = new Int32Array(count), vKind = new Uint8Array(count), vUse2 = new Int32Array(count);
    var dist = new Float64Array(count * 2), stamp = new Int32Array(count * 2), parent = new Int32Array(count * 2), run = 0;
    var tStamp = new Int32Array(count), tAt = {};
    var heapK = new Float64Array(4096), heapG = new Float64Array(4096), heapS = new Int32Array(4096), hn = 0;
    function hpush(k, g, s) {
      if (hn === heapK.length) { var nk = new Float64Array(hn * 2), ng = new Float64Array(hn * 2), ns = new Int32Array(hn * 2); nk.set(heapK); ng.set(heapG); ns.set(heapS); heapK = nk; heapG = ng; heapS = ns; }
      var i = hn++;
      while (i > 0) { var p = (i - 1) >> 1; if (heapK[p] <= k) break; heapK[i] = heapK[p]; heapG[i] = heapG[p]; heapS[i] = heapS[p]; i = p; }
      heapK[i] = k; heapG[i] = g; heapS[i] = s;
    }
    var popK = 0, popG = 0, popS = 0;
    function hpop() {
      popK = heapK[0]; popG = heapG[0]; popS = heapS[0];
      var lk = heapK[--hn], lg = heapG[hn], ls = heapS[hn], i = 0;
      while (true) {
        var c = 2 * i + 1; if (c >= hn) break;
        if (c + 1 < hn && heapK[c + 1] < heapK[c]) c++;
        if (heapK[c] >= lk) break;
        heapK[i] = heapK[c]; heapG[i] = heapG[c]; heapS[i] = heapS[c]; i = c;
      }
      if (hn > 0) { heapK[i] = lk; heapG[i] = lg; heapS[i] = ls; }
    }

    var totalPops = 0, POP_LIMIT = 300000 + 8000 * graph.nodes.length;
    var clock = function () { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); };
    // Orçamento de tempo (só age em máquina muito lenta): acima de SLOW_MS a
    // busca fica local e a fase de melhoria é pulada; acima de PANIC_MS as
    // setas restantes usam busca curta relaxada e, por fim, o roteamento seguro.
    var started = clock(), panic = false, slow = false, emergency = false, SLOW_MS = 400, PANIC_MS = 800;

    function kindOfFlow(fi) {
      var f = flows[fi], S0 = boxes[f.from], T0 = boxes[f.to];
      if (f.from === f.to || T0.cx <= S0.cx + 20) return 'back';
      if (S0.boundary) return 'boundary';
      return 'fwd';
    }
    function portCost(p, role, kind, node) {
      var g = GATEWAYS[node.type], ev = !g && !ACTIVITIES[node.type];
      var side = p.side, c;
      if (kind === 'fwd' || kind === 'boundary') {
        if (role === 's') c = side === 'r' ? 0 : side === 'l' ? Infinity : g ? 12 : ev ? 40 : 90;
        else c = side === 'l' ? 0 : side === 'r' ? Infinity : g ? 12 : ev ? 30 : 90;
      } else {
        if (role === 's') c = side === 't' || side === 'b' ? 0 : side === 'r' ? 50 : 70;
        else c = side === 't' || side === 'b' ? 0 : side === 'l' ? 50 : 70;
      }
      if (g && p.off) c += 20;
      return c + Math.abs(p.off) * 0.4 + p.len;
    }

    // Pré-atribuição de portas por ordem angular: em divisões/junções, o ramo
    // mais acima usa a porta mais acima (vértice de cima), o da mesma linha a
    // porta central e o mais abaixo a de baixo. Evita cruzar na saída.
    var pref = {};
    graph.nodes.forEach(function (n) {
      var b = boxes[n.id]; if (!b || b.boundary) return;
      var plist = ports[n.id] || [], usedHere = {};
      [['s', 'r'], ['t', 'l']].forEach(function (rs) {
        var role = rs[0], side = rs[1], ends = [];
        flows.forEach(function (f, i) {
          if (!f || !boxes[f.from] || !boxes[f.to] || kindOfFlow(i) === 'back') return;
          if (role === 's' ? f.from !== n.id : f.to !== n.id) return;
          var o = boxes[role === 's' ? f.to : f.from];
          ends.push({ i: i, dy: o.cy - b.cy, dx: Math.abs(o.cx - b.cx) });
        });
        if (ends.length < 2) return;
        var sidePorts = plist.filter(function (p) { return p.side === side; }).sort(function (a, c) { return a.off - c.off; });
        var list = [];
        var top = plist.filter(function (p) { return p.side === 't' && p.off === 0; })[0], bot = plist.filter(function (p) { return p.side === 'b' && p.off === 0; })[0];
        var useTB = !ACTIVITIES[n.type] || ends.length > sidePorts.length;
        if (useTB && top) list.push(top);
        list = list.concat(sidePorts);
        if (useTB && bot) list.push(bot);
        var center = list.indexOf(sidePorts.filter(function (p) { return p.off === 0; })[0]);
        if (center < 0) return;
        var above = ends.filter(function (e) { return e.dy < 0; }).sort(function (a, c) { return a.dy - c.dy || c.dx - a.dx || a.i - c.i; });
        var same = ends.filter(function (e) { return e.dy === 0; }).sort(function (a, c) { return a.dx - c.dx || a.i - c.i; });
        var below = ends.filter(function (e) { return e.dy > 0; }).sort(function (a, c) { return c.dy - a.dy || c.dx - a.dx || a.i - c.i; });
        // cima/baixo já usados pelas saídas ficam para elas; as chegadas
        // pegam a próxima porta para dentro.
        var taken = {};
        list.forEach(function (p, j) { if (usedHere[pkey(p)]) taken[j] = 1; });
        var give = function (e, j) { pref[e.i + role] = pkey(list[j]); taken[j] = 1; usedHere[pkey(list[j])] = 1; };
        if (same.length && !taken[center]) give(same[0], center);
        var j = 0;
        above.forEach(function (e) { while (j < center && taken[j]) j++; if (j < center) give(e, j); });
        j = list.length - 1;
        below.forEach(function (e) { while (j > center && taken[j]) j--; if (j > center) give(e, j); });
      });
    });

    // Tocos das portas: passar por cima do toco de uma porta alheia custa
    // (muito, se ela já é a preferida de outra seta).
    var qRes = new Float64Array(count);
    // Tocos das portas centrais e das pré-atribuídas são exclusivos (nenhuma
    // outra seta passa por eles); os demais só custam um pouco.
    Object.keys(ports).forEach(function (id) { ports[id].forEach(function (p) { if (!qRes[p.q]) qRes[p.q] = p.off === 0 ? Infinity : 60; }); });
    Object.keys(pref).forEach(function (k) { var parts = pref[k].split('|'); (ports[parts[0]] || []).forEach(function (p) { if (pkey(p) === pref[k]) qRes[p.q] = Infinity; }); });
    // Custo de um cruzamento para cada seta: um desvio que deixaria a seta
    // com mais de ~2,5x a distância direta perde para o cruzamento.
    function crossCostOf(fi) {
      var f = flows[fi], a = boxes[f.from], b = boxes[f.to];
      var man = Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy);
      return Math.max(1600, Math.min(CROSS, 4 * man + 4 * BEND));
    }
    var prefOwner = {};
    Object.keys(pref).forEach(function (k) { prefOwner[pref[k]] = k; });
    var paths = {};
    // Busca A*: estado = vértice x eixo da chegada (0 horizontal, 1 vertical).
    function search(fi, relax, force, region) {
      var f = flows[fi], kind = kindOfFlow(fi), me = fi + 1;
      var tNode = S.byId[f.to], late = kind !== 'back', XC = crossCostOf(fi);
      var ls = boxes[f.from].lane, lt = boxes[f.to].lane;
      run++; hn = 0;
      var starts = {}, tminX = Infinity, tmaxX = -Infinity, tminY = Infinity, tmaxY = -Infinity, nt = 0;
      (ports[f.to] || []).forEach(function (p) {
        if (force && force.t && force.t !== pkey(p)) return;
        if ((portUsed[pkey(p)] || vUse[p.q]) && !relax) return;
        var c = portCost(p, 't', kind, tNode); if (!isFinite(c)) { if (!relax) return; c = 600; }
        if (pref[fi + 't'] && pref[fi + 't'] !== pkey(p)) c += 240;
        if (prefOwner[pkey(p)] !== undefined && prefOwner[pkey(p)] !== fi + 't') c += 300;
        if (portUsed[pkey(p)]) c += 4000;
        if (tStamp[p.q] !== run) { tStamp[p.q] = run; tAt[p.q] = []; }
        tAt[p.q].push({ port: p, cost: c }); nt++;
        var x = X(p.q % nx), y = Yc((p.q / nx) | 0);
        tminX = Math.min(tminX, x); tmaxX = Math.max(tmaxX, x); tminY = Math.min(tminY, y); tmaxY = Math.max(tmaxY, y);
      });
      if (!nt) return null;
      var heur = function (v) { var x = X(v % nx), y = Yc((v / nx) | 0), dx = Math.max(tminX - x, 0, x - tmaxX), dy = Math.max(tminY - y, 0, y - tmaxY); return dx + dy + (dx && dy ? BEND : 0); };
      var ri0 = 0, ri1 = nx - 1, rj0 = 0, rj1 = ny - 1;
      if (region) { ri0 = region[0]; ri1 = region[1]; rj0 = region[2]; rj1 = region[3]; }
      (ports[f.from] || []).forEach(function (p) {
        if (force && force.s && force.s !== pkey(p)) return;
        if ((portUsed[pkey(p)] || vUse[p.q]) && !relax) return;
        var c = portCost(p, 's', kind, S.byId[f.from]); if (!isFinite(c)) { if (!relax) return; c = 600; }
        if (pref[fi + 's'] && pref[fi + 's'] !== pkey(p)) c += 240;
        if (prefOwner[pkey(p)] !== undefined && prefOwner[pkey(p)] !== fi + 's') c += 300;
        if (portUsed[pkey(p)]) c += 4000;
        var st = p.q * 2 + p.axis;
        if (stamp[st] !== run || c < dist[st]) { stamp[st] = run; dist[st] = c; parent[st] = -1; starts[st] = p; hpush(c + 1.002 * heur(p.q), c, st); }
      });
      if (!hn) return null;
      var best = Infinity, bestState = -1, bestT = null, pops = 0, limit = relax ? 30000 : 20000;
      while (hn) {
        hpop();
        var key = popK, g = popG, st = popS;
        if (key >= best) break;
        if (g > dist[st] + 1e-9) continue;
        if (++pops > (emergency ? 2500 : limit)) break;
        totalPops++;
        if (!emergency && (totalPops & 4095) === 0) { var el = clock() - started; if (el > SLOW_MS) slow = true; if (el > PANIC_MS) { panic = true; break; } }
        var v = st >> 1, ax = st & 1;
        if (tStamp[v] === run) tAt[v].forEach(function (t) {
          var c = g + t.cost + (ax !== t.port.axis ? BEND : 0);
          if (c < best) { best = c; bestState = st; bestT = t; }
        });
        // toco de porta do destino: só se chega nele para terminar
        if (tStamp[v] === run && qRes[v] && !starts[st]) continue;
        var crossing = vUse[v] !== 0 && vUse[v] !== me && !starts[st];
        var vxI = v % nx, vyJ = (v / nx) | 0;
        for (var dir = 0; dir < 4; dir++) {
          var nax = dir >> 1;
          if (crossing && nax !== ax) continue;
          var w, e;
          if (dir === 0) { if (vxI + 1 > ri1) continue; w = v + 1; e = v; }
          else if (dir === 1) { if (vxI <= ri0) continue; w = v - 1; e = w; }
          else if (dir === 2) { if (vyJ + 1 > rj1) continue; w = v + nx; e = v; }
          else { if (vyJ <= rj0) continue; w = v - nx; e = w; }
          if (blocked[w]) continue;
          var extra = 0, occ = nax ? occV[e] : occH[e];
          if (occ && occ !== me) { if (!relax) continue; extra += 3000; }
          if (qRes[w] && tStamp[w] !== run) { if (qRes[w] === Infinity) { if (!relax) continue; extra += 2000; } else extra += qRes[w]; }
          var u1 = vUse[w];
          if (u1 && u1 !== me) {
            var k2 = vKind[w];
            if (vUse2[w] || k2 === 3 || k2 === (nax ? 2 : 1)) { if (!relax) continue; extra += 2500; }
            else extra += XC;
          }
          var lj = laneOfJ[(w / nx) | 0];
          var stepCost = GRID;
          if (nax && late) stepCost += 0.5 * (1 - (w % nx) / nx);
          if (lj !== ls && lj !== lt) stepCost += GRID * FOREIGN;
          if (!nax && nearBorder[vyJ]) stepCost += GRID * 0.5;
          var ng = g + stepCost + extra + (nax !== ax ? BEND : 0);
          var ns = w * 2 + nax;
          if (stamp[ns] !== run || ng < dist[ns] - 1e-9) {
            stamp[ns] = run; dist[ns] = ng; parent[ns] = st;
            hpush(ng + 1.002 * heur(w), ng, ns);
          }
        }
      }
      if (bestState < 0) return null;
      var verts = [], cur = bestState, sp = null;
      while (cur >= 0) { verts.push(cur >> 1); if (parent[cur] < 0) { sp = starts[cur]; break; } cur = parent[cur]; }
      verts.reverse();
      return { verts: verts, sp: sp, tp: bestT.port, cost: best };
    }
    // Busca em regiões crescentes: caixa da origem/destino com margem curta,
    // depois maior, e só então a grade inteira (se ainda houver cruzamento).
    function regionFor(fi, m) {
      var f = flows[fi], a = boxes[f.from], b = boxes[f.to];
      var x0 = Math.min(a.x, b.x) - m, x1 = Math.max(a.x + a.w, b.x + b.w) + m, y0 = Math.min(a.y, b.y) - m, y1 = Math.max(a.y + a.h, b.y + b.h) + m;
      return [Math.max(0, Math.floor((x0 - gx0) / GRID)), Math.min(nx - 1, Math.ceil((x1 - gx0) / GRID)), Math.max(0, Math.floor((y0 - gy0) / GRID)), Math.min(ny - 1, Math.ceil((y1 - gy0) / GRID))];
    }
    function route(fi, force) {
      if (clock() - started > SLOW_MS) slow = true;
      var r = search(fi, false, force, regionFor(fi, 112));
      if (slow) return r;
      var XC = crossCostOf(fi);
      if ((!r || r.cost >= XC) && (!r || totalPops < POP_LIMIT)) { var r2 = search(fi, false, force, regionFor(fi, 900)); if (r2 && (!r || r2.cost < r.cost)) r = r2; }
      if (!r || (r.cost >= XC && totalPops < POP_LIMIT * 0.9)) { var r3 = search(fi, false, force, null); if (r3 && (!r || r3.cost < r.cost)) r = r3; }
      return r;
    }
    function mark(fi, r) {
      var me = fi + 1, vs = r.verts;
      for (var k = 0; k + 1 < vs.length; k++) {
        var a = vs[k], b = vs[k + 1], h = Math.abs(a - b) === 1, e = Math.min(a, b);
        if (h) { if (!occH[e]) occH[e] = me; } else if (!occV[e]) occV[e] = me;
      }
      for (k = 0; k < vs.length; k++) {
        var v = vs[k], kind;
        if (k === 0 || k === vs.length - 1) kind = 3;
        else { var h1 = Math.abs(vs[k] - vs[k - 1]) === 1, h2 = Math.abs(vs[k + 1] - vs[k]) === 1; kind = h1 !== h2 ? 3 : h1 ? 1 : 2; }
        if (!vUse[v]) { vUse[v] = me; vKind[v] = kind; }
        else if (vUse[v] !== me && !vUse2[v]) vUse2[v] = me;
      }
      portUsed[pkey(r.sp)] = me; portUsed[pkey(r.tp)] = me;
      r.sres = qRes[r.sp.q]; r.tres = qRes[r.tp.q]; qRes[r.sp.q] = 0; qRes[r.tp.q] = 0;
    }
    function unmark(fi, r) {
      var me = fi + 1, vs = r.verts;
      for (var k = 0; k + 1 < vs.length; k++) {
        var a = vs[k], b = vs[k + 1], h = Math.abs(a - b) === 1, e = Math.min(a, b);
        if (h) { if (occH[e] === me) occH[e] = 0; } else if (occV[e] === me) occV[e] = 0;
      }
      for (k = 0; k < vs.length; k++) {
        var v = vs[k];
        if (vUse2[v] === me) vUse2[v] = 0;
        else if (vUse[v] === me) {
          if (vUse2[v]) { var o = vUse2[v]; vUse[v] = o; vUse2[v] = 0; vKind[v] = occH[v] === o || (v % nx > 0 && occH[v - 1] === o) ? 1 : 2; }
          else { vUse[v] = 0; vKind[v] = 0; }
        }
      }
      if (r.sres !== undefined) { qRes[r.sp.q] = r.sres; qRes[r.tp.q] = r.tres; }
      if (portUsed[pkey(r.sp)] === me) delete portUsed[pkey(r.sp)];
      if (portUsed[pkey(r.tp)] === me) delete portUsed[pkey(r.tp)];
    }
    function toPoints(r) {
      var ps = [r.sp.p];
      r.verts.forEach(function (v) { ps.push([X(v % nx), Yc((v / nx) | 0)]); });
      ps.push(r.tp.p);
      return simplifyPts(ps);
    }

    // Ordem: retas curtas primeiro, depois por extensão; voltas por último
    // (as internas antes, as externas contornam).
    var order = [];
    flows.forEach(function (f, i) { if (f && boxes[f.from] && boxes[f.to]) order.push(i); });
    function span(i) { var f = flows[i], a = boxes[f.from], b = boxes[f.to]; return Math.abs(a.cx - b.cx) + Math.abs(a.cy - b.cy); }
    var rankKind = { fwd: 0, boundary: 1, back: 2 };
    // Setas entre colunas vizinhas primeiro; as longas (que pulam colunas)
    // depois, contornando o que já está desenhado em vez de cortá-lo.
    // Num corredor, a seta que desce e começa mais acima dobra mais tarde
    // (mais à direita); a que sobe e começa mais abaixo, idem. Roteando nessa
    // ordem com preferência por dobra tardia, as verticais não se cruzam.
    function fkey(i) {
      var f = flows[i], a = boxes[f.from], b = boxes[f.to], dy = b.cy - a.cy, sy = a.cy;
      var pk = pref[i + 's'];
      if (pk) (ports[f.from] || []).forEach(function (p) { if (pkey(p) === pk) sy = p.p[1]; });
      return [a.boundary ? 1 : 0, Math.abs(b.col - a.col) > 1 ? 1 : 0, dy === 0 ? 0 : 1, a.cx, dy > 0 ? sy : dy < 0 ? -sy : 0, b.cx];
    }
    order.sort(function (a, b) {
      var ka = kindOfFlow(a), kb = kindOfFlow(b);
      if (rankKind[ka] !== rankKind[kb]) return rankKind[ka] - rankKind[kb];
      if (ka !== 'back') { var x = fkey(a), y = fkey(b); for (var k = 0; k < x.length; k++) if (x[k] !== y[k]) return x[k] - y[k]; return a - b; }
      return span(a) - span(b) || a - b;
    });
    // Uma passada = rotear todas as setas numa ordem + fase de melhoria.
    var passPops = 0;
    function runPass(ord) {
      var failed = [];
      ord.forEach(function (i) {
        var r = null;
        if (!panic) { r = route(i, null); if (!r && !panic) r = search(i, true, null, null); }
        if (!r) { emergency = true; r = search(i, true, null, regionFor(i, 160)); emergency = false; }
        if (r) { paths[i] = r; mark(i, r); } else failed.push(i);
      });
      // Melhoria: (a) troca as portas de pares que cruzam e dividem um nó;
      // (b) rerroteia cada seta que cruza, com as demais fixas. Só aceita se a
      // nota geométrica (comprimento + dobras + cruzamentos) melhorar.
      var ptsOf = {};
      function refreshPts(i) { ptsOf[i] = paths[i] ? toPoints(paths[i]) : null; }
      Object.keys(paths).forEach(function (i) { refreshPts(+i); });
      function crossCount(pa, pb) {
        var n = 0;
        for (var x = 1; x < pa.length; x++) for (var y = 1; y < pb.length; y++) {
          var s1 = [pa[x - 1], pa[x]], s2 = [pb[y - 1], pb[y]];
          var h1 = s1[0][1] === s1[1][1], h2 = s2[0][1] === s2[1][1]; if (h1 === h2) continue;
          var h = h1 ? s1 : s2, v = h1 ? s2 : s1;
          if (v[0][0] > Math.min(h[0][0], h[1][0]) && v[0][0] < Math.max(h[0][0], h[1][0]) && h[0][1] > Math.min(v[0][1], v[1][1]) && h[0][1] < Math.max(v[0][1], v[1][1])) n++;
        }
        return n;
      }
      function score(ids) {
        var total = 0;
        ids.forEach(function (i, k) {
          var ps = ptsOf[i]; if (!ps) { total += 1e7; return; }
          total += (ps.length - 2) * BEND;
          for (var m = 1; m < ps.length; m++) total += Math.abs(ps[m][0] - ps[m - 1][0]) + Math.abs(ps[m][1] - ps[m - 1][1]);
          Object.keys(ptsOf).forEach(function (j) { j = +j; if (j === i || !ptsOf[j] || (ids.indexOf(j) >= 0 && ids.indexOf(j) < k)) return; total += Math.min(crossCostOf(i), crossCostOf(j)) * crossCount(ps, ptsOf[j]); });
        });
        return total;
      }
      function crossingPairs() {
        var out = [], keys = Object.keys(ptsOf).map(Number).filter(function (i) { return ptsOf[i]; });
        for (var x = 0; x < keys.length; x++) for (var y = x + 1; y < keys.length; y++) { var c = crossCount(ptsOf[keys[x]], ptsOf[keys[y]]); if (c) out.push([keys[x], keys[y], c]); }
        return out;
      }
      function tryChange(ids, plan) {
        var before = score(ids), old = {};
        ids.forEach(function (i) { old[i] = paths[i]; unmark(i, paths[i]); });
        var ok = true;
        plan.forEach(function (st) { if (!ok) return; var r = route(st.i, st.force); if (!r) { ok = false; return; } paths[st.i] = r; mark(st.i, r); refreshPts(st.i); });
        if (ok && score(ids) < before - 1e-6) return true;
        ids.forEach(function (i) { if (paths[i] !== old[i] && paths[i]) unmark(i, paths[i]); });
        ids.forEach(function (i) { paths[i] = old[i]; });
        ids.forEach(function (i) { mark(i, old[i]); refreshPts(i); });
        return false;
      }
      for (var round = 0; round < 4 && !panic && !slow && totalPops < POP_LIMIT; round++) {
        var pairs = crossingPairs(), changed = false;
        if (!pairs.length) break;
        pairs.forEach(function (pr) {
          if (panic || slow || totalPops > POP_LIMIT) return;
          var a = pr[0], b = pr[1], fa = flows[a], fb = flows[b];
          if (!paths[a] || !paths[b] || !crossCount(ptsOf[a], ptsOf[b])) return;
          var pa = paths[a], pb = paths[b], plan = null;
          if (fa.from === fb.from) plan = [{ i: a, force: { s: pkey(pb.sp) } }, { i: b, force: { s: pkey(pa.sp) } }];
          else if (fa.to === fb.to) plan = [{ i: a, force: { t: pkey(pb.tp) } }, { i: b, force: { t: pkey(pa.tp) } }];
          if (plan && tryChange([a, b], plan)) { changed = true; return; }
          if (tryChange([a, b], [{ i: b }, { i: a }])) { changed = true; return; }
          if (tryChange([a, b], [{ i: a }, { i: b }])) changed = true;
        });
        if (!changed) break;
      }
      passPops += totalPops;
      return { paths: paths, failed: failed };
    }
    // (outras ordens de roteamento foram testadas: quase não mudam o total de
    // cruzamentos, que depende da ordem dos nós; por isso uma passada só)
    var best = runPass(order);
    paths = best.paths; var failed = best.failed;
    var routes = {};
    Object.keys(paths).forEach(function (i) { routes[i] = toPoints(paths[i]); });
    failed.forEach(function (i) { routes[i] = safeRoute(flows[i], boxes); });
    L.waypoints = routes;
    L.routeStats = { orderCross: S.orderCross, pops: passPops, failed: failed.length, slow: slow, panic: panic, ms: Math.round(clock() - started) };
  }

  function simplifyPts(ps) {
    var out = [];
    ps.forEach(function (p) {
      p = [Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100];
      var last = out[out.length - 1], prev = out[out.length - 2];
      if (last && Math.abs(p[0] - last[0]) < 0.01 && Math.abs(p[1] - last[1]) < 0.01) return;
      if (prev && ((Math.abs(prev[0] - last[0]) < 0.01 && Math.abs(last[0] - p[0]) < 0.01) || (Math.abs(prev[1] - last[1]) < 0.01 && Math.abs(last[1] - p[1]) < 0.01))) out.pop();
      out.push(p);
    });
    return out;
  }

  // Roteamento seguro (sem busca): sai pela direita/baixo e entra pela
  // esquerda/cima com uma ou duas dobras. Usado só se o roteador falhar.
  function safeRoute(f, boxes) {
    var a = boxes[f.from], b = boxes[f.to];
    if (!a || !b) return [[0, 0], [10, 0]];
    if (a.boundary) { var yb = Math.max(a.y + a.h + 24, b.cy); return simplifyPts([[a.cx, a.y + a.h], [a.cx, yb], [b.x - 24, yb], [b.x - 24, b.cy], [b.x, b.cy]]); }
    if (b.cx > a.cx + 20) {
      var mx = Math.round((a.x + a.w + b.x) / 2);
      return simplifyPts([[a.x + a.w, a.cy], [mx, a.cy], [mx, b.cy], [b.x, b.cy]]);
    }
    var top = Math.min(a.y, b.y) - 24;
    return simplifyPts([[a.cx, a.y], [a.cx, top], [b.cx, top], [b.cx, b.y]]);
  }

  // --- rótulos dos fluxos -------------------------------------------------------
  function placeFlowLabels(graph, L) {
    var boxes = L.boxes, routes = L.waypoints, labels = {};
    var X0 = POOL_X + LANE_LABEL_W, X1 = POOL_X + L.poolW, Y0 = POOL_Y, Y1 = POOL_Y + L.poolH;
    var borders = L.laneTop.slice(1);
    var segs = [];
    Object.keys(routes).forEach(function (i) { var ps = routes[i]; for (var k = 1; k < ps.length; k++) segs.push({ i: +i, a: ps[k - 1], b: ps[k] }); });
    var fixed = Object.keys(boxes).map(function (id) { return boxes[id]; }).concat(Object.keys(L.nodeLabels).map(function (id) { return L.nodeLabels[id]; }));
    function free(r) {
      if (r.x < X0 + 4 || r.x + r.w > X1 - 4 || r.y < Y0 + 4 || r.y + r.h > Y1 - 4) return false;
      for (var k = 0; k < borders.length; k++) if (borders[k] > r.y - 4 && borders[k] < r.y + r.h + 4) return false;
      for (k = 0; k < fixed.length; k++) if (overlaps(r, fixed[k], 4)) return false;
      for (var id in labels) if (overlaps(r, labels[id], 4)) return false;
      for (k = 0; k < segs.length; k++) if (segHits(segs[k].a, segs[k].b, r, 3)) return false;
      return true;
    }
    var idx = Object.keys(routes).map(Number).filter(function (i) { return graph.flows[i] && graph.flows[i].label; }).sort(function (a, b) { return a - b; });
    var far = [];
    function placeOne(i) {
      var f = graph.flows[i], ps = routes[i], sz = labelSize(f.label), found = null;
      // trecho por trecho a partir da saída; em cada um, da folga menor à maior
      for (var k = 1; k < ps.length && !found; k++) [[4, 0], [10, 0], [4, 1], [16, 1], [22, 1]].forEach(function (mode) {
        if (found) return;
        var gapD = mode[0], wide = mode[1];
        {
          var a = ps[k - 1], b = ps[k], h = Math.abs(a[1] - b[1]) < 0.01, len = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]);
          var dir = h ? Math.sign(b[0] - a[0]) : Math.sign(b[1] - a[1]), ext = h ? sz.w : sz.h;
          // primeiro sobre o trecho; depois deixando o rótulo passar das pontas
          for (var t = wide ? 12 - ext : 6; t <= Math.max(6, len - (wide ? 12 : 6)) && !found; t += 6) {
            var cands;
            if (h) {
              var x = dir > 0 ? a[0] + t : a[0] - t - sz.w;
              cands = [rect(x, a[1] - gapD - sz.h, sz.w, sz.h), rect(x, a[1] + gapD, sz.w, sz.h)];
            } else {
              var y = dir > 0 ? a[1] + t : a[1] - t - sz.h;
              cands = [rect(a[0] + gapD, y, sz.w, sz.h), rect(a[0] - gapD - sz.w, y, sz.w, sz.h)];
            }
            for (var c = 0; c < cands.length && !found; c++) if (free(cands[c])) found = cands[c];
          }
        }
      });
      // Busca radial (rótulo um pouco mais longe, mas sem sobrepor nada).
      if (!found) {
        far.push(i);
        var a0 = ps[0], b0 = ps[1] || ps[0];
        var base = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
        for (var rad = 8; rad < 400 && !found; rad += 8) {
          for (var ang = 0; ang < 16 && !found; ang++) {
            var cx = base[0] + Math.cos(ang * Math.PI / 8) * rad, cy = base[1] + Math.sin(ang * Math.PI / 8) * rad;
            var r = rect(cx - sz.w / 2, cy - sz.h / 2, sz.w, sz.h);
            if (free(r)) found = r;
          }
        }
      }
      if (!found) found = rect(ps[0][0] + 6, ps[0][1] - sz.h - 6, sz.w, sz.h);
      labels[i] = rect(Math.round(found.x), Math.round(found.y), sz.w, sz.h);
    }
    idx.forEach(placeOne);
    // Rótulo que não coube perto da seta: refaz a colocação começando por ele.
    if (far.length) {
      var first = { labels: labels, far: far };
      labels = {}; var again = far.slice(); far = [];
      again.concat(idx.filter(function (i) { return again.indexOf(i) < 0; })).forEach(placeOne);
      if (far.length >= first.far.length) labels = first.labels;
    }
    L.flowLabels = labels;
  }

  // --- compactação: remove faixas vazias ----------------------------------------
  // Cada elemento ocupa um intervalo no eixo, com uma folga própria; a parte
  // do eixo que não é coberta por nenhum intervalo+folga é removida. A ordem e
  // a topologia não mudam; distâncias só diminuem até a soma das folgas.
  function compact(graph, L) {
    var boxes = L.boxes, routes = L.waypoints, nl = L.labels;
    function run(axis) {
      var feats = [], P = axis ? 1 : 0, xy = axis ? 'y' : 'x', wh = axis ? 'h' : 'w';
      Object.keys(boxes).forEach(function (id) { var b = boxes[id]; feats.push([b[xy], b[xy] + b[wh], axis ? 20 : 30]); });
      [L.nodeLabels, L.flowLabels].forEach(function (m) { Object.keys(m).forEach(function (id) { var b = m[id]; feats.push([b[xy], b[xy] + b[wh], 8]); }); });
      Object.keys(routes).forEach(function (i) {
        var ps = routes[i];
        for (var k = 1; k < ps.length; k++) {
          var a = ps[k - 1], b = ps[k];
          if (Math.abs(a[P] - b[P]) < 0.01) feats.push([a[P], a[P], 8]);
        }
        feats.push([ps[0][P], ps[0][P], 0]); feats.push([ps[ps.length - 1][P], ps[ps.length - 1][P], 0]);
      });
      var lo = axis ? POOL_Y : POOL_X + LANE_LABEL_W;
      feats.push([lo, lo, axis ? 16 : 40]);
      if (axis) L.laneTop.forEach(function (t, l) { feats.push([t, t, 16]); feats.push([t + L.laneH[l], t + L.laneH[l], 16]); });
      feats.sort(function (a, b) { return (a[0] - a[2]) - (b[0] - b[2]); });
      var cuts = [], reach = -Infinity;
      feats.forEach(function (f) {
        var a = f[0] - f[2], b = f[1] + f[2];
        if (reach > -Infinity && a > reach + 0.5) cuts.push([reach, a]);
        reach = Math.max(reach, b);
      });
      // Raia nunca fica menor que o mínimo (nome da raia legível).
      if (axis) {
        var minH = L.lanes.map(function (name) { return Math.max(120, Math.min(220, String(name).length * 7 + 24)); });
        L.laneTop.forEach(function (t, l) {
          var bot = t + L.laneH[l], inside = cuts.filter(function (c) { return c[0] >= t && c[1] <= bot; });
          var total = inside.reduce(function (s, c) { return s + c[1] - c[0]; }, 0), excess = total - (L.laneH[l] - minH[l]);
          // devolve o excesso, começando pelos cortes de baixo
          for (var k = inside.length - 1; k >= 0 && excess > 0; k--) { var c = inside[k], give = Math.min(excess, c[1] - c[0]); c[1] -= give; excess -= give; }
        });
      }
      cuts = cuts.filter(function (c) { return c[1] - c[0] > 0.5; }).map(function (c) { return [c[0], c[1]]; });
      function f(v) {
        var d = 0;
        for (var k = 0; k < cuts.length; k++) { var c = cuts[k]; if (v >= c[1]) d += c[1] - c[0]; else if (v > c[0]) d += v - c[0]; }
        return Math.round((v - d) * 100) / 100;
      }
      Object.keys(boxes).forEach(function (id) { var b = boxes[id], n = f(b[xy]); b[xy] = n; if (axis) b.cy = n + b.h / 2; else b.cx = n + b.w / 2; });
      [L.nodeLabels, L.flowLabels].forEach(function (m) { Object.keys(m).forEach(function (id) { m[id][xy] = f(m[id][xy]); }); });
      Object.keys(routes).forEach(function (i) { routes[i] = routes[i].map(function (p) { var q = p.slice(); q[P] = f(p[P]); return q; }); });
      if (axis) {
        var ends = L.laneTop.map(function (t, l) { return f(t + L.laneH[l]); });
        L.laneTop = L.laneTop.map(f);
        L.laneH = ends.map(function (e, l) { return e - L.laneTop[l]; });
        L.poolH = ends[ends.length - 1] - POOL_Y;
      } else {
        var right = POOL_X + LANE_LABEL_W + 40;
        Object.keys(boxes).forEach(function (id) { right = Math.max(right, boxes[id].x + boxes[id].w); });
        [L.nodeLabels, L.flowLabels].forEach(function (m) { Object.keys(m).forEach(function (id) { right = Math.max(right, m[id].x + m[id].w); }); });
        Object.keys(routes).forEach(function (i) { routes[i].forEach(function (p) { right = Math.max(right, p[0]); }); });
        L.poolW = Math.round(right + 48 - POOL_X);
      }
    }
    run(1); run(0);
  }

  // Layout de emergência: nunca lança. Nós em sequência por raia.
  function safeLayout(graph) {
    var lanes = (graph.lanes || []).slice(), boxes = {}, col = 0;
    graph.nodes.forEach(function (n) { if (lanes.indexOf(n.lane) < 0) lanes.push(n.lane); });
    if (!lanes.length) lanes.push('Processo');
    var laneH = lanes.map(function () { return 200; }), laneTop = lanes.map(function (_, l) { return POOL_Y + 200 * l; });
    graph.nodes.forEach(function (n) {
      if (n.type === 'boundaryTimer') return;
      var sz = (SIZE[n.type] || SIZE.task).slice(), l = Math.max(0, lanes.indexOf(n.lane));
      var cx = POOL_X + LANE_LABEL_W + 100 + 180 * col++, cy = laneTop[l] + 100;
      boxes[n.id] = { x: cx - sz[0] / 2, y: cy - sz[1] / 2, w: sz[0], h: sz[1], cx: cx, cy: cy, col: col, row: 0, lane: l };
    });
    graph.nodes.forEach(function (n) {
      var h = n.type === 'boundaryTimer' && boxes[n.attachedTo]; if (!h) return;
      boxes[n.id] = { x: h.x + h.w - 40, y: h.y + h.h - 18, w: 36, h: 36, cx: h.x + h.w - 22, cy: h.y + h.h, col: h.col, row: 0, lane: h.lane, boundary: true };
    });
    var routes = {};
    (graph.flows || []).forEach(function (f, i) { if (f && boxes[f.from] && boxes[f.to]) routes[i] = safeRoute(f, boxes); });
    return { lanes: lanes, laneTop: laneTop, laneH: laneH, poolW: Math.max(400, 180 * col + 200), poolH: 200 * lanes.length, boxes: boxes, back: {}, waypoints: routes, nodeLabels: {}, flowLabels: {}, safe: true };
  }

  function layoutGraph(graph) {
    var S, L;
    try {
      S = structure(graph); orderRows(S); L = place(graph, S);
    } catch (e) { L = safeLayout(graph); L.error = String(e && e.message || e); return L; }
    try { routeGraph(graph, L, S); }
    catch (e) {
      L.error = String(e && e.message || e); L.waypoints = {};
      (graph.flows || []).forEach(function (f, i) { if (f && L.boxes[f.from] && L.boxes[f.to]) L.waypoints[i] = safeRoute(f, L.boxes); });
    }
    try { placeFlowLabels(graph, L); } catch (e) { L.error = String(e && e.message || e); L.flowLabels = L.flowLabels || {}; }
    try { compact(graph, L); } catch (e) { L.error = String(e && e.message || e); }
    return L;
  }
  function colorAttrsFor(actColor) {
    var act = actColor && actColor.fill ? actColor : { fill: '#dbeafe', stroke: '#1c5cff' };
    var SCHEME = {
      startEvent: { fill: '#dcfce7', stroke: '#16a34a' },
      endEvent: { fill: '#fee2e2', stroke: '#dc2626' },
      gateway: { fill: '#fef9c3', stroke: '#ca8a04' },
      timer: { fill: '#e0f2fe', stroke: '#0284c7' },
      task: act
    };
    return function (type) {
      var c = GATEWAYS[type] ? SCHEME.gateway : (type === 'timerEvent' || type === 'boundaryTimer') ? SCHEME.timer : SCHEME[type] || SCHEME.task;
      return ' bioc:stroke="' + c.stroke + '" bioc:fill="' + c.fill + '" color:background-color="' + c.fill + '" color:border-color="' + c.stroke + '"';
    };
  }

  // id de cada nó do grafo -> id no XML (NCName, sem repetição).
  function xmlIds(graph) {
    var ids = {}, used = {};
    graph.nodes.forEach(function (n) { var b = xmlId(n.id), id = b, k = 1; while (used[id]) id = b + '_' + (++k); used[id] = 1; ids[n.id] = id; });
    return ids;
  }

  // Devolve { xml, summary } prontos para o bpmn-js e para download.
  function buildXml(graph, actColor) {
    if (!graph || !graph.nodes || !graph.nodes.length) throw new Error('vazio');
    var L = layoutGraph(graph), colorOf = colorAttrsFor(actColor);
    var ids = xmlIds(graph);
    var byId = {}; graph.nodes.forEach(function (n) { byId[n.id] = n; });
    var flows = graph.flows.filter(function (f, i) { return ids[f.from] && ids[f.to] && L.waypoints[i]; });
    var flowId = function (f) { return 'Flow_' + (graph.flows.indexOf(f) + 1); };

    var elTag = function (n) {
      var id = ids[n.id], name = ' name="' + esc(n.name) + '"';
      switch (n.type) {
        case 'startEvent':
        case 'endEvent': {
          var def = eventDefXml(eventTypeOf(n), id);
          return '    <' + n.type + ' id="' + id + '"' + name + (def ? '>' + def + '</' + n.type + '>' : '/>');
        }
        case 'timerEvent': return '    <intermediateCatchEvent id="' + id + '"' + name + '><timerEventDefinition id="' + id + '_def"/></intermediateCatchEvent>';
        case 'boundaryTimer': return '    <boundaryEvent id="' + id + '"' + name + ' attachedToRef="' + ids[n.attachedTo] + '"' + (n.interrupting === false ? ' cancelActivity="false"' : '') + '><timerEventDefinition id="' + id + '_def"/></boundaryEvent>';
        case 'subProcess': return '    <subProcess id="' + id + '"' + name + '/>';
        case 'task': return '    <' + (TASK_TAG[n.taskType] || 'task') + ' id="' + id + '"' + name + '/>';
        default: return '    <' + n.type + ' id="' + id + '"' + (n.name ? name : '') + '/>';
      }
    };
    var flowTag = function (f) { return '    <sequenceFlow id="' + flowId(f) + '"' + (f.label ? ' name="' + esc(f.label) + '"' : '') + ' sourceRef="' + ids[f.from] + '" targetRef="' + ids[f.to] + '"/>'; };
    var laneMembers = L.lanes.map(function () { return []; });
    graph.nodes.forEach(function (n) { var b = L.boxes[n.id]; if (b) laneMembers[b.lane].push(ids[n.id]); });
    var laneTag = function (name, i) {
      return '      <lane id="Lane_' + (i + 1) + '" name="' + esc(name) + '">\n' + laneMembers[i].map(function (id) { return '        <flowNodeRef>' + id + '</flowNodeRef>'; }).join('\n') + (laneMembers[i].length ? '\n' : '') + '      </lane>';
    };
    var labelTag = function (b) { return b ? '\n        <bpmndi:BPMNLabel><omgdc:Bounds x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '"/></bpmndi:BPMNLabel>' : ''; };
    var shapeTag = function (n) {
      var b = L.boxes[n.id]; if (!b) return '';
      var extra = n.type === 'exclusiveGateway' ? ' isMarkerVisible="true"' : n.type === 'subProcess' ? ' isExpanded="false"' : '';
      return '      <bpmndi:BPMNShape id="' + ids[n.id] + '_di" bpmnElement="' + ids[n.id] + '"' + extra + colorOf(n.type) + '>\n        <omgdc:Bounds x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '"/>' + labelTag(L.nodeLabels[n.id]) + '\n      </bpmndi:BPMNShape>';
    };
    var edgeTag = function (f) {
      return '      <bpmndi:BPMNEdge id="' + flowId(f) + '_di" bpmnElement="' + flowId(f) + '">\n' + L.waypoints[graph.flows.indexOf(f)].map(function (p) { return '        <omgdi:waypoint x="' + p[0] + '" y="' + p[1] + '"/>'; }).join('\n') + labelTag(L.flowLabels[graph.flows.indexOf(f)]) + '\n      </bpmndi:BPMNEdge>';
    };
    var laneX = POOL_X + LANE_LABEL_W, laneW = L.poolW - LANE_LABEL_W;
    var laneShape = function (name, i) { return '      <bpmndi:BPMNShape id="Lane_' + (i + 1) + '_di" bpmnElement="Lane_' + (i + 1) + '" isHorizontal="true">\n        <omgdc:Bounds x="' + laneX + '" y="' + L.laneTop[i] + '" width="' + laneW + '" height="' + L.laneH[i] + '"/>\n      </bpmndi:BPMNShape>'; };
    // Boundary events vêm depois das atividades no DI para ficarem por cima.
    var shapes = graph.nodes.filter(function (n) { return n.type !== 'boundaryTimer'; }).concat(graph.nodes.filter(function (n) { return n.type === 'boundaryTimer'; }));

    var xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:omgdc="http://www.omg.org/spec/DD/20100524/DC" xmlns:omgdi="http://www.omg.org/spec/DD/20100524/DI" xmlns:bioc="http://bpmn.io/schema/bpmn/biocolor/1.0" xmlns:color="http://www.omg.org/spec/BPMN/non-normative/color/1.0" targetNamespace="http://bpmn.io/schema/bpmn" id="Definitions_ARI">\n' +
      '  <collaboration id="Collaboration_1">\n    <participant id="Participant_1" name="' + esc(graph.processName || 'Processo') + '" processRef="Process_1"/>\n  </collaboration>\n' +
      '  <process id="Process_1" isExecutable="false">\n    <laneSet id="LaneSet_1">\n' + L.lanes.map(laneTag).join('\n') + '\n    </laneSet>\n' +
      graph.nodes.map(elTag).join('\n') + '\n' + flows.map(flowTag).join('\n') + '\n  </process>\n' +
      '  <bpmndi:BPMNDiagram id="BPMNDiagram_1">\n    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Collaboration_1">\n' +
      '      <bpmndi:BPMNShape id="Participant_1_di" bpmnElement="Participant_1" isHorizontal="true">\n        <omgdc:Bounds x="' + POOL_X + '" y="' + POOL_Y + '" width="' + L.poolW + '" height="' + L.poolH + '"/>\n      </bpmndi:BPMNShape>\n' +
      L.lanes.map(laneShape).join('\n') + '\n' + shapes.map(shapeTag).filter(Boolean).join('\n') + '\n' + flows.map(edgeTag).join('\n') + '\n' +
      '    </bpmndi:BPMNPlane>\n  </bpmndi:BPMNDiagram>\n</definitions>\n';

    var count = function (pred) { return graph.nodes.filter(pred).length; };
    var summary = 'MAPEAMENTO BPMN GERADO\n\n' + (graph.processName || 'Processo') + '\nRaias: ' + L.lanes.join(', ') + '\n\n' +
      count(function (n) { return ACTIVITIES[n.type]; }) + ' atividade(s), ' +
      count(function (n) { return n.type === 'exclusiveGateway' || n.type === 'inclusiveGateway'; }) + ' gateway(s) de decisão, ' +
      count(function (n) { return n.type === 'parallelGateway'; }) + ' gateway(s) paralelo(s), ' +
      count(function (n) { return n.type === 'timerEvent' || n.type === 'boundaryTimer'; }) + ' evento(s) de tempo, ' +
      count(function (n) { return n.type === 'endEvent'; }) + ' fim(ns).\n' +
      'Clique em "Baixar arquivo .bpmn" — abre no bpmn.io, Camunda e Bizagi.';
    return { xml: xml, summary: summary };
  }

  // Converte a estrutura antiga (lista de tarefas e decisões sim/não, usada pela
  // leitura automática offline e por mapeamentos salvos antes da mudança).
  function legacyToGraph(list) {
    var nodes = [], flows = [], lanes = [], k = 0;
    var lane = function (a) { a = String(a || '').trim() || 'Processo'; if (lanes.indexOf(a) < 0) lanes.push(a); return a; };
    var add = function (type, name, actor) { var n = { id: type.charAt(0) + '_' + (++k), type: type, name: name || '', lane: lane(actor), taskType: 'none', eventType: 'none', attachedTo: '', interrupting: false }; nodes.push(n); return n; };
    var link = function (exits, to) { exits.forEach(function (e) { flows.push({ from: e.id, to: to.id, label: e.label || '' }); }); };
    var merge = function (exits) {
      var out = [];
      exits.forEach(function (e) { var s = out.filter(function (o) { return o.id === e.id; })[0]; if (s) s.label = [s.label, e.label].filter(Boolean).join(' / '); else out.push({ id: e.id, label: e.label }); });
      return out;
    };
    var firstActor = list[0] && list[0].actor;
    var start = add('startEvent', 'Início', firstActor);
    var exits = [{ id: start.id, label: '' }];
    var join = function (actor) { if (exits.length < 2) return; var j = add('exclusiveGateway', '', actor); link(exits, j); exits = [{ id: j.id, label: '' }]; };
    (list || []).forEach(function (n) {
      join(n.actor);
      if (n.type === 'decision') {
        var gw = add('exclusiveGateway', n.name || 'Decisão?', n.actor);
        link(exits, gw);
        var branch = function (tasks, label) {
          if (!tasks || !tasks.length) return [{ id: gw.id, label: label }];
          var prev = null;
          tasks.forEach(function (t, i) { var tn = add('task', t.name, t.actor || n.actor); flows.push({ from: i ? prev.id : gw.id, to: tn.id, label: i ? '' : label }); prev = tn; });
          return [{ id: prev.id, label: '' }];
        };
        exits = merge(branch(n.sim, 'Sim').concat(branch(n.nao, 'Não')));
      } else {
        var t = add('task', n.name, n.actor);
        link(exits, t); exits = [{ id: t.id, label: '' }];
      }
    });
    join(list.length && list[list.length - 1].actor);
    var end = add('endEvent', 'Fim', list.length && list[list.length - 1].actor);
    link(exits, end);
    return { processName: 'Processo', lanes: lanes, nodes: nodes, flows: flows };
  }

  // Diagrama editado à mão (definições do bpmn-js / moddle) → grafo do ARI.
  // Mantém o que muda a lógica (elementos, nomes, raias, ligações das setas);
  // posições ficam só no XML editado.
  var TASK_OF = {
    'bpmn:Task': 'none', 'bpmn:UserTask': 'user', 'bpmn:ServiceTask': 'service', 'bpmn:ManualTask': 'manual',
    'bpmn:SendTask': 'send', 'bpmn:ReceiveTask': 'receive', 'bpmn:ScriptTask': 'script', 'bpmn:BusinessRuleTask': 'businessRule'
  };
  var EVENT_OF = {
    'bpmn:MessageEventDefinition': 'message', 'bpmn:TimerEventDefinition': 'timer', 'bpmn:SignalEventDefinition': 'signal',
    'bpmn:ConditionalEventDefinition': 'conditional', 'bpmn:TerminateEventDefinition': 'terminate',
    'bpmn:ErrorEventDefinition': 'error', 'bpmn:EscalationEventDefinition': 'escalation'
  };
  function xmlToGraph(defs) {
    var roots = (defs && defs.rootElements) || [];
    var procs = roots.filter(function (r) { return r.$type === 'bpmn:Process'; });
    var collab = roots.filter(function (r) { return r.$type === 'bpmn:Collaboration'; })[0];
    var part = collab && collab.participants && collab.participants[0];
    var lanes = [], laneOf = {};
    var walkLanes = function (sets) {
      (sets || []).forEach(function (ls) {
        (ls && ls.lanes || []).forEach(function (l) {
          var name = String(l.name || '').trim() || 'Raia ' + (lanes.length + 1);
          if (lanes.indexOf(name) < 0) lanes.push(name);
          (l.flowNodeRef || []).forEach(function (n) { if (n && n.id) laneOf[n.id] = name; });
          if (l.childLaneSet) walkLanes([l.childLaneSet]);
        });
      });
    };
    procs.forEach(function (p) { walkLanes(p.laneSets); });
    var hasDef = function (el, t) { return (el.eventDefinitions || []).some(function (d) { return d.$type === t; }); };
    // Primeira definição reconhecida que vale para o evento (início ou fim).
    var eventOf = function (el, list) {
      var defs = el.eventDefinitions || [];
      for (var i = 0; i < defs.length; i++) { var v = EVENT_OF[defs[i] && defs[i].$type]; if (v && allowed(list, v)) return v; }
      return 'none';
    };
    var nodes = [], flows = [];
    procs.forEach(function (p) {
      (p.flowElements || []).forEach(function (el) {
        var t = el.$type;
        if (t === 'bpmn:SequenceFlow') {
          if (el.sourceRef && el.targetRef) flows.push({ from: el.sourceRef.id, to: el.targetRef.id, label: String(el.name || '').trim() });
          return;
        }
        var n = null;
        if (t === 'bpmn:StartEvent') n = { type: 'startEvent', eventType: eventOf(el, TYPE_OPTIONS.start) };
        else if (t === 'bpmn:EndEvent') n = { type: 'endEvent', eventType: eventOf(el, TYPE_OPTIONS.end) };
        else if (TASK_OF[t]) n = { type: 'task', taskType: TASK_OF[t] };
        else if (t === 'bpmn:SubProcess' || t === 'bpmn:CallActivity' || t === 'bpmn:Transaction' || t === 'bpmn:AdHocSubProcess') n = { type: 'subProcess' };
        else if (t === 'bpmn:ParallelGateway') n = { type: 'parallelGateway' };
        else if (t === 'bpmn:InclusiveGateway') n = { type: 'inclusiveGateway' };
        else if (/Gateway$/.test(t)) n = { type: 'exclusiveGateway' };
        else if (t === 'bpmn:BoundaryEvent') n = { type: 'boundaryTimer', attachedTo: el.attachedToRef ? el.attachedToRef.id : '', interrupting: el.cancelActivity !== false };
        else if (t === 'bpmn:IntermediateCatchEvent' && hasDef(el, 'bpmn:TimerEventDefinition')) n = { type: 'timerEvent' };
        // Outros eventos intermediários (mensagem, sinal...) viram tarefa de envio/recebimento.
        else if (t === 'bpmn:IntermediateCatchEvent') n = { type: 'task', taskType: 'receive' };
        else if (t === 'bpmn:IntermediateThrowEvent') n = { type: 'task', taskType: 'send' };
        if (!n) return; // objetos de dados, anotações etc.
        nodes.push({
          id: el.id, type: n.type, name: String(el.name || '').trim(), lane: laneOf[el.id] || '',
          taskType: n.taskType || 'none', eventType: n.eventType || 'none', attachedTo: n.attachedTo || '', interrupting: !!n.interrupting
        });
      });
    });
    return { processName: String(part && part.name || procs[0] && procs[0].name || 'Processo').trim(), lanes: lanes.length ? lanes : ['Processo'], nodes: nodes, flows: flows };
  }

  // Troca o tipo de um elemento num XML editado à mão sem refazer o desenho: o
  // DI (posições, tamanhos e dobras das setas) e o id ficam iguais. Início/fim
  // (value = eventType) trocam a definição do evento; atividades (value =
  // taskType) trocam a tag (userTask, scriptTask…). Devolve o XML novo, ou null
  // se o elemento não existe ou não é de um tipo que dá para trocar aqui (ex.:
  // evento intermediário que o grafo trata como atividade). dom = { DOMParser,
  // XMLSerializer } (padrão: os do navegador).
  var BPMN_NS = 'http://www.omg.org/spec/BPMN/20100524/MODEL', XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance', XMLNS_NS = 'http://www.w3.org/2000/xmlns/';
  var TASK_LOCAL = { task: 1, userTask: 1, serviceTask: 1, manualTask: 1, sendTask: 1, receiveTask: 1, scriptTask: 1, businessRuleTask: 1 };
  // Atributos e filhos que só valem para um tipo de atividade (somem na troca).
  var TASK_ONLY_ATTRS = { scriptFormat: 1, messageRef: 1, instantiate: 1, implementation: 1, operationRef: 1 };
  function retypeXml(xml, id, value, dom) {
    dom = dom || root;
    if (!dom.DOMParser || !dom.XMLSerializer) return null;
    var doc = new dom.DOMParser().parseFromString(String(xml || ''), 'application/xml');
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) return null;
    var all = doc.getElementsByTagNameNS(BPMN_NS, '*'), el = null, ids = {};
    for (var i = 0; i < all.length; i++) {
      var aid = all[i].getAttribute('id');
      if (aid) ids[aid] = 1;
      if (!el && aid === id) el = all[i];
    }
    if (!el) return null;
    var prefix = el.prefix, local = el.localName;
    var qn = function (name) { return prefix ? prefix + ':' + name : name; };
    var isBlank = function (c) { return c && c.nodeType === 3 && !/\S/.test(c.nodeValue); };
    var drop = function (c) { if (isBlank(c.previousSibling)) c.parentNode.removeChild(c.previousSibling); c.parentNode.removeChild(c); };
    if (local === 'startEvent' || local === 'endEvent') {
      if (!allowed(local === 'startEvent' ? TYPE_OPTIONS.start : TYPE_OPTIONS.end, value)) return null;
      Array.prototype.slice.call(el.childNodes).forEach(function (c) {
        if (c.nodeType === 1 && c.namespaceURI === BPMN_NS && /EventDefinition(Ref)?$/.test(c.localName)) { delete ids[c.getAttribute('id')]; drop(c); }
      });
      if (EVENT_DEF[value]) {
        var defId = id + '_def', k = 1;
        while (ids[defId]) defId = id + '_def' + (++k);
        var def = doc.createElementNS(BPMN_NS, qn(EVENT_DEF[value]));
        def.setAttribute('id', defId);
        if (value === 'conditional') {
          var rootEl = doc.documentElement;
          if (!rootEl.getAttribute('xmlns:xsi')) rootEl.setAttributeNS(XMLNS_NS, 'xmlns:xsi', XSI_NS);
          var cond = doc.createElementNS(BPMN_NS, qn('condition'));
          cond.setAttributeNS(XSI_NS, 'xsi:type', qn('tFormalExpression'));
          def.appendChild(cond);
        }
        // Mantém a indentação do XML formatado (definição depois de incoming/outgoing).
        var firstEl = null;
        for (var c = el.firstChild; c; c = c.nextSibling) if (c.nodeType === 1) { firstEl = c; break; }
        var indent = firstEl && isBlank(firstEl.previousSibling) ? firstEl.previousSibling.nodeValue : null;
        if (indent && isBlank(el.lastChild)) {
          el.insertBefore(doc.createTextNode(indent), el.lastChild);
          el.insertBefore(def, el.lastChild);
        } else el.appendChild(def);
      }
    } else if (TASK_LOCAL[local]) {
      if (value !== 'none' && !TASK_TAG[value]) return null;
      var tag = TASK_TAG[value] || 'task';
      if (tag !== local) {
        var nu = doc.createElementNS(BPMN_NS, qn(tag));
        Array.prototype.slice.call(el.attributes).forEach(function (a) {
          if (!a.namespaceURI && TASK_ONLY_ATTRS[a.localName || a.name]) return;
          if (a.namespaceURI) nu.setAttributeNS(a.namespaceURI, a.name, a.value);
          else nu.setAttribute(a.name, a.value);
        });
        Array.prototype.slice.call(el.childNodes).forEach(function (ch) {
          if (ch.nodeType === 1 && ch.namespaceURI === BPMN_NS && ch.localName === 'script') return;
          nu.appendChild(ch);
        });
        el.parentNode.replaceChild(nu, el);
      }
    } else return null;
    var out = new dom.XMLSerializer().serializeToString(doc);
    if (/^\s*<\?xml/.test(xml) && !/^\s*<\?xml/.test(out)) out = '<?xml version="1.0" encoding="UTF-8"?>\n' + out;
    return out;
  }

  // Ids dos eventos intermediários de um XML editado à mão. Os de mensagem,
  // sinal etc. entram no grafo como atividade de envio/recebimento, mas
  // retypeXml não os troca: o painel mostra esses itens desabilitados.
  function intermediateIds(xml, dom) {
    dom = dom || root;
    var out = {};
    if (!dom.DOMParser) return out;
    var doc = null;
    try { doc = new dom.DOMParser().parseFromString(String(xml || ''), 'application/xml'); } catch (_) { return out; } // xmldom lança em XML inválido
    if (!doc || !doc.documentElement || doc.getElementsByTagName('parsererror').length) return out;
    ['intermediateCatchEvent', 'intermediateThrowEvent'].forEach(function (tag) {
      var list = doc.getElementsByTagNameNS(BPMN_NS, tag);
      for (var i = 0; i < list.length; i++) { var id = list[i].getAttribute('id'); if (id) out[id] = 1; }
    });
    return out;
  }

  root.AriBpmn = { layoutGraph: layoutGraph, buildXml: buildXml, xmlIds: xmlIds, legacyToGraph: legacyToGraph, xmlToGraph: xmlToGraph, retypeXml: retypeXml, intermediateIds: intermediateIds, eventTypeOf: eventTypeOf, TYPE_OPTIONS: TYPE_OPTIONS };
})(typeof window !== 'undefined' ? window : globalThis);
