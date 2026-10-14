const { spawn } = require('child_process');
const path = require('path');
const log = require('./logger');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO_BOT = path.join(__dirname, 'index.js');
const CODIGO_REINICIO_ATUALIZACAO = 75;
const ATRASO_INICIAL_MS = 5000;
const ATRASO_MAXIMO_MS = 60000;
const TEMPO_ESTAVEL_MS = 120000;

function iniciarSupervisor(arquivoBot = ARQUIVO_BOT) {
  let processoBot = null;
  let temporizadorReinicio = null;
  let encerrando = false;
  let atrasoAtualMs = ATRASO_INICIAL_MS;

  function iniciarBot() {
    if (encerrando) return;
    const iniciadoEm = Date.now();
    log.info('Iniciando o serviço do bot');
    processoBot = spawn(process.execPath, [arquivoBot], {
      cwd: RAIZ,
      stdio: 'inherit',
      windowsHide: true,
    });

    processoBot.once('error', (erro) => {
      log.error('Não foi possível iniciar o serviço do bot', erro);
    });

    processoBot.once('close', (codigo, sinal) => {
      processoBot = null;
      if (encerrando) return;

      if (Date.now() - iniciadoEm >= TEMPO_ESTAVEL_MS) {
        atrasoAtualMs = ATRASO_INICIAL_MS;
      }
      const atraso = codigo === CODIGO_REINICIO_ATUALIZACAO ? 1000 : atrasoAtualMs;
      const motivo = codigo === CODIGO_REINICIO_ATUALIZACAO
        ? 'atualização aplicada'
        : `processo encerrado${sinal ? ` (${sinal})` : ''}`;
      log.warn(`${motivo}; reinício em ${Math.ceil(atraso / 1000)}s`);
      temporizadorReinicio = setTimeout(iniciarBot, atraso);
      if (codigo !== CODIGO_REINICIO_ATUALIZACAO) {
        atrasoAtualMs = Math.min(atrasoAtualMs * 2, ATRASO_MAXIMO_MS);
      }
    });
  }

  function encerrar(sinal) {
    if (encerrando) return;
    encerrando = true;
    if (temporizadorReinicio) clearTimeout(temporizadorReinicio);
    if (!processoBot) {
      process.exit(0);
      return;
    }

    log.info(`Encerramento solicitado (${sinal})`);
    processoBot.kill(sinal);
    const temporizadorForcado = setTimeout(() => {
      if (processoBot) processoBot.kill('SIGKILL');
    }, 10000);
    temporizadorForcado.unref();
  }

  process.once('SIGINT', () => encerrar('SIGINT'));
  process.once('SIGTERM', () => encerrar('SIGTERM'));
  iniciarBot();
  return encerrar;
}

if (require.main === module) iniciarSupervisor();

module.exports = { iniciarSupervisor };
