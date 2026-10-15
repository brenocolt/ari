// Grafo BPMN que a IA devolve para o mapeamento, e as regras que o código
// verifica antes de aceitar. Um grafo (nós + fluxos) consegue representar o
// que a lista linear antiga não conseguia: fins em qualquer ramo, gateways
// paralelos e inclusivos, decisões com várias saídas, ciclos de retrabalho e
// eventos de tempo.

export const NODE_TYPES = [
  "startEvent", "endEvent", "task", "subProcess",
  "exclusiveGateway", "parallelGateway", "inclusiveGateway",
  "timerEvent", "boundaryTimer",
];
export const TASK_TYPES = ["user", "service", "manual", "send", "receive", "script", "businessRule", "none"];
// Tipo (definição) dos eventos de início e de fim. "none" = evento simples.
// Grafos antigos marcavam o fim com "terminate": true; normalizeGraph converte.
export const START_EVENT_TYPES = ["none", "message", "timer", "signal", "conditional"];
export const END_EVENT_TYPES = ["none", "message", "terminate", "error", "signal", "escalation"];
export const EVENT_TYPES = [...new Set([...START_EVENT_TYPES, ...END_EVENT_TYPES])];

const GATEWAYS = new Set(["exclusiveGateway", "parallelGateway", "inclusiveGateway"]);
const ACTIVITIES = new Set(["task", "subProcess"]);

// Schema para as saídas estruturadas da API (todos os campos obrigatórios;
// "" / false / "none" quando não se aplicam).
export const GRAPH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["processName", "lanes", "nodes", "flows"],
  properties: {
    processName: { type: "string" },
    lanes: { type: "array", items: { type: "string" } },
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "type", "name", "lane", "taskType", "eventType", "attachedTo", "interrupting"],
        properties: {
          id: { type: "string" },
          type: { type: "string", enum: NODE_TYPES },
          name: { type: "string" },
          lane: { type: "string" },
          taskType: { type: "string", enum: TASK_TYPES },
          eventType: { type: "string", enum: EVENT_TYPES },
          attachedTo: { type: "string" },
          interrupting: { type: "boolean" },
        },
      },
    },
    flows: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "to", "label"],
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          label: { type: "string" },
        },
      },
    },
  },
};

const str = (v) => (v == null ? "" : String(v)).trim();

// Tipo do evento de início/fim, aceitando o formato antigo ("terminate": true).
export function eventTypeOf(n) {
  if (!n || (n.type !== "startEvent" && n.type !== "endEvent")) return "none";
  const allowed = n.type === "startEvent" ? START_EVENT_TYPES : END_EVENT_TYPES;
  if (allowed.includes(n.eventType)) return n.eventType;
  return n.type === "endEvent" && n.terminate === true ? "terminate" : "none";
}

// Preferência do usuário no formulário ("Tipo de início"/"Tipo de fim"):
// vale para todos os inícios / todos os fins. "" = a ARI decide.
export function cleanEventPrefs(p) {
  const o = p && typeof p === "object" ? p : {};
  return {
    start: START_EVENT_TYPES.includes(o.start) ? o.start : "",
    end: END_EVENT_TYPES.includes(o.end) ? o.end : "",
  };
}
export function applyEventPrefs(g, prefs) {
  const p = cleanEventPrefs(prefs);
  if (!p.start && !p.end) return g;
  return {
    ...g,
    nodes: g.nodes.map((n) => (n.type === "startEvent" && p.start ? { ...n, eventType: p.start }
      : n.type === "endEvent" && p.end ? { ...n, eventType: p.end } : n)),
  };
}

// Limpa o grafo vindo da IA: tipos, textos e raias. Não "conserta" a lógica —
// problemas de lógica viram erros de validate() para a IA corrigir.
export function normalizeGraph(raw) {
  const g = raw && typeof raw === "object" ? raw : {};
  const lanes = [];
  const addLane = (l) => { if (l && !lanes.includes(l)) lanes.push(l); };
  (Array.isArray(g.lanes) ? g.lanes : []).forEach((l) => addLane(str(l)));
  const nodes = (Array.isArray(g.nodes) ? g.nodes : []).filter((n) => n && typeof n === "object").map((n) => {
    const type = NODE_TYPES.includes(n.type) ? n.type : "task";
    const lane = str(n.lane) || lanes[0] || "Processo";
    addLane(lane);
    return {
      id: str(n.id),
      type,
      name: str(n.name),
      lane,
      taskType: ACTIVITIES.has(type) && TASK_TYPES.includes(n.taskType) ? n.taskType : "none",
      eventType: eventTypeOf({ ...n, type }),
      attachedTo: type === "boundaryTimer" ? str(n.attachedTo) : "",
      interrupting: type === "boundaryTimer" ? n.interrupting !== false : false,
    };
  });
  const flows = (Array.isArray(g.flows) ? g.flows : []).filter((f) => f && typeof f === "object")
    .map((f) => ({ from: str(f.from), to: str(f.to), label: str(f.label) }));
  // A raia de um evento de borda é sempre a da atividade em que ele está preso.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  nodes.forEach((n) => { if (n.type === "boundaryTimer" && byId.has(n.attachedTo)) n.lane = byId.get(n.attachedTo).lane; });
  return { processName: str(g.processName) || "Processo", lanes: lanes.length ? lanes : ["Processo"], nodes, flows };
}

// Devolve { errors, warnings } em português, prontos para a IA corrigir.
// errors = o diagrama está errado ou não abre; warnings = provável problema.
export function validateGraph(g) {
  const errors = [], warnings = [];
  const byId = new Map();
  for (const n of g.nodes) {
    if (!n.id) { errors.push(`Há um nó do tipo ${n.type} sem id.`); continue; }
    if (byId.has(n.id)) errors.push(`O id "${n.id}" está repetido em mais de um nó.`);
    byId.set(n.id, n);
  }
  const label = (id) => { const n = byId.get(id); return n ? `"${n.name || n.id}" (${n.id})` : `"${id}"`; };
  const inc = new Map(), out = new Map();
  for (const n of g.nodes) { inc.set(n.id, []); out.set(n.id, []); }
  g.flows.forEach((f, i) => {
    if (!byId.has(f.from) || !byId.has(f.to)) { errors.push(`O fluxo ${i + 1} (${f.from} -> ${f.to}) aponta para um nó que não existe.`); return; }
    if (f.from === f.to) { errors.push(`O fluxo de ${label(f.from)} volta para ele mesmo.`); return; }
    out.get(f.from).push(f); inc.get(f.to).push(f);
  });

  const starts = g.nodes.filter((n) => n.type === "startEvent");
  const ends = g.nodes.filter((n) => n.type === "endEvent");
  if (!starts.length) errors.push("Não há evento de início (startEvent).");
  if (!ends.length) errors.push("Não há evento de fim (endEvent).");

  for (const n of g.nodes) {
    const i = inc.get(n.id).length, o = out.get(n.id).length;
    const name = label(n.id);
    if (n.type === "startEvent") {
      if (i) errors.push(`O início ${name} recebe fluxos; início não pode ter entrada.`);
      if (!o) errors.push(`O início ${name} não tem saída.`);
      const et = eventTypeOf(n);
      if (!n.name && (et === "timer" || et === "conditional")) warnings.push(`O início ${n.id} é ${et === "timer" ? "temporizador" : "condicional"} mas não diz ${et === "timer" ? "quando ocorre (ex.: \"Todo dia 1º\")" : "a condição (ex.: \"Estoque abaixo do mínimo\")"}.`);
    } else if (n.type === "endEvent") {
      if (o) errors.push(`O fim ${name} tem saída; um evento de fim encerra o caminho e não continua.`);
      if (!i) errors.push(`O fim ${name} não recebe nenhum fluxo.`);
    } else if (n.type === "boundaryTimer") {
      const host = byId.get(n.attachedTo);
      if (!host || !ACTIVITIES.has(host.type)) errors.push(`O temporizador de borda ${name} precisa estar preso (attachedTo) a uma atividade existente.`);
      if (i) errors.push(`O temporizador de borda ${name} recebe fluxos; ele só pode ter saída.`);
      if (!o) errors.push(`O temporizador de borda ${name} não tem saída: diga o que acontece quando o prazo estoura.`);
      if (!n.name) warnings.push(`O temporizador de borda ${n.id} não diz o prazo (ex.: "48 horas").`);
    } else {
      if (!i) errors.push(`${name} não recebe nenhum fluxo (nó solto).`);
      if (!o) errors.push(`${name} não tem saída: todo caminho precisa chegar a um evento de fim.`);
    }
    if (ACTIVITIES.has(n.type)) {
      if (/\?\s*$/.test(n.name)) errors.push(`A atividade ${name} é uma pergunta; decisões devem ser gateways.`);
      if (o > 1) errors.push(`A atividade ${name} tem ${o} saídas; use um gateway (exclusivo para decisão, paralelo para atividades simultâneas).`);
      if (!n.name) errors.push(`A atividade ${n.id} está sem nome.`);
    }
    if (n.type === "timerEvent") {
      if (i !== 1 || o !== 1) errors.push(`O evento de tempo ${name} deve ter exatamente uma entrada e uma saída.`);
      if (!n.name) warnings.push(`O evento de tempo ${n.id} não diz quanto tempo (ex.: "2 dias úteis").`);
    }
    if (GATEWAYS.has(n.type)) {
      if (i <= 1 && o <= 1) errors.push(`O gateway ${name} não divide nem junta caminhos (1 entrada e 1 saída); remova-o ou complete os caminhos.`);
      if (i > 1 && o > 1) warnings.push(`O gateway ${name} junta e divide ao mesmo tempo; separe em um gateway de junção seguido de um de divisão.`);
      const split = o > 1;
      if (split && n.type !== "parallelGateway") {
        out.get(n.id).forEach((f) => { if (!f.label) errors.push(`A saída de ${name} para ${label(f.to)} está sem condição; rotule cada saída de uma decisão.`); });
        if (!n.name) warnings.push(`O gateway de decisão ${n.id} está sem a pergunta.`);
      }
      if (split && n.type === "parallelGateway") {
        out.get(n.id).forEach((f) => { if (f.label) warnings.push(`A saída de ${name} tem a condição "${f.label}", mas saídas de gateway paralelo não têm condição (todas acontecem).`); });
      }
    }
  }

  // Alcance: tudo deve sair de um início e chegar a um fim.
  const fwd = new Map(g.nodes.map((n) => [n.id, []])), back = new Map(g.nodes.map((n) => [n.id, []]));
  g.flows.forEach((f) => { if (fwd.has(f.from) && fwd.has(f.to)) { fwd.get(f.from).push(f.to); back.get(f.to).push(f.from); } });
  // Evento de borda "pertence" à atividade: alcançá-la alcança o evento.
  g.nodes.forEach((n) => { if (n.type === "boundaryTimer" && fwd.has(n.attachedTo)) { fwd.get(n.attachedTo).push(n.id); back.get(n.id).push(n.attachedTo); } });
  const reach = (seeds, adj) => { const seen = new Set(seeds); const st = [...seeds]; while (st.length) for (const m of adj.get(st.pop()) || []) if (!seen.has(m)) { seen.add(m); st.push(m); } return seen; };
  const fromStart = reach(starts.map((n) => n.id), fwd);
  const toEnd = reach(ends.map((n) => n.id), back);
  for (const n of g.nodes) {
    if (starts.length && !fromStart.has(n.id)) errors.push(`${label(n.id)} não é alcançado a partir do início.`);
    else if (ends.length && !toEnd.has(n.id) && n.type !== "endEvent") errors.push(`A partir de ${label(n.id)} não há caminho até um evento de fim (laço sem saída ou caminho interrompido).`);
  }

  // Ramos de um gateway paralelo não podem ser reunidos por um gateway
  // exclusivo (a etapa seguinte rodaria uma vez para cada ramo).
  for (const p of g.nodes.filter((n) => n.type === "parallelGateway" && out.get(n.id).length > 1)) {
    const firstMerge = (startId) => {
      const seen = new Set([p.id]); const st = [startId];
      while (st.length) {
        const id = st.pop(); if (seen.has(id)) continue; seen.add(id);
        const node = byId.get(id); if (!node) continue;
        if (GATEWAYS.has(node.type) && inc.get(id).length > 1) return id;
        for (const f of out.get(id)) st.push(f.to);
      }
      return null;
    };
    const merges = out.get(p.id).map((f) => firstMerge(f.to)).filter(Boolean);
    const counts = merges.reduce((m, id) => m.set(id, (m.get(id) || 0) + 1), new Map());
    for (const [id, c] of counts) {
      if (c > 1 && byId.get(id).type === "exclusiveGateway") errors.push(`Os ramos paralelos que saem de ${label(p.id)} se juntam no gateway exclusivo ${label(id)}; a sincronização de ramos paralelos exige um gateway paralelo de junção.`);
    }
    // Junção paralela alcançável por dois ou mais ramos, mesmo depois de
    // decisões internas do ramo.
    const parallelJoins = (startId) => {
      const seen = new Set([p.id]), found = new Set(), st = [startId];
      while (st.length) {
        const id = st.pop(); if (seen.has(id)) continue; seen.add(id);
        const node = byId.get(id); if (!node) continue;
        if (node.type === "parallelGateway" && inc.get(id).length > 1) { found.add(id); continue; }
        for (const f of out.get(id)) st.push(f.to);
      }
      return found;
    };
    const joinHits = new Map();
    out.get(p.id).forEach((f) => parallelJoins(f.to).forEach((id) => joinHits.set(id, (joinHits.get(id) || 0) + 1)));
    if (![...joinHits.values()].some((c) => c > 1)) warnings.push(`Os ramos paralelos de ${label(p.id)} não têm um gateway paralelo de junção (sincronização) antes de seguir.`);
  }

  for (const n of g.nodes) if (n.lane && !g.lanes.includes(n.lane)) warnings.push(`O nó ${label(n.id)} está na raia "${n.lane}", que não está na lista de raias.`);
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function summarizeGraph(g) {
  const count = (pred) => g.nodes.filter(pred).length;
  return {
    activities: count((n) => ACTIVITIES.has(n.type)),
    decisions: count((n) => n.type === "exclusiveGateway" || n.type === "inclusiveGateway"),
    parallels: count((n) => n.type === "parallelGateway"),
    timers: count((n) => n.type === "timerEvent" || n.type === "boundaryTimer"),
    ends: count((n) => n.type === "endEvent"),
    lanes: g.lanes.length,
  };
}
