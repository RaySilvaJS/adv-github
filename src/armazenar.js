const fs = require('fs');
const path = require('path');

const PASTA = path.join(__dirname, '..', 'dados');

// Salva a consulta em dados/<OAB>.json, indexada pelo número do processo.
// Mantém quando cada processo foi visto pela primeira vez e devolve quais são novos nesta consulta.
function salvarConsulta(oab, resultados, detalhes) {
  fs.mkdirSync(PASTA, { recursive: true });
  const arquivo = path.join(PASTA, `${oab}.json`);
  const agora = new Date().toISOString();

  let anterior = null;
  try { anterior = JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch {}
  const antigos = (anterior && anterior.processos) || {};

  const processos = {};
  const novos = [];
  for (const r of resultados) {
    const velho = antigos[r.nr_processo];
    if (!velho && anterior) novos.push(r.nr_processo);
    const detalhesNovos = detalhes[r.nr_processo] || {};
    processos[r.nr_processo] = {
      primeira_vez_visto: velho ? velho.primeira_vez_visto : agora,
      atualizado_em: agora,
      dados: r, // todos os campos devolvidos pela lista do eproc
      detalhes: {
        ...(velho?.detalhes || {}),
        ...detalhesNovos,
        advogado: detalhesNovos.advogado || velho?.detalhes?.advogado || null,
      },
    };
  }
  // Processos que sumiram da lista continuam guardados.
  for (const [nr, p] of Object.entries(antigos)) if (!processos[nr]) processos[nr] = p;

  const saida = {
    oab,
    primeira_consulta: anterior ? anterior.primeira_consulta : agora,
    ultima_consulta: agora,
    total_na_ultima_consulta: resultados.length,
    processos,
  };
  fs.writeFileSync(arquivo, JSON.stringify(saida, null, 2), 'utf8');
  return { arquivo, novos, primeiraVez: !anterior };
}

function lerJson(arquivo) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
}

// Grava no mesmo formato do scripts/varrer-oab-eproc.js (dados/advogados/<OAB>/_advogado.json + um <CNJ>.json
// por processo + _indice.json), para o próximo /oab da mesma OAB sair dos dados salvos, sem consultar o eproc.
// Só regrava o arquivo do processo que ainda não existe ou que ganhou detalhes agora; detalhes com erro não entram.
function salvarPastaAdvogado(oab, lista, detalhes) {
  const pasta = path.join(PASTA, 'advogados', oab);
  fs.mkdirSync(pasta, { recursive: true });
  const agora = new Date().toISOString();
  let nome = null;
  let detalhados = 0;
  for (const r of lista) {
    const arquivo = path.join(pasta, `${r.nr_processo}.json`);
    const atual = lerJson(arquivo);
    const novo = detalhes[r.nr_processo];
    const detalheNovo = novo && !novo.erro && !atual?.detalhes ? novo : null;
    if (!atual?.dados || detalheNovo) {
      fs.writeFileSync(arquivo, JSON.stringify({
        oab,
        nr_processo: r.nr_processo,
        dados: r,
        detalhes: detalheNovo || atual?.detalhes || null,
        atualizado_em: agora,
      }, null, 2), 'utf8');
    }
    const det = detalheNovo || atual?.detalhes;
    if (det) detalhados += 1;
    nome = nome || det?.advogado?.nome || null;
  }
  const metaArquivo = path.join(pasta, '_advogado.json');
  const metaAnterior = lerJson(metaArquivo);
  nome = nome || metaAnterior?.nome || null;
  // A data da lista só muda quando a lista muda (é a data mostrada no "/oab ... encontrada no nosso sistema").
  const mesmaLista = metaAnterior?.processos?.join() === lista.map((r) => r.nr_processo).join();
  const dataLista = mesmaLista ? metaAnterior.atualizado_em : agora;
  fs.writeFileSync(metaArquivo, JSON.stringify({
    oab,
    uf: oab.slice(0, 2),
    nome,
    atualizado_em: dataLista,
    total_processos: lista.length,
    processos_detalhados: detalhados,
    processos: lista.map((r) => r.nr_processo),
  }, null, 2), 'utf8');

  const indiceArquivo = path.join(PASTA, 'advogados', '_indice.json');
  const indice = lerJson(indiceArquivo) || {};
  indice[oab] = { nome, total_processos: lista.length, processos_detalhados: detalhados, atualizado_em: dataLista };
  fs.writeFileSync(indiceArquivo, JSON.stringify(indice, null, 2), 'utf8');
}

module.exports = { salvarConsulta, salvarPastaAdvogado };
