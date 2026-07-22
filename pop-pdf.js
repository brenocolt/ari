import PDFDocument from 'pdfkit';

// ---------------------------------------------------------------------------
// Paleta
// ---------------------------------------------------------------------------
const C = {
  navy: '#0A1F2E',
  body: '#2A3540',
  labelGray: '#8A98A5',
  teal: '#2BA8BC',
  boxBg: '#F4F6F8',
  boxBorder: '#E4E9ED',
  noBg: '#FCE9DD',
  noText: '#C2643A',
  yesBg: '#DCEFE6',
  yesText: '#2E8B6B',
  white: '#FFFFFF',
  chipBg: '#DCF1F4',
  chipText: '#0A1F2E',
};

// Fontes padrão pdfkit
const F = {
  bold: 'Helvetica-Bold',
  reg: 'Helvetica',
  obl: 'Helvetica-Oblique',
  serif: 'Times-Roman',
  serifBold: 'Times-Bold',
  serifItalic: 'Times-Italic',
};

const PAGE = { w: 595.28, h: 841.89, margin: 56 };
const CONTENT_W = PAGE.w - PAGE.margin * 2;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
function applyDefaults(raw = {}) {
  const d = { ...raw };
  const def = (k, v) => {
    if (d[k] === undefined || d[k] === null || (typeof d[k] === 'string' && d[k].trim() === '')) d[k] = v;
  };
  def('consultancy', '[ Nome da sua consultoria ]');
  def('processName', '[ Nome do processo ]');
  def('sector', '[ Setor ]');
  def('oneLineDesc', '[ Breve descrição do processo em uma linha ]');
  def('code', 'POP-XX-000');
  def('version', '001');
  def('emission', '00/00/0000');
  def('responsible', '[ Cargo / equipe ]');
  def('lastRevision', '00/00/0000');
  def('materials', '[ Ex.: Computador, sistema X ]');
  def('processText', '');
  if (!Array.isArray(d.steps)) d.steps = [];
  if (d.flowchartImage === undefined) d.flowchartImage = null;
  return d;
}

// ---------------------------------------------------------------------------
// Helpers de desenho
// ---------------------------------------------------------------------------
function miniLogo(doc, x, y, scale = 1) {
  // 3 barrinhas + traço que lembra um "P"
  const s = scale;
  doc.save();
  const bars = [
    { h: 14 * s, col: C.teal },
    { h: 20 * s, col: C.navy },
    { h: 11 * s, col: C.teal },
  ];
  let bx = x;
  const bw = 4 * s;
  const baseline = y + 20 * s;
  bars.forEach((b) => {
    doc.roundedRect(bx, baseline - b.h, bw, b.h, 1.5 * s).fill(b.col);
    bx += bw + 2.5 * s;
  });
  doc.restore();
}

function dashedBox(doc, x, y, w, h, opts = {}) {
  doc.save();
  doc
    .lineWidth(opts.lineWidth || 1)
    .strokeColor(opts.color || C.boxBorder)
    .dash(4, { space: 3 })
    .roundedRect(x, y, w, h, opts.radius || 6)
    .stroke();
  doc.undash();
  doc.restore();
}

function chip(doc, x, y, text, opts = {}) {
  const padX = opts.padX || 16;
  const padY = opts.padY || 9;
  const font = opts.font || F.bold;
  const size = opts.size || 12;
  doc.font(font).fontSize(size);
  const tw = doc.widthOfString(text);
  const th = doc.currentLineHeight();
  const w = tw + padX * 2;
  const h = th + padY * 2;
  doc.save();
  doc.roundedRect(x, y, w, h, opts.radius || (h / 2)).fill(opts.bg || C.chipBg);
  doc.fillColor(opts.fg || C.chipText).font(font).fontSize(size);
  doc.text(text, x + padX, y + padY, { lineBreak: false });
  doc.restore();
  return { w, h };
}

// Cabeçalho de seção com badge numerado
function sectionHeader(doc, number, title) {
  const x = PAGE.margin;
  let y = PAGE.margin;
  const badge = 30;
  // badge arredondado escuro
  doc.save();
  doc.roundedRect(x, y, badge, badge, 7).fill(C.navy);
  doc.fillColor(C.white).font(F.bold).fontSize(15);
  doc.text(String(number), x, y + (badge - doc.currentLineHeight()) / 2 + 1, {
    width: badge,
    align: 'center',
  });
  doc.restore();
  // título
  doc.fillColor(C.navy).font(F.bold).fontSize(19);
  doc.text(title, x + badge + 14, y + (badge - doc.currentLineHeight()) / 2 + 1);
  y += badge + 12;
  // linha divisória
  doc.save();
  doc.lineWidth(0.8).strokeColor(C.boxBorder);
  doc.moveTo(x, y).lineTo(PAGE.w - PAGE.margin, y).stroke();
  // traço teal sob o início
  doc.lineWidth(2.5).strokeColor(C.teal);
  doc.moveTo(x, y).lineTo(x + 46, y).stroke();
  doc.restore();
  doc.y = y + 22;
  doc.x = x;
}

function label(doc, text, x, y) {
  doc.font(F.bold).fontSize(7.5).fillColor(C.labelGray);
  doc.text(String(text).toUpperCase(), x, y, { characterSpacing: 0.8 });
  return doc.y;
}

function paragraph(doc, text, opts = {}) {
  doc
    .font(opts.font || F.serif)
    .fontSize(opts.size || 10.5)
    .fillColor(opts.color || C.body);
  doc.text(text, {
    width: opts.width || CONTENT_W,
    align: opts.align || 'justify',
    lineGap: opts.lineGap !== undefined ? opts.lineGap : 2.5,
    paragraphGap: opts.paragraphGap !== undefined ? opts.paragraphGap : 8,
    indent: opts.indent || 0,
  });
}

function subtitle(doc, text) {
  doc.moveDown(0.4);
  doc.font(F.bold).fontSize(12).fillColor(C.navy);
  doc.text(text, PAGE.margin, doc.y, { width: CONTENT_W });
  doc.moveDown(0.25);
}

// Caixa de dica com barra teal à esquerda
function tipBox(doc, text) {
  const x = PAGE.margin;
  const w = CONTENT_W;
  const padX = 16;
  const padY = 12;
  const innerW = w - padX * 2 - 6;
  doc.font(F.serif).fontSize(9.5);
  const textH = doc.heightOfString(text, { width: innerW, lineGap: 2 });
  const h = textH + padY * 2;
  const y = doc.y + 6;
  doc.save();
  doc.roundedRect(x, y, w, h, 6).fill(C.boxBg);
  doc.rect(x, y, 4, h).fill(C.teal);
  doc.fillColor(C.body).font(F.serif).fontSize(9.5);
  doc.text(text, x + padX + 4, y + padY, { width: innerW, lineGap: 2 });
  doc.restore();
  doc.y = y + h + 6;
  doc.x = x;
}

// Card simples com borda e título teal
function card(doc, x, y, w, title, lines) {
  const padX = 14;
  const padY = 12;
  const innerW = w - padX * 2;
  doc.font(F.bold).fontSize(8.5);
  let contentH = doc.currentLineHeight() + 6;
  doc.font(F.serif).fontSize(9.5);
  lines.forEach((ln) => {
    contentH += doc.heightOfString(ln, { width: innerW, lineGap: 2 }) + 3;
  });
  const h = contentH + padY * 2;
  doc.save();
  doc.roundedRect(x, y, w, h, 6).lineWidth(1).fillAndStroke(C.white, C.boxBorder);
  doc.fillColor(C.teal).font(F.bold).fontSize(8.5);
  doc.text(String(title).toUpperCase(), x + padX, y + padY, { width: innerW, characterSpacing: 0.6 });
  let cy = doc.y + 4;
  doc.fillColor(C.body).font(F.serif).fontSize(9.5);
  lines.forEach((ln) => {
    doc.text(ln, x + padX, cy, { width: innerW, lineGap: 2 });
    cy = doc.y + 3;
  });
  doc.restore();
  return h;
}

// Grade de informações 2 colunas (array de células {label, value})
function infoGrid(doc, cells, startY, opts = {}) {
  const x = PAGE.margin;
  const w = CONTENT_W;
  const cols = opts.cols || 2;
  const colW = w / cols;
  const padX = 12;
  const padY = 9;
  const innerW = colW - padX * 2;
  let y = startY;

  // medir altura de cada linha (par de células)
  doc.font(F.bold).fontSize(10);
  for (let i = 0; i < cells.length; i += cols) {
    const row = cells.slice(i, i + cols);
    let rowH = 0;
    row.forEach((cell) => {
      doc.font(F.bold).fontSize(7.5);
      const lh = doc.currentLineHeight();
      doc.font(F.bold).fontSize(10);
      const vh = doc.heightOfString(String(cell.value), { width: innerW });
      rowH = Math.max(rowH, lh + 4 + vh);
    });
    rowH += padY * 2;
    // desenhar fundo + bordas das células
    row.forEach((cell, ci) => {
      const cx = x + ci * colW;
      doc.save();
      doc.rect(cx, y, colW, rowH).lineWidth(0.8).fillAndStroke(C.white, C.boxBorder);
      doc.restore();
      label(doc, cell.label, cx + padX, y + padY);
      doc.font(F.bold).fontSize(10).fillColor(C.navy);
      doc.text(String(cell.value), cx + padX, doc.y + 3, { width: innerW });
    });
    y += rowH;
  }
  return y;
}

// Tabela genérica (cabeçalho escuro + linhas)
function table(doc, startY, colWidths, header, rows) {
  const x = PAGE.margin;
  const padX = 8;
  const padY = 7;
  let y = startY;
  const totalW = colWidths.reduce((a, b) => a + b, 0);

  // cabeçalho
  doc.font(F.bold).fontSize(7.5);
  let headH = doc.currentLineHeight() + padY * 2;
  doc.save();
  doc.rect(x, y, totalW, headH).fill(C.navy);
  doc.fillColor(C.white).font(F.bold).fontSize(7.5);
  let cx = x;
  header.forEach((htxt, i) => {
    doc.text(String(htxt).toUpperCase(), cx + padX, y + padY, {
      width: colWidths[i] - padX * 2,
      characterSpacing: 0.5,
    });
    cx += colWidths[i];
  });
  doc.restore();
  y += headH;

  // linhas
  rows.forEach((row) => {
    doc.font(F.serif).fontSize(9);
    let rowH = 0;
    row.forEach((cell, i) => {
      const h = doc.heightOfString(String(cell), { width: colWidths[i] - padX * 2 });
      rowH = Math.max(rowH, h);
    });
    rowH += padY * 2;
    doc.save();
    cx = x;
    row.forEach((cell, i) => {
      doc.rect(cx, y, colWidths[i], rowH).lineWidth(0.8).strokeColor(C.boxBorder).stroke();
      doc.fillColor(C.body).font(F.serif).fontSize(9);
      doc.text(String(cell), cx + padX, y + padY, { width: colWidths[i] - padX * 2 });
      cx += colWidths[i];
    });
    doc.restore();
    y += rowH;
  });
  return y;
}

// ícones BPMN simples
function bpmnIcon(doc, type, x, y, size = 16) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size / 2;
  doc.save();
  doc.lineWidth(1.2).strokeColor(C.navy).fillColor(C.navy);
  switch (type) {
    case 'start':
      doc.lineWidth(1).circle(cx, cy, r).stroke();
      break;
    case 'startMsg':
      doc.lineWidth(1).circle(cx, cy, r).stroke();
      doc.rect(cx - 3, cy - 2, 6, 4).stroke();
      break;
    case 'startTimer':
      doc.lineWidth(1).circle(cx, cy, r).stroke();
      doc.moveTo(cx, cy).lineTo(cx, cy - 3).stroke();
      doc.moveTo(cx, cy).lineTo(cx + 2.5, cy).stroke();
      break;
    case 'end':
      doc.lineWidth(2.5).circle(cx, cy, r).stroke();
      break;
    case 'terminal':
      doc.circle(cx, cy, r).fill(C.navy);
      break;
    case 'endMsg':
      doc.lineWidth(2).circle(cx, cy, r).stroke();
      doc.lineWidth(1).rect(cx - 3, cy - 2, 6, 4).stroke();
      break;
    case 'task':
      doc.lineWidth(1).roundedRect(x, cy - 5, size, 10, 2).stroke();
      break;
    case 'subprocess':
      doc.lineWidth(1).roundedRect(x, cy - 5, size, 10, 2).stroke();
      doc.moveTo(cx, cy - 2.5).lineTo(cx, cy + 2.5).stroke();
      doc.moveTo(cx - 2.5, cy).lineTo(cx + 2.5, cy).stroke();
      break;
    case 'arrow':
      doc.lineWidth(1.2).moveTo(x, cy).lineTo(x + size - 3, cy).stroke();
      doc.moveTo(x + size - 3, cy).lineTo(x + size - 6, cy - 3).stroke();
      doc.moveTo(x + size - 3, cy).lineTo(x + size - 6, cy + 3).stroke();
      break;
    case 'link':
      doc.lineWidth(1).circle(cx, cy, r).stroke();
      doc.moveTo(cx - 3, cy).lineTo(cx + 2, cy).stroke();
      doc.moveTo(cx + 2, cy).lineTo(cx, cy - 2).stroke();
      doc.moveTo(cx + 2, cy).lineTo(cx, cy + 2).stroke();
      break;
    case 'gwX':
      diamond(doc, cx, cy, r);
      doc.lineWidth(1.2);
      doc.moveTo(cx - 3, cy - 3).lineTo(cx + 3, cy + 3).stroke();
      doc.moveTo(cx + 3, cy - 3).lineTo(cx - 3, cy + 3).stroke();
      break;
    case 'gwParallel':
      diamond(doc, cx, cy, r);
      doc.lineWidth(1.4);
      doc.moveTo(cx, cy - 4).lineTo(cx, cy + 4).stroke();
      doc.moveTo(cx - 4, cy).lineTo(cx + 4, cy).stroke();
      break;
    case 'gwInclusive':
      diamond(doc, cx, cy, r);
      doc.lineWidth(1.4).circle(cx, cy, 3.5).stroke();
      break;
    case 'data':
      doc.lineWidth(1);
      doc.moveTo(x + 2, y).lineTo(x + size - 4, y).lineTo(x + size - 1, y + 3)
        .lineTo(x + size - 1, y + size).lineTo(x + 2, y + size).closePath().stroke();
      doc.moveTo(x + size - 4, y).lineTo(x + size - 4, y + 3).lineTo(x + size - 1, y + 3).stroke();
      break;
    case 'annotation':
      doc.lineWidth(1);
      doc.moveTo(x + 4, y).lineTo(x, y).lineTo(x, y + size).lineTo(x + 4, y + size).stroke();
      break;
    default:
      doc.circle(cx, cy, r).stroke();
  }
  doc.restore();
}

function diamond(doc, cx, cy, r) {
  doc.lineWidth(1)
    .moveTo(cx, cy - r)
    .lineTo(cx + r, cy)
    .lineTo(cx, cy + r)
    .lineTo(cx - r, cy)
    .closePath()
    .stroke();
}

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------
function coverPage(doc, d) {
  const x = PAGE.margin;
  // topo esquerdo: logo + consultoria
  miniLogo(doc, x, PAGE.margin - 2, 1);
  doc.fillColor(C.navy).font(F.bold).fontSize(11);
  doc.text(d.consultancy, x + 30, PAGE.margin + 4, { lineBreak: false, width: 280 });
  // topo direito
  doc.font(F.bold).fontSize(8).fillColor(C.labelGray);
  doc.text('DOCUMENTO INTERNO', PAGE.w - PAGE.margin - 200, PAGE.margin + 6, {
    width: 200,
    align: 'right',
    characterSpacing: 1.5,
  });
  // linha divisória sob o topo
  const lineY = PAGE.margin + 32;
  doc.save();
  doc.lineWidth(0.8).strokeColor(C.boxBorder);
  doc.moveTo(x, lineY).lineTo(PAGE.w - PAGE.margin, lineY).stroke();
  doc.restore();

  // bloco central-baixo (avanço de y manual — lineBreak:false NÃO move doc.y)
  let y = 300;
  // eyebrow
  doc.font(F.bold).fontSize(10).fillColor(C.teal);
  doc.text('PROCEDIMENTO OPERACIONAL PADRÃO', x, y, { characterSpacing: 2.5, lineBreak: false });
  y += 24;
  // título gigante
  doc.font(F.bold).fontSize(120).fillColor(C.navy);
  doc.text('POP', x, y, { lineBreak: false });
  y += 118; // altura aproximada do bloco "POP"
  // traço teal curto e grosso
  doc.save();
  doc.lineWidth(6).strokeColor(C.teal);
  doc.moveTo(x + 4, y).lineTo(x + 80, y).stroke();
  doc.restore();
  y += 22;

  // chip do nome do processo
  const ch = chip(doc, x, y, d.processName, {
    bg: C.chipBg,
    fg: C.teal,
    font: F.bold,
    size: 22,
    padX: 22,
    padY: 12,
    radius: 10,
  });
  y += ch.h + 18;

  // descrição
  doc.font(F.serifItalic).fontSize(12).fillColor(C.labelGray);
  doc.text(d.oneLineDesc, x, y, { width: CONTENT_W - 40, lineGap: 3 });

  // rodapé: tabela de 4 colunas
  const ty = PAGE.h - PAGE.margin - 70;
  const cols = [
    { label: 'CÓDIGO', value: d.code },
    { label: 'VERSÃO', value: d.version },
    { label: 'EMISSÃO', value: d.emission },
    { label: 'ÁREA', value: d.sector },
  ];
  const cw = CONTENT_W / 4;
  const th = 56;
  cols.forEach((c, i) => {
    const cx = x + i * cw;
    doc.save();
    doc.rect(cx, ty, cw, th).lineWidth(0.8).strokeColor(C.boxBorder).stroke();
    doc.restore();
    label(doc, c.label, cx + 12, ty + 12);
    doc.font(F.bold).fontSize(12).fillColor(C.navy);
    doc.text(String(c.value), cx + 12, doc.y + 5, { width: cw - 24 });
  });
}

function identificationPage(doc, d) {
  sectionHeader(doc, 'i', 'Identificação do documento');
  const cells = [
    { label: 'Título / Atividade', value: d.processName },
    { label: 'Código', value: d.code },
    { label: 'Área / Setor', value: d.sector },
    { label: 'Responsável(is)', value: d.responsible },
    { label: 'Data de emissão', value: d.emission },
    { label: 'Última revisão', value: d.lastRevision },
    { label: 'Versão', value: d.version },
    { label: 'Materiais necessários', value: d.materials },
  ];
  let y = infoGrid(doc, cells, doc.y);
  y += 24;

  // Histórico de revisões
  doc.font(F.bold).fontSize(12).fillColor(C.navy);
  doc.text('HISTÓRICO DE REVISÕES', PAGE.margin, y, { characterSpacing: 0.5 });
  y = doc.y + 8;
  const cw = [60, 90, CONTENT_W - 60 - 90 - 150, 150];
  y = table(
    doc,
    y,
    cw,
    ['Versão', 'Data', 'Descrição da alteração', 'Responsável'],
    [
      ['001', d.emission, 'Criação do documento', d.responsible],
      ['—', '—', '—', '—'],
    ],
  );
  y += 24;

  // Sumário
  doc.font(F.bold).fontSize(12).fillColor(C.navy);
  doc.text('SUMÁRIO', PAGE.margin, y, { characterSpacing: 0.5 });
  y = doc.y + 10;
  const toc = [
    ['1', 'Introdução', '3'],
    ['2', 'Mapeamento de processos', '4'],
    ['3', 'Legenda BPMN', '5'],
    ['4', 'O processo & fluxograma', '6'],
    ['5', 'Descrição das etapas', '7'],
    ['6', 'POP — procedimento detalhado', '8'],
  ];
  const x = PAGE.margin;
  toc.forEach(([num, title, pg]) => {
    doc.font(F.bold).fontSize(10).fillColor(C.teal);
    doc.text(num, x, y, { width: 18, lineBreak: false });
    doc.font(F.serif).fontSize(10.5).fillColor(C.body);
    const titleX = x + 22;
    doc.text(title, titleX, y, { lineBreak: false });
    const titleW = doc.widthOfString(title);
    // leaders pontilhados
    const pgW = doc.widthOfString(pg);
    const dotStart = titleX + titleW + 6;
    const dotEnd = PAGE.w - PAGE.margin - pgW - 6;
    if (dotEnd > dotStart) {
      doc.save();
      doc.fillColor(C.boxBorder);
      let dx = dotStart;
      while (dx < dotEnd) {
        doc.circle(dx, y + 6, 0.7).fill(C.boxBorder);
        dx += 5;
      }
      doc.restore();
    }
    doc.font(F.bold).fontSize(10).fillColor(C.navy);
    doc.text(pg, PAGE.w - PAGE.margin - pgW, y, { lineBreak: false });
    y += 22;
  });
}

function introPage(doc, d) {
  sectionHeader(doc, 1, 'Introdução');
  subtitle(doc, 'O que é um POP?');
  paragraph(
    doc,
    'O Procedimento Operacional Padrão (POP) é um documento que descreve, de forma clara e detalhada, todas as etapas necessárias para a execução de uma atividade. Funciona como guia de referência que padroniza a maneira como o trabalho é realizado, garantindo que qualquer colaborador o execute com o mesmo nível de qualidade, independentemente de quem o faça.',
  );
  subtitle(doc, 'Qual a finalidade deste POP?');
  paragraph(
    doc,
    `Este POP tem como finalidade padronizar, documentar e orientar todas as etapas envolvidas no processo de ${d.processName}, realizado pelo setor de ${d.sector}. O objetivo é assegurar uniformidade, clareza e eficiência na execução, reduzindo erros, retrabalho e variações entre colaboradores.`,
  );
  subtitle(doc, 'Quem deve seguir este POP?');
  paragraph(
    doc,
    `Este documento é de uso obrigatório para todos os colaboradores do setor de ${d.sector}, bem como para novos integrantes em fase de treinamento. Deve ser consultado sempre que houver dúvidas sobre a execução correta do processo.`,
  );
  doc.moveDown(0.5);
  tipBox(
    doc,
    'Como preencher: ajuste apenas os campos destacados. O texto padrão acima pode permanecer igual em todos os POPs.',
  );
}

function mappingPage(doc, d) {
  sectionHeader(doc, 2, 'Mapeamento de processos');
  subtitle(doc, 'O que são processos?');
  paragraph(
    doc,
    'Processos são conjuntos de atividades organizadas com o objetivo de transformar entradas em saídas e gerar resultados. Eles alinham o trabalho dos setores aos objetivos da empresa, integrando tarefas de diferentes áreas de forma coordenada. Processos bem definidos proporcionam visão clara da operação, promovem o engajamento da equipe e facilitam a tomada de decisão.',
  );
  paragraph(
    doc,
    'O mapeamento de processos registra como as atividades ocorrem na prática, permitindo identificar pontos de melhoria. A partir dele evolui-se para a modelagem, que representa a versão otimizada do processo. Para compreender os fluxogramas deste documento utilizamos a notação BPMN, cuja legenda está descrita a seguir.',
  );
  doc.moveDown(0.6);
  const gap = 16;
  const cardW = (CONTENT_W - gap) / 2;
  const y = doc.y;
  const h1 = card(doc, PAGE.margin, y, cardW, 'Mapeamento', [
    'Como o processo acontece hoje — o estado atual ("as is").',
  ]);
  card(doc, PAGE.margin + cardW + gap, y, cardW, 'Modelagem', [
    'Como o processo deve acontecer — o estado otimizado ("to be").',
  ]);
  doc.y = y + h1;
}

function bpmnPage(doc, d) {
  sectionHeader(doc, 3, 'Legenda BPMN');
  paragraph(doc, 'Referência dos principais elementos da notação BPMN utilizados nos fluxogramas deste documento.', {
    align: 'left',
  });
  doc.moveDown(0.4);

  const groups = [
    {
      title: 'Eventos de início',
      items: [
        ['start', 'Início', 'Início de um processo.'],
        ['startMsg', 'Mensagem', 'Início pela chegada de uma comunicação.'],
        ['startTimer', 'Temporal', 'Início a partir de um fato temporal.'],
      ],
    },
    {
      title: 'Eventos de fim',
      items: [
        ['end', 'Fim', 'Fim de um processo.'],
        ['terminal', 'Terminal', 'Fim sem nenhuma atividade posterior.'],
        ['endMsg', 'Mensagem', 'Fim com envio de uma comunicação.'],
      ],
    },
    {
      title: 'Atividades',
      items: [
        ['task', 'Tarefa', 'Ação realizada por pessoa ou sistema.'],
        ['subprocess', 'Subprocesso', 'Conjunto de atividades em sequência.'],
      ],
    },
    {
      title: 'Conexão',
      items: [
        ['arrow', 'Seta (fluxo)', 'Sequência entre os símbolos do processo.'],
        ['link', 'Link', 'Conexão entre partes do mesmo fluxo.'],
      ],
    },
    {
      title: 'Gateways',
      items: [
        ['gwX', 'Exclusivo', 'Apenas um dos caminhos será seguido.'],
        ['gwParallel', 'Paralelo', 'Divide o fluxo em caminhos simultâneos.'],
        ['gwInclusive', 'Inclusivo', 'Combinação possível de caminhos.'],
      ],
    },
    {
      title: 'Artefatos',
      items: [
        ['data', 'Objeto de dados', 'Documento ou dado ligado à atividade.'],
        ['annotation', 'Anotação', 'Comentário que agrega informação.'],
      ],
    },
  ];

  const gap = 16;
  const cardW = (CONTENT_W - gap) / 2;
  const padX = 14;
  const padY = 12;
  let col = 0;
  let rowY = doc.y;
  let rowMaxH = 0;

  groups.forEach((g, idx) => {
    const cx = PAGE.margin + col * (cardW + gap);
    // medir altura
    const innerW = cardW - padX * 2 - 24;
    doc.font(F.bold).fontSize(8.5);
    let h = padY + doc.currentLineHeight() + 8;
    g.items.forEach(([, name, desc]) => {
      doc.font(F.bold).fontSize(9);
      const nameH = doc.currentLineHeight();
      doc.font(F.serif).fontSize(8.5);
      const descH = doc.heightOfString(desc, { width: innerW });
      h += Math.max(20, nameH + descH) + 8;
    });
    h += padY - 4;

    doc.save();
    doc.roundedRect(cx, rowY, cardW, h, 6).lineWidth(1).fillAndStroke(C.white, C.boxBorder);
    doc.fillColor(C.teal).font(F.bold).fontSize(8.5);
    doc.text(g.title.toUpperCase(), cx + padX, rowY + padY, { characterSpacing: 0.6 });
    let iy = doc.y + 6;
    g.items.forEach(([icon, name, desc]) => {
      bpmnIcon(doc, icon, cx + padX, iy + 1, 16);
      const tx = cx + padX + 24;
      doc.fillColor(C.navy).font(F.bold).fontSize(9);
      doc.text(name, tx, iy, { width: innerW });
      doc.fillColor(C.labelGray).font(F.serif).fontSize(8.5);
      doc.text(desc, tx, doc.y + 1, { width: innerW, lineGap: 1 });
      iy = Math.max(iy + 20, doc.y) + 8;
    });
    doc.restore();

    rowMaxH = Math.max(rowMaxH, h);
    col++;
    if (col === 2) {
      col = 0;
      rowY += rowMaxH + gap;
      rowMaxH = 0;
    }
  });
}

function processFlowPage(doc, d) {
  sectionHeader(doc, 4, 'O processo & fluxograma');
  // descrição do processo
  doc.font(F.bold).fontSize(12).fillColor(C.navy);
  doc.text('Descrição do processo', PAGE.margin, doc.y);
  doc.moveDown(0.3);
  const x = PAGE.margin;
  const w = CONTENT_W;
  const padX = 14;
  const padY = 12;
  const innerW = w - padX * 2;
  const hasText = d.processText && d.processText.trim() !== '';
  const textContent = hasText ? d.processText : '[ Descreva o processo em texto corrido ]';
  doc.font(hasText ? F.serif : F.serifItalic).fontSize(10.5);
  const textH = doc.heightOfString(textContent, { width: innerW, lineGap: 2.5 });
  const boxH = Math.max(70, textH + padY * 2);
  const by = doc.y;
  doc.save();
  doc.roundedRect(x, by, w, boxH, 6).fill(C.boxBg);
  doc.fillColor(hasText ? C.body : C.labelGray).font(hasText ? F.serif : F.serifItalic).fontSize(10.5);
  doc.text(textContent, x + padX, by + padY, { width: innerW, lineGap: 2.5, align: hasText ? 'justify' : 'left' });
  doc.restore();
  doc.y = by + boxH + 22;

  // fluxograma
  doc.font(F.bold).fontSize(12).fillColor(C.navy);
  doc.text('Fluxograma', PAGE.margin, doc.y);
  doc.moveDown(0.3);
  const fy = doc.y;
  const fh = PAGE.h - PAGE.margin - fy;
  dashedBox(doc, x, fy, w, fh, { radius: 8 });
  if (d.flowchartImage) {
    try {
      const pad = 16;
      doc.image(d.flowchartImage, x + pad, fy + pad, {
        fit: [w - pad * 2, fh - pad * 2],
        align: 'center',
        valign: 'center',
      });
    } catch (e) {
      doc.font(F.serifItalic).fontSize(11).fillColor(C.labelGray);
      doc.text('[ Não foi possível carregar a imagem do fluxograma ]', x, fy + fh / 2 - 8, {
        width: w,
        align: 'center',
      });
    }
  } else {
    doc.font(F.serifItalic).fontSize(12).fillColor(C.labelGray);
    doc.text('[ Cole aqui o fluxograma do processo ]', x, fy + fh / 2 - 8, {
      width: w,
      align: 'center',
    });
  }
}

function stepsListPage(doc, d) {
  sectionHeader(doc, 5, 'Descrição das etapas');
  paragraph(
    doc,
    'Liste, em ordem, cada etapa do processo. Use frases curtas, no infinitivo (ex.: "Acessar...", "Selecionar...", "Preencher...").',
    { font: F.serif, color: C.labelGray, align: 'left' },
  );
  doc.moveDown(0.6);

  const steps = d.steps.length ? d.steps : [{ title: '[ Descreva a primeira etapa ]', description: '' }];
  const x = PAGE.margin;
  steps.forEach((step, i) => {
    if (doc.y > PAGE.h - PAGE.margin - 40) doc.addPage();
    const y = doc.y;
    // badge teal-claro
    const num = String(i + 1);
    doc.save();
    doc.roundedRect(x, y, 26, 26, 6).fill(C.chipBg);
    doc.fillColor(C.teal).font(F.bold).fontSize(12);
    doc.text(num, x, y + (26 - doc.currentLineHeight()) / 2 + 1, { width: 26, align: 'center' });
    doc.restore();
    // título
    doc.fillColor(C.body).font(F.serif).fontSize(11.5);
    doc.text(step.title || '[ Etapa ]', x + 38, y + 5, { width: CONTENT_W - 38 });
    const endY = Math.max(y + 26, doc.y) + 10;
    // divisória
    doc.save();
    doc.lineWidth(0.6).strokeColor(C.boxBorder);
    doc.moveTo(x, endY).lineTo(PAGE.w - PAGE.margin, endY).stroke();
    doc.restore();
    doc.y = endY + 10;
  });
}

function popDetailPages(doc, d) {
  sectionHeader(doc, 6, 'POP — procedimento detalhado');
  const x = PAGE.margin;
  const w = CONTENT_W;

  // faixa escura
  const bandH = 34;
  let y = doc.y;
  doc.save();
  doc.roundedRect(x, y, w, bandH, 5).fill(C.navy);
  doc.fillColor(C.white).font(F.bold).fontSize(10);
  doc.text('PROCEDIMENTO OPERACIONAL PADRÃO — POP', x + 14, y + (bandH - doc.currentLineHeight()) / 2, {
    lineBreak: false,
  });
  doc.fillColor(C.teal).font(F.bold).fontSize(11);
  doc.text(d.code, x, y + (bandH - doc.currentLineHeight()) / 2, { width: w - 14, align: 'right' });
  doc.restore();
  y += bandH;

  // tabela de info
  const halfW = w / 2;
  y = table(doc, y, [halfW, halfW], ['Atividade', 'Código'], [[d.processName, d.code]]);
  y = table(doc, y, [halfW, halfW], ['Responsável(is)', 'Área'], [[d.responsible, d.sector]]);
  y = table(doc, y, [w], ['Materiais necessários'], [[d.materials]]);
  const q = w / 4;
  y = table(
    doc,
    y,
    [q, q, q, q],
    ['Emissão', 'Revisão', 'Versão', 'Página'],
    [[d.emission, d.lastRevision, d.version, '1 de 1']],
  );
  y += 22;

  // PROCEDIMENTO
  doc.font(F.bold).fontSize(12).fillColor(C.navy);
  doc.text('PROCEDIMENTO', x, y, { characterSpacing: 0.5 });
  y = doc.y + 12;
  doc.y = y;

  const steps = d.steps.length
    ? d.steps
    : [{ title: '[ Descreva a primeira etapa ]', description: '[ Descreva o que deve ser feito nesta etapa ]' }];

  steps.forEach((step, i) => {
    drawProcedureBlock(doc, i + 1, step);
  });

  // APROVAÇÕES
  approvalsSection(doc, d);

  // rodapé final
  finalFooter(doc, d);
}

function drawProcedureBlock(doc, num, step) {
  const x = PAGE.margin;
  const w = CONTENT_W;
  const gap = 16;
  const leftW = (w - gap) * 0.55;
  const rightW = (w - gap) * 0.45;
  const desc = step.description && step.description.trim() !== '' ? step.description : '[ Descreva o que deve ser feito nesta etapa ]';

  // medir altura necessária
  doc.font(F.bold).fontSize(11);
  const badgeH = 28;
  doc.font(F.bold).fontSize(7.5);
  const labelH = doc.currentLineHeight();
  doc.font(F.serif).fontSize(10);
  const descH = doc.heightOfString(desc, { width: leftW, lineGap: 2.5 });
  const leftContentH = labelH + 4 + descH;
  const evidenceH = Math.max(leftContentH, 90);
  const blockH = badgeH + 10 + Math.max(leftContentH, evidenceH) + 22;

  // quebra de página
  if (doc.y + blockH > PAGE.h - PAGE.margin) {
    doc.addPage();
  }

  let y = doc.y;
  // badge escuro + título
  doc.save();
  doc.roundedRect(x, y, badgeH, badgeH, 6).fill(C.navy);
  doc.fillColor(C.white).font(F.bold).fontSize(13);
  doc.text(String(num), x, y + (badgeH - doc.currentLineHeight()) / 2 + 1, { width: badgeH, align: 'center' });
  doc.restore();
  doc.fillColor(C.navy).font(F.bold).fontSize(12);
  doc.text(step.title || '[ Etapa ]', x + badgeH + 12, y + (badgeH - doc.currentLineHeight()) / 2 + 1, {
    width: w - badgeH - 12,
  });
  y += badgeH + 12;

  // duas colunas
  const colY = y;
  // esquerda: DESCRIÇÃO
  label(doc, 'Descrição', x, colY);
  doc.font(F.serif).fontSize(10).fillColor(C.body);
  doc.text(desc, x, doc.y + 3, { width: leftW, lineGap: 2.5, align: 'justify' });
  const leftEndY = doc.y;

  // direita: PRINT / EVIDÊNCIA
  const rx = x + leftW + gap;
  label(doc, 'Print / Evidência', rx, colY);
  const evY = doc.y + 3;
  const boxH = Math.max(leftEndY - evY, 80);
  dashedBox(doc, rx, evY, rightW, boxH, { radius: 6 });
  doc.font(F.serifItalic).fontSize(9.5).fillColor(C.labelGray);
  doc.text('[ Cole o print da tela ]', rx, evY + boxH / 2 - 6, { width: rightW, align: 'center' });

  doc.y = Math.max(leftEndY, evY + boxH) + 20;
  doc.x = x;
}

function approvalsSection(doc, d) {
  const x = PAGE.margin;
  const w = CONTENT_W;
  const needed = 110;
  if (doc.y + needed > PAGE.h - PAGE.margin) doc.addPage();
  let y = doc.y + 6;
  doc.font(F.bold).fontSize(12).fillColor(C.navy);
  doc.text('APROVAÇÕES', x, y, { characterSpacing: 0.5 });
  y = doc.y + 16;

  const gap = 16;
  const colW = (w - gap * 2) / 3;
  const cols = ['Elaborado por', 'Revisado por', 'Aprovado por'];
  cols.forEach((c, i) => {
    const cx = x + i * (colW + gap);
    // linha de assinatura
    const lineY = y + 28;
    doc.save();
    doc.lineWidth(0.8).strokeColor(C.navy);
    doc.moveTo(cx, lineY).lineTo(cx + colW, lineY).stroke();
    doc.restore();
    doc.font(F.serifItalic).fontSize(9).fillColor(C.labelGray);
    doc.text('[ Nome — data ]', cx, lineY + 5, { width: colW, align: 'center' });
    doc.font(F.bold).fontSize(7.5).fillColor(C.labelGray);
    doc.text(c.toUpperCase(), cx, lineY + 22, { width: colW, align: 'center', characterSpacing: 0.6 });
  });
  doc.y = y + 70;
}

function finalFooter(doc, d) {
  const x = PAGE.margin;
  const y = PAGE.h - PAGE.margin + 8;
  miniLogo(doc, x, y - 6, 0.5);
  doc.font(F.reg).fontSize(8).fillColor(C.labelGray);
  doc.text(
    `${d.consultancy} · Documento interno · ${d.code} · v${d.version}`,
    x + 20,
    y,
    { width: CONTENT_W - 20 },
  );
}

// ---------------------------------------------------------------------------
// API principal
// ---------------------------------------------------------------------------
export async function buildPopPdf(rawData) {
  const d = applyDefaults(rawData);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: [PAGE.w, PAGE.h],
        margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
        autoFirstPage: false,
        bufferPages: true,
      });

      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Página 1 — capa
      doc.addPage();
      coverPage(doc, d);

      // Página 2 — identificação
      doc.addPage();
      identificationPage(doc, d);

      // Página 3 — introdução
      doc.addPage();
      introPage(doc, d);

      // Página 4 — mapeamento
      doc.addPage();
      mappingPage(doc, d);

      // Página 5 — legenda BPMN
      doc.addPage();
      bpmnPage(doc, d);

      // Página 6 — processo & fluxograma
      doc.addPage();
      processFlowPage(doc, d);

      // Página 7 — descrição das etapas
      doc.addPage();
      stepsListPage(doc, d);

      // Página 8+ — POP detalhado
      doc.addPage();
      popDetailPages(doc, d);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

export default buildPopPdf;

// ---------------------------------------------------------------------------
// Auto-teste (somente quando executado diretamente)
// ---------------------------------------------------------------------------
const isMain = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}` ||
      import.meta.url.endsWith(process.argv[1] || '###');
  } catch {
    return false;
  }
})();

if (isMain) {
  (async () => {
    const fs = await import('node:fs/promises');
    const sample = {
      consultancy: 'Consultoria Exemplo',
      processName: 'Aprovação de pedidos',
      sector: 'Comercial',
      oneLineDesc: 'Processo de análise e aprovação de pedidos de clientes pelo time comercial.',
      code: 'POP-CO-001',
      version: '001',
      emission: '29/06/2026',
      responsible: 'Equipe Comercial',
      lastRevision: '29/06/2026',
      materials: 'Computador, sistema de gestão (ERP), e-mail',
      processText:
        'O processo de aprovação de pedidos inicia com o recebimento da solicitação do cliente. O time comercial verifica os dados, valida o crédito e confirma a disponibilidade de estoque antes de prosseguir com a aprovação formal e a emissão da ordem de venda.',
      steps: [
        { title: 'Receber a solicitação do cliente', description: 'Acessar a caixa de entrada do canal comercial e registrar o pedido recebido no sistema de gestão, conferindo se todos os campos obrigatórios foram preenchidos pelo cliente.' },
        { title: 'Validar dados cadastrais e de crédito', description: 'Consultar o cadastro do cliente no ERP, verificar o limite de crédito disponível e confirmar que não há pendências financeiras. Caso haja restrição, encaminhar para o setor financeiro antes de prosseguir. Esta etapa é crítica para evitar inadimplência e garantir que o pedido esteja em conformidade com a política comercial vigente da empresa, incluindo descontos autorizados e condições especiais de pagamento previamente negociadas.' },
        { title: 'Confirmar disponibilidade de estoque', description: 'Verificar no sistema a quantidade disponível dos itens solicitados e reservar os produtos para o pedido em análise.' },
        { title: 'Aprovar e emitir a ordem de venda', description: 'Registrar a aprovação no sistema, gerar a ordem de venda e notificar o cliente e a logística sobre a confirmação do pedido.' },
      ],
      flowchartImage: null,
    };
    const buf = await buildPopPdf(sample);
    const out = '/tmp/pop-sample.pdf';
    await fs.writeFile(out, buf);
    console.log(`OK ${out} ${buf.length}`);
  })().catch((e) => {
    console.error('FALHOU:', e);
    process.exit(1);
  });
}
