// Modelos de design do POP e paleta de cores. Módulo ESM usado pelo servidor
// (pop-pptx.js) e pelo navegador (prévia, miniaturas e leitura da logo).
// Cores em hex SEM '#', como o pptxgenjs espera.

export const MODELS = [
  { id: 1, name: 'Clássico', desc: 'Fundo claro e número da seção vazado' },
  { id: 2, name: 'Faixas', desc: 'Capa e cabeçalhos em faixa de cor' },
  { id: 3, name: 'Lateral', desc: 'Barra lateral colorida com título vertical' },
];

// Paleta original dos modelos (azul-marinho + laranja).
export const DEFAULT_PALETTE = { primary: '1B2F6E', accent: 'F26B1D' };

// Neutros fixos dos modelos.
const NEUTRAL = {
  body: '22283A', muted: '5A6585', line: 'E1E3EA', gray: 'EFEFEF',
  sign: '3A4258', boxFill: 'FAFAFA', boxLine: 'C9CDD8', white: 'FFFFFF',
};

const HEX = /^[0-9A-F]{6}$/;
export function normHex(v) {
  const s = String(v == null ? '' : v).trim().replace(/^#/, '').toUpperCase();
  return HEX.test(s) ? s : null;
}

const toRgb = (h) => [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
const toHex = (r, g, b) => [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('').toUpperCase();

function luminance(h) {
  const [r, g, b] = toRgb(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
const hsl = (h) => rgbToHsl(...toRgb(h));

// Mistura a cor com outra (t = quanto da outra entra).
export function mix(a, b, t) {
  const x = toRgb(a), y = toRgb(b);
  return toHex(x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t);
}

// Escurece (mantendo matiz e saturação) até atingir o contraste pedido com o branco.
function darkenTo(h, ratio) {
  let [hh, s, l] = hsl(h);
  let out = h;
  while (contrast(out, 'FFFFFF') < ratio && l > 0.04) { l -= 0.01; out = hslToHex(hh, s, l); }
  return out;
}

// Cores de cada papel no layout, a partir da paleta (primária + destaque).
// - primary: títulos, tabelas e faixas (texto branco em cima) → contraste ≥ 6 com o branco.
// - accent: títulos grandes, números, marcadores e pontos → contraste ≥ 3, como no modelo original.
export function buildTheme(palette) {
  const primary = darkenTo(normHex(palette && palette.primary) || DEFAULT_PALETTE.primary, 6);
  const accent = darkenTo(normHex(palette && palette.accent) || DEFAULT_PALETTE.accent, 3);
  return {
    ...NEUTRAL,
    primary,
    accent,
    // Destaque claro para campos que ainda precisam ser preenchidos.
    tint: mix(accent, 'FFFFFF', 0.85),
    // Rótulos e textos claros sobre a faixa primária.
    onPrimaryMuted: mix(primary, 'FFFFFF', 0.62),
    onPrimaryText: mix(primary, 'FFFFFF', 0.8),
    // Título sobre a faixa: o destaque, se for legível sobre a primária; senão branco.
    onPrimaryTitle: contrast(accent, primary) >= 3 ? accent : 'FFFFFF',
    primarySoft: mix(primary, 'FFFFFF', 0.45),
  };
}

// Extrai a paleta das cores da logo (pixels RGBA de um canvas). Ignora fundo
// transparente, branco, preto e cinzas. Devolve { primary, accent } ou null
// quando a logo não tem cor marcante (aí vale a paleta padrão).
export function paletteFromPixels(data) {
  // Faixas de matiz (10°) × faixas de luminosidade (escura / média / clara):
  // separa tanto cores diferentes quanto dois tons da mesma cor (ex.: marinho + azul-claro).
  const HB = 36, LB = 3;
  const band = (l) => (l < 0.38 ? 0 : l > 0.62 ? 2 : 1);
  const b = Array.from({ length: HB * LB }, () => ({ n: 0, r: 0, g: 0, bl: 0 }));
  let opaque = 0, colored = 0;
  const step = Math.max(1, Math.floor(data.length / 4 / 40000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] < 160) continue;
    opaque++;
    const r = data[i], g = data[i + 1], bl = data[i + 2];
    const [h, s, l] = rgbToHsl(r, g, bl);
    if (s < 0.22 || l > 0.93 || l < 0.08) continue;
    colored++;
    const k = (Math.floor(h / (360 / HB)) % HB) * LB + band(l);
    b[k].n++; b[k].r += r; b[k].g += g; b[k].bl += bl;
  }
  if (!opaque || colored < Math.max(20, opaque * 0.02)) return null;
  // Junta cada faixa com as vizinhas de matiz (mesma luminosidade).
  const near = (k) => { const hb = Math.floor(k / LB), lb = k % LB; return [k, ((hb + 1) % HB) * LB + lb, ((hb + HB - 1) % HB) * LB + lb]; };
  const score = b.map((_, k) => b[k].n + 0.5 * (b[near(k)[1]].n + b[near(k)[2]].n));
  const avg = (k) => {
    const ks = near(k).filter((j) => b[j].n);
    const n = ks.reduce((t, j) => t + b[j].n, 0);
    return toHex(ks.reduce((t, j) => t + b[j].r, 0) / n, ks.reduce((t, j) => t + b[j].g, 0) / n, ks.reduce((t, j) => t + b[j].bl, 0) / n);
  };
  const order = score.map((sc, k) => [sc, k]).sort((x, y) => y[0] - x[0]);
  const main = order[0][1];
  const hueDist = (a, c) => { const d = Math.abs(Math.floor(a / LB) - Math.floor(c / LB)) % HB; return Math.min(d, HB - d); };
  // Segunda cor: outro matiz, ou o mesmo matiz em outra luminosidade.
  const second = order.find(([sc, k]) => sc >= order[0][0] * 0.08 && (hueDist(k, main) >= 4 || (hueDist(k, main) <= 3 && k % LB !== main % LB)));
  const c1 = avg(main);
  if (second) {
    const c2 = avg(second[1]);
    // A mais escura vira a primária; a mais clara/viva, o destaque.
    return luminance(c1) <= luminance(c2) ? { primary: c1, accent: c2 } : { primary: c2, accent: c1 };
  }
  // Uma cor só: ela é o destaque, e um tom bem escuro dela vira a primária.
  const [h, s] = hsl(c1);
  const sat = Math.min(0.85, Math.max(0.45, s));
  let l = 0.5, primary = hslToHex(h, sat, l);
  while (contrast(primary, 'FFFFFF') < 10 && l > 0.05) { l -= 0.01; primary = hslToHex(h, sat, l); }
  return { primary, accent: c1 };
}

export function modelInfo(id) {
  return MODELS.find((m) => m.id === Number(id)) || MODELS[0];
}
