// Teste de não regressão do desenho BPMN (bpmn-layout.js): setas.
//
// Regra do usuário: "nunca uma seta pode passar por cima de outra". Cada
// diagrama (casos reais em test/fixtures + um lote aleatório com semente fixa)
// passa por buildXml e o XML gerado é conferido geometricamente:
//
//   ROTA_AUSENTE     fluxo sem BPMNEdge (ou com menos de 2 pontos)
//   SOBREPOSICAO     duas setas em paralelo a menos de 12 px (inclui tronco
//                    compartilhado entre setas da mesma origem/destino)
//   TOQUE            ponta/dobra de uma seta encostando em outra
//   ATRAVESSA_NO     seta passando por dentro de um nó (ou do próprio nó)
//   SOBRE_ROTULO     seta passando por cima de um rótulo (de nó ou de fluxo)
//   ROTULO           rótulo sobre rótulo/nó, cortado por divisa ou fora do pool
//   ROTULO_LONGE     rótulo do fluxo a mais de 24 px da própria seta
//   LADO_ERRADO      seta fora da borda do nó; fluxo para frente saindo pela
//                    esquerda ou entrando pela direita
//   DIVISA           seta correndo em cima da divisa de raias
//   GEOMETRIA        segmento diagonal, ponto repetido, último trecho < 10 px
//   CRUZAMENTO       cruzamentos acima do limite do caso (0, salvo exceções
//                    justificadas em LIMITES)
//   DOBRAS/DESVIO    total de setas com > 4 dobras ou > 3x a distância direta
//                    acima do teto registrado (só pode melhorar)
//   TEMPO            buildXml lento demais (roda na thread do navegador)
//   DETERMINISMO, IDA_E_VOLTA (xmlToGraph), LINEAR, NUNCA_LANCA
//
// Sem dependências: o XML é lido com expressões regulares (formato próprio
// de buildXml). Rode com: node test/bpmn-layout.test.mjs
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
await import(pathToFileURL(join(HERE, '..', 'bpmn-layout.js')).href);
const A = globalThis.AriBpmn;
const G = await import(pathToFileURL(join(HERE, '..', 'bpmn-graph.js')).href);

// Cruzamentos aceitos por caso (o mínimo conseguido; o teste falha se piorar).
const LIMITES = {
  'construtor-cruzamento-k33': { cruz: 3, motivo: 'K3,3 não é planar' },
  'construtor-grande-complexo': { cruz: 2, motivo: 'idas e voltas entre raias vizinhas nas mesmas colunas' },
  'perf-35-nos': { cruz: 12, motivo: 'grafo de estresse com muitas idas e voltas entre raias' },
  'perf-80-nos': { cruz: 1, motivo: 'grafo de estresse de 80 nós' }
};
// Tetos globais (quantidade de setas): só podem diminuir.
const TETO = { fixturesDobras: 7, fixturesDesvio: 2, aleatorioCruz: 52, aleatorioDobras: 27, aleatorioDesvio: 6 };
const TEMPO_MAX_MS = 1500; // por diagrama (folga para máquinas lentas/CI)
const N_ALEATORIOS = 60;

const falhas = [];
const falha = (caso, cls, msg) => falhas.push(`[${caso}] ${cls}: ${msg}`);

// ---------- leitura do XML ----------
function attr(s, name) { const m = s.match(new RegExp('\\s' + name + '="([^"]*)"')); return m ? m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : ''; }
function bounds(s) { return { x: +attr(s, 'x'), y: +attr(s, 'y'), w: +attr(s, 'width'), h: +attr(s, 'height') }; }
function parse(xml) {
  const proc = xml.slice(xml.indexOf('<process'), xml.indexOf('</process>'));
  const nodes = {}, flows = {}, lanes = [];
  for (const line of proc.split('\n')) {
    const m = line.match(/^ {4}<(\w+) id="([^"]+)"/);
    if (!m || m[1] === 'laneSet') continue;
    if (m[1] === 'sequenceFlow') { flows[m[2]] = { id: m[2], src: attr(line, 'sourceRef'), tgt: attr(line, 'targetRef'), name: attr(line, 'name') }; continue; }
    const tag = m[1], kind = /Gateway$/.test(tag) ? 'gateway' : /Event$/.test(tag) ? 'event' : 'task';
    const defs = (line.match(/<(\w+)EventDefinition/g) || []).map((d) => d.slice(1).replace('EventDefinition', ''));
    nodes[m[2]] = { id: m[2], tag, kind, name: attr(line, 'name'), attachedTo: attr(line, 'attachedToRef'), cancel: attr(line, 'cancelActivity'), defs };
  }
  for (const m of proc.matchAll(/<lane id="([^"]+)" name="([^"]*)">([\s\S]*?)<\/lane>/g)) lanes.push({ id: m[1], name: m[2], refs: [...m[3].matchAll(/<flowNodeRef>([^<]+)<\/flowNodeRef>/g)].map((r) => r[1]) });
  let pool = null; const laneB = {};
  for (const m of xml.matchAll(/<bpmndi:BPMNShape id="[^"]+" bpmnElement="([^"]+)"[^>]*>\s*<omgdc:Bounds([^>]*)\/>(?:\s*<bpmndi:BPMNLabel><omgdc:Bounds([^>]*)\/><\/bpmndi:BPMNLabel>)?/g)) {
    const b = bounds(m[2]);
    if (nodes[m[1]]) Object.assign(nodes[m[1]], b, { label: m[3] ? bounds(m[3]) : null });
    else if (m[1].startsWith('Participant')) pool = b; else laneB[m[1]] = b;
  }
  lanes.forEach((l) => { l.b = laneB[l.id]; l.refs.forEach((r) => { if (nodes[r]) nodes[r].lane = l.id; }); });
  for (const m of xml.matchAll(/<bpmndi:BPMNEdge id="[^"]+" bpmnElement="([^"]+)">([\s\S]*?)<\/bpmndi:BPMNEdge>/g)) {
    const f = flows[m[1]]; if (!f) continue;
    f.pts = [...m[2].matchAll(/<omgdi:waypoint x="([^"]+)" y="([^"]+)"\/>/g)].map((w) => [+w[1], +w[2]]);
    const lab = m[2].match(/<bpmndi:BPMNLabel><omgdc:Bounds([^>]*)\/>/);
    f.label = lab ? bounds(lab[1]) : null;
  }
  return { nodes, flows, lanes, pool, processName: attr(xml.slice(xml.indexOf('<participant')), 'name') };
}

// ---------- geometria ----------
const E = 0.5;
const segBox = (a, b, r, pad) => Math.max(a[0], b[0]) > r.x - pad && Math.min(a[0], b[0]) < r.x + r.w + pad && Math.max(a[1], b[1]) > r.y - pad && Math.min(a[1], b[1]) < r.y + r.h + pad;
const boxBox = (a, b, pad) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
// trecho ortogonal a-b dentro do losango (amostragem fina basta: lados de 1 px)
function inDiamond(a, b, n, m) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2, hw = n.w / 2 + m, hh = n.h / 2 + m, L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let inside = 0;
  for (let t = 0.5; t < L; t += 1) { const x = a[0] + (b[0] - a[0]) * t / L, y = a[1] + (b[1] - a[1]) * t / L; if (Math.abs(x - cx) / hw + Math.abs(y - cy) / hh < 1) inside++; }
  return inside;
}
function outlineDist(p, n) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  if (n.kind === 'event') return Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - n.w / 2);
  if (n.kind === 'gateway') return Math.abs(Math.abs(p[0] - cx) / (n.w / 2) + Math.abs(p[1] - cy) / (n.h / 2) - 1) * Math.min(n.w, n.h) / 2;
  const dx = Math.max(n.x - p[0], 0, p[0] - n.x - n.w), dy = Math.max(n.y - p[1], 0, p[1] - n.y - n.h);
  if (dx || dy) return Math.hypot(dx, dy);
  return Math.min(p[0] - n.x, n.x + n.w - p[0], p[1] - n.y, n.y + n.h - p[1]);
}
function side(p, n) { // lado do nó por onde a ponta encosta
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2, dx = (p[0] - cx) / (n.w / 2), dy = (p[1] - cy) / (n.h / 2);
  return Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? 'r' : 'l') : (dy > 0 ? 'b' : 't');
}

function check(caso, xml, opts = {}) {
  const D = parse(xml), out = { cruz: 0, dobras: 0, desvio: 0 };
  const nm = (id) => (D.nodes[id] && D.nodes[id].name) || id;
  const fn = (f) => `${f.id} (${nm(f.src)} → ${nm(f.tgt)})`;
  const F = Object.values(D.flows), N = Object.values(D.nodes);
  F.forEach((f) => { if (!f.pts || f.pts.length < 2) falha(caso, 'ROTA_AUSENTE', `${fn(f)} não tem desenho`); });
  const ok = F.filter((f) => f.pts && f.pts.length >= 2);
  const segs = [];
  ok.forEach((f) => {
    for (let k = 1; k < f.pts.length; k++) {
      const a = f.pts[k - 1], b = f.pts[k];
      if (Math.abs(a[0] - b[0]) > E && Math.abs(a[1] - b[1]) > E) falha(caso, 'GEOMETRIA', `${fn(f)} tem trecho diagonal ${a} → ${b}`);
      if (Math.abs(a[0] - b[0]) < E && Math.abs(a[1] - b[1]) < E) falha(caso, 'GEOMETRIA', `${fn(f)} tem ponto repetido ${a}`);
      segs.push({ f, k, a, b, h: Math.abs(a[1] - b[1]) < E, first: k === 1, last: k === f.pts.length - 1 });
    }
    const n = f.pts.length, last = Math.hypot(f.pts[n - 1][0] - f.pts[n - 2][0], f.pts[n - 1][1] - f.pts[n - 2][1]);
    if (last < 10) falha(caso, 'GEOMETRIA', `${fn(f)} chega com um último trecho de ${last.toFixed(0)} px`);
  });
  // setas x setas
  const seen = new Set();
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j]; if (s.f === t.f) continue;
    if (s.h === t.h) {
      const c = s.h ? 1 : 0, o = 1 - c, dist = Math.abs(s.a[c] - t.a[c]);
      const ov = Math.min(Math.max(s.a[o], s.b[o]), Math.max(t.a[o], t.b[o])) - Math.max(Math.min(s.a[o], s.b[o]), Math.min(t.a[o], t.b[o]));
      if (ov > 1 && dist < 12) { const key = s.f.id + '|' + t.f.id; if (!seen.has(key)) { seen.add(key); falha(caso, 'SOBREPOSICAO', `${fn(s.f)} e ${fn(t.f)} correm em paralelo a ${dist.toFixed(0)} px por ${ov.toFixed(0)} px`); } }
      continue;
    }
    const H = s.h ? s : t, V = s.h ? t : s, x = V.a[0], y = H.a[1];
    const inH = x > Math.min(H.a[0], H.b[0]) - E && x < Math.max(H.a[0], H.b[0]) + E, inV = y > Math.min(V.a[1], V.b[1]) - E && y < Math.max(V.a[1], V.b[1]) + E;
    if (!inH || !inV) continue;
    const intH = x > Math.min(H.a[0], H.b[0]) + E && x < Math.max(H.a[0], H.b[0]) - E, intV = y > Math.min(V.a[1], V.b[1]) + E && y < Math.max(V.a[1], V.b[1]) - E;
    if (intH && intV) { out.cruz++; if (opts.cruzMax !== undefined && out.cruz > opts.cruzMax) falha(caso, 'CRUZAMENTO', `${fn(s.f)} cruza ${fn(t.f)} em (${Math.round(x)},${Math.round(y)})`); }
    else {
      // encosto: só é aceito quando as duas setas terminam/começam no mesmo nó e o ponto é a própria ponta
      const sameEnd = (s.f.src === t.f.src || s.f.tgt === t.f.tgt) && !intH && !intV;
      if (!sameEnd) falha(caso, 'TOQUE', `${fn(s.f)} encosta em ${fn(t.f)} em (${Math.round(x)},${Math.round(y)})`);
    }
  }
  // setas x nós
  segs.forEach((s) => N.forEach((n) => {
    if (!n.w) return;
    const own = n.id === s.f.src || n.id === s.f.tgt;
    if (own) {
      const inside = n.kind === 'gateway' ? inDiamond(s.a, s.b, n, -1.5) : segBox(s.a, s.b, { x: n.x + (n.kind === 'event' ? 6 : 1), y: n.y + (n.kind === 'event' ? 6 : 1), w: n.w - (n.kind === 'event' ? 12 : 2), h: n.h - (n.kind === 'event' ? 12 : 2) }, 0);
      if (inside) falha(caso, 'ATRAVESSA_NO', `${fn(s.f)} passa por dentro do próprio nó ${nm(n.id)}`);
      return;
    }
    if (D.nodes[s.f.src] && D.nodes[s.f.src].attachedTo === n.id && s.first) return; // saída do evento de borda
    const hit = n.kind === 'gateway' ? inDiamond(s.a, s.b, n, 2) > 0 : segBox(s.a, s.b, n, 2);
    if (hit) falha(caso, 'ATRAVESSA_NO', `${fn(s.f)} atravessa ${nm(n.id)}`);
  }));
  // rótulos
  const labels = [];
  N.forEach((n) => { if (n.kind !== 'task' && n.name && n.label) labels.push({ who: 'nó ' + nm(n.id), id: n.id, b: n.label }); });
  ok.forEach((f) => { if (f.name) { if (!f.label) falha(caso, 'ROTULO', `${fn(f)} tem nome mas não tem posição de rótulo`); else labels.push({ who: `fluxo ${fn(f)}`, flow: f, b: f.label }); } });
  segs.forEach((s) => labels.forEach((l) => { if (segBox(s.a, s.b, l.b, -1)) falha(caso, 'SOBRE_ROTULO', `${fn(s.f)} passa por cima do rótulo do ${l.who}`); }));
  const ys = [];
  if (D.pool) { ys.push(D.pool.y, D.pool.y + D.pool.h); D.lanes.forEach((l) => l.b && ys.push(l.b.y, l.b.y + l.b.h)); }
  labels.forEach((l, i) => {
    for (let j = i + 1; j < labels.length; j++) if (boxBox(l.b, labels[j].b, -1)) falha(caso, 'ROTULO', `rótulo do ${l.who} sobre o rótulo do ${labels[j].who}`);
    N.forEach((n) => { if (n.w && boxBox(l.b, n, -1)) falha(caso, 'ROTULO', `rótulo do ${l.who} sobre o nó ${nm(n.id)}`); });
    ys.forEach((y) => { if (y > l.b.y + 1 && y < l.b.y + l.b.h - 1) falha(caso, 'ROTULO', `rótulo do ${l.who} cortado pela divisa y=${y}`); });
    if (D.pool && (l.b.x < D.pool.x + 30 || l.b.x + l.b.w > D.pool.x + D.pool.w || l.b.y < D.pool.y || l.b.y + l.b.h > D.pool.y + D.pool.h)) falha(caso, 'ROTULO', `rótulo do ${l.who} fora do pool`);
    if (l.flow) {
      let best = Infinity;
      for (let k = 1; k < l.flow.pts.length; k++) { const a = l.flow.pts[k - 1], b = l.flow.pts[k]; const dx = Math.max(l.b.x - Math.max(a[0], b[0]), 0, Math.min(a[0], b[0]) - l.b.x - l.b.w), dy = Math.max(l.b.y - Math.max(a[1], b[1]), 0, Math.min(a[1], b[1]) - l.b.y - l.b.h); best = Math.min(best, Math.hypot(dx, dy)); }
      if (best > 24) falha(caso, 'ROTULO_LONGE', `rótulo "${l.flow.name}" está a ${best.toFixed(0)} px da seta ${fn(l.flow)}`);
    }
  });
  // divisas
  segs.forEach((s) => { if (s.h && Math.abs(s.a[0] - s.b[0]) > 1) ys.forEach((y) => { if (Math.abs(s.a[1] - y) < 3) falha(caso, 'DIVISA', `${fn(s.f)} corre em cima da divisa y=${y}`); }); });
  // pontas, lados, dobras e desvio
  ok.forEach((f) => {
    const S = D.nodes[f.src], T = D.nodes[f.tgt]; if (!S || !T || !S.w || !T.w) return;
    const p = f.pts, a = p[0], z = p[p.length - 1];
    if (outlineDist(a, S) > 2) falha(caso, 'LADO_ERRADO', `${fn(f)} começa fora da borda de ${nm(S.id)}`);
    if (outlineDist(z, T) > 2) falha(caso, 'LADO_ERRADO', `${fn(f)} termina fora da borda de ${nm(T.id)}`);
    const fwd = T.x + T.w / 2 > S.x + S.w / 2 + 20;
    if (fwd && side(z, T) === 'r') falha(caso, 'LADO_ERRADO', `${fn(f)} vai para frente mas entra pela direita de ${nm(T.id)}`);
    if (fwd && S.tag !== 'boundaryEvent' && side(a, S) === 'l') falha(caso, 'LADO_ERRADO', `${fn(f)} vai para frente mas sai pela esquerda de ${nm(S.id)}`);
    if (p.length - 2 > 4) out.dobras++;
    let L = 0; for (let k = 1; k < p.length; k++) L += Math.abs(p[k][0] - p[k - 1][0]) + Math.abs(p[k][1] - p[k - 1][1]);
    const man = Math.abs(a[0] - z[0]) + Math.abs(a[1] - z[1]);
    if (L > 600 && L > 3 * Math.max(man, 60)) out.desvio++;
  });
  if (opts.cruzMax !== undefined && out.cruz <= opts.cruzMax && LIMITES[caso] && out.cruz < LIMITES[caso].cruz) out.melhorou = true;
  return { D, ...out };
}

// ---------- ida e volta: XML -> estrutura do moddle -> xmlToGraph ----------
const TASK_T = { task: 'bpmn:Task', userTask: 'bpmn:UserTask', serviceTask: 'bpmn:ServiceTask', manualTask: 'bpmn:ManualTask', sendTask: 'bpmn:SendTask', receiveTask: 'bpmn:ReceiveTask', scriptTask: 'bpmn:ScriptTask', businessRuleTask: 'bpmn:BusinessRuleTask' };
function toDefs(D) {
  const els = {}, flowElements = [];
  Object.values(D.nodes).forEach((n) => {
    const $type = 'bpmn:' + n.tag[0].toUpperCase() + n.tag.slice(1);
    els[n.id] = { $type: TASK_T[n.tag] || $type, id: n.id, name: n.name, eventDefinitions: n.defs.map((d) => ({ $type: 'bpmn:' + d[0].toUpperCase() + d.slice(1) + 'EventDefinition' })), cancelActivity: n.cancel !== 'false' };
    flowElements.push(els[n.id]);
  });
  Object.values(D.nodes).forEach((n) => { if (n.attachedTo) els[n.id].attachedToRef = els[n.attachedTo]; });
  Object.values(D.flows).forEach((f) => flowElements.push({ $type: 'bpmn:SequenceFlow', id: f.id, name: f.name, sourceRef: els[f.src], targetRef: els[f.tgt] }));
  const lanes = D.lanes.map((l) => ({ name: l.name, flowNodeRef: l.refs.map((r) => els[r]).filter(Boolean) }));
  return { rootElements: [{ $type: 'bpmn:Collaboration', participants: [{ name: D.processName }] }, { $type: 'bpmn:Process', flowElements, laneSets: [{ lanes }] }] };
}
function idaEVolta(caso, g, D) {
  const back = A.xmlToGraph(toDefs(D)), ids = A.xmlIds(g), byId = new Map(back.nodes.map((n) => [n.id, n]));
  g.nodes.forEach((n) => {
    const m = byId.get(ids[n.id]); if (!m) { falha(caso, 'IDA_E_VOLTA', `nó ${n.id} sumiu`); return; }
    const keys = ['type', 'name', 'lane', 'eventType', 'interrupting'].concat(n.type === 'task' ? ['taskType'] : []);
    keys.forEach((k) => { if (String(n[k]) !== String(m[k])) falha(caso, 'IDA_E_VOLTA', `${n.id}.${k}: ${n[k]} → ${m[k]}`); });
  });
  const key = (f) => f.from + '>' + f.to + '>' + f.label;
  const a = g.flows.map((f) => key({ from: ids[f.from], to: ids[f.to], label: f.label })).sort(), b = back.flows.map(key).sort();
  if (a.join('|') !== b.join('|')) falha(caso, 'IDA_E_VOLTA', 'os fluxos mudaram');
}

// ---------- gerador aleatório enxuto (semente fixa) ----------
function rng(seed) {
  let a = seed >>> 0;
  const f = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  f.int = (lo, hi) => lo + Math.floor(f() * (hi - lo + 1)); f.pick = (arr) => arr[Math.floor(f() * arr.length)]; f.chance = (p) => f() < p;
  return f;
}
function gerar(seed) {
  const r = rng(seed * 7919 + 13), lanesAll = ['Atendimento', 'Financeiro', 'Jurídico', 'Gerência', 'Compras', 'TI', 'Cliente', 'Diretoria'];
  const lanes = lanesAll.slice().sort(() => r() - 0.5).slice(0, r.int(2, 6)), target = r.int(8, 40), nodes = [], flows = [];
  let k = 0;
  const node = (type, lane, extra) => { const n = { id: type.replace(/[a-z]+/g, (m) => m[0]) + '_' + (++k), type, name: '', lane, taskType: 'none', eventType: 'none', attachedTo: '', interrupting: false, ...extra }; nodes.push(n); return n; };
  const flow = (from, to, label = '') => flows.push({ from, to, label });
  const move = (lane) => (r.chance(0.55) ? lane : r.pick(lanes)), room = () => target - nodes.length;
  const tname = () => r.pick(['Analisar', 'Conferir', 'Registrar', 'Enviar', 'Aprovar', 'Validar', 'Emitir', 'Receber']) + ' ' + r.pick(['pedido', 'nota fiscal', 'contrato', 'orçamento', 'cadastro do cliente', 'relatório mensal de atendimentos', 'parecer técnico do setor jurídico']);
  const labs = (n) => { const b = r.pick([['Sim', 'Não'], ['Aprovado', 'Reprovado'], ['Completo', 'Incompleto', 'Parcial', 'Cancelado'], ['Não (fora do contrato)', 'Sim (correto)', 'Não (falta resultado)', 'Em análise']]); const o = b.slice(0, n); while (o.length < n) o.push('Opção ' + (o.length + 1)); return o; };
  function seq(prev, label, lane, budget, depth) {
    let cur = prev, curLabel = label, used = 0;
    const link = (to) => { flow(cur, to.id, curLabel); curLabel = ''; cur = to.id; };
    while (used < budget && room() > 0) {
      const roll = r(), before = nodes.length;
      if (depth < 3 && roll < 0.16 && room() >= 5) {
        const nb = r.int(2, Math.min(4, Math.max(2, room() - 2))), gw = node('exclusiveGateway', lane, { name: r.pick(['Aprovado?', 'Documentação completa?', 'Valor conforme o contrato?']) }); link(gw);
        const ls = labs(nb), exits = []; let ended = false;
        for (let b = 0; b < nb; b++) {
          const bl = move(lane);
          if (b > 0 && (!ended || r.chance(0.4)) && r.chance(0.35)) { let p = gw.id, pl = ls[b]; if (r.chance(0.5)) { const t = node('task', bl, { name: tname() }); flow(p, t.id, pl); pl = ''; p = t.id; } const e = node('endEvent', bl, { name: r.pick(['Fim', 'Cancelado', 'Pedido recusado']) }); flow(p, e.id, pl); ended = true; continue; }
          const res = seq(gw.id, ls[b], bl, r.int(1, 3), depth + 1); if (res) exits.push(res);
        }
        if (!exits.length) return null;
        if (exits.length === 1) { cur = exits[0].exit; lane = exits[0].lane; curLabel = exits[0].label || ''; }
        else { const j = node('exclusiveGateway', lane); exits.forEach((e) => flow(e.exit, j.id, e.label || '')); cur = j.id; curLabel = ''; }
      } else if (depth < 3 && roll < 0.27 && room() >= 5) {
        const sp = node('parallelGateway', lane); link(sp); const ex = [];
        for (let b = 0; b < r.int(2, 3); b++) { const t = node('task', move(lane), { name: tname(), taskType: r.pick(['user', 'service', 'send', 'none']) }); flow(sp.id, t.id); ex.push(t.id); }
        const j = node('parallelGateway', lane); ex.forEach((e) => flow(e, j.id)); cur = j.id; curLabel = '';
      } else if (roll < 0.40 && room() >= 4) {
        const t1 = node('task', move(lane), { name: tname() }); link(t1);
        if (r.chance(0.5)) { const t2 = node('task', move(lane), { name: tname() }); link(t2); }
        const q = node('exclusiveGateway', move(lane), { name: 'Precisa de ajuste?' }); link(q);
        if (r.chance(0.3)) { const fix = node('task', r.pick(lanes), { name: 'Corrigir ' + tname() }); flow(q.id, fix.id, 'Sim'); flow(fix.id, t1.id); } else flow(q.id, t1.id, 'Sim');
        curLabel = 'Não';
      } else if (roll < 0.47) { const tm = node('timerEvent', move(lane), { name: r.pick(['Aguardar 2 dias úteis', '48 horas']) }); link(tm); }
      else {
        lane = move(lane); const t = node(r.chance(0.07) ? 'subProcess' : 'task', lane, { name: tname() }); link(t);
        if (r.chance(0.12) && room() >= 2) { const bt = node('boundaryTimer', lane, { name: 'Prazo de 48 horas', attachedTo: t.id, interrupting: true }); const e = node('endEvent', r.chance(0.5) ? lane : move(lane), { name: 'Prazo expirado' }); flow(bt.id, e.id); }
      }
      used += Math.max(1, nodes.length - before);
    }
    return { exit: cur, lane, label: curLabel };
  }
  const st = node('startEvent', lanes[0], { name: 'Início' }), res = seq(st.id, '', lanes[0], 999, 0);
  if (res) flow(res.exit, node('endEvent', res.lane, { name: 'Fim' }).id, res.label);
  return { processName: 'Processo ' + seed, lanes, nodes, flows };
}
function grafoValido(seed) {
  for (let t = 0; t < 50; t++) { const g = G.normalizeGraph(gerar(seed * 101 + t)); if (!G.validateGraph(g).errors.length && g.nodes.length >= 8) return g; }
  return null;
}

// ---------- execução ----------
function rodar(caso, g, opts) {
  let built, ms;
  try { const t0 = performance.now(); built = A.buildXml(g); ms = performance.now() - t0; }
  catch (e) { falha(caso, 'NUNCA_LANCA', `buildXml lançou: ${e && e.message}`); return null; }
  if (ms > TEMPO_MAX_MS) falha(caso, 'TEMPO', `buildXml levou ${ms.toFixed(0)} ms (máximo ${TEMPO_MAX_MS})`);
  if (A.buildXml(g).xml !== built.xml) falha(caso, 'DETERMINISMO', 'duas execuções deram XML diferente');
  const r = check(caso, built.xml, opts);
  idaEVolta(caso, g, r.D);
  return { ...r, ms, nodes: g.nodes.length };
}

const tempos = [], fix = { dobras: 0, desvio: 0 }, melhoras = [];
const dir = join(HERE, 'fixtures');
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const caso = f.replace('.json', ''), g = G.normalizeGraph(JSON.parse(fs.readFileSync(join(dir, f), 'utf8')));
  const lim = LIMITES[caso] ? LIMITES[caso].cruz : 0;
  const r = rodar(caso, g, { cruzMax: lim }); if (!r) continue;
  tempos.push(r.ms); fix.dobras += r.dobras; fix.desvio += r.desvio;
  if (r.melhorou) melhoras.push(`${caso}: ${r.cruz} cruzamento(s) (limite ${lim})`);
}
if (fix.dobras > TETO.fixturesDobras) falha('fixtures', 'DOBRAS', `${fix.dobras} setas com mais de 4 dobras (teto ${TETO.fixturesDobras})`);
if (fix.desvio > TETO.fixturesDesvio) falha('fixtures', 'DESVIO', `${fix.desvio} setas com desvio > 3x (teto ${TETO.fixturesDesvio})`);

const ale = { cruz: 0, dobras: 0, desvio: 0, n: 0 };
for (let s = 1; s <= N_ALEATORIOS; s++) {
  const g = grafoValido(s); if (!g) continue;
  const r = rodar('aleatório ' + s, g, {}); if (!r) continue;
  ale.n++; ale.cruz += r.cruz; ale.dobras += r.dobras; ale.desvio += r.desvio; tempos.push(r.ms);
}
if (ale.cruz > TETO.aleatorioCruz) falha('aleatórios', 'CRUZAMENTO', `${ale.cruz} cruzamentos em ${ale.n} grafos (teto ${TETO.aleatorioCruz})`);
if (ale.dobras > TETO.aleatorioDobras) falha('aleatórios', 'DOBRAS', `${ale.dobras} setas com mais de 4 dobras (teto ${TETO.aleatorioDobras})`);
if (ale.desvio > TETO.aleatorioDesvio) falha('aleatórios', 'DESVIO', `${ale.desvio} setas com desvio > 3x (teto ${TETO.aleatorioDesvio})`);

// Diagrama linear: tudo numa linha reta, sem dobras.
{
  const nodes = [{ id: 's', type: 'startEvent', name: 'Início', lane: 'Equipe' }], flows = [];
  for (let i = 1; i <= 8; i++) { nodes.push({ id: 't' + i, type: 'task', name: 'Etapa ' + i, lane: 'Equipe' }); flows.push({ from: i === 1 ? 's' : 't' + (i - 1), to: 't' + i }); }
  nodes.push({ id: 'e', type: 'endEvent', name: 'Fim', lane: 'Equipe' }); flows.push({ from: 't8', to: 'e' });
  const r = rodar('linear', G.normalizeGraph({ lanes: ['Equipe'], nodes, flows }), { cruzMax: 0 });
  if (r) Object.values(r.D.flows).forEach((f) => { if (f.pts.length !== 2) falha('linear', 'LINEAR', `${f.id} tem ${f.pts.length - 2} dobra(s) num fluxo reto`); });
}

// Entradas estranhas: buildXml nunca lança e desenha todo fluxo válido.
{
  const casos = {
    'sem raias e com fluxo para nó inexistente': { nodes: [{ id: 'a', type: 'startEvent' }, { id: 'b', type: 'task', name: 'x' }], flows: [{ from: 'a', to: 'b' }, { from: 'b', to: 'zzz' }] },
    'laço na própria atividade': { lanes: ['L'], nodes: [{ id: 'a', type: 'startEvent', lane: 'L' }, { id: 'b', type: 'task', name: 'x', lane: 'L' }, { id: 'c', type: 'endEvent', lane: 'L' }], flows: [{ from: 'a', to: 'b' }, { from: 'b', to: 'b' }, { from: 'b', to: 'c' }] },
    'evento de borda sem atividade': { lanes: ['L'], nodes: [{ id: 'a', type: 'startEvent', lane: 'L' }, { id: 't', type: 'boundaryTimer', attachedTo: 'nada', lane: 'L' }, { id: 'c', type: 'endEvent', lane: 'L' }], flows: [{ from: 'a', to: 'c' }, { from: 't', to: 'c' }] },
    'fluxos repetidos e ids com espaço': { lanes: ['L'], nodes: [{ id: 'início 1', type: 'startEvent', lane: 'L' }, { id: 'g', type: 'inclusiveGateway', lane: 'L' }, { id: 'b', type: 'task', name: 'x', lane: 'L' }, { id: 'c', type: 'endEvent', lane: 'L' }], flows: [{ from: 'início 1', to: 'g' }, { from: 'g', to: 'b', label: 'A' }, { from: 'g', to: 'b', label: 'B' }, { from: 'g', to: 'b', label: 'C' }, { from: 'b', to: 'c' }] },
    'divisão em 30 ramos': (() => { const nodes = [{ id: 's', type: 'startEvent', lane: 'L' }, { id: 'g', type: 'exclusiveGateway', name: 'Qual?', lane: 'L' }, { id: 'j', type: 'exclusiveGateway', lane: 'L' }, { id: 'e', type: 'endEvent', lane: 'L' }], flows = [{ from: 's', to: 'g' }, { from: 'j', to: 'e' }]; for (let i = 0; i < 30; i++) { nodes.push({ id: 't' + i, type: 'task', name: 'Ramo ' + i, lane: 'L' }); flows.push({ from: 'g', to: 't' + i, label: 'Op ' + i }, { from: 't' + i, to: 'j' }); } return { lanes: ['L'], nodes, flows }; })()
  };
  for (const [nome, raw] of Object.entries(casos)) {
    const g = G.normalizeGraph(raw);
    let built;
    try { built = A.buildXml(g); } catch (e) { falha(nome, 'NUNCA_LANCA', `buildXml lançou: ${e && e.message}`); continue; }
    const D = parse(built.xml), ids = A.xmlIds(g);
    g.flows.forEach((f) => {
      if (!ids[f.from] || !ids[f.to]) return;
      const src = g.nodes.find((n) => n.id === f.from);
      if (src && src.type === 'boundaryTimer' && !g.nodes.some((n) => n.id === src.attachedTo)) return; // evento de borda órfão não é desenhado
      const e = Object.values(D.flows).find((x) => x.src === ids[f.from] && x.tgt === ids[f.to] && (x.name || '') === (f.label || ''));
      if (!e || !e.pts || e.pts.length < 2) falha(nome, 'ROTA_AUSENTE', `fluxo ${f.from} → ${f.to} sem desenho`);
    });
  }
}

tempos.sort((a, b) => a - b);
const mediana = tempos[tempos.length >> 1] || 0, pior = tempos[tempos.length - 1] || 0;
console.log(`bpmn-layout: ${tempos.length} diagramas | buildXml mediana ${mediana.toFixed(1)} ms, pior ${pior.toFixed(0)} ms | aleatórios: ${ale.cruz} cruzamentos, ${ale.dobras} setas com > 4 dobras, ${ale.desvio} com desvio > 3x | fixtures: ${fix.dobras} com > 4 dobras, ${fix.desvio} com desvio > 3x`);
if (melhoras.length) console.log('Melhorou (dá para baixar LIMITES): ' + melhoras.join('; '));
if (falhas.length) {
  const porClasse = {};
  falhas.forEach((f) => { const c = f.split('] ')[1].split(':')[0]; porClasse[c] = (porClasse[c] || 0) + 1; });
  console.error(`\nFALHOU: ${falhas.length} problema(s) ${JSON.stringify(porClasse)}`);
  falhas.slice(0, 60).forEach((f) => console.error('  ' + f));
  if (falhas.length > 60) console.error(`  ... e mais ${falhas.length - 60}`);
  process.exit(1);
}
console.log('OK: nenhuma seta sobre outra, sobre nó ou sobre rótulo.');
