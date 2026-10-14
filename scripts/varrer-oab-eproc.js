// Varre números de OAB no eproc e descobre o nome do advogado de cada número que tenha processos.
// Uso: node scripts/varrer-oab-eproc.js [inicio] [fim] [UF] [letra]
// Inscrições com letra (TO06830B...): node scripts/varrer-oab-eproc.js --lista TO   (usa as OABs das páginas já coletadas)
// Ex.: node scripts/varrer-oab-eproc.js 1 50 TO   (teste pequeno)
// Não faz login: usa a sessão salva pelo bot. Em HTTP 401/403 relê o arquivo de sessão e, se persistir, para.
// Retoma de onde parou (dados/varredura-oab-progresso.json). Saída: dados/advogados-eproc.csv

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { ARQUIVO_CREDENCIAIS, autenticarEproc, loginEprocConfigurado } = require('../src/loginEproc');
require('dotenv').config({ path: ARQUIVO_CREDENCIAIS, override: true });
const zlib = require('node:zlib');
const {
  consultarPorOab, sessaoExpirou, abrirProcesso, extrairAdvogado, buscarInformacoesAdicionais, extrairDetalhes, extrairRequerente,
} = require('../src/eproc');
const { extrairExtras } = require('./extrair-processo');
const { parseResposta } = require('../src/formatar');
const { capturarIpSaidaInicial } = require('../src/ipEgress');

// Modo lista (--lista [UF]): consulta as OABs achadas nas páginas já coletadas, com a grafia exata do eproc.
const MODO_LISTA = process.argv.includes('--lista');
const ARGS = process.argv.slice(2).filter((a) => a !== '--lista');
const INICIO = Number.parseInt(ARGS[0] || '1', 10);
const FIM = Number.parseInt(ARGS[1] || '50', 10);
const UF = ((MODO_LISTA ? ARGS[0] : ARGS[2]) || process.env.UF_PADRAO || 'TO').toUpperCase();
// Série da inscrição: vazio = principal (TO006940); letra = inscrição com letra (TO006940B). Só funciona se o eproc a conhecer assim.
const SUFIXO = (ARGS[3] || process.env.SUFIXO || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1);
const TIMEOUT_MS = Number.parseInt(process.env.TIMEOUT_MS || '120000', 10);
const ESPERA_MS = Number.parseInt(process.env.ESPERA_MS || '3000', 10);
const PARAR_APOS = Number.parseInt(process.env.PARAR_APOS || '500', 10);
const PASTA_ADV = path.resolve('dados/advogados');
const DETALHES_TODOS = (process.env.DETALHES || '').trim() === 'todos';
const REFAZER = (process.env.REFAZER || '').trim() === '1';
const PARALELO = Math.max(1, Number.parseInt(process.env.PARALELO || '1', 10));
// Advogados com muitos processos pendentes usam paralelismo aleatório (desligue com ALEATORIO=0).
// trim: no cmd, "set ALEATORIO=0 && ..." grava "0 " (com espaço).
const ALEATORIO = (process.env.ALEATORIO || '').trim() !== '0';
const MUITOS = Number.parseInt(process.env.MUITOS || '100', 10);
const MUITISSIMOS = Number.parseInt(process.env.MUITISSIMOS || '300', 10);
const DETALHES_LIMITE = Number.parseInt(process.env.DETALHES_LIMITE || '30', 10);
const SAIDA = path.resolve('dados/advogados-eproc.csv');
const PROGRESSO = path.resolve(`dados/varredura-oab-progresso-${UF}${SUFIXO ? `-${SUFIXO}` : ''}.json`);

function criarCfg() {
  require('dotenv').config({ path: ARQUIVO_CREDENCIAIS, override: true });
  return {
    cookie: process.env.EPROC_COOKIE,
    ajaxHash: process.env.EPROC_AJAX_HASH,
    refererHash: process.env.EPROC_REFERER_HASH,
    testOab: process.env.EPROC_TEST_OAB || process.env.OAB_PADRAO,
    userAgent: process.env.EPROC_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  };
}

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
const csv = (v) => `"${String(v).replaceAll('"', '""')}"`;

function lerProgresso() {
  try { return JSON.parse(fs.readFileSync(PROGRESSO, 'utf8')); } catch { return { ultimo: INICIO - 1 }; }
}

function anexarCsv(linha) {
  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  if (!fs.existsSync(SAIDA)) fs.writeFileSync(SAIDA, '﻿oab,nome,processo\r\n', 'utf8');
  fs.appendFileSync(SAIDA, `${linha}\r\n`, 'utf8');
}

// Estrutura pensada para consulta futura (ex.: /advteste <OAB>):
//   dados/advogados/<OAB>/_advogado.json   -> nome, totais e lista dos números de processo
//   dados/advogados/<OAB>/<CNJ>.json       -> um arquivo por processo ("dados" = lista do eproc, "detalhes" = página)
//   dados/advogados/_indice.json           -> todos os advogados achados
// Cada processo é gravado assim que é consultado, então uma queda no meio não perde o que já foi coletado.
function pastaDoAdvogado(oab) {
  const pasta = path.join(PASTA_ADV, oab);
  fs.mkdirSync(pasta, { recursive: true });
  return pasta;
}

function lerJson(arquivo) {
  try { return JSON.parse(fs.readFileSync(arquivo, 'utf8')); } catch { return null; }
}

function salvarMetaAdvogado(oab, adv, lista) {
  const pasta = pastaDoAdvogado(oab);
  const agora = new Date().toISOString();
  const detalhados = lista.filter((r) => lerJson(path.join(pasta, `${r.nr_processo}.json`))?.detalhes).length;
  fs.writeFileSync(path.join(pasta, '_advogado.json'), JSON.stringify({
    oab,
    uf: UF,
    nome: adv.nome,
    atualizado_em: agora,
    total_processos: lista.length,
    processos_detalhados: detalhados,
    processos: lista.map((r) => r.nr_processo),
  }, null, 2), 'utf8');

  const indiceArquivo = path.join(PASTA_ADV, '_indice.json');
  const indice = lerJson(indiceArquivo) || {};
  indice[oab] = { nome: adv.nome, total_processos: lista.length, processos_detalhados: detalhados, atualizado_em: agora };
  fs.writeFileSync(indiceArquivo, JSON.stringify(indice, null, 2), 'utf8');
}

// Grava a lista de cada processo (sem custo extra), sem sobrescrever detalhes já coletados.
function salvarListaDeProcessos(oab, lista) {
  const pasta = pastaDoAdvogado(oab);
  for (const r of lista) {
    const arquivo = path.join(pasta, `${r.nr_processo}.json`);
    const atual = lerJson(arquivo);
    fs.writeFileSync(arquivo, JSON.stringify({
      oab,
      nr_processo: r.nr_processo,
      dados: r,
      detalhes: atual?.detalhes || null,
      atualizado_em: new Date().toISOString(),
    }, null, 2), 'utf8');
  }
}

// Busca os detalhes dos processos, gravando cada um na hora; pula os que já têm detalhes (retomada).
// Com PARALELO > 1, abre vários processos ao mesmo tempo (cada um grava o próprio arquivo, sem conflito).
async function coletarDetalhes(oab, adv, lista, cfg) {
  const pasta = pastaDoAdvogado(oab);
  let falhasSeguidas = 0;
  let proximo = 0;
  let erroFatal = null;

  async function processar(i, r) {
    const arquivo = path.join(pasta, `${r.nr_processo}.json`);
    const atual = lerJson(arquivo);
    // Retoma pulando o que já tem detalhes. Com REFAZER=1, os salvos antes dos campos extras também são refeitos.
    if (atual?.detalhes && (!REFAZER || atual.detalhes.partes)) return;
    await pausa(ESPERA_MS);
    let detalhes = null;
    let motivo = '';
    // Duas tentativas: falhas isoladas costumam ser instabilidade momentânea do eproc.
    for (let tentativa = 1; tentativa <= 2 && !detalhes; tentativa += 1) {
      let pagina;
      try {
        pagina = await abrirProcesso(r.linkProcessoAssinado, cfg);
        if (MODO_LISTA) colherOabs(pagina);
        const novos = { requerente: extrairRequerente(pagina), advogado: extrairAdvogado(pagina, oab), ...extrairExtras(pagina) };
        const info = await buscarInformacoesAdicionais(pagina, r.linkProcessoAssinado, cfg);
        if (info === null) novos.semInformacoesAdicionais = true;
        else Object.assign(novos, extrairDetalhes(info));
        detalhes = novos;
      } catch (erro) {
        motivo = erro.message;
        // Guarda a página recebida para diagnóstico (dados/debug-falha-<processo>.html).
        if (pagina) try { fs.writeFileSync(path.resolve(`dados/debug-falha-${r.nr_processo}.html`), pagina, 'utf8'); } catch { /* opcional */ }
        if (tentativa < 2) await pausa(ESPERA_MS * 2);
      }
    }
    if (!detalhes) {
      falhasSeguidas += 1;
      console.log(`  [${i + 1}/${lista.length}] ${r.nr_processo}: falhou (${motivo})`);
      if (falhasSeguidas >= 5) erroFatal = new Error('5 falhas seguidas ao abrir processos (sessão expirada ou bloqueio?).');
      return;
    }
    falhasSeguidas = 0;
    fs.writeFileSync(arquivo, JSON.stringify({ ...atual, detalhes, atualizado_em: new Date().toISOString() }, null, 2), 'utf8');
    console.log(`  [${i + 1}/${lista.length}] ${r.nr_processo}: salvo`);
  }

  // Quantos processos abrir ao mesmo tempo. Com muitos pendentes, o nível é sorteado e muda de tempos em tempos:
  // a partir de MUITOS (padrão 100) sorteia 2 ou 3; a partir de MUITISSIMOS (padrão 300), 2, 3 ou 5. Poucos: PARALELO.
  const pendentes = lista.filter((r) => {
    const a = lerJson(path.join(pasta, `${r.nr_processo}.json`));
    return !(a?.detalhes && (!REFAZER || a.detalhes.partes));
  }).length;
  let opcoes = [PARALELO];
  if (ALEATORIO && pendentes >= MUITOS) opcoes = pendentes >= MUITISSIMOS ? [2, 3, 5] : [2, 3];
  const sortear = () => opcoes[Math.floor(Math.random() * opcoes.length)];
  const proximaTroca = () => 3 + Math.floor(Math.random() * 10); // troca depois de 3 a 12 processos concluídos
  let limite = sortear();
  let ativos = 0;
  let concluidos = 0;
  let ate = proximaTroca();
  if (opcoes.length > 1) console.log(`  ${pendentes} processos pendentes: paralelismo aleatório entre ${opcoes.join(', ')}.`);

  async function trabalhador() {
    while (proximo < lista.length && !erroFatal) {
      if (ativos >= limite) {
        await pausa(300);
        continue;
      }
      const i = proximo;
      proximo += 1;
      ativos += 1;
      try {
        await processar(i, lista[i]);
      } finally {
        ativos -= 1;
        concluidos += 1;
        if (opcoes.length > 1 && concluidos >= ate) {
          const novo = sortear();
          if (novo !== limite) console.log(`  ↔ paralelismo agora: ${novo}`);
          limite = novo;
          concluidos = 0;
          ate = proximaTroca();
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(...opcoes) }, trabalhador));
  if (erroFatal) throw erroFatal;
  salvarMetaAdvogado(oab, adv, lista);
}

async function renovarSessao(cfg, motivo) {
  if (!loginEprocConfigurado()) throw new Error(`${motivo}; configure o login automático (npm run eproc:configurar).`);
  console.log(`  Sessão do eproc expirada (${motivo}); renovando o login (pode levar um minuto)...`);
  await autenticarEproc(cfg);
}

// Consulta a lista de processos da OAB; se a sessão expirou, renova o login (como o bot) e tenta de novo uma vez.
async function consultar(oab, cfg) {
  let resp;
  try {
    resp = await consultarPorOab(oab, cfg);
  } catch (erro) {
    if (![401, 403].includes(erro.status)) throw erro;
    await renovarSessao(cfg, `HTTP ${erro.status}`);
    resp = await consultarPorOab(oab, cfg);
  }
  try {
    return parseResposta(resp);
  } catch {
    if (!sessaoExpirou(resp)) throw new Error('Resposta do eproc fora do formato esperado.');
    await renovarSessao(cfg, 'resposta de sessão expirada');
    resp = await consultarPorOab(oab, cfg);
    try { return parseResposta(resp); } catch { throw new Error('Resposta do eproc fora do formato mesmo após renovar a sessão.'); }
  }
}

let comDetalhes = 0;

// Falhas de fetch não indicam, por si só, sessão expirada nem bloqueio do IP.
function textoSeguro(valor) {
  return String(valor).replace(/(cookie|authorization|password|token|hash)=([^&\s]+)/gi, '$1=[REDACTED]');
}

function detalheErro(erro, profundidade = 0) {
  if (!(erro instanceof Error) || profundidade >= 5) return undefined;
  const detalhe = {
    nome: erro.name,
    mensagem: textoSeguro(erro.message),
  };
  if (erro.code) detalhe.codigo = textoSeguro(erro.code);
  if (erro.stack) detalhe.stack = textoSeguro(erro.stack);
  const causa = detalheErro(erro.cause, profundidade + 1);
  if (causa) detalhe.causa = causa;
  return detalhe;
}

function salvarDiagnostico(oab, erro) {
  const agora = new Date();
  const nomeArquivo = `erro-eproc-${agora.toISOString().replace(/[:.]/g, '-')}.json`;
  const pasta = path.resolve('dados/erros-varredura-eproc');
  const arquivo = path.join(pasta, nomeArquivo);
  const diagnostico = {
    data: agora.toISOString(),
    modo: MODO_LISTA ? 'lista' : 'numerico',
    uf: UF,
    oab,
    etapa: erro.etapa || 'não identificada',
    erro: detalheErro(erro),
  };
  try {
    fs.mkdirSync(pasta, { recursive: true });
    fs.writeFileSync(arquivo, `${JSON.stringify(diagnostico, null, 2)}\n`, 'utf8');
    return arquivo;
  } catch (falhaAoSalvar) {
    console.error(`Não foi possível salvar o diagnóstico em ${arquivo}: ${falhaAoSalvar.message}`);
    return null;
  }
}

function avisoDeParada(oab, erro, oQueFoiSalvo) {
  const arquivoDiagnostico = salvarDiagnostico(oab, erro);
  const causa = erro.cause;
  const detalheCausa = causa
    ? [causa.code, causa.message].filter(Boolean).join(': ') || String(causa)
    : '';
  console.error(`Parando em ${oab} durante ${erro.etapa || 'etapa não identificada'}: ${erro.message}${detalheCausa ? ` (${detalheCausa})` : ''}`);
  if (arquivoDiagnostico) console.error(`Diagnóstico detalhado salvo em: ${arquivoDiagnostico}`);
  if (/fetch failed/i.test(erro.message) || causa) {
    console.error(`Falha de rede/socket; isso não confirma bloqueio do IP. Pode ser uma interrupção entre esta máquina, a VPN e o eproc. Espere um pouco e, ao retomar, use ALEATORIO=0, PARALELO=1 e ESPERA_MS=10000 para manter a coleta sequencial; ${oQueFoiSalvo}.`);
  } else {
    console.error(`Rode de novo depois de renovar a sessão; ${oQueFoiSalvo}.`);
  }
}

// Desiste de um pedido ao eproc que não responde, em vez de ficar parado sem aviso.
function comLimite(promessa, ms, mensagem) {
  let timer;
  const limite = new Promise((_, rejeitar) => {
    timer = setTimeout(() => {
      const erro = new Error(mensagem);
      erro.timeout = true;
      rejeitar(erro);
    }, ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

// Consulta uma OAB (escrita exatamente como o eproc a conhece), salva o advogado e os processos.
// Devolve 'vazio' (sem processos), 'sem-nome' (tem processos, mas o nome não foi achado) ou 'achou'.
async function processarOab(oab, cfg) {
  if (MODO_LISTA) console.log(`→ consultando ${oab}...`);
  let etapa = 'consultando processos da OAB';
  try {
    const dados = await comLimite(consultar(oab, cfg), TIMEOUT_MS, `o eproc não respondeu à consulta de ${oab} em ${Math.round(TIMEOUT_MS / 1000)} s`);
    const lista = dados.resultados || [];
    if (!lista.length) {
      console.log(`${oab}: sem processos`);
      return 'vazio';
    }
    etapa = 'abrindo o primeiro processo para identificar o advogado';
    await pausa(ESPERA_MS);
    const pagina = await comLimite(abrirProcesso(lista[0].linkProcessoAssinado, cfg), TIMEOUT_MS, `o eproc não abriu o processo de ${oab} em ${Math.round(TIMEOUT_MS / 1000)} s`);
    if (MODO_LISTA) colherOabs(pagina);
    const adv = extrairAdvogado(pagina, oab);
    if (!adv) {
      console.log(`${oab}: tem processos, mas o nome não foi encontrado (página salva em dados/debug-${oab}.html)`);
      fs.writeFileSync(path.resolve(`dados/debug-${oab}.html`), pagina, 'utf8');
      return 'sem-nome';
    }
    anexarCsv(`${csv(adv.oab)},${csv(adv.nome)},${csv(lista[0].nr_processo)}`);
    console.log(`${oab}: ${adv.nome}`);
    // Lista de processos de todo advogado achado. Detalhes (requerente, valor da causa) só dos primeiros
    // DETALHES_LIMITE advogados (teste, padrão 30) ou de todos com DETALHES=todos: custam 2 requisições por processo.
    salvarListaDeProcessos(oab, lista);
    salvarMetaAdvogado(oab, adv, lista);
    if (comDetalhes < DETALHES_LIMITE || DETALHES_TODOS) {
      etapa = 'coletando detalhes dos processos';
      comDetalhes += 1;
      console.log(`  Buscando detalhes de ${lista.length} processo(s)...`);
      await coletarDetalhes(oab, adv, lista, cfg);
    }
    return 'achou';
  } catch (erro) {
    if (erro instanceof Error && !erro.etapa) erro.etapa = etapa;
    throw erro;
  }
}

// ---- Modo lista: a fila de OABs vem das páginas já coletadas, com a grafia exata do eproc ----
// O eproc só acha a OAB com letra escrita como está cadastrada (TO06830B funciona; TO006830B e TO6830B não).
const ARQUIVO_FILA = path.resolve(`dados/oabs-fila-${UF}.json`);
const PADRAO_OAB = /<a\b[^>]*>\s*([A-Z]{2}\s*\d{3,8}(?:\s*-?\s*[A-Z])?)\s*<\/a>[\s\S]{0,300}?Tipo de Usu[aá]rio:\s*([^<]+?)\s*<\/div>/gi;
const fila = { pendentes: new Set(), tentadas: {}, achadas: new Set() };

// UF + número sem zeros à esquerda + letra: identifica a inscrição independentemente do preenchimento.
function canonica(oab) {
  const m = /^([A-Z]{2})0*(\d+)([A-Z]?)$/.exec(oab);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : oab;
}

function adicionarNaFila(oab) {
  if (fila.tentadas[oab] || fila.pendentes.has(oab) || fila.achadas.has(canonica(oab))) return;
  fila.pendentes.add(oab);
}

// Procura na página as OABs da UF (advogados e procuradores) e coloca na fila as que ainda não foram tentadas.
function colherOabs(html) {
  for (const m of String(html).matchAll(PADRAO_OAB)) {
    const oab = m[1].replace(/[\s-]+/g, '');
    if (!oab.startsWith(UF) || !/ADVOGADO|PROCURADOR/i.test(m[2])) continue;
    adicionarNaFila(oab);
  }
}

function salvarFila() {
  fs.mkdirSync(path.dirname(ARQUIVO_FILA), { recursive: true });
  fs.writeFileSync(ARQUIVO_FILA, JSON.stringify({
    pendentes: [...fila.pendentes], tentadas: fila.tentadas, achadas: [...fila.achadas],
  }), 'utf8');
}

function lerPaginasSalvas(pasta) {
  for (const nome of fs.readdirSync(pasta)) {
    const caminho = path.join(pasta, nome);
    if (fs.statSync(caminho).isDirectory()) lerPaginasSalvas(caminho);
    else if (nome.endsWith('.html.gz')) {
      try { colherOabs(zlib.gunzipSync(fs.readFileSync(caminho)).toString('utf8')); } catch { /* arquivo ilegível */ }
    }
  }
}

function prepararFila() {
  const salvo = lerJson(ARQUIVO_FILA);
  if (salvo) {
    for (const o of salvo.pendentes || []) fila.pendentes.add(o);
    Object.assign(fila.tentadas, salvo.tentadas || {});
    for (const c of salvo.achadas || []) fila.achadas.add(c);
  }
  // Quem já tem pasta em dados/advogados já foi coletado (inclusive pela varredura numérica).
  if (fs.existsSync(PASTA_ADV)) {
    for (const nome of fs.readdirSync(PASTA_ADV)) {
      if (fs.statSync(path.join(PASTA_ADV, nome)).isDirectory()) fila.achadas.add(canonica(nome));
    }
  }
  if (!salvo || process.env.REESCANEAR === '1') {
    console.log('Lendo as páginas já coletadas para montar a fila de OABs (pode levar alguns minutos)...');
    if (fs.existsSync(PASTA_ADV)) lerPaginasSalvas(PASTA_ADV);
  }
  for (const c of [...fila.pendentes]) if (fila.achadas.has(canonica(c))) fila.pendentes.delete(c);
  // RETENTAR=1: coloca de volta na fila as OABs que o eproc não respondeu na vez anterior.
  if (process.env.RETENTAR === '1') {
    for (const [oab, resultado] of Object.entries(fila.tentadas)) {
      if (resultado === 'timeout') {
        delete fila.tentadas[oab];
        fila.pendentes.add(oab);
      }
    }
  }
}

// Inscrições com letra primeiro, que são as que a varredura numérica não alcança.
function proximaDaFila() {
  const todas = [...fila.pendentes];
  return todas.find((o) => /[A-Z]$/.test(o)) || todas[0];
}

async function mainLista() {
  const ipSaida = await capturarIpSaidaInicial();
  console.log(`IP público de saída detectado: ${ipSaida}`);
  const cfg = criarCfg();
  if (!cfg.cookie || !cfg.refererHash) throw new Error('Sem sessão do eproc salva. Faça login pelo bot primeiro.');
  prepararFila();
  salvarFila();
  const letras = [...fila.pendentes].filter((o) => /[A-Z]$/.test(o)).length;
  console.log(`Modo lista ${UF}: ${fila.pendentes.size} OABs na fila (${letras} com letra), ${fila.achadas.size} já coletadas.`);

  let timeoutsSeguidos = 0;
  while (fila.pendentes.size) {
    const oab = proximaDaFila();
    fila.pendentes.delete(oab);
    if (fila.achadas.has(canonica(oab))) continue;
    try {
      const resultado = await processarOab(oab, cfg);
      timeoutsSeguidos = 0;
      fila.tentadas[oab] = resultado;
      if (resultado === 'achou') fila.achadas.add(canonica(oab));
    } catch (erro) {
      if (erro.timeout) {
        // Uma OAB que o eproc não responde não trava a fila: marca e segue. 3 seguidas indicam eproc fora do ar.
        fila.tentadas[oab] = 'timeout';
        timeoutsSeguidos += 1;
        salvarFila();
        console.log(`  ⚠ ${erro.message}; pulando (RETENTAR=1 tenta de novo na próxima execução).`);
        if (timeoutsSeguidos < 3) {
          await pausa(ESPERA_MS);
          continue;
        }
        console.error('3 OABs seguidas sem resposta: o eproc parece fora do ar ou a sessão caiu. Parando; a fila foi salva.');
        process.exitCode = 1;
        return;
      }
      fila.pendentes.add(oab); // volta para a fila: será tentada de novo na próxima execução
      salvarFila();
      avisoDeParada(oab, erro, 'a fila foi salva');
      process.exitCode = 1;
      return;
    }
    salvarFila();
    if (fila.pendentes.size) console.log(`  [fila: ${fila.pendentes.size} restantes]`);
    await pausa(ESPERA_MS);
  }
  console.log('Fila esgotada. Para achar novas OABs, rode de novo depois de coletar mais processos (REESCANEAR=1 relê as páginas salvas).');
}

async function main() {
  const ipSaida = await capturarIpSaidaInicial();
  console.log(`IP público de saída detectado: ${ipSaida}`);
  const cfg = criarCfg();
  if (!cfg.cookie || !cfg.refererHash) throw new Error('Sem sessão do eproc salva. Faça login pelo bot primeiro.');

  const progresso = lerProgresso();
  const inicio = Math.max(INICIO, progresso.ultimo + 1);
  console.log(`Varrendo ${UF}${SUFIXO ? ` série ${SUFIXO}` : ''} de ${inicio} a ${FIM} (pausa ${ESPERA_MS} ms)...`);

  let semResultado = 0;
  let achouAlgum = false;
  for (let n = inicio; n <= FIM; n += 1) {
    const oab = UF + String(n).padStart(6, '0') + SUFIXO;
    try {
      const resultado = await processarOab(oab, cfg);
      if (resultado === 'vazio') {
        semResultado += 1;
      } else {
        semResultado = 0;
        achouAlgum = true;
      }
    } catch (erro) {
      avisoDeParada(oab, erro, 'o progresso foi salvo');
      process.exitCode = 1;
      return;
    }
    fs.mkdirSync(path.dirname(PROGRESSO), { recursive: true });
    fs.writeFileSync(PROGRESSO, JSON.stringify({ ultimo: n }), 'utf8');
    if (achouAlgum && semResultado >= PARAR_APOS) {
      console.log(`${PARAR_APOS} números seguidos sem processos: provavelmente passou do último número emitido. Parando.`);
      return;
    }
    await pausa(ESPERA_MS);
  }
  console.log('Concluído.');
}

(MODO_LISTA ? mainLista() : main()).catch((e) => { console.error(e.message); process.exitCode = 1; });
