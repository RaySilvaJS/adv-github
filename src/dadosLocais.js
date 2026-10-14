const fs = require('fs');
const path = require('path');

const PASTA = path.join(__dirname, '..', 'dados');
// Saída do scripts/varrer-oab-eproc.js: dados/advogados/<OAB>/_advogado.json + um <CNJ>.json por processo.
const PASTA_VARREDURA = path.join(PASTA, 'advogados');

async function lerJson(arquivo) {
  try { return JSON.parse(await fs.promises.readFile(arquivo, 'utf8')); } catch { return null; }
}

// Detalhes que dispensam abrir o processo no eproc: já têm o valor da causa (mesmo que vazio) ou o eproc
// informou que não há informações adicionais. Detalhes com erro são buscados de novo.
function detalheCompleto(det) {
  return Boolean(det && !det.erro && (det.semInformacoesAdicionais || 'valorCausa' in det));
}

// Procura a OAB nos dados já salvos: primeiro a varredura, depois as consultas anteriores do bot (dados/<OAB>.json).
// Devolve { lista, detalhes, fonte, atualizadoEm } ou null. A lista sai na mesma ordem em que o eproc devolveu.
// Leitura assíncrona, em blocos: OABs com milhares de processos não travam o bot enquanto os arquivos são lidos.
async function carregarOabLocal(oab) {
  const detalhes = {};
  let lista = null;
  let fonte = null;
  let atualizadoEm = null;

  const pastaVarredura = path.join(PASTA_VARREDURA, oab);
  const meta = await lerJson(path.join(pastaVarredura, '_advogado.json'));
  if (meta?.processos?.length) {
    lista = [];
    for (let i = 0; i < meta.processos.length; i += 200) {
      const bloco = meta.processos.slice(i, i + 200);
      const arquivos = await Promise.all(bloco.map((nr) => lerJson(path.join(pastaVarredura, `${nr}.json`))));
      arquivos.forEach((j, k) => {
        if (!j?.dados) return;
        lista.push(j.dados);
        if (detalheCompleto(j.detalhes)) detalhes[bloco[k]] = j.detalhes;
      });
    }
    fonte = 'varredura';
    atualizadoEm = meta.atualizado_em;
  }

  const consulta = await lerJson(path.join(PASTA, `${oab}.json`));
  const processos = consulta?.processos || {};
  if (!lista?.length && Object.keys(processos).length) {
    lista = Object.values(processos).map((p) => p.dados).filter(Boolean);
    fonte = 'consulta anterior';
    atualizadoEm = consulta.ultima_consulta;
  }
  // Detalhes das consultas do bot completam os que a varredura não tem.
  for (const [nr, p] of Object.entries(processos)) {
    if (!detalhes[nr] && detalheCompleto(p.detalhes)) detalhes[nr] = p.detalhes;
  }

  if (!lista?.length) return Object.keys(detalhes).length ? { lista: null, detalhes } : null;
  return { lista, detalhes, fonte, atualizadoEm };
}

module.exports = { carregarOabLocal, detalheCompleto };
