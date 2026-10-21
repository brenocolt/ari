// Layout automático e XML BPMN 2.0 do mapeamento da ARI.
//
// Recebe o grafo (nós + fluxos, ver bpmn-graph.js) e posiciona tudo em raias:
//   1. setas de volta (ciclos de retrabalho) são detectadas por busca em
//      profundidade a partir do início;
//   2. sem elas o grafo é acíclico; cada nó vai para a coluna do caminho mais
//      longo desde o início, e para a raia do seu responsável;
//   3. nós que caem na mesma coluna e raia ganham linhas próprias;
//   4. as setas são roteadas em ângulo reto por corredores livres (entre
//      colunas e nas faixas acima/abaixo de cada linha), sem cruzar caixas.
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
  var COL_W = 180, ROW_H = 140, LANE_LABEL_W = 30, POOL_X = 160, POOL_Y = 80, PAD_LEFT = 100, PAD_RIGHT = 80;
  var TRACKS = [0, 8, -8, 16, -16, 24, -24, 32, -32];
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

  function layoutGraph(graph) {
    var nodes = graph.nodes, byId = {}, order = {};
    nodes.forEach(function (n, i) { byId[n.id] = n; order[n.id] = i; });
    var isBoundary = function (id) { return byId[id] && byId[id].type === 'boundaryTimer'; };
    var hostOf = function (id) { return isBoundary(id) && byId[byId[id].attachedTo] ? byId[id].attachedTo : id; };
    var main = nodes.filter(function (n) { return n.type !== 'boundaryTimer'; });

    // Arestas para o layout: a saída de um evento de borda conta como saída da atividade.
    var edges = [];
    graph.flows.forEach(function (f, i) {
      if (!byId[f.from] || !byId[f.to] || isBoundary(f.to)) return;
      var u = hostOf(f.from);
      if (u !== f.to) edges.push({ i: i, u: u, v: f.to });
    });
    var out = {};
    main.forEach(function (n) { out[n.id] = []; });
    edges.forEach(function (e) { if (out[e.u]) out[e.u].push(e); });

    // 1. setas de volta via DFS (iterativa), começando pelos inícios.
    var state = {}, back = {};
    var roots = main.filter(function (n) { return n.type === 'startEvent'; }).concat(main.filter(function (n) { return n.type !== 'startEvent'; }));
    roots.forEach(function (r) {
      if (state[r.id]) return;
      var stack = [[r.id, 0]]; state[r.id] = 1;
      while (stack.length) {
        var top = stack[stack.length - 1], list = out[top[0]] || [];
        if (top[1] >= list.length) { state[top[0]] = 2; stack.pop(); continue; }
        var e = list[top[1]++];
        if (state[e.v] === 1) back[e.i] = true;
        else if (!state[e.v]) { state[e.v] = 1; stack.push([e.v, 0]); }
      }
    });

    // 2. colunas: caminho mais longo no grafo sem as setas de volta.
    var layer = {}, indeg = {};
    main.forEach(function (n) { layer[n.id] = 0; indeg[n.id] = 0; });
    edges.forEach(function (e) { if (!back[e.i]) indeg[e.v]++; });
    var queue = main.filter(function (n) { return !indeg[n.id]; }).map(function (n) { return n.id; });
    var topo = [];
    while (queue.length) {
      var id = queue.shift(); topo.push(id);
      (out[id] || []).forEach(function (e) {
        if (back[e.i]) return;
        if (layer[e.u] + 1 > layer[e.v]) layer[e.v] = layer[e.u] + 1;
        if (--indeg[e.v] === 0) queue.push(e.v);
      });
    }

    // 3. raias e linhas dentro de cada raia.
    var lanes = (graph.lanes || []).slice();
    main.forEach(function (n) { if (lanes.indexOf(n.lane) < 0) lanes.push(n.lane); });
    if (!lanes.length) lanes.push('Processo');
    var laneOf = function (n) { var l = lanes.indexOf(n.lane); return l < 0 ? 0 : l; };
    var preds = {};
    edges.forEach(function (e) { if (!back[e.i]) (preds[e.v] = preds[e.v] || []).push(e.u); });
    var cells = {}, sub = {}, rowKey = {};
    topo.slice().sort(function (a, b) { return layer[a] - layer[b] || order[a] - order[b]; }).forEach(function (id) {
      var key = layer[id] + '|' + laneOf(byId[id]);
      (cells[key] = cells[key] || []).push(id);
    });
    // Ordena cada célula pela posição média dos antecessores (menos cruzamentos).
    var posKey = function (id) { return laneOf(byId[id]) * 1000 + (sub[id] || 0); };
    Object.keys(cells).sort(function (a, b) { return +a.split('|')[0] - +b.split('|')[0]; }).forEach(function (key) {
      var list = cells[key];
      list.sort(function (a, b) {
        var bary = function (id) { var p = preds[id] || []; if (!p.length) return order[id] / 1e4; var s = 0; p.forEach(function (q) { s += posKey(q); }); return s / p.length; };
        return bary(a) - bary(b) || order[a] - order[b];
      });
      list.forEach(function (id, k) { sub[id] = k; });
    });
    var rows = lanes.map(function () { return 1; });
    Object.keys(cells).forEach(function (key) { var l = +key.split('|')[1]; rows[l] = Math.max(rows[l], cells[key].length); });
    var laneTop = [], rowStart = [], acc = POOL_Y, accRow = 0;
    lanes.forEach(function (_, l) { laneTop.push(acc); rowStart.push(accRow); acc += rows[l] * ROW_H; accRow += rows[l]; });

    var cx = function (c) { return POOL_X + LANE_LABEL_W + PAD_LEFT + c * COL_W; };
    var rowTop = function (r) {
      for (var l = lanes.length - 1; l >= 0; l--) if (r >= rowStart[l]) return laneTop[l] + (r - rowStart[l]) * ROW_H;
      return POOL_Y;
    };
    var boxes = {}, occ = {}, maxLayer = 0;
    main.forEach(function (n) {
      var sz = SIZE[n.type] || SIZE.task, l = laneOf(n), r = rowStart[l] + (sub[n.id] || 0);
      var c = layer[n.id] || 0, ccx = cx(c), ccy = rowTop(r) + ROW_H / 2;
      boxes[n.id] = { x: Math.round(ccx - sz[0] / 2), y: Math.round(ccy - sz[1] / 2), w: sz[0], h: sz[1], cx: ccx, cy: ccy, col: c, row: r, lane: l };
      occ[c + '|' + r] = true;
      if (c > maxLayer) maxLayer = c;
    });
    // Eventos de borda: na borda inferior da atividade, da direita para a esquerda.
    var perHost = {};
    nodes.forEach(function (n) {
      if (n.type !== 'boundaryTimer') return;
      var h = boxes[n.attachedTo]; if (!h) return;
      var k = perHost[n.attachedTo] = (perHost[n.attachedTo] || 0) + 1;
      var bcx = h.x + h.w - 22 - (k - 1) * 40, bcy = h.y + h.h;
      boxes[n.id] = { x: bcx - 18, y: bcy - 18, w: 36, h: 36, cx: bcx, cy: bcy, col: h.col, row: h.row, lane: h.lane, boundary: true };
    });

    // 4. roteamento ortogonal.
    var used = {};
    var track = function (key) { var k = used[key] = (used[key] || 0) + 1; return TRACKS[(k - 1) % TRACKS.length]; };
    var gapX = function (c) { return cx(c) + COL_W / 2; };
    var clearRow = function (r, c1, c2) { var lo = Math.min(c1, c2), hi = Math.max(c1, c2); for (var c = lo + 1; c < hi; c++) if (occ[c + '|' + r]) return false; return true; };
    var clearCol = function (c, r1, r2) { var lo = Math.min(r1, r2), hi = Math.max(r1, r2); for (var r = lo + 1; r < hi; r++) if (occ[c + '|' + r]) return false; return true; };
    var waypoints = {};
    graph.flows.forEach(function (f, i) {
      var S = boxes[f.from], T = boxes[f.to];
      if (!S || !T) return;
      var taskT = ACTIVITIES[byId[f.to].type];
      var isBack = back[i] || T.col <= S.col;
      var wp;
      if (S.boundary) {
        // Sai por baixo do evento de borda até o corredor inferior da linha.
        var yb0 = rowTop(S.row) + ROW_H - 14 + track('rb' + S.row) / 2;
        var p0 = [S.cx, S.y + S.h];
        if (!isBack && T.col === S.col + 1 && T.row > S.row) wp = [p0, [S.cx, yb0], [gapX(S.col) + track('g' + S.col), yb0], [gapX(S.col) + track('g' + S.col), T.cy], [T.x, T.cy]];
        else {
          var xg0 = gapX(isBack ? T.col - 1 : T.col - 1) + track('g' + (T.col - 1));
          wp = [p0, [S.cx, yb0], [xg0, yb0], [xg0, T.cy + (taskT && isBack ? 20 : 0)], [T.x, T.cy + (taskT && isBack ? 20 : 0)]];
        }
      } else if (isBack) {
        // Retrabalho: desce ao corredor inferior, volta pela esquerda do destino.
        var yb = rowTop(S.row) + ROW_H - 14 + track('rb' + S.row) / 2;
        var xg = gapX(T.col - 1) + track('g' + (T.col - 1));
        var ty = T.cy + (taskT ? 20 : 0);
        wp = [[S.cx, S.y + S.h], [S.cx, yb], [xg, yb], [xg, ty], [T.x, ty]];
      } else if (S.row === T.row && clearRow(S.row, S.col, T.col)) {
        wp = [[S.x + S.w, S.cy], [T.x, T.cy]];
      } else if (GATEWAYS[byId[f.from].type] && clearCol(S.col, S.row, T.row) && clearRow(T.row, S.col, T.col)) {
        // Saída de gateway pelo vértice de cima/baixo, direto até a linha do destino.
        var vy = T.cy < S.cy ? S.y : S.y + S.h;
        wp = [[S.cx, vy], [S.cx, T.cy], [T.x, T.cy]];
      } else {
        var x1 = gapX(S.col) + track('g' + S.col);
        if (clearRow(T.row, S.col, T.col)) wp = [[S.x + S.w, S.cy], [x1, S.cy], [x1, T.cy], [T.x, T.cy]];
        else {
          var ch = rowTop(T.row) + 14 + track('rt' + T.row) / 2, x2 = gapX(T.col - 1) + track('g' + (T.col - 1));
          wp = [[S.x + S.w, S.cy], [x1, S.cy], [x1, ch], [x2, ch], [x2, T.cy], [T.x, T.cy]];
        }
      }
      // Remove pontos repetidos/colineares para a seta ficar limpa.
      var clean = [];
      wp.forEach(function (p) {
        p = [Math.round(p[0]), Math.round(p[1])];
        var last = clean[clean.length - 1];
        if (last && last[0] === p[0] && last[1] === p[1]) return;
        if (clean.length >= 2) {
          var a = clean[clean.length - 2];
          if ((a[0] === last[0] && last[0] === p[0]) || (a[1] === last[1] && last[1] === p[1])) clean.pop();
        }
        clean.push(p);
      });
      waypoints[i] = clean;
    });

    var poolW = Math.round(cx(maxLayer) + COL_W / 2 + PAD_RIGHT - POOL_X);
    return { lanes: lanes, laneTop: laneTop, laneH: rows.map(function (r) { return r * ROW_H; }), poolW: poolW, poolH: acc - POOL_Y, boxes: boxes, waypoints: waypoints, back: back };
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
    var shapeTag = function (n) {
      var b = L.boxes[n.id]; if (!b) return '';
      var extra = n.type === 'exclusiveGateway' ? ' isMarkerVisible="true"' : n.type === 'subProcess' ? ' isExpanded="false"' : '';
      return '      <bpmndi:BPMNShape id="' + ids[n.id] + '_di" bpmnElement="' + ids[n.id] + '"' + extra + colorOf(n.type) + '>\n        <omgdc:Bounds x="' + b.x + '" y="' + b.y + '" width="' + b.w + '" height="' + b.h + '"/>\n      </bpmndi:BPMNShape>';
    };
    var edgeTag = function (f) {
      return '      <bpmndi:BPMNEdge id="' + flowId(f) + '_di" bpmnElement="' + flowId(f) + '">\n' + L.waypoints[graph.flows.indexOf(f)].map(function (p) { return '        <omgdi:waypoint x="' + p[0] + '" y="' + p[1] + '"/>'; }).join('\n') + '\n      </bpmndi:BPMNEdge>';
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
