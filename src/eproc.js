const classes = require('./classes');
const log = require('./logger');
const { verificarIpSaidaEproc } = require('./ipEgress');

const BASE = 'https://eproc1.tjto.jus.br/eprocV2_prod_1grau';

// Os hashes do eproc mudam a cada sessão. Abre a página de busca por OAB e lê o hash atual da chamada
// processos_consulta_por_oab; se não achar, usa o EPROC_AJAX_HASH do .env.
async function obterHashAjax(cfg) {
  await verificarIpSaidaEproc();
  try {
    const res = await fetch(`${BASE}/controlador.php?acao=pesquisa_processo_por_num_oab&hash=${cfg.refererHash}`, {
      headers: { Accept: 'text/html', Cookie: cfg.cookie, 'User-Agent': cfg.userAgent },
    });
    const html = new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
    const m = /processos_consulta_por_oab(?:&amp;|&)hash=([0-9a-f]{32})/i.exec(html);
    if (m) return m[1];
    log.warn('Hash atual da consulta indisponível; usando o hash salvo');
  } catch (e) {
    log.warn(`Não foi possível atualizar o hash (${e.cause?.code || e.cause?.message || e.message}); usando o hash salvo`);
  }
  return cfg.ajaxHash;
}

// Equivalente ao curl original: POST em controlador_ajax.php?acao_ajax=processos_consulta_por_oab
async function consultarPorOab(numOab, cfg) {
  const ajaxHash = await obterHashAjax(cfg);
  await verificarIpSaidaEproc();
  const body = new URLSearchParams();
  body.append('hdnInfraTipoPagina', '1');
  body.append('strIdForm', 'frmProcessoListaAjax');
  body.append('fnValidacao[]', 'gerenciadorTelaConsulta');
  body.append('fnValidacao[]', 'executarValidacoes');
  body.append('acao_origem', '');
  body.append('acao_retorno', '');
  body.append('acao', 'pesquisa_processo_por_num_oab');
  body.append('tipoPesquisa', 'OA');
  body.append('numNumOab', numOab);
  body.append('selIdClasse', classes[0]);
  body.append('selectAllselIdClasse', 'on');
  for (const c of classes) body.append('selectItemselIdClasse', c);
  body.append('selIdClasseSelecionados', classes.join(','));
  body.append('chkExibirBaixados', 'on');

  const res = await fetch(`${BASE}/controlador_ajax.php?acao_ajax=processos_consulta_por_oab&hash=${ajaxHash}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'en-US,en;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Cookie: cfg.cookie,
      Origin: 'https://eproc1.tjto.jus.br',
      Referer: `${BASE}/controlador.php?acao=pesquisa_processo_por_num_oab&hash=${cfg.refererHash}`,
      'User-Agent': cfg.userAgent,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const erro = new Error(`eproc respondeu HTTP ${res.status}`);
    erro.status = res.status;
    throw erro;
  }
  return res.text();
}

// A resposta pode ser JSON ou HTML; extraímos os números CNJ de qualquer forma.
function extrairProcessos(texto) {
  const re = /\d{7}-\d{2}\.\d{4}\.\d\.\d{2}\.\d{4}/g;
  return [...new Set(texto.match(re) || [])];
}

function sessaoExpirou(texto) {
  return /login|sess[aã]o.*expir/i.test(texto) && !/\d{7}-\d{2}\.\d{4}\./.test(texto);
}

// Abre a página de detalhes do processo (mesmo GET do curl: processo_selecionar) e devolve o HTML.
async function abrirProcesso(linkProcessoAssinado, cfg) {
  await verificarIpSaidaEproc();
  const res = await fetch(`${BASE}/${linkProcessoAssinado}`, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: cfg.cookie,
      Referer: `${BASE}/controlador.php?acao=pesquisa_processo_por_num_oab&hash=${cfg.refererHash}`,
      'Upgrade-Insecure-Requests': '1',
      'User-Agent': cfg.userAgent,
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // A página do eproc vem em ISO-8859-1.
  return new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
}

// "Informações Adicionais" não vem na página: ela dispara um POST (carregarInformacoesAdicionais) ao abrir.
// Lemos a URL e o id_pessoa_entidade do onclick da página e repetimos essa chamada.
async function buscarInformacoesAdicionais(htmlProcesso, linkProcessoAssinado, cfg) {
  const u = /carregarInformacoesAdicionais\('([^']+)'/.exec(htmlProcesso);
  // Processos em segredo de justiça não têm a seção "Informações Adicionais" na página.
  if (!u) return null;
  const url = u[1].replace(/&amp;/g, '&');
  const ids = (/'id_pessoa_entidade':\s*'([^']*)'/.exec(htmlProcesso) || [])[1] || '';

  await verificarIpSaidaEproc();
  const res = await fetch(`${BASE}/${url}`, {
    method: 'POST',
    headers: {
      Accept: '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Cookie: cfg.cookie,
      Origin: 'https://eproc1.tjto.jus.br',
      Referer: `${BASE}/${linkProcessoAssinado}`,
      'User-Agent': cfg.userAgent,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams({ id_pessoa_entidade: ids, pagina: '', evento: '', ia_aberta: 'true' }).toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (informações adicionais)`);
  return new TextDecoder('iso-8859-1').decode(await res.arrayBuffer());
}

// Extrai dados da página de detalhes. Por enquanto (teste): valor da causa.
function extrairDetalhes(html) {
  const texto = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
  // Na página aparece como "Valor da Causa: Histórico do Valor da Causa R$ 383.971,83".
  const m = /Valor\s+da\s+Causa\s*:?[\s\S]{0,80}?(R\$\s*[\d.]+,\d{2})/i.exec(texto);
  if (!m) {
    const i = texto.search(/valor\s+da\s+causa/i);
    log.debug(i >= 0 ? 'Campo de valor da causa ausente nos detalhes' : 'Texto do valor da causa não encontrado');
    // Guarda a página para análise (arquivo ignorado pelo Git); evita ter que colar HTML enorme.
    try { require('fs').writeFileSync('debug-processo.html', html); } catch {}
  }
  return { valorCausa: m ? m[1].replace(/\s+/g, ' ') : null };
}

// Primeira parte do polo ativo (1ª coluna da tabela "Partes e Representantes"): nome, CPF/CNPJ, tipo e papel
// (AUTOR, REQUERENTE, EXEQUENTE...). Opcional: devolve null se a página não tiver esses dados.
function extrairRequerente(html) {
  const tab = /id="tblPartesERepresentantes"[\s\S]*?<\/table>/i.exec(html);
  if (!tab) return null;
  const papel = /<th[^>]*>\s*([^<]+?)\s*<\/th>/i.exec(tab[0]);
  const td = /<td[^>]*class="autorReu"[^>]*>([\s\S]*?)<\/td>/i.exec(tab[0]);
  if (!td) return null;
  const nome = /class=['"]infraNomeParte['"][^>]*>\s*(?:<span[^>]*>)?\s*([^<]+)/i.exec(td[1]);
  if (!nome) return null;
  const doc = /id="spnCpfParte\w+"[^>]*>\s*([\d.\/-]+)\s*<\/span>/i.exec(td[1]);
  const tipo = /<\/span>\)(?:&nbsp;|\s)*<span[^>]*>\s*-\s*([^<]+)</i.exec(td[1]);
  return {
    nome: nome[1].replace(/&amp;/g, '&').trim(),
    doc: doc ? doc[1] : null,
    tipo: tipo ? tipo[1].trim() : null,
    papel: papel ? papel[1].trim() : null,
  };
}

function extrairAdvogado(html, numeroOab) {
  if (!numeroOab) return null;
  const tab = /id="tblPartesERepresentantes"[\s\S]*?<\/table>/i.exec(html);
  if (!tab) return null;

  const normalizarInscricao = (inscricao) => {
    const valor = inscricao.toUpperCase().replace(/[^A-Z0-9]/g, '');
    // Aceita inscrição com letra (suplementar etc.): TO6940-B -> TO006940B.
    const match = /^([A-Z]{2})(\d+)([A-Z]?)$/.exec(valor);
    return match ? match[1] + match[2].padStart(6, '0') + match[3] : valor;
  };
  const oabConsultada = normalizarInscricao(numeroOab);
  const celulas = tab[0].matchAll(/<td\b[^>]*class=['"][^'"]*\bautorReu\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi);
  const padrao = /([^<>]*?)<a\b[^>]*>\s*([A-Z]{2}\s*\d{3,8}(?:\s*-?\s*[A-Z])?)\s*<\/a>\s*(?:&nbsp;|&#160;|\s)*<div\b[^>]*class=['"][^'"]*\bsr-only\b[^'"]*['"][^>]*>\s*Tipo de Usuário:\s*ADVOGADO\b[\s\S]*?<\/div>/gi;

  for (const celula of celulas) {
    for (const match of celula[1].matchAll(padrao)) {
      const inscricao = normalizarInscricao(match[2]);
      if (inscricao !== oabConsultada) continue;

      const nome = match[1]
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (nome) return { nome, oab: match[2].replace(/\s+/g, '') };
    }
  }
  return null;
}

// Busca os detalhes de cada processo da lista, poucas requisições por vez para não sobrecarregar o eproc.
async function buscarDetalhes(resultados, cfg, numeroOab = null, paralelo = 1, intervaloMs = 5000) {
  const detalhes = {};
  let idx = 0;
  let primeiraConsulta = true;
  async function worker() {
    while (idx < resultados.length) {
      const r = resultados[idx++];
      if (!primeiraConsulta) await new Promise((ok) => setTimeout(ok, intervaloMs));
      primeiraConsulta = false;
      let pagina;
      try {
        pagina = await abrirProcesso(r.linkProcessoAssinado, cfg);
        detalhes[r.nr_processo] = {
          requerente: extrairRequerente(pagina),
          advogado: extrairAdvogado(pagina, numeroOab),
        };
        const info = await buscarInformacoesAdicionais(pagina, r.linkProcessoAssinado, cfg);
        if (info === null) detalhes[r.nr_processo].semInformacoesAdicionais = true;
        else Object.assign(detalhes[r.nr_processo], extrairDetalhes(info));
      } catch (e) {
        log.warn('Não foi possível abrir os detalhes de um processo');
        // Guarda a página recebida para diagnóstico (arquivos debug-*.html são ignorados pelo Git).
        if (pagina) try { require('fs').writeFileSync(`debug-falha-${r.nr_processo}.html`, pagina); } catch {}
        detalhes[r.nr_processo] = { ...detalhes[r.nr_processo], erro: true };
      }
    }
  }
  await Promise.all(Array.from({ length: paralelo }, worker));
  return detalhes;
}

module.exports = { consultarPorOab, extrairProcessos, sessaoExpirou, abrirProcesso, buscarInformacoesAdicionais, extrairDetalhes, extrairRequerente, extrairAdvogado, buscarDetalhes };
