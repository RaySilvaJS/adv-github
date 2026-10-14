// Descobre, pelas páginas de processo já salvas, quais formatos de OAB existem de verdade no eproc:
// quais letras aparecem depois do número, de qual estado e com que "Tipo de Usuário".
// Uso: node scripts/mapear-oabs.js [pasta]     (padrão: dados/advogados; lê os *.html.gz e *.html)

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const RAIZ = path.resolve(process.argv[2] || 'dados/advogados');
const padrao = /<a\b[^>]*>\s*([A-Z]{2}\s*\d{3,8}(?:\s*-?\s*[A-Z])?)\s*<\/a>[\s\S]{0,300}?Tipo de Usu[aá]rio:\s*([^<]+?)\s*<\/div>/gi;

const grupos = new Map();
let paginas = 0;

function ler(arquivo) {
  const bruto = fs.readFileSync(arquivo);
  const buf = arquivo.endsWith('.gz') ? zlib.gunzipSync(bruto) : bruto;
  return buf.toString('utf8');
}

function percorrer(pasta) {
  for (const nome of fs.readdirSync(pasta)) {
    const caminho = path.join(pasta, nome);
    if (fs.statSync(caminho).isDirectory()) percorrer(caminho);
    else if (/\.html(\.gz)?$/.test(nome)) analisar(caminho);
  }
}

function analisar(arquivo) {
  let html;
  try { html = ler(arquivo); } catch { return; }
  paginas += 1;
  for (const m of html.matchAll(padrao)) {
    const oab = m[1].replace(/\s+/g, ' ').trim();
    const uf = oab.slice(0, 2);
    const letra = (/\d\s*-?\s*([A-Z])$/.exec(oab) || [])[1] || '(sem letra)';
    const tipo = m[2].replace(/\s+/g, ' ').trim().toUpperCase();
    const chave = `${uf}\t${letra}\t${tipo}`;
    const g = grupos.get(chave) || { total: 0, exemplos: new Set() };
    g.total += 1;
    if (g.exemplos.size < 3) g.exemplos.add(oab);
    grupos.set(chave, g);
  }
}

if (!fs.existsSync(RAIZ)) {
  console.error(`Pasta não encontrada: ${RAIZ}`);
  process.exit(1);
}
percorrer(RAIZ);

console.log(`Páginas lidas: ${paginas}\n`);
console.log('UF\tLetra\tTipo de usuário\tOcorrências\tExemplos');
const linhas = [...grupos].sort((a, b) => b[1].total - a[1].total);
for (const [chave, g] of linhas) console.log(`${chave}\t${g.total}\t${[...g.exemplos].join(' | ')}`);
if (!linhas.length) console.log('(nenhuma OAB encontrada; as páginas .html.gz só existem para os processos coletados com detalhes)');
