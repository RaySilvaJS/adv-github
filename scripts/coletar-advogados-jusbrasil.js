// Coleta o nome dos advogados da listagem do Jusbrasil, entrando em cada perfil.
// Uso: node scripts/coletar-advogados-jusbrasil.js [URL] [arquivo.csv]
// Se o arquivo de saída já existir, os perfis já salvos são pulados (retoma de onde parou).

const { chromium } = require('playwright');
const fs = require('node:fs/promises');
const path = require('node:path');

const URL_INICIAL = process.argv[2] || 'https://www.jusbrasil.com.br/advogados/direito-civil-to/';
const ARQUIVO_SAIDA = path.resolve(process.argv[3] || 'dados/advogados-jusbrasil.csv');
const MAX_PAGINAS = Number.parseInt(process.env.MAX_PAGINAS || '1000', 10);
const ESPERA_MS = Number.parseInt(process.env.ESPERA_MS || '2000', 10);

function csv(valor) {
  return `"${String(valor).replaceAll('"', '""')}"`;
}

async function lerSalvos() {
  const salvos = new Map();
  try {
    const texto = await fs.readFile(ARQUIVO_SAIDA, 'utf8');
    for (const linha of texto.replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
      const m = linha.match(/^"((?:[^"]|"")*)","((?:[^"]|"")*)"$/);
      if (m) salvos.set(m[2].replaceAll('""', '"'), m[1].replaceAll('""', '"'));
    }
  } catch { /* arquivo ainda não existe */ }
  return salvos;
}

async function salvar(resultados) {
  await fs.mkdir(path.dirname(ARQUIVO_SAIDA), { recursive: true });
  const linhas = ['nome,url', ...[...resultados].map(([perfil, nome]) => `${csv(nome)},${csv(perfil)}`)];
  await fs.writeFile(ARQUIVO_SAIDA, `﻿${linhas.join('\r\n')}\r\n`, 'utf8');
}

const ESPERA_VERIFICACAO_MS = Number.parseInt(process.env.ESPERA_VERIFICACAO_MS || '300000', 10);

async function emVerificacao(page) {
  const texto = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  return /etapa de seguran|Verificando|Just a moment|Verify you are human/i.test(texto);
}

async function abrir(page, url) {
  let resposta = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);

  // Verificação de segurança (Cloudflare): espera a pessoa concluir no navegador.
  if ((resposta && resposta.status() === 403) || await emVerificacao(page)) {
    console.log('  >> Verificação de segurança: conclua na janela do Chrome. Aguardando...');
    const limite = Date.now() + ESPERA_VERIFICACAO_MS;
    while (Date.now() < limite && await emVerificacao(page)) await page.waitForTimeout(2000);
    if (await emVerificacao(page)) throw new Error('Verificação de segurança não concluída a tempo.');
    resposta = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(1200);
  }

  if (resposta && resposta.status() >= 400) throw new Error(`O site respondeu HTTP ${resposta.status()}.`);
}

// Perfis ficam em subdomínios próprios (ex.: https://fulano.jusbrasil.com.br/).
function extrairListagem() {
  const perfis = new Set();
  const ignorados = new Set(['www', 'static', 'imgs', 'api', 'blog', 'ajuda', 'app']);
  for (const a of document.querySelectorAll('a[href]')) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    const m = u.hostname.match(/^([a-z0-9-]+)\.jusbrasil\.com\.br$/i);
    if (!m || ignorados.has(m[1].toLowerCase())) continue;
    perfis.add(`${u.origin}/`);
  }

  const rel = ['next', 'Next', 'Próxima', 'próxima', 'Seguinte', 'seguinte'];
  let proxima = document.querySelector('a[rel="next"]')?.href || null;
  if (!proxima) {
    const link = [...document.querySelectorAll('a[href]')]
      .find(a => rel.includes((a.innerText || a.getAttribute('aria-label') || '').trim()));
    if (link) proxima = link.href;
  }
  return { perfis: [...perfis], proxima };
}

function extrairNomePerfil() {
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const json = JSON.parse(s.textContent);
      const itens = json['@graph'] || [json];
      const pessoa = itens.find(i => i['@type'] === 'Person' && i.name);
      if (pessoa) return pessoa.name.replace(/\s+/g, ' ').trim();
    } catch { /* tenta o próximo bloco */ }
  }
  const titulo = document.title.replace(/^Advogado\s+/i, '').split('|')[0].trim();
  return titulo || null;
}

async function main() {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await browser.newPage({ locale: 'pt-BR' });
  const resultados = await lerSalvos();
  if (resultados.size) console.log(`${resultados.size} perfil(is) já salvos; serão pulados.`);
  const visitadas = new Set();
  let url = URL_INICIAL;

  try {
    for (let numero = 1; url && numero <= MAX_PAGINAS; numero += 1) {
      const atual = new URL(url);
      atual.hash = '';
      if (visitadas.has(atual.href)) break;
      visitadas.add(atual.href);

      console.log(`Página ${numero}: ${atual.href}`);
      await abrir(page, atual.href);
      const { perfis, proxima } = await page.evaluate(extrairListagem);
      const novos = perfis.filter(p => !resultados.has(p));
      console.log(`  ${perfis.length} perfil(is) na página; ${novos.length} novo(s).`);

      for (const perfil of novos) {
        try {
          await abrir(page, perfil);
          const nome = await page.evaluate(extrairNomePerfil);
          if (!nome) { console.log(`  sem nome: ${perfil}`); continue; }
          resultados.set(perfil, nome);
          console.log(`  ${nome}`);
        } catch (erro) {
          console.log(`  falhou ${perfil}: ${erro.message}`);
        }
        await page.waitForTimeout(ESPERA_MS);
      }

      await salvar(resultados);
      url = proxima;
      if (url) await page.waitForTimeout(ESPERA_MS);
    }
  } finally {
    await salvar(resultados);
    await browser.close();
  }
  console.log(`Salvo ${resultados.size} nome(s) em ${ARQUIVO_SAIDA}`);
}

main().catch(erro => {
  console.error(`Falha na coleta: ${erro.message}`);
  console.error('Se aparecer CAPTCHA, bloqueio ou consentimento, conclua isso manualmente no navegador e tente novamente.');
  process.exitCode = 1;
});
