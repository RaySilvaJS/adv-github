// Abre o eproc num Chrome visível, faz o login sozinho e mantém a sessão ativa até você fechar a janela.
// Uso: node scripts/manter-sessao-eproc.js
// Faz o login dentro da própria janela, com os mesmos campos e seletores do bot (usuário, senha e TOTP salvos
// por "npm run eproc:configurar"). Não lê nem grava a sessão do bot. Se o eproc deslogar, entra de novo sozinho.
// Se pedir algo extra (captcha, desafio), conclua na própria janela.

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  ARQUIVO_CREDENCIAIS, enviarFormulario, gerarTotpAtual, lerConfiguracaoLocal, localizarCampoTotp, localizarCampoVisivel,
} = require('../src/loginEproc');

const BASE = 'https://eproc1.tjto.jus.br/eprocV2_prod_1grau';
const URL_LOGIN = `${BASE}/externo_controlador.php?acao=login`;
const INTERVALO_MS = Number.parseInt(process.env.INTERVALO_MS || String(4 * 60 * 1000), 10);
const PERFIL = path.join(path.dirname(ARQUIVO_CREDENCIAIS), 'perfil-manter-sessao');

const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));
const hora = () => new Date().toLocaleTimeString('pt-BR');

function naTelaDeLogin(url) {
  const u = new URL(url);
  return u.hostname === 'sso.tjto.jus.br' || (u.pathname.endsWith('/externo_controlador.php') && u.searchParams.get('acao') === 'login');
}

async function entrar(page) {
  const config = lerConfiguracaoLocal();
  if (!config.EPROC_USERNAME || !config.EPROC_PASSWORD || !config.EPROC_TOTP_SECRET) {
    throw new Error('Credenciais não encontradas. Rode antes: npm run eproc:configurar');
  }

  await page.goto(URL_LOGIN, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1500);

  const campoUsuario = await localizarCampoVisivel(page, [
    '#kc-form-login input[name="username"]:visible',
    '#frmLogin input[name="txtUsuario"]:visible',
    'input[name="username"]:visible',
    'input[name="txtUsuario"]:visible',
  ]);
  if (!campoUsuario) return; // a janela já está logada (o perfil guarda a sessão)

  await campoUsuario.fill(config.EPROC_USERNAME);
  const campoSenha = await localizarCampoVisivel(page, [
    '#kc-form-login input#password[type="text"]:visible',
    '#kc-form-login input[name="password"]:visible',
    '#frmLogin input#pwdSenha[type="text"]:visible',
    '#frmLogin input[name="pwdSenha"]:visible',
    'input[name="password"]:visible',
    'input[name="pwdSenha"]:visible',
  ]);
  if (!campoSenha) throw new Error('não encontrei o campo de senha na tela de login');
  await campoSenha.fill(config.EPROC_PASSWORD);

  const botaoEntrar = await localizarCampoVisivel(page, [
    '#kc-form-login #kc-login:visible',
    '#frmLogin #sbmEntrar:visible',
  ]);
  if (!botaoEntrar) throw new Error('não encontrei o botão de entrar');
  await botaoEntrar.click();
  await page.waitForTimeout(1000);

  const campoTotp = await localizarCampoTotp(page);
  if (campoTotp) {
    await campoTotp.fill(await gerarTotpAtual(config.EPROC_TOTP_SECRET));
    await enviarFormulario(page);
    await page.waitForTimeout(2000);
  }
}

async function main() {
  fs.mkdirSync(PERFIL, { recursive: true });
  const context = await chromium.launchPersistentContext(PERFIL, { headless: false, viewport: null });
  const page = context.pages()[0] || await context.newPage();

  let aberto = true;
  context.on('close', () => { aberto = false; });

  console.log(`[${hora()}] Entrando no eproc...`);
  try {
    await entrar(page);
    console.log(`[${hora()}] Pronto. Mantendo a sessão ativa (a cada ${Math.round(INTERVALO_MS / 60000)} min). Feche a janela para encerrar.`);
  } catch (erro) {
    if (aberto) console.error(`Falha no login automático: ${erro.message}. Conclua o login na janela.`);
  }

  while (aberto) {
    await pausa(INTERVALO_MS);
    if (!aberto) break;
    try {
      // Requisição em segundo plano pelo próprio navegador: renova a sessão sem recarregar a página que você está vendo.
      const urlFinal = await page.evaluate(async () => {
        const r = await fetch(location.href, { credentials: 'include', redirect: 'follow' });
        return r.url;
      });
      if (naTelaDeLogin(urlFinal)) {
        console.log(`[${hora()}] Sessão caiu. Entrando de novo...`);
        await entrar(page);
      } else {
        console.log(`[${hora()}] Sessão ativa.`);
      }
    } catch (erro) {
      if (!aberto) break;
      console.log(`[${hora()}] Não consegui renovar (${erro.message.split('\n')[0]}).`);
    }
  }
  console.log(`[${hora()}] Janela fechada. Encerrado.`);
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
