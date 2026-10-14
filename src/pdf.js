const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { limpar, formatarCnj, formatarDoc } = require('./formatar');

const PASTA_DADOS = path.join(__dirname, '..', 'dados');
const PASTA_PDFS = path.join(__dirname, '..', 'pdfs');
const ARQUIVO_MODELO = path.join(__dirname, '..', 'modelo.pdf');

const soDigitos = (s) => (s || '').replace(/\D/g, '');

// Procura o processo nos JSONs de dados/ (um por OAB). Devolve { oab, registro } ou null.
function localizarProcesso(numero) {
  const nr = soDigitos(numero);
  let arquivos = [];
  try { arquivos = fs.readdirSync(PASTA_DADOS).filter((f) => f.endsWith('.json')); } catch {}
  for (const f of arquivos) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(PASTA_DADOS, f), 'utf8'));
      if (j.processos && j.processos[nr]) return { oab: j.oab, registro: j.processos[nr] };
    } catch {}
  }
  return null;
}

async function gerarFormularioPdf(registro) {
  if (!fs.existsSync(ARQUIVO_MODELO)) {
    throw new Error('Arquivo modelo.pdf não encontrado na pasta do bot.');
  }

  const r = registro.dados;
  const detalhes = registro.detalhes || {};
  const requerente = detalhes.requerente || {};
  const pdfDoc = await PDFDocument.load(fs.readFileSync(ARQUIVO_MODELO));
  const pagina = pdfDoc.getPages()[0];
  const fonte = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const campos = {
    requerente: { x: 100, y: 555 },
    cpfCnpj: { x: 125, y: 536 },
    advogado: { x: 137, y: 516 },
    processo: { x: 135, y: 465 },
    cumprimentoDeSentenca: { x: 298, y: 425, tamanho: 12 },
    valorAReceber: { x: 148, y: 255 },
  };
  const preencher = (nome, valor) => {
    if (!valor) return;
    const texto = String(valor).replace(/\s+/g, ' ').trim();
    const campo = campos[nome];
    const larguraMaxima = pagina.getWidth() - campo.x - 40;
    let tamanho = campo.tamanho || 10;
    while (tamanho > 6 && fonte.widthOfTextAtSize(texto, tamanho) > larguraMaxima) {
      tamanho -= 0.5;
    }
    if (fonte.widthOfTextAtSize(texto, tamanho) > larguraMaxima) {
      throw new Error(`O texto do campo "${nome}" é longo demais para o formulário.`);
    }
    pagina.drawText(texto, {
      x: campo.x,
      y: campo.y,
      size: tamanho,
      font: fonte,
      color: rgb(0, 0, 0),
    });
  };

  preencher('requerente', limpar(requerente.nome) || limpar(r.autor));
  preencher('cpfCnpj', formatarDoc(requerente.doc || r.ident_autor));
  preencher('advogado', detalhes.advogado?.nome);
  preencher('processo', formatarCnj(r.nr_processo));
  preencher('cumprimentoDeSentenca', limpar(r.classe).toLocaleUpperCase('pt-BR'));
  preencher('valorAReceber', detalhes.valorCausa);

  fs.mkdirSync(PASTA_PDFS, { recursive: true });
  const arquivo = path.join(PASTA_PDFS, `alvara_${soDigitos(r.nr_processo)}.pdf`);
  await fs.promises.writeFile(arquivo, await pdfDoc.save());
  return arquivo;
}

module.exports = { localizarProcesso, gerarFormularioPdf, soDigitos };
