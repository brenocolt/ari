// Layout do POP nos três modelos de design. O desenho é escrito uma vez só,
// em pontos tipográficos (página A4 = 595 x 842 pt), sobre uma "superfície"
// abstrata. O servidor desenha na superfície do pptxgenjs (pop-pptx.js) e o
// navegador na superfície SVG daqui (prévia e miniaturas), então a prévia
// mostra as mesmas páginas, nas mesmas posições, que o arquivo baixado.
//
// Medidas tiradas dos PDFs dos modelos (modelo-pop/modelo 1..3.pdf).

import { buildTheme } from './pop-theme.js';

export const PAGE = { w: 595.28, h: 841.89 };
const FONT = 'Inter';

// ---------------------------------------------------------------------------
// Medida aproximada de texto (Inter). O pptxgenjs não mede texto, então a
// paginação usa esta estimativa; ela erra para mais, para o texto não vazar.
// ---------------------------------------------------------------------------
function charW(ch) {
  if (ch === ' ') return 0.28;
  if (/[iljtfrI.,:;'!|()\[\]]/.test(ch)) return 0.34;
  if (/[mwMW@%]/.test(ch)) return 0.88;
  if (/[A-ZÀ-Ý]/.test(ch)) return 0.72;
  if (/[0-9]/.test(ch)) return 0.62;
  return 0.57;
}
export function textWidth(str, size, o = {}) {
  let w = 0;
  for (const ch of String(str)) w += charW(ch) * size + (o.charSpacing || 0);
  return w * (o.bold ? 1.06 : 1);
}
function lineCount(text, width, size, o = {}) {
  const space = textWidth(' ', size, o);
  let lines = 0;
  String(text == null ? '' : text).split('\n').forEach((p) => {
    let cur = 0, n = 1;
    for (const word of p.split(/\s+/).filter(Boolean)) {
      let ww = textWidth(word, size, o);
      const add = cur ? space + ww : ww;
      if (cur + add <= width) { cur += add; continue; }
      if (cur) n++;
      while (ww > width) { n++; ww -= width; }
      cur = ww;
    }
    lines += n;
  });
  return lines;
}
export function textHeight(text, width, size, lh, o = {}) {
  return lineCount(text, width, size, o) * lh;
}

// Encaixa uma imagem (w/h em px) numa caixa, mantendo a proporção.
function fit(img, x, y, w, h) {
  if (!img || !img.w || !img.h) return { x, y, w, h };
  const a = img.w / img.h;
  const dw = Math.min(w, h * a), dh = dw / a;
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}

// ---------------------------------------------------------------------------
// Dados: preenche o que faltar, igual no servidor e na prévia.
// ---------------------------------------------------------------------------
export function prepareData(raw = {}) {
  const d = { ...raw };
  const s = (v) => (v == null ? '' : String(v)).trim();
  const today = new Date().toLocaleDateString('pt-BR');
  d.processName = s(d.processName) || '[ Nome do processo ]';
  d.sector = s(d.sector) || '[ Setor ]';
  if (!s(d.code)) {
    const ab = d.sector.normalize('NFD').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'XX';
    d.code = 'POP-' + ab + '-001';
  }
  d.code = s(d.code);
  d.version = s(d.version) || '001';
  d.emission = s(d.emission) || today;
  d.lastRevision = s(d.lastRevision) || d.emission;
  d.responsible = s(d.responsible) || 'Equipe de ' + d.sector;
  d.materials = s(d.materials) || '—';
  d.processText = s(d.processText);
  d.author = s(d.author) || 'Produtiva Junior';
  d.reviewCycle = s(d.reviewCycle) || 'Trimestral';
  d.conclusion = s(d.conclusion) || 'Processo concluído.';
  d.steps = (Array.isArray(d.steps) ? d.steps : []).filter((x) => x && typeof x === 'object').map((x) => ({
    title: s(x.title) || '[ Etapa ]',
    description: s(x.description),
    hasPrint: x.hasPrint !== false,
    ifYes: s(x.ifYes),
    ifNo: s(x.ifNo),
  }));
  return d;
}

// ---------------------------------------------------------------------------
// Desenho
// surface.addPage() devolve uma página com: rect, ellipse, line, diamond,
// text e image (coordenadas em pt). assets: { flowchart, logo, clientLogo },
// cada um { data (data URI ou URL), w, h } ou null. opts: { model, palette,
// coverOnly }.
// ---------------------------------------------------------------------------
export function renderPop(surface, raw, assets = {}, opts = {}) {
  const d = prepareData(raw);
  const M = [1, 2, 3].includes(Number(opts.model)) ? Number(opts.model) : 1;
  const T = buildTheme(opts.palette);
  const G = M === 3 ? { x: 81, r: 551 } : M === 2 ? { x: 48, r: 542 } : { x: 48, r: 547 };
  G.w = G.r - G.x;
  G.bottom = 778;
  const PW = PAGE.w, PH = PAGE.h;

  const pages = [];
  const toc = {};
  const late = []; // desenhos que dependem do total de páginas

  const T_ = (p, x, y, w, h, content, s = {}) => p.text(x, y, w, h, content, { font: FONT, size: 10, color: T.body, lh: (s.size || 10) * 1.2, ...s });
  const caps = (v) => String(v).toUpperCase();
  const outlined = (p, str, x, y, w, size, color, s = {}) =>
    T_(p, x, y, w, size * 1.25, str, { size, bold: true, color, outline: { color, width: size > 60 ? 1.1 : 0.9 }, lh: size * 1.2, ...s });

  const dots = (p, x0, y0, cols, rows, dx, dy, size, color, square) => {
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      if (square) p.rect(x0 + c * dx, y0 + r * dy, size, size, { fill: color, radius: size * 0.25 });
      else p.ellipse(x0 + c * dx, y0 + r * dy, size, size, { fill: color });
    }
  };
  // Texto vertical (lido de baixo para cima) na barra lateral do modelo 3.
  const sideLabel = (p, label, x, w, size, bottom, height) =>
    T_(p, x, bottom - height, w, height, caps(label), { size, bold: true, color: T.white, charSpacing: size * 0.32, vert: true, valign: 'middle' });

  const highlight = (p, x, y, text, size, color = T.body) => {
    const w = textWidth(text, size) + 7;
    p.rect(x, y - 1.5, w, size * 1.45, { fill: T.tint });
    T_(p, x + 3.5, y, w, size * 1.3, text, { size, color });
  };

  // ── molduras ──────────────────────────────────────────────────────────────
  // kind: 'section' (primeira página da seção), 'ident' ou 'cont' (continuação).
  function decor(p, kind, label) {
    if (M === 1) {
      p.rect(469.3, 0, PW - 469.3, 29.5, { fill: T.gray });
      dots(p, 471.5, 44.5, 5, 2, 18.1, 15, 3.4, T.accent, true);
    } else if (M === 2) {
      const bandH = kind === 'section' ? 101.4 : kind === 'ident' ? 80 : 70.7;
      p.rect(0, 0, PW, bandH, { fill: T.primary });
      const rows = kind === 'section' ? 3 : 2;
      dots(p, 470.8, kind === 'cont' ? 16.5 : 27.2, 5, rows, 18.1, 18.1, 4.4, T.accent);
      p.rect(572.5, bandH + 19, PW - 572.5, 113, { fill: T.gray });
    } else {
      p.rect(0, 0, 42, PH, { fill: T.accent });
      dots(p, 15.1, 45.8, 2, 6, 8.1, 11.9, 3.6, T.white);
      p.rect(483.7, 0, PW - 483.7, 29.4, { fill: T.gray });
      sideLabel(p, label, 12, 18, 8.2, 812, 330);
    }
  }

  function newPage(kind, label) {
    const p = surface.addPage();
    pages.push(p);
    if (kind) decor(p, kind, label);
    return p;
  }

  function sectionPage(n, title) {
    const num = String(n).padStart(2, '0');
    const p = newPage('section', num + ' ' + title);
    toc[n] = pages.length;
    let y;
    if (M === 1) {
      outlined(p, num, 47, 65, 80, 48, T.accent);
      p.rect(125, 82.6, 30, 3, { fill: T.accent });
      T_(p, 125, 91.3, G.r - 125, 24, caps(title), { size: 19.5, bold: true, color: T.primary, charSpacing: 0.4 });
      y = 141;
    } else if (M === 2) {
      T_(p, G.x, 37.4, 300, 12, 'SEÇÃO ' + num, { size: 9, bold: true, color: T.onPrimaryMuted, charSpacing: 1.6 });
      T_(p, G.x, 55.8, 415, 26, caps(title), { size: 21, bold: true, color: T.onPrimaryTitle, charSpacing: 0.4 });
      y = 133;
    } else {
      outlined(p, num, 80, 52, 160, 67.5, T.accent);
      T_(p, 81, 127.3, G.w, 24, caps(title), { size: 19.5, bold: true, color: T.primary, charSpacing: 0.4 });
      p.line(81, 162, G.r, 162, { color: T.primary, width: 1.25 });
      y = 190;
    }
    return { p, y };
  }

  function contPage(n, title) {
    const num = String(n).padStart(2, '0');
    const p = newPage('cont', num + ' ' + title);
    if (M === 2) {
      T_(p, G.x, 21.4, 300, 12, 'SEÇÃO ' + num, { size: 9, bold: true, color: T.onPrimaryMuted, charSpacing: 1.6 });
      T_(p, G.x, 39, 415, 18, caps(title) + ' (CONT.)', { size: 13.5, bold: true, color: T.onPrimaryTitle, charSpacing: 0.4 });
      return { p, y: 92 };
    }
    return { p, y: 76 };
  }

  function footers() {
    const label = caps(`${d.code} · V${d.version} · SETOR ${d.sector}`);
    const top = M === 2 ? 800.8 : 797.8;
    pages.forEach((p, i) => {
      if (i === 0) return; // capa
      T_(p, G.x, top, G.w - 50, 10, label, { size: 7.5, bold: true, color: T.muted, charSpacing: 1 });
      p.rect(G.r - 30, top + 5, 13, 2, { fill: T.accent });
      T_(p, G.r - 16, top, 16, 10, String(i + 1).padStart(2, '0'), { size: 7.5, bold: true, color: T.muted, align: 'right', charSpacing: 1 });
    });
  }

  // ── capa ────────────────────────────────────────────────────────────────
  function cover() {
    const p = newPage(null);
    const setor = caps('Setor ' + d.sector);
    const proc = caps(d.processName);
    // Nome do setor vazado: diminui a fonte para caber numa linha.
    const setorSize = (max, w) => Math.max(14, Math.min(max, w / Math.max(1, textWidth(setor, 1, { bold: true }))));
    const placeLogo = (img, x, y, w, h) => { if (img) { const f = fit(img, x, y, w, h); p.image(f.x, f.y, f.w, f.h, img); } };

    if (M === 1) {
      p.rect(0, 0, 48.2, 157.7, { fill: T.gray });
      p.rect(408.6, 0, PW - 408.6, 43.8, { fill: T.gray });
      p.rect(563.1, 337.9, PW - 563.1, 157.7, { fill: T.gray });
      p.rect(0, 732, 165.2, 48.2, { fill: T.gray });
      dots(p, 400.3, 38, 7, 3, 21.07, 15, 3.8, T.accent, true);
      dots(p, 35.5, 711.3, 8, 3, 21.1, 15.3, 3.8, T.accent, true);
      [100.1, 117, 134.5, 151.4, 169].forEach((cy) => p.ellipse(60.7 - 6.9, cy - 6.9, 13.8, 13.8, { fill: T.primary }));
      placeLogo(assets.logo, 479.3, 202.7, 59.4, 59.4);
      p.rect(48.2, 270.3, 41.3, 3.8, { fill: T.accent });
      T_(p, 48, 289.5, 470, 110, 'PROCEDIMENTO\nOPERACIONAL\nPADRÃO - POP', { size: 33, bold: true, color: T.accent, lh: 35.5 });
      const ss = setorSize(27, 499);
      outlined(p, setor, 47, 447 - ss * 0.96, 520, ss, T.primary);
      T_(p, 48, 456.5, 499, 70, proc, { size: 17.2, bold: true, color: T.primary, lh: 20.6 });
      placeLogo(assets.clientLogo, 322.9, 707, 225.2, 81.3);
    } else if (M === 2) {
      p.rect(0, 0, PW, 522.5, { fill: T.primary });
      dots(p, 435.4, 49.4, 7, 5, 18.1, 18.1, 5.2, T.accent);
      placeLogo(assets.logo, 48.2, 48.2, 60, 60);
      T_(p, 48, 345, 300, 14, d.code, { size: 10.5, bold: true, color: T.onPrimaryMuted, charSpacing: 1.6 });
      T_(p, 48, 367.9, 500, 120, 'PROCEDIMENTO\nOPERACIONAL\nPADRÃO - POP', { size: 34.5, bold: true, color: T.onPrimaryTitle, lh: 36.5 });
      p.rect(563.1, 522.5, PW - 563.1, 134.5, { fill: T.gray });
      const ss = setorSize(27, 499);
      outlined(p, setor, 47, 578 - ss * 0.96, 515, ss, T.primary);
      T_(p, 48, 587.5, 499, 70, proc, { size: 17.2, bold: true, color: T.primary, lh: 20.6 });
      dots(p, 55.8, 771.4, 6, 2, 18.9, 15, 3.2, T.accent);
      placeLogo(assets.clientLogo, 337.9, 719.5, 210.2, 75);
    } else {
      p.rect(0, 0, 112.6, PH, { fill: T.accent });
      dots(p, 28.1, 55.7, 4, 5, 18, 18, 3.4, T.white);
      sideLabel(p, 'Documento interno', 46, 22, 11.2, 795, 260);
      p.rect(446.1, 0, PW - 446.1, 43.8, { fill: T.gray });
      [83.2, 99.5, 115.1, 130.8, 146.4].forEach((cy, i) => p.ellipse(160.2 - 5.6, cy - 5.6, 11.2, 11.2, { fill: i < 3 ? T.primary : T.primarySoft }));
      placeLogo(assets.logo, 491.2, 78.2, 59.4, 59.4);
      outlined(p, 'POP', 151, 292, 400, 112.5, T.accent);
      T_(p, 154, 420.4, 397, 60, 'PROCEDIMENTO\nOPERACIONAL PADRÃO', { size: 22.5, bold: true, color: T.accent, lh: 26 });
      p.line(155, 495, G.r, 495, { color: T.primary, width: 1.25 });
      const ss = setorSize(24, 397);
      outlined(p, setor, 153, 537 - ss * 0.96, 420, ss, T.primary);
      T_(p, 154, 543.9, 397, 64, proc, { size: 15.7, bold: true, color: T.primary, lh: 19 });
      p.rect(566.3, 352.3, PW - 566.3, 150.2, { fill: T.gray });
      placeLogo(assets.clientLogo, 341, 719.5, 209.6, 75);
    }
  }

  // ── identificação + histórico + sumário ─────────────────────────────────
  function identification() {
    const p = newPage('ident', 'Identificação do documento');
    let y;
    if (M === 1) {
      p.rect(48, 75, 30, 3, { fill: T.accent });
      T_(p, 48, 84.3, G.w, 24, 'IDENTIFICAÇÃO DO DOCUMENTO', { size: 19.5, bold: true, color: T.primary, charSpacing: 0.4 });
      y = 133;
    } else if (M === 2) {
      T_(p, 48, 34.8, 415, 26, 'IDENTIFICAÇÃO DO DOCUMENTO', { size: 21, bold: true, color: T.onPrimaryTitle, charSpacing: 0.4 });
      y = 109.5;
    } else {
      T_(p, 81, 63.3, G.w, 24, 'IDENTIFICAÇÃO DO DOCUMENTO', { size: 19.5, bold: true, color: T.primary, charSpacing: 0.4 });
      p.line(81, 97.6, G.r, 97.6, { color: T.primary, width: 1.25 });
      y = 122.6;
    }
    const rows = [
      ['Título / atividade', d.processName],
      ['Código', d.code],
      ['Área / setor', d.sector],
      ['Responsável(is)', d.responsible],
      ['Emissão · Revisão', `${d.emission} · ${d.lastRevision}`],
      ['Versão', d.version],
      ['Periodicidade de revisão', d.reviewCycle],
      ['Materiais necessários', d.materials],
    ];
    const vx = G.x + 139, vw = G.r - vx;
    p.line(G.x, y, G.r, y, { color: T.primary, width: 1.25 });
    rows.forEach(([l, v], i) => {
      const vh = textHeight(v, vw, 10.1, 14);
      const rh = Math.max(31, vh + 17);
      T_(p, G.x, y + 9.4, 135, 12, l, { size: 9, color: T.muted });
      T_(p, vx, y + 8.6, vw, vh, v, { size: 10.1, lh: 14 });
      y += rh;
      p.line(G.x, y, G.r, y, i === rows.length - 1 ? { color: T.primary, width: 1.25 } : { color: T.line, width: 0.75 });
    });

    y += 22;
    T_(p, G.x, y, G.w, 14, 'HISTÓRICO DE REVISÕES', { size: 10.5, bold: true, color: T.primary, charSpacing: 1 });
    y += 21;
    const k = G.w / 500;
    const cols = [0, 59.4 * k, 148.9 * k, 394.2 * k, G.w];
    p.rect(G.x, y, G.w, 25.6, { fill: T.primary });
    ['Versão', 'Data', 'Descrição da alteração', 'Responsável'].forEach((h, i) =>
      T_(p, G.x + cols[i] + 7.5, y, cols[i + 1] - cols[i] - 10, 25.6, h, { size: 8.2, bold: true, color: T.white, valign: 'middle' }));
    y += 25.6;
    [['001', d.emission, 'Criação do documento', d.author], ['—', '—', '—', '—']].forEach((row, r) => {
      const rh = Math.max(28.4, ...row.map((c, i) => textHeight(c, cols[i + 1] - cols[i] - 12, 9.4, 12.5) + 15));
      row.forEach((c, i) => T_(p, G.x + cols[i] + 7.5, y, cols[i + 1] - cols[i] - 12, rh, c, { size: 9.4, lh: 12.5, color: r ? T.muted : T.body, valign: 'middle' }));
      y += rh;
      p.line(G.x, y, G.r, y, { color: T.line, width: 0.75 });
    });

    y += 30;
    T_(p, G.x, y, G.w, 14, 'SUMÁRIO', { size: 10.5, bold: true, color: T.primary, charSpacing: 1 });
    y += 19;
    const entries = ['Introdução', 'Mapeamento de processos', 'Legenda BPMN', 'O processo e o fluxograma', 'Descrição das etapas', 'POP: procedimento detalhado'];
    entries.forEach((title, i) => {
      const rowY = y;
      T_(p, G.x, rowY, 24, 28, String(i + 1).padStart(2, '0'), { size: 10.1, bold: true, color: T.accent, valign: 'middle' });
      T_(p, G.x + 27, rowY, G.w - 70, 28, title, { size: 10.1, color: T.primary, valign: 'middle' });
      late.push(() => T_(p, G.r - 40, rowY, 40, 28, String(toc[i + 1] || ''), { size: 10.1, color: T.muted, align: 'right', valign: 'middle' }));
      y += 28;
      p.line(G.x, y, G.r, y, { color: T.line, width: 0.75 });
    });
  }

  // ── 01 introdução ───────────────────────────────────────────────────────
  function blocks(p, y, list) {
    list.forEach((b) => {
      if (b.sub) { T_(p, G.x, y, G.w, 14, b.sub, { size: 10.5, bold: true, color: T.primary }); y += 21; }
      const h = textHeight(b.par, G.w, 10.1, 16.8);
      T_(p, G.x, y, G.w, h, b.par, { size: 10.1, lh: 16.8 });
      y += h + (b.gap != null ? b.gap : 18);
    });
    return y;
  }
  function introduction() {
    const { p, y } = sectionPage(1, 'Introdução');
    blocks(p, y, [
      { sub: 'O que é um POP?', par: 'O Procedimento Operacional Padrão (POP) é um documento que descreve, de forma clara e detalhada, todas as etapas necessárias para a execução de uma atividade. Funciona como guia de referência que padroniza a maneira como o trabalho é realizado, garantindo que qualquer colaborador o execute com o mesmo nível de qualidade, independentemente de quem o faça.' },
      { sub: 'Qual a finalidade deste POP?', par: `Este POP tem como finalidade padronizar, documentar e orientar todas as etapas envolvidas no processo de ${d.processName}, realizado pelo setor de ${d.sector}. O objetivo é assegurar uniformidade, clareza e eficiência na execução, reduzindo erros, retrabalho e variações entre colaboradores.` },
      { sub: 'Quem deve seguir este POP?', par: `Este documento é de uso obrigatório para todos os colaboradores do setor de ${d.sector}, bem como para novos integrantes em fase de treinamento. Deve ser consultado sempre que houver dúvidas sobre a execução correta do processo.` },
    ]);
  }

  // ── 02 mapeamento de processos ──────────────────────────────────────────
  function mapping() {
    const s = sectionPage(2, 'Mapeamento de processos');
    const p = s.p;
    let y = blocks(p, s.y, [
      { sub: 'O que são processos?', par: 'Processos são conjuntos de atividades organizadas com o objetivo de transformar entradas em saídas e gerar resultados. Eles alinham o trabalho dos setores aos objetivos da empresa, integrando tarefas de diferentes áreas de forma coordenada. Processos bem definidos proporcionam visão clara da operação, promovem o engajamento da equipe e facilitam a tomada de decisão.', gap: 11 },
      { par: 'O mapeamento de processos registra como as atividades ocorrem na prática, permitindo identificar pontos de melhoria. A partir dele evolui-se para a modelagem, que representa a versão otimizada do processo. Para compreender os fluxogramas deste documento utilizamos a notação BPMN, cuja legenda está descrita a seguir.' },
    ]);
    y += 14;
    const gap = 10.6, cw = (G.w - gap) / 2;
    const cards = [
      { x: G.x, fill: T.gray, tag: 'AS IS', title: 'Mapeamento', text: 'Como o processo acontece hoje: o estado atual.', tc: T.primary, bc: T.body },
      { x: G.x + cw + gap, fill: T.primary, tag: 'TO BE', title: 'Modelagem', text: 'Como o processo deve acontecer: o estado otimizado.', tc: T.white, bc: T.onPrimaryText },
    ];
    const ch = Math.max(119, ...cards.map((c) => 69 + textHeight(c.text, cw - 34, 9.7, 15.6) + 17));
    cards.forEach((c) => {
      p.rect(c.x, y, cw, ch, { fill: c.fill });
      T_(p, c.x + 17, y + 17.6, cw - 34, 12, c.tag, { size: 8.2, bold: true, color: T.accent, charSpacing: 1.6 });
      T_(p, c.x + 17, y + 41.7, cw - 34, 21, c.title, { size: 16.5, bold: true, color: c.tc });
      T_(p, c.x + 17, y + 69, cw - 34, ch - 80, c.text, { size: 9.7, lh: 15.6, color: c.bc });
    });
  }

  // ── 03 legenda BPMN ─────────────────────────────────────────────────────
  function icon(p, kind, x, y) {
    const s = 17, c = T.primary, ln = { color: c, width: 1.1 };
    const cx = x + s / 2, cy = y + s / 2;
    const circle = (r, o) => p.ellipse(cx - r, cy - r, r * 2, r * 2, o);
    switch (kind) {
      case 'start': circle(8, { line: ln }); break;
      case 'startMsg': circle(8, { line: ln }); p.rect(cx - 4.5, cy - 3, 9, 6, { line: { color: c, width: 0.9 } }); break;
      case 'startTimer': circle(8, { line: ln }); circle(5.4, { line: { color: c, width: 0.9 } }); break;
      case 'end': circle(7.6, { line: { color: c, width: 2.2 } }); break;
      case 'terminal': circle(7.6, { line: { color: c, width: 2.2 } }); circle(4, { fill: c }); break;
      case 'endMsg': circle(7.6, { line: { color: c, width: 2.2 } }); p.rect(cx - 4, cy - 2.6, 8, 5.2, { fill: c }); break;
      case 'task': p.rect(x - 1, y + 1.5, 24, 15, { line: ln, radius: 2.5 }); break;
      case 'subprocess':
        p.rect(x - 1, y + 1.5, 24, 15, { line: ln, radius: 2.5 });
        p.rect(x + 8, y + 10.5, 6, 6, { line: { color: c, width: 0.7 } });
        T_(p, x + 8, y + 10.2, 6, 6, '+', { size: 6, color: c, align: 'center', valign: 'middle', lh: 6 });
        break;
      case 'arrow': p.line(x - 1, cy, x + 22, cy, { color: c, width: 1.1, arrow: true }); break;
      case 'link': p.line(x - 1, cy, x + 22, cy, { color: c, width: 1.1, dash: true, arrow: true }); break;
      case 'gwX': case 'gwP': case 'gwO':
        p.diamond(x, y, s, s, { line: ln });
        if (kind === 'gwO') circle(3.4, { line: { color: c, width: 0.9 } });
        else T_(p, x, y, s, s, kind === 'gwX' ? '×' : '+', { size: 8.2, color: c, align: 'center', valign: 'middle', lh: 9 });
        break;
      case 'data':
        p.rect(x + 1, y - 1, 13, 18, { line: ln });
        break;
      case 'annotation':
        p.line(x + 1, y - 1, x + 1, y + 18, ln);
        p.line(x + 1, y - 1, x + 8, y - 1, ln);
        p.line(x + 1, y + 18, x + 8, y + 18, ln);
        break;
    }
  }
  function legend() {
    const s = sectionPage(3, 'Legenda BPMN');
    const p = s.p;
    const intro = 'Referência dos principais elementos da notação BPMN utilizados nos fluxogramas deste documento.';
    T_(p, G.x, s.y, G.w, 16, intro, { size: 10.1, lh: 16.8 });
    let y = s.y + textHeight(intro, G.w, 10.1, 16.8) + 14;
    const gap = 23.6, cw = (G.w - gap) / 2;
    const rows = [
      [['Eventos de início', [['start', 'Início', 'Início de um processo.'], ['startMsg', 'Mensagem', 'Início pela chegada de uma comunicação.'], ['startTimer', 'Temporal', 'Início a partir de um fato temporal.']]],
        ['Eventos de fim', [['end', 'Fim', 'Fim de um processo.'], ['terminal', 'Terminal', 'Fim sem nenhuma atividade posterior.'], ['endMsg', 'Mensagem', 'Fim com envio de uma comunicação.']]]],
      [['Atividades', [['task', 'Tarefa', 'Ação realizada por pessoa ou sistema.'], ['subprocess', 'Subprocesso', 'Conjunto de atividades em sequência.']]],
        ['Conexão', [['arrow', 'Seta (fluxo)', 'Sequência entre os símbolos do processo.'], ['link', 'Link', 'Conexão entre partes do mesmo fluxo.']]]],
      [['Gateways', [['gwX', 'Exclusivo', 'Apenas um dos caminhos será seguido.'], ['gwP', 'Paralelo', 'Divide o fluxo em caminhos simultâneos.'], ['gwO', 'Inclusivo', 'Combinação possível de caminhos.']]],
        ['Artefatos', [['data', 'Objeto de dados', 'Documento ou dado ligado à atividade.'], ['annotation', 'Anotação', 'Comentário que agrega informação.']]]],
    ];
    const tw = cw - 31;
    rows.forEach((row) => {
      let rowH = 0;
      row.forEach(([title, items], ci) => {
        const x = G.x + ci * (cw + gap);
        T_(p, x, y, cw, 12, caps(title), { size: 9, bold: true, color: T.accent, charSpacing: 1 });
        p.line(x, y + 16, x + cw, y + 16, { color: T.primary, width: 1.25 });
        let iy = y + 27;
        items.forEach(([kind, name, desc]) => {
          const th = textHeight(name + '. ' + desc, tw, 9, 12.6, { bold: false }) ;
          icon(p, kind, x, iy + (th > 13 ? 3 : -2));
          T_(p, x + 31, iy, tw, th, [{ text: name + '. ', bold: true, color: T.primary }, { text: desc }], { size: 9, lh: 12.6 });
          iy += Math.max(17, th) + 10;
        });
        rowH = Math.max(rowH, iy - y);
      });
      y += rowH + 8;
    });
  }

  // ── 04 processo e fluxograma ────────────────────────────────────────────
  function processAndFlow() {
    let { p, y } = sectionPage(4, 'O processo e o fluxograma');
    T_(p, G.x, y, G.w, 14, 'Descrição do processo', { size: 10.5, bold: true, color: T.primary });
    y += 21;
    const paras = d.processText ? d.processText.split(/\n+/).map((t) => t.trim()).filter(Boolean) : [];
    if (paras.length) {
      paras.forEach((par) => {
        const h = textHeight(par, G.w, 10.1, 16.8);
        if (y + h > G.bottom) ({ p, y } = contPage(4, 'O processo e o fluxograma'));
        T_(p, G.x, y, G.w, h, par, { size: 10.1, lh: 16.8 });
        y += h + 8;
      });
    } else {
      highlight(p, G.x, y, 'Descreva o processo em texto corrido.', 10.1);
      y += 22;
    }
    y += 16;
    // Descrição longa: o fluxograma ganha uma página própria.
    if (G.bottom - y - 21 < 220) ({ p, y } = contPage(4, 'O processo e o fluxograma'));
    T_(p, G.x, y, G.w, 14, 'Fluxograma', { size: 10.5, bold: true, color: T.primary });
    y += 21;
    const bh = G.bottom - y;
    p.rect(G.x, y, G.w, bh, { fill: T.boxFill, line: { color: T.boxLine, width: 0.75, dash: true } });
    const img = assets.flowchart;
    if (img) {
      const f = fit(img, G.x + 12, y + 12, G.w - 24, bh - 24);
      p.image(f.x, f.y, f.w, f.h, img);
    } else {
      T_(p, G.x, y, G.w, bh, 'COLE AQUI O FLUXOGRAMA (BPMN) · PNG OU SVG', { size: 8.2, bold: true, color: T.muted, charSpacing: 1, align: 'center', valign: 'middle' });
    }
    // Fluxograma largo (pool BPMN): página extra com a imagem girada 90°,
    // aproveitando a altura da folha. O início do processo fica no topo.
    if (img && img.w / img.h >= 1.6) {
      const z = contPage(4, 'O processo e o fluxograma');
      const note = 'Fluxograma ampliado e girado 90° para leitura: o início do processo fica no topo da página.';
      T_(z.p, G.x, z.y, G.w, 14, note, { size: 9.4, color: T.muted, lh: 13 });
      const top = z.y + 26, availW = G.w, availH = G.bottom - top;
      const a = img.w / img.h;
      const dw = Math.min(availH, availW * a), dh = dw / a;
      const cx = G.x + availW / 2, cy = top + availH / 2;
      z.p.image(cx - dw / 2, cy - dh / 2, dw, dh, img, { rotate: 90 });
    }
  }

  // Caminhos de uma decisão (SE NÃO / SE SIM), com a barra de destaque à esquerda.
  function branchesHeight(st, width) {
    const list = [['SE NÃO', st.ifNo], ['SE SIM', st.ifYes]].filter((b) => b[1]);
    return list.reduce((t, b) => t + Math.max(20, textHeight(b[1], width - 66, 9.7, 13.5) + 6.5), 0);
  }
  function drawBranches(p, st, x, y, width) {
    const list = [['SE NÃO', st.ifNo], ['SE SIM', st.ifYes]].filter((b) => b[1]);
    const h = branchesHeight(st, width);
    if (!h) return 0;
    p.rect(x, y, 1.9, h, { fill: T.accent });
    let by = y;
    list.forEach(([label, text]) => {
      const th = textHeight(text, width - 66, 9.7, 13.5);
      T_(p, x + 9.2, by + 3.5, 54, 12, label, { size: 8.2, bold: true, color: T.primary });
      T_(p, x + 66, by + 2.5, width - 66, th, text, { size: 9.7, lh: 13.5 });
      by += Math.max(20, th + 6.5);
    });
    return h;
  }

  // ── 05 descrição das etapas ─────────────────────────────────────────────
  function stepsList() {
    let { p, y } = sectionPage(5, 'Descrição das etapas');
    const intro = 'Etapas do processo na ordem de execução. Nas decisões, os caminhos aparecem como SE SIM e SE NÃO.';
    const ih = textHeight(intro, G.w, 10.1, 16.3);
    T_(p, G.x, y, G.w, ih, intro, { size: 10.1, lh: 16.3 });
    y += ih + 18;
    p.line(G.x, y, G.r, y, { color: T.primary, width: 1.25 });
    const tx = G.x + 34, tw = G.r - tx;
    const bx = G.x + 30.8, bw = G.r - bx; // caminhos das decisões
    const rows = d.steps.map((st, i) => ({ st, label: String(i + 1), dec: !!(st.ifYes || st.ifNo) }));
    rows.push({ st: { title: d.conclusion }, label: 'FIM', end: true });
    rows.forEach(({ st, label, dec, end }) => {
      const th = textHeight(st.title, tw, 10.1, 14.5);
      const bh = dec ? branchesHeight(st, bw) + 8 : 0;
      const rh = Math.max(20.6, th) + bh + 20.6;
      if (y + rh > G.bottom) {
        ({ p, y } = contPage(5, 'Descrição das etapas'));
        p.line(G.x, y, G.r, y, { color: T.primary, width: 1.25 });
      }
      const by = y + 10.3;
      p.ellipse(G.x, by, 20.6, 20.6, { fill: dec || end ? T.primary : T.accent });
      T_(p, G.x, by, 20.6, 20.6, label, { size: end ? 6.7 : 9, bold: true, color: T.white, align: 'center', valign: 'middle', lh: 10 });
      T_(p, tx, by + (th > 14.5 ? 0 : 3), tw, th, st.title, { size: 10.1, lh: 14.5 });
      if (dec) drawBranches(p, st, bx, by + Math.max(20.6, th) + 6, bw);
      y += rh;
      p.line(G.x, y, G.r, y, { color: T.line, width: 0.75 });
    });
  }

  // ── 06 procedimento detalhado ───────────────────────────────────────────
  function detailed() {
    let { p, y } = sectionPage(6, 'Procedimento detalhado');
    const first = pages.length;
    // Quadro de identificação do POP.
    const bw = 1.4, x = G.x, w = G.w;
    const top = y;
    p.rect(x, y, w, 26.9, { fill: T.primary });
    T_(p, x + 10, y, w - 120, 26.9, 'PROCEDIMENTO OPERACIONAL PADRÃO', { size: 8.2, bold: true, color: T.white, charSpacing: 1.2, valign: 'middle' });
    T_(p, x + w - 150, y, 140, 26.9, d.code, { size: 8.2, bold: true, color: T.white, charSpacing: 1.2, valign: 'middle', align: 'right' });
    y += 26.9;
    const cell = (cx, cy, cw, ch, label, value) => {
      T_(p, cx + 10, cy + 9.4, cw - 20, 10, caps(label), { size: 7.5, bold: true, color: T.muted, charSpacing: 1 });
      T_(p, cx + 10, cy + 22.4, cw - 20, ch - 26, value, { size: 9.4, lh: 13 });
    };
    const rowH = (cells) => Math.max(40.5, ...cells.map(([, cw, , v]) => 22.4 + textHeight(v, cw - 20, 9.4, 13) + 6));
    const tableRow = (cells) => {
      const h = rowH(cells);
      cells.forEach(([cx, cw, l, v], i) => {
        cell(cx, y, cw, h, l, v);
        if (i) p.line(cx, y, cx, y + h, { color: T.line, width: 0.75 });
      });
      y += h;
      return h;
    };
    const c1 = w * 0.443, c2 = w * 0.277;
    tableRow([[x, c1, 'Atividade', d.processName], [x + c1, c2, 'Responsável(is)', d.responsible], [x + c1 + c2, w - c1 - c2, 'Área', d.sector]]);
    p.line(x, y, x + w, y, { color: T.line, width: 0.75 });
    tableRow([[x, w, 'Materiais necessários', d.materials]]);
    p.line(x, y, x + w, y, { color: T.line, width: 0.75 });
    const q = w / 4;
    const lastRowY = y;
    tableRow([[x, q, 'Emissão', d.emission], [x + q, q, 'Revisão', d.lastRevision], [x + 2 * q, q, 'Versão', d.version], [x + 3 * q, q, 'Página', '']]);
    p.rect(x, top, w, y - top, { line: { color: T.primary, width: bw } });
    const tp = p;
    late.push(() => T_(tp, x + 3 * q + 10, lastRowY + 22.4, q - 20, 14, `1 de ${pages.length - first + 1}`, { size: 9.4, lh: 13 }));
    y += 21.5;

    const cont = () => contPage(6, 'Procedimento detalhado');
    d.steps.forEach((st, i) => {
      const print = st.hasPrint;
      const lw = print ? 222 : G.w;
      const titleH = textHeight(st.title, lw - 34, 11.2, 15, { bold: true });
      const desc = st.description || 'Descreva exatamente o que fazer nesta etapa, de forma objetiva.';
      const descH = textHeight(desc, lw, 10.1, 16.6);
      const dec = !!(st.ifYes || st.ifNo);
      const head = 15 + Math.max(22.5, titleH + 3.75);
      const leftH = head + 15.1 + 12.5 + descH + (dec ? 10 + branchesHeight(st, lw) : 0);
      // O quadro do print encolhe (até 150 pt) para a etapa caber no resto da página.
      const sizeFor = (room) => (print ? Math.max(150, Math.min(225, room - 22 - 15)) : 0);
      let printH = sizeFor(G.bottom - y);
      // Última etapa: se o print encolhido deixar as aprovações na mesma página, encolhe.
      const keep = 656 - y;
      if (print && i === d.steps.length - 1 && keep - 37 >= 150 && leftH + 22 <= keep) printH = Math.min(printH, sizeFor(keep));
      let blockH = Math.max(leftH, print ? 15 + printH : 0) + 22;
      if (y + blockH > G.bottom) {
        ({ p, y } = cont());
        printH = 225;
        blockH = Math.max(leftH, print ? 15 + printH : 0) + 22;
      }
      p.line(G.x, y, G.r, y, { color: T.primary, width: 1.25 });
      p.ellipse(G.x, y + 15, 22.5, 22.5, { fill: T.accent });
      T_(p, G.x, y + 15, 22.5, 22.5, String(i + 1), { size: 9.7, bold: true, color: T.white, align: 'center', valign: 'middle', lh: 11 });
      T_(p, G.x + 34, y + 18.75, lw - 34, titleH, st.title, { size: 11.2, bold: true, color: T.primary, lh: 15 });
      const ly = y + head + 15.1 - 8;
      T_(p, G.x, ly, lw, 10, 'DESCRIÇÃO', { size: 7.5, bold: true, color: T.muted, charSpacing: 1 });
      if (st.description) T_(p, G.x, ly + 12.5, lw, descH, desc, { size: 10.1, lh: 16.6 });
      else highlight(p, G.x, ly + 12.5, desc, 10.1);
      if (dec) drawBranches(p, st, G.x, ly + 12.5 + descH + 10, lw);
      if (print) {
        const px = G.x + 236.5;
        p.rect(px, y + 15, G.r - px, printH, { fill: T.boxFill, line: { color: T.boxLine, width: 0.75, dash: true } });
        T_(p, px, y + 15, G.r - px, printH, 'PRINT / EVIDÊNCIA DA TELA', { size: 8.2, bold: true, color: T.muted, charSpacing: 1, align: 'center', valign: 'middle' });
      }
      y += blockH;
    });

    // Aprovações, perto do pé da página como no modelo.
    if (y + 24 > 680) ({ p, y } = cont());
    const ay = Math.max(y + 24, 680);
    T_(p, G.x, ay, G.w, 14, 'APROVAÇÕES', { size: 10.5, bold: true, color: T.primary, charSpacing: 1.2 });
    const gap = 19.4, cw = (G.w - 2 * gap) / 3;
    [['Elaborado por', `${d.author} · ${d.emission}`, false], ['Revisado por', 'Nome · data', true], ['Aprovado por', 'Nome · data', true]].forEach(([l, v, hl], i) => {
      const cx = G.x + i * (cw + gap);
      p.line(cx, ay + 64.6, cx + cw, ay + 64.6, { color: T.sign, width: 0.9 });
      T_(p, cx, ay + 72.8, cw, 10, caps(l), { size: 7.5, bold: true, color: T.muted, charSpacing: 1 });
      if (hl) highlight(p, cx, ay + 85, v, 9.4);
      else T_(p, cx, ay + 85, cw, 13, v, { size: 9.4 });
    });
  }

  cover();
  if (opts.coverOnly) return { pages: 1 }; // miniaturas dos modelos
  identification();
  introduction();
  mapping();
  legend();
  processAndFlow();
  stepsList();
  detailed();
  late.forEach((f) => f());
  footers();
  return { pages: pages.length };
}

// ---------------------------------------------------------------------------
// Superfície SVG (navegador): cada página vira um <svg> em pt. O texto usa
// <foreignObject> para quebrar linha como no PowerPoint.
// ---------------------------------------------------------------------------
export function svgSurface() {
  const pages = [];
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const col = (c) => '#' + c;
  const stroke = (l) => l ? ` stroke="${col(l.color)}" stroke-width="${l.width || 1}"${l.dash ? ' stroke-dasharray="3 2"' : ''}` : '';
  const fill = (f) => ` fill="${f ? col(f) : 'none'}"`;
  const page = (items) => ({
    rect(x, y, w, h, o = {}) { items.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}"${o.radius ? ` rx="${o.radius}"` : ''}${fill(o.fill)}${stroke(o.line)}/>`); },
    ellipse(x, y, w, h, o = {}) { items.push(`<ellipse cx="${x + w / 2}" cy="${y + h / 2}" rx="${w / 2}" ry="${h / 2}"${fill(o.fill)}${stroke(o.line)}/>`); },
    diamond(x, y, w, h, o = {}) { items.push(`<polygon points="${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}"${fill(o.fill)}${stroke(o.line)}/>`); },
    line(x1, y1, x2, y2, o = {}) {
      items.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"${stroke(o)}/>`);
      if (o.arrow) items.push(`<polygon points="${x2},${y2} ${x2 - 5},${y2 - 2.6} ${x2 - 5},${y2 + 2.6}" fill="${col(o.color)}"/>`);
    },
    image(x, y, w, h, img, o = {}) {
      const rot = o.rotate ? ` transform="rotate(${o.rotate} ${x + w / 2} ${y + h / 2})"` : '';
      items.push(`<image href="${esc(img.data)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"${rot}/>`);
    },
    text(x, y, w, h, content, s = {}) {
      const runs = Array.isArray(content) ? content : [{ text: content }];
      const html = runs.map((r) => {
        const st = (r.bold != null ? `font-weight:${r.bold ? 700 : 400};` : '') + (r.color ? `color:${col(r.color)};` : '');
        return st ? `<span style="${st}">${esc(r.text)}</span>` : esc(r.text);
      }).join('');
      const just = s.valign === 'middle' ? 'center' : s.valign === 'bottom' ? 'flex-end' : 'flex-start';
      const look = s.outline ? `color:transparent;-webkit-text-stroke:${s.outline.width}px ${col(s.outline.color)};` : `color:${col(s.color)};`;
      const box = s.vert ? { x: x + w / 2 - h / 2, y: y + h / 2 - w / 2, w: h, h: w } : { x, y, w, h };
      const div = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${box.w}px;height:${box.h}px;display:flex;flex-direction:column;justify-content:${just};` +
        `font-family:'${s.font || 'Inter'}',Arial,sans-serif;font-size:${s.size}px;line-height:${s.lh}px;font-weight:${s.bold ? 700 : 400};` +
        `${s.italic ? 'font-style:italic;' : ''}letter-spacing:${s.charSpacing || 0}px;text-align:${s.align || 'left'};${look}white-space:pre-wrap;overflow-wrap:break-word;"><div>${html}</div></div>`;
      const fo = `<foreignObject x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" overflow="visible">${div}</foreignObject>`;
      items.push(s.vert ? `<g transform="rotate(-90 ${x + w / 2} ${y + h / 2})">${fo}</g>` : fo);
    },
  });
  return {
    pages,
    addPage() { const items = []; pages.push(items); return page(items); },
    svg(i) {
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PAGE.w} ${PAGE.h}" style="display:block;width:100%;height:auto;background:#fff;">${pages[i].join('')}</svg>`;
    },
  };
}
