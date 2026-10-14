const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  cyan: '\u001b[36m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  magenta: '\u001b[35m',
};

const coresAtivas = Boolean(process.stdout.isTTY && !process.env.NO_COLOR);
const nivelDebug = process.env.BOT_LOG_LEVEL === 'debug';
let logsSignalSuprimidos = false;

function colorir(cor, texto) {
  return coresAtivas ? `${ANSI[cor]}${texto}${ANSI.reset}` : texto;
}

function horario() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

function imprimir(nivel, icone, cor, mensagem) {
  const linha = `${colorir('dim', horario())}  ${colorir(cor, icone)}  ${mensagem}`;
  process.stdout.write(`${linha}\n`);
}

function erro(nome, err) {
  const tipo = err instanceof Error ? err.name : typeof err === 'string' ? 'Erro' : 'Falha';
  const detalhe = err instanceof Error
    ? err.message.split(/\r?\n/, 1)[0].replace(/https?:\/\/\S+/g, '[URL]').slice(0, 180)
    : typeof err === 'string' ? err.split(/\r?\n/, 1)[0].slice(0, 180) : '';
  const sufixo = detalhe ? `: ${detalhe}` : '';
  imprimir('error', '✖', 'red', `${nome} ${colorir('dim', `(${tipo})${sufixo}`)}`);
}

function faixa(titulo = 'BOT WHATSAPP · EPROC TJTO') {
  const borda = '═'.repeat(52);
  process.stdout.write(`\n${colorir('cyan', `╔${borda}╗`)}\n`);
  process.stdout.write(`${colorir('cyan', '║')}  ${colorir('bold', titulo.padEnd(50))}${colorir('cyan', '║')}\n`);
  process.stdout.write(`${colorir('cyan', `╚${borda}╝`)}\n`);
}

function silenciarDiagnosticosSignalRepetitivos() {
  if (logsSignalSuprimidos || nivelDebug) return;
  logsSignalSuprimidos = true;

  const padroesIgnorados = [
    /^Failed to decrypt message with any known session/,
    /^Session error:/,
    /^Closing open session in favor of incoming prekey bundle/,
    /^Closing session:/,
  ];

  for (const metodo of ['error', 'warn', 'info']) {
    const original = console[metodo].bind(console);
    console[metodo] = (...argumentos) => {
      const inicio = typeof argumentos[0] === 'string' ? argumentos[0] : '';
      if (padroesIgnorados.some((padrao) => padrao.test(inicio))) return;
      original(...argumentos);
    };
  }
}

module.exports = {
  info: (mensagem) => imprimir('info', '●', 'cyan', mensagem),
  success: (mensagem) => imprimir('success', '✔', 'green', mensagem),
  warn: (mensagem) => imprimir('warn', '▲', 'yellow', mensagem),
  error: erro,
  debug: (mensagem) => {
    if (nivelDebug) imprimir('debug', '·', 'magenta', mensagem);
  },
  faixa,
  silenciarDiagnosticosSignalRepetitivos,
};
