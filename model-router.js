// Escolha do modelo da Anthropic para o mapeamento BPMN.
//
// O Jev (TypeSafe, modelo jev-latest) avalia a descrição do processo em quatro
// dimensões independentes de complexidade, todas numa única requisição. O código
// combina as notas com pesos e escolhe o modelo: processo simples -> modelo
// simples (mais rápido e barato), processo complexo -> modelo mais capaz.
// Sem TYPESAFE_API_KEY, ou se o Jev falhar, usa o modelo padrão do servidor.

import { TypeSafeClient, score } from "@typesafe-ai/sdk";

// Lido sob demanda: os imports rodam antes de o server.js carregar o .env.
export function tiers() {
  return {
    simple: { model: process.env.ARI_MODEL_SIMPLES || "claude-haiku-5-5", label: "baixa" },
    medium: { model: process.env.ARI_MODEL_MEDIO || "claude-sonnet-5-5", label: "média" },
    complex: { model: process.env.ARI_MODEL_COMPLEXO || "claude-opus-5-5", label: "alta" },
  };
}

// Cada pergunta mede UMA dimensão; os níveis descrevem situações concretas.
const QUESTIONS = {
  branching: score("How much conditional logic does the business process in `description` contain?", [
    "A straight sequence of steps with no decisions or conditions",
    "One or two simple yes/no decisions, each with a short outcome",
    "Several decisions, including chained or nested conditions, loops, rework, or exception paths",
  ]),
  participants: score("How many distinct people, areas, or organizations take part in the business process in `description`?", [
    "One person or one area performs every step",
    "Two or three areas or roles hand the work to each other",
    "Four or more areas or roles, or outside parties such as customers or suppliers exchanging information",
  ]),
  size: score("How many separate activities does the business process in `description` contain?", [
    "About five activities or fewer",
    "Roughly six to twelve activities",
    "More than twelve activities",
  ]),
  ambiguity: score("How much must a reader infer to draw the business process in `description` as a flowchart?", [
    "Steps are explicit, in order, and say who performs each one",
    "Mostly explicit, but some order, responsibilities, or conditions are only implied",
    "Loose narrative prose; order, responsibilities, and conditions must largely be inferred",
  ]),
};

// Peso de cada dimensão na complexidade final (soma 1). Ajuste aqui sem
// precisar mudar as perguntas.
const WEIGHTS = { branching: 0.35, ambiguity: 0.25, participants: 0.2, size: 0.2 };

// Limites da complexidade combinada (0 a 1) para cada faixa.
const SIMPLE_MAX = 0.34;
const MEDIUM_MAX = 0.67;

let client;
function getClient() {
  if (client === undefined) {
    client = process.env.TYPESAFE_API_KEY ? new TypeSafeClient({ timeout: 8000, retry: { maxRetries: 1 } }) : null;
  }
  return client;
}

// O mesmo texto gerado de novo não precisa de outra avaliação.
const cache = new Map();
const CACHE_MAX = 100;

export function tierForComplexity(complexity, dims) {
  let tier = complexity < SIMPLE_MAX ? "simple" : complexity < MEDIUM_MAX ? "medium" : "complex";
  // Decisões encadeadas/aninhadas nunca vão para o modelo simples.
  if (tier === "simple" && dims.branching >= 0.75) tier = "medium";
  return tier;
}

// Devolve { tier, model, label, complexity, dims, source } ou null quando o
// roteamento não está disponível (o chamador usa o modelo padrão).
export async function routeBpmnModel(description) {
  const jev = getClient();
  if (!jev) return null;
  const key = description.trim();
  if (cache.has(key)) return cache.get(key);

  try {
    const res = await jev.systemOne({ state: { description: key }, questions: QUESTIONS });
    // Cada Score vira uma posição de 0 a 1 (nota / último nível).
    const dims = {};
    for (const id of Object.keys(QUESTIONS)) {
      const a = res.answers[id];
      const top = Object.keys(a.legend).length - 1;
      dims[id] = top > 0 ? a.score / top : 0;
    }
    const complexity = Object.entries(WEIGHTS).reduce((sum, [id, w]) => sum + w * dims[id], 0);
    const tier = tierForComplexity(complexity, dims);
    const t = tiers()[tier];
    const result = { tier, model: t.model, label: t.label, complexity, dims, source: res.model };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, result);
    return result;
  } catch (err) {
    console.error("[ARI] Jev indisponível, usando o modelo padrão:", err && err.message ? err.message : err);
    return null;
  }
}
