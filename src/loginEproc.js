const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { atualizarEnv } = require('./cookies');
const { verificarIpSaidaEproc } = require('./ipEgress');

const BASE = 'https://eproc1.tjto.jus.br/eprocV2_prod_1grau';
const URL_LOGIN = `${BASE}/externo_controlador.php?acao=login`;
const URL_BUSCA_OAB = `${BASE}/controlador.php?acao=pesquisa_processo_por_num_oab`;
const PASTA_CONFIGURACAO = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'adv-github')
  : path.join(os.homedir(), '.config', 'adv-github');
const ARQUIVO_CREDENCIAIS = path.join(PASTA_CONFIGURACAO, 'eproc.env');

function lerConfiguracaoLocal() {
  if (!fs.existsSync(ARQUIVO_CREDENCIAIS)) return {};
  return require('dotenv').parse(fs.readFileSync(ARQUIVO_CREDENCIAIS));
}

function loginEprocConfigurado() {
  const config = lerConfiguracaoLocal();
  return Boolean(config.EPROC_USERNAME || config.EPROC_PASSWORD || config.EPROC_TOTP_SECRET);
}

async function reutilizarSessaoEproc(cfg) {
  if (!cfg.cookie || !cfg.refererHash) {
    return { valida: false, motivo: 'não há cookies e hash de referência salvos' };
  }

  await verificarIpSaidaEproc();
  const urlBusca = `${URL_BUSCA_OAB}&hash=${encodeURIComponent(cfg.refererHash)}`;
  const resposta = await fetch(urlBusca, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      Cookie: cfg.cookie,
      'User-Agent': cfg.userAgent || 'Mozilla/5.0',
    },
    redirect: 'follow',
  });
  if (!resposta.ok) {
    return { valida: false, motivo: `o eproc respondeu HTTP ${resposta.status}` };
  }

  const urlFinal = new URL(resposta.url);
  if (
    urlFinal.pathname.endsWith('/externo_controlador.php') ||
    urlFinal.searchParams.get('acao') === 'principal' ||
    urlFinal.searchParams.get('acao') === 'login'
  ) {
    return { valida: false, motivo: 'o eproc redirecionou para a página pública de login' };
  }

  const html = await resposta.text();
  const refererHash = urlFinal.searchParams.get('hash')
    || extrairHash(html, 'pesquisa_processo_por_num_oab');
  const ajaxHash = extrairHash(html, 'processos_consulta_por_oab');
  if (!refererHash || !ajaxHash) {
    return { valida: false, motivo: 'a página não retornou os hashes da consulta OAB' };
  }

  const valores = {
    EPROC_AJAX_HASH: ajaxHash,
    EPROC_REFERER_HASH: refererHash,
  };
  salvarConfiguracaoLocal(valores);
  Object.assign(process.env, valores);
  Object.assign(cfg, {
    ajaxHash: valores.EPROC_AJAX_HASH,
    refererHash: valores.EPROC_REFERER_HASH,
  });
  return { valida: true };
}

function salvarConfiguracaoLocal(valores) {
  fs.mkdirSync(PASTA_CONFIGURACAO, { recursive: true });
  atualizarEnv(valores, ARQUIVO_CREDENCIAIS);
  if (process.platform !== 'win32') fs.chmodSync(ARQUIVO_CREDENCIAIS, 0o600);
}

function decodificarBase32(secret) {
  const normalizado = secret.toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(normalizado)) {
    throw new Error('EPROC_TOTP_SECRET deve conter uma chave TOTP Base32 válida.');
  }
  let bits = '';
  for (const caractere of normalizado) {
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(caractere).toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function gerarCodigoTotp(secret, timestamp = Date.now()) {
  const contador = Buffer.alloc(8);
  contador.writeBigUInt64BE(BigInt(Math.floor(timestamp / 1000 / 30)));
  const hmac = crypto.createHmac('sha1', decodificarBase32(secret)).update(contador).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const valor = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(valor % 1000000).padStart(6, '0');
}

// O TOTP só vale 30s; usa a hora do servidor do eproc para não depender do relógio do PC.
async function obterDesvioRelogioMs() {
  await verificarIpSaidaEproc();
  try {
    const antes = Date.now();
    const resposta = await fetch(BASE, { method: 'HEAD', signal: AbortSignal.timeout(10000) });
    const depois = Date.now();
    const dataServidor = Date.parse(resposta.headers.get('date'));
    if (Number.isNaN(dataServidor)) return 0;
    // O cabeçalho Date é truncado no segundo; soma 500ms para centralizar.
    const desvio = dataServidor + 500 - (antes + depois) / 2;
    return Math.abs(desvio) > 2000 ? desvio : 0;
  } catch {
    return 0;
  }
}

async function gerarTotpAtual(secret) {
  const desvio = await obterDesvioRelogioMs();
  const agora = () => Date.now() + desvio;
  const segundosRestantes = 30 - (Math.floor(agora() / 1000) % 30);
  if (segundosRestantes <= 4) {
    await new Promise((resolve) => setTimeout(resolve, (segundosRestantes + 1) * 1000));
  }
  return gerarCodigoTotp(secret, agora());
}

async function localizarCampoVisivel(page, seletores) {
  for (const seletor of seletores) {
    const campo = page.locator(seletor).first();
    if (await campo.count() && await campo.isVisible() && await campo.isEnabled()) return campo;
  }
  return null;
}

async function localizarCampoTotp(page) {
  const campos = await page.locator('input').evaluateAll((inputs) => inputs
    .map((input, index) => ({ input, index }))
    .filter(({ input }) => {
      const estilo = window.getComputedStyle(input);
      const retangulo = input.getBoundingClientRect();
      return estilo.display !== 'none' &&
        estilo.visibility !== 'hidden' &&
        retangulo.width > 0 &&
        retangulo.height > 0 &&
        input.type !== 'hidden' &&
        !input.disabled;
    })
    .map(({ input, index }) => ({
      index,
      id: input.id,
      name: input.name,
      type: input.type,
      autocomplete: input.autocomplete,
      aria: input.getAttribute('aria-label') || '',
      placeholder: input.placeholder || '',
      label: Array.from(input.labels || []).map((label) => label.innerText).join(' '),
    })));

  const campo = campos.find((item) =>
    item.autocomplete === 'one-time-code' ||
    /totp|otp|token|c[oó]digo|autentic|verifica|2fa|fator/i.test(`${item.id} ${item.name} ${item.aria} ${item.placeholder} ${item.label}`));
  return campo ? page.locator('input').nth(campo.index) : null;
}

async function enviarFormulario(page) {
  const botao = page.getByRole('button', { name: /continuar|validar|confirmar|entrar|autenticar/i }).first();
  if (await botao.count()) {
    await botao.click();
    return;
  }
  await page.keyboard.press('Enter');
}

function extrairHash(html, acao) {
  const normalizado = html
    .replace(/&amp;|&#0*38;|\\u0026|\\x26|%26/gi, '&')
    .replace(/%3d/gi, '=');
  const expressao = new RegExp(`${acao}[^"'<>]{0,500}?\\bhash=([0-9a-f]{32})`, 'i');
  return expressao.exec(normalizado)?.[1] || null;
}

function redirecionouParaLogin(url) {
  const pagina = new URL(url);
  return (
    pagina.hostname === 'sso.tjto.jus.br' ||
    (pagina.pathname.endsWith('/externo_controlador.php') &&
      pagina.searchParams.get('acao') === 'login')
  );
}

function normalizarOabTeste(entrada) {
  const valor = String(entrada || '').toUpperCase().replace(/[\s.-]/g, '');
  const correspondencia = /^([A-Z]{2})(\d{1,8})$/.exec(valor);
  if (!correspondencia) {
    throw new Error('Configure EPROC_TEST_OAB com uma OAB válida no formato UF + número (ex.: TO002140).');
  }
  return correspondencia[1] + correspondencia[2].padStart(6, '0');
}

async function aguardarCampoVisivel(page, seletores, tempoMs) {
  const limite = Date.now() + tempoMs;
  do {
    const campo = await localizarCampoVisivel(page, seletores).catch(() => null);
    if (campo) return campo;
    await page.waitForTimeout(500);
  } while (Date.now() < limite);
  return null;
}

async function salvarDiagnostico(page) {
  const pasta = path.join(PASTA_CONFIGURACAO, 'diagnostico');
  try {
    fs.mkdirSync(pasta, { recursive: true });
    await page.screenshot({ path: path.join(pasta, 'eproc.png'), fullPage: true });
    const resumo = await page.evaluate(() => ({
      titulo: document.title,
      links: Array.from(document.querySelectorAll('a')).map((a) => `${a.innerText.trim()} -> ${a.getAttribute('href')}`).filter((t) => t.length > 6).slice(0, 80),
      inputs: Array.from(document.querySelectorAll('input,select')).map((i) => `${i.tagName} name=${i.name} id=${i.id} type=${i.type}`).slice(0, 60),
      texto: document.body.innerText.slice(0, 1500),
      tipoPesquisa: (() => {
        const el = document.querySelector('#selTipoPesquisa, select[name="tipoPesquisa"]');
        return el ? { valor: el.value, texto: el.options[el.selectedIndex]?.text, opcoes: Array.from(el.options).map((o) => `${o.value}=${o.text}`) } : null;
      })(),
      campoOab: (() => {
        const el = document.querySelector('#numNumOab');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { display: getComputedStyle(el).display, visibility: getComputedStyle(el).visibility, largura: r.width, desabilitado: el.disabled };
      })(),
    }));
    fs.writeFileSync(path.join(pasta, 'eproc.json'), JSON.stringify({ url: page.url(), ...resumo }, null, 2));
  } catch { /* diagnóstico é opcional */ }
  return pasta;
}

async function selecionarTipoOab(page) {
  const radio = page.locator('input[name="tipoPesquisa"][value="OA"]').first();
  if (await radio.count() && await radio.isVisible() && !await radio.isChecked()) {
    await radio.check();
    return;
  }
  const tipo = page.locator('#selTipoPesquisa, select[name="tipoPesquisa"]').first();
  if (await tipo.count()) {
    const valor = await tipo.evaluate((el) => {
      const o = Array.from(el.options).find((x) => /^\s*OAB\s*$/i.test(x.text));
      return o ? o.value : null;
    });
    if (valor !== null) {
      await tipo.selectOption(valor, { force: true });
      await tipo.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await page.waitForTimeout(500);
      return;
    }
  }
  const selects = page.locator('select:visible');
  const total = await selects.count();
  for (let i = 0; i < total; i += 1) {
    const select = selects.nth(i);
    const opcao = await select.evaluate((el) => {
      const o = Array.from(el.options).find((x) => /oab/i.test(x.text));
      return o ? o.value : null;
    });
    if (opcao !== null) {
      await select.selectOption(opcao);
      await page.waitForLoadState('domcontentloaded').catch(() => null);
      return;
    }
  }
}

async function diagnosticarCamposPesquisa(page) {
  const resumo = await page.evaluate(() => {
    const formulario = document.querySelector('form') || document;
    const textoRotulo = (el) => {
      const associado = el.id ? formulario.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
      const rotulo = associado?.innerText || el.closest('label')?.innerText || '';
      return rotulo.replace(/\s+/g, ' ').trim().slice(0, 80);
    };
    const tipos = Array.from(formulario.querySelectorAll('input[type="radio"], select'))
      .filter((el) => /tipo.?pesquisa/i.test(`${el.name} ${el.id}`))
      .flatMap((el) => {
        if (el.tagName === 'SELECT') {
          return Array.from(el.options).map((opcao) => opcao.textContent.trim()).filter(Boolean);
        }
        return [textoRotulo(el)].filter(Boolean);
      });
    const campos = Array.from(formulario.querySelectorAll('input:not([type="hidden"]), select, textarea'))
      .map((el) => ({
        tipo: el.type || el.tagName.toLowerCase(),
        nome: el.name || el.id || '(sem identificador)',
        rotulo: textoRotulo(el),
      }));
    return { tipos: [...new Set(tipos)], campos };
  });
  process.stdout.write('\nDiagnóstico da tela de pesquisa do eproc (sem valores digitados):\n');
  process.stdout.write(`Tipos de pesquisa: ${resumo.tipos.length ? resumo.tipos.join(', ') : 'não identificados'}\n`);
  for (const campo of resumo.campos) {
    process.stdout.write(`Campo ${campo.tipo} ${campo.nome}${campo.rotulo ? ` — ${campo.rotulo}` : ''}\n`);
  }
  process.stdout.write('\n');
}

async function abrirConsultaOab(page, mostrarDiagnosticoPesquisa = false) {
  let linkOab = page.locator('a[href*="acao=pesquisa_processo_por_num_oab"]').first();
  if (!await linkOab.count()) {
    // O submenu começa oculto; o href (com hash) já está no HTML, então navega direto.
    const linkConsulta = page.locator('a[href*="acao=processo_consultar"][href*="acao_origem=consultar"]').first();
    if (await linkConsulta.count()) {
      const href = await linkConsulta.getAttribute('href');
      if (href && !href.endsWith('#')) {
        await page.goto(new URL(href, page.url()).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
      }
    }
    linkOab = page.locator('a[href*="acao=pesquisa_processo_por_num_oab"]').first();
  }

  if (await linkOab.count()) {
    const href = await linkOab.getAttribute('href');
    if (href) {
      await page.goto(new URL(href, BASE).toString(), { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
  }

  if (mostrarDiagnosticoPesquisa) await diagnosticarCamposPesquisa(page);
  await selecionarTipoOab(page);

  const seletoresOab = ['input[name="numNumOab"]', '#numNumOab', 'input[name*="oab" i]:visible', 'input[id*="oab" i]:visible'];
  const campoOab = await aguardarCampoVisivel(page, seletoresOab, 10000);
  if (!campoOab) {
    const pasta = await salvarDiagnostico(page);
    throw new Error(`Login realizado, mas a tela de consulta não apresentou o campo OAB (página: ${page.url()}). Diagnóstico salvo em ${pasta}.`);
  }
  return campoOab;
}

async function consultarOabParaValidar(page, campoOab, oabTeste) {
  await campoOab.fill(oabTeste);
  const consulta = page.waitForRequest((requisicao) =>
    requisicao.url().includes('acao_ajax=processos_consulta_por_oab'), { timeout: 30000 }).catch(() => null);
  const formulario = campoOab.locator('xpath=ancestor::form[1]');
  const botao = formulario.getByRole('button', { name: /consultar|pesquisar|buscar/i }).first();
  const submit = formulario.locator('input[type="submit"]:visible, button[type="submit"]:visible').first();
  if (await botao.count()) {
    await botao.click();
  } else if (await submit.count()) {
    await submit.click();
  } else {
    await campoOab.press('Enter');
  }

  const requisicao = await consulta;
  if (!requisicao) {
    throw new Error('A consulta de teste da OAB não foi enviada pelo eproc. Verifique a tela de pesquisa e tente novamente.');
  }
  const resposta = await requisicao.response();
  if (!resposta || !resposta.ok()) {
    throw new Error(`A consulta de teste da OAB falhou no eproc${resposta ? ` (HTTP ${resposta.status()})` : ''}.`);
  }
  const conteudoResposta = await resposta.text();
  if (/login|sess[aã]o.*expir/i.test(conteudoResposta) && !/\d{7}-\d{2}\.\d{4}\./.test(conteudoResposta)) {
    throw new Error('O eproc recusou a consulta de teste; a sessão não foi autenticada corretamente.');
  }

  const hashAjax = new URL(requisicao.url()).searchParams.get('hash');
  const referer = (await requisicao.allHeaders()).referer;
  const hashReferer = referer ? new URL(referer).searchParams.get('hash') : null;
  if (!hashAjax || !hashReferer) {
    throw new Error('A consulta de teste foi enviada, mas o eproc não retornou os hashes necessários.');
  }
  return { hashAjax, hashReferer };
}

async function autenticarEproc(cfg, opcoes = {}) {
  await verificarIpSaidaEproc();
  const configLocal = lerConfiguracaoLocal();
  const usuario = configLocal.EPROC_USERNAME;
  const senha = configLocal.EPROC_PASSWORD;
  const segredoTotp = configLocal.EPROC_TOTP_SECRET;
  const oabTeste = normalizarOabTeste(
    opcoes.testOab || configLocal.EPROC_TEST_OAB || cfg.testOab || process.env.EPROC_TEST_OAB,
  );
  if (!usuario || !senha || !segredoTotp) {
    throw new Error('Configure usuário, senha e chave TOTP pelo comando local npm run eproc:configurar.');
  }

  decodificarBase32(segredoTotp);
  const browser = await chromium.launch({ headless: opcoes.headless !== false });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let loginManualAguardado = false;
    const aguardarLoginManual = async () => {
      if (!opcoes.aguardarLoginManual || loginManualAguardado) return;
      loginManualAguardado = true;
      await opcoes.aguardarLoginManual();
    };
    let usarPaginaAtual = false;
    const cookieSalvo = cfg.cookie || process.env.EPROC_COOKIE;
    if (cookieSalvo && await semearSessaoPorCookie(context, page, cookieSalvo)) {
      const campoOabSalvo = await abrirConsultaOab(page, opcoes.mostrarDiagnosticoPesquisa).catch(() => null);
      if (campoOabSalvo) {
        return await finalizarAutenticacao(cfg, context, page, campoOabSalvo, oabTeste);
      }
    }
    await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const campoUsuario = await localizarCampoVisivel(page, [
      '#kc-form-login input[name="username"]:visible',
      '#frmLogin input[name="txtUsuario"]:visible',
      'input[name="username"]:visible',
      'input[name="txtUsuario"]:visible',
    ]);
    if (!campoUsuario) {
      throw new Error('Não foi possível localizar o campo de usuário visível na tela de login do eproc.');
    }
    try {
      await campoUsuario.fill(usuario);
    } catch {
      throw new Error('Não foi possível preencher o campo de usuário do eproc.');
    }

    const campoSenha = await localizarCampoVisivel(page, [
      '#kc-form-login input#password[type="text"]:visible',
      '#kc-form-login input[name="password"]:visible',
      '#frmLogin input#pwdSenha[type="text"]:visible',
      '#frmLogin input[name="pwdSenha"]:visible',
      'input[name="password"]:visible',
      'input[name="pwdSenha"]:visible',
    ]);
    if (!campoSenha) {
      throw new Error('Não foi possível localizar o campo de senha visível na tela de login do eproc.');
    }
    try {
      await campoSenha.fill(senha);
    } catch {
      throw new Error('Não foi possível preencher o campo de senha visível do eproc. Verifique se a tela de login carregou corretamente.');
    }

    const botaoEntrar = await localizarCampoVisivel(page, [
      '#kc-form-login #kc-login:visible',
      '#frmLogin #sbmEntrar:visible',
    ]);
    if (!botaoEntrar) {
      throw new Error('Não foi possível localizar o botão de entrada na tela de login do eproc.');
    }
    await botaoEntrar.click();
    await page.waitForTimeout(1000);

    const campoTotp = await localizarCampoTotp(page);
    if (campoTotp) {
      try {
        await campoTotp.fill(await gerarTotpAtual(segredoTotp));
      } catch {
        throw new Error('Não foi possível preencher o campo de autenticação em dois fatores do eproc.');
      }
      await enviarFormulario(page);
      await page.waitForTimeout(1000);
      const erro2fa = page.getByText(/erro verificando chave|c[oó]digo inv[aá]lido/i).first();
      if (await erro2fa.count() && await erro2fa.isVisible()) {
        throw new Error(
          'O eproc recusou o código 2FA. Confira a chave TOTP configurada e se o relógio do computador está sincronizado.',
        );
      }
    }

    const campoUsuarioLogin = await localizarCampoVisivel(page, [
      '#kc-form-login input[name="username"]:visible',
      '#frmLogin input[name="txtUsuario"]:visible',
      'input[name="username"]:visible',
      'input[name="txtUsuario"]:visible',
    ]);
    if (campoUsuarioLogin) {
      if (!opcoes.aguardarLoginManual) {
        throw new Error('O eproc manteve a tela de login. Verifique usuário, senha, TOTP ou um desafio adicional.');
      }
      await aguardarLoginManual();
      usarPaginaAtual = true;
    }

    if (redirecionouParaLogin(page.url()) && !usarPaginaAtual) {
      throw new Error(
        'O eproc redirecionou para a página pública e encerrou a sessão; o login não foi aceito. ' +
        'Confira usuário, senha e código 2FA no próprio eproc e verifique a data/hora do servidor.',
      );
    }

    if (!usarPaginaAtual && page.url().includes('sso.tjto.jus.br')) {
      throw new Error('O login do eproc não foi concluído no SSO; confira usuário, senha, TOTP ou desafio adicional.');
    }
    const campoOab = await abrirConsultaOab(page, opcoes.mostrarDiagnosticoPesquisa);
    return await finalizarAutenticacao(cfg, context, page, campoOab, oabTeste);
  } finally {
    await browser.close();
  }
}

async function semearSessaoPorCookie(context, page, cookie) {
  const cookies = String(cookie).split(';')
    .map((parte) => parte.trim())
    .filter((parte) => parte.includes('='))
    .map((parte) => {
      const i = parte.indexOf('=');
      return { name: parte.slice(0, i), value: parte.slice(i + 1), url: BASE };
    });
  if (!cookies.length) return false;
  await context.addCookies(cookies);
  await page.goto(URL_BUSCA_OAB, { waitUntil: 'domcontentloaded', timeout: 60000 });
  return !redirecionouParaLogin(page.url());
}

async function finalizarAutenticacao(cfg, context, page, campoOab, oabTeste) {
  {
    const hashesCapturados = await consultarOabParaValidar(page, campoOab, oabTeste);

    const lerHashesPagina = async () => {
      const urlAtual = new URL(page.url());
      const conteudo = await page.content();
      return {
        url: urlAtual,
        refererHash: hashesCapturados.hashReferer
          || urlAtual.searchParams.get('hash')
          || extrairHash(conteudo, 'pesquisa_processo_por_num_oab'),
        ajaxHash: hashesCapturados.hashAjax
          || extrairHash(conteudo, 'processos_consulta_por_oab'),
      };
    };
    let { url: buscaUrl, refererHash, ajaxHash } = await lerHashesPagina();
    if (!refererHash || !ajaxHash) {
      const acao = buscaUrl.searchParams.get('acao') || 'não identificada';
      const titulo = (await page.title()).replace(/[\r\n"]/g, '').slice(0, 80);
      throw new Error(
        `A página de consulta OAB não forneceu os hashes necessários (ação "${acao}", título "${titulo}", ` +
        `hash de referência: ${refererHash ? 'sim' : 'não'}, hash AJAX: ${ajaxHash ? 'sim' : 'não'}). ` +
        'Verifique se a conta chegou à tela inicial autenticada e tente novamente.',
      );
    }

    const cookies = await context.cookies(BASE);
    if (!cookies.length) throw new Error('O eproc não retornou cookies de sessão.');
    const valores = {
      EPROC_COOKIE: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
      EPROC_AJAX_HASH: ajaxHash,
      EPROC_REFERER_HASH: refererHash,
    };
    salvarConfiguracaoLocal(valores);
    Object.assign(process.env, valores);
    Object.assign(cfg, {
      cookie: valores.EPROC_COOKIE,
      ajaxHash: valores.EPROC_AJAX_HASH,
      refererHash: valores.EPROC_REFERER_HASH,
    });
    return valores;
  }
}

module.exports = {
  autenticarEproc,
  enviarFormulario,
  gerarTotpAtual,
  lerConfiguracaoLocal,
  localizarCampoTotp,
  localizarCampoVisivel,
  gerarCodigoTotp,
  loginEprocConfigurado,
  reutilizarSessaoEproc,
  salvarConfiguracaoLocal,
  ARQUIVO_CREDENCIAIS,
};
