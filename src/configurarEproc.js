const readline = require('readline');
require('dotenv').config();
const {
  autenticarEproc,
  loginEprocConfigurado,
  salvarConfiguracaoLocal,
} = require('./loginEproc');
const { capturarIpSaidaInicial } = require('./ipEgress');
const log = require('./logger');

function perguntarOculto(rotulo) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return Promise.reject(new Error('Execute este comando em um terminal interativo para ocultar os segredos digitados.'));
  }

  process.stdout.write(rotulo);
  return new Promise((resolve, reject) => {
    let valor = '';
    const entrada = process.stdin;

    function limpar() {
      entrada.removeListener('data', aoDigitar);
      entrada.setRawMode(false);
      entrada.pause();
      process.stdout.write('\n');
    }

    function aoDigitar(teclas) {
      for (const tecla of teclas) {
        if (tecla === '\u0003') {
          limpar();
          reject(new Error('Configuração cancelada.'));
          return;
        }
        if (tecla === '\r' || tecla === '\n') {
          limpar();
          resolve(valor);
          return;
        }
        if (tecla === '\u0008' || tecla === '\u007f') {
          valor = valor.slice(0, -1);
          continue;
        }
        if (tecla >= ' ') valor += tecla;
      }
    }

    entrada.setRawMode(true);
    entrada.setEncoding('utf8');
    entrada.resume();
    entrada.on('data', aoDigitar);
  });
}

function perguntarOabTeste() {
  const interfaceLeitura = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    interfaceLeitura.question(
      `OAB autorizada para a consulta de teste (ex.: TO002140)${process.env.OAB_PADRAO ? ` [${process.env.OAB_PADRAO}]` : ''}: `,
      (resposta) => {
        interfaceLeitura.close();
        resolve(resposta.trim() || process.env.OAB_PADRAO || '');
      },
    );
  });
}

function aguardarLoginManual() {
  const interfaceLeitura = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    interfaceLeitura.question(
      'Na janela do Chromium, conclua o login/2FA. Quando estiver autenticado, pressione Enter aqui: ',
      () => {
        interfaceLeitura.close();
        resolve();
      },
    );
  });
}

async function autenticarNoNavegador(testOab) {
  const ipSaida = await capturarIpSaidaInicial();
  log.info(`IP público de saída detectado para a sessão do eproc: ${ipSaida}`);
  return autenticarEproc({}, {
    headless: false,
    aguardarLoginManual,
    testOab,
    mostrarDiagnosticoPesquisa: true,
  });
}

async function configurarOabTeste() {
  const testOab = await perguntarOabTeste();
  if (!/^[A-Z]{2}\s*\d{1,8}$/i.test(testOab)) {
    throw new Error('Informe a OAB de teste no formato UF + número, por exemplo TO002140.');
  }
  const valor = testOab.toUpperCase().replace(/\s/g, '');
  salvarConfiguracaoLocal({ EPROC_TEST_OAB: valor });
  process.env.EPROC_TEST_OAB = valor;
  return valor;
}

async function main() {
  log.faixa('CONFIGURADOR DE LOGIN · EPROC');
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Execute este comando em um terminal interativo para ocultar os segredos digitados.');
  }
  if (loginEprocConfigurado()) {
    const testOab = await configurarOabTeste();
    await autenticarNoNavegador(testOab);
    log.success('Login e sessão do eproc configurados');
    return;
  }

  const interfaceLeitura = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const usuario = await new Promise((resolve) => interfaceLeitura.question('Usuário eproc (ex.: TO001234): ', resolve));
    interfaceLeitura.close();
    const senha = await perguntarOculto('Senha eproc (não será exibida): ');
    const segredoTotp = await perguntarOculto('Chave TOTP Base32 (não será exibida): ');
    if (!usuario.trim() || !senha || !segredoTotp) throw new Error('Usuário, senha e chave TOTP são obrigatórios.');
    const testOab = await configurarOabTeste();

    const valores = {
      EPROC_USERNAME: usuario.trim(),
      EPROC_PASSWORD: senha,
      EPROC_TOTP_SECRET: segredoTotp.replace(/\s/g, ''),
    };
    salvarConfiguracaoLocal(valores);
    Object.assign(process.env, valores);
    await autenticarNoNavegador(testOab);
    log.success('Login e sessão do eproc configurados');
  } finally {
    interfaceLeitura.close();
  }
}

main().catch((erro) => {
  log.error('Falha ao configurar o login do eproc', erro);
  process.exitCode = 1;
});
