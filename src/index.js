require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  autenticarEproc,
  loginEprocConfigurado,
  reutilizarSessaoEproc,
  ARQUIVO_CREDENCIAIS,
} = require('./loginEproc');
require('dotenv').config({ path: ARQUIVO_CREDENCIAIS, override: true });
const { execFile } = require('child_process');
const { promisify } = require('util');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const { consultarPorOab, buscarDetalhes, sessaoExpirou } = require('./eproc');
const { formatarResposta, parseResposta, formatarCnj } = require('./formatar');
const { localizarProcesso, gerarFormularioPdf, soDigitos } = require('./pdf');
const { salvarConsulta, salvarPastaAdvogado } = require('./armazenar');
const { carregarOabLocal, detalheCompleto } = require('./dadosLocais');
const { consultarPartes, tratarMensagemDoGrupo, definirGrupoConsultas, grupoConsultasAtual, diagnosticarGrupo, definirNumeroSistema, numeroSistema } = require('./consultaGrupo');
const { criarVerificadorGrupo, mensagemPodeAtualizarNoPrivado, normalizarNumeroWhatsApp } = require('./commandAccess');
const { capturarIpSaidaInicial, localizarIpPublico } = require('./ipEgress');
const log = require('./logger');
log.silenciarDiagnosticosSignalRepetitivos();

const executarArquivo = promisify(execFile);
const cfg = {
  cookie: process.env.EPROC_COOKIE,
  ajaxHash: process.env.EPROC_AJAX_HASH,
  refererHash: process.env.EPROC_REFERER_HASH,
  testOab: process.env.EPROC_TEST_OAB || process.env.OAB_PADRAO,
  userAgent: process.env.EPROC_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
};
const UF_PADRAO = process.env.UF_PADRAO || 'TO';

// Converte "TO2140", "TO 2140", "2140/TO", "2140" em "TO002140" (UF + 6 dígitos).
function normalizarOab(entrada) {
  if (!entrada) return null;
  const s = entrada.toUpperCase().replace(/[.\-\s]/g, '');
  const uf = (s.match(/[A-Z]{2}/) || [UF_PADRAO])[0];
  const num = (s.match(/\d{1,6}/) || [])[0];
  return num ? uf + num.padStart(6, '0') : null;
}

const PASTA_AUTENTICACAO = path.join(__dirname, '..', '.baileys_auth');
const mensagensProcessadas = new Set();
const TAMANHO_PAGINA = 1;
// Processos por lote: ao fim de cada lote a consulta pausa e a pessoa pede os próximos com /mais.
const LOTE_PROCESSOS = Number(process.env.LOTE_PROCESSOS) || 30;
const sessoes = new Map(); // chat + pessoa -> { oab, lista, proximo, fimLote, detalhes, novos }
// Uma puxada (lote de /oab ou /mais) por vez no bot inteiro. Quem pedir enquanto outra roda entra na fila
// e é chamado quando o lote atual termina.
const filaPuxadas = [];
let puxadaAtual = null;

// Até onde cada pessoa chegou em cada OAB, gravado em disco: mandar o mesmo /oab continua de onde parou,
// mesmo depois de o bot reiniciar. Fica guardado para sempre: só "/oab X reiniciar" (ou apagar o arquivo) zera.
const ARQUIVO_PROGRESSO = path.join(__dirname, '..', 'dados', 'progresso-oab.json');
const CHAVE_PROGRESSO_GLOBAL = '__oab_global__|';

function lerProgresso() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO_PROGRESSO, 'utf8')); } catch { return {}; }
}

function salvarProgresso(chave, oab, proximo, total, { autor, quem, processo } = {}) {
  const todos = lerProgresso();
  const em = new Date().toISOString();
  todos[`${chave}|${oab}`] = { oab, proximo, total, em };
  todos[`${CHAVE_PROGRESSO_GLOBAL}${oab}`] = {
    oab,
    proximo,
    total,
    em,
    quem: quem || 'Nome indisponível',
    autor: jidSemDispositivo(autor || ''),
    numero: /@(?:s\.whatsapp\.net|c\.us)$/i.test(autor || '') ? numeroDoJid(autor) : '',
    processo: processo || null,
  };
  try {
    fs.mkdirSync(path.dirname(ARQUIVO_PROGRESSO), { recursive: true });
    fs.writeFileSync(ARQUIVO_PROGRESSO, JSON.stringify(todos, null, 2), 'utf8');
  } catch (e) {
    log.warn(`Não consegui salvar o progresso da OAB ${oab}: ${e.message}`);
  }
}

function progressoSalvo(chave, oab) {
  return lerProgresso()[`${chave}|${oab}`] || null;
}

function progressoGlobalOab(oab) {
  return lerProgresso()[`${CHAVE_PROGRESSO_GLOBAL}${oab}`] || null;
}

function mesmoAutor(progresso, autor) {
  if (!progresso?.autor || !autor) return false;
  const numeroAtual = /@(?:s\.whatsapp\.net|c\.us)$/i.test(autor) ? numeroDoJid(autor) : '';
  if (progresso.numero && numeroAtual) return progresso.numero === numeroAtual;
  return jidSemDispositivo(progresso.autor) === jidSemDispositivo(autor);
}

// OAB mais recente que a pessoa consultou e ainda não terminou (para o /mais depois de um reinício).
function ultimaOabPendente(chave) {
  return Object.entries(lerProgresso())
    .filter(([k, v]) => k.startsWith(`${chave}|`) && v.proximo < v.total)
    .sort((a, b) => Date.parse(b[1].em) - Date.parse(a[1].em))[0]?.[1].oab || null;
}
const verificadoresGrupoComandos = new WeakMap();

function grupoPodeUsarComandos(sock, chatId) {
  let verificarGrupo = verificadoresGrupoComandos.get(sock);
  if (!verificarGrupo) {
    verificarGrupo = criarVerificadorGrupo(sock);
    verificadoresGrupoComandos.set(sock, verificarGrupo);
  }
  return verificarGrupo(chatId);
}

// Estado da conexão. Após uma reconexão o socket antigo morre; quem envia usa sempre o socket atual.
let sockAtual = null;
let conectado = false;
let avisoInicialEnviado = false;
const statusInicializacao = { ip: null, localizacao: null };
let desconectadoDesde = Date.now();
let sessaoEncerrada = false;
let tentativasReconexao = 0;
let reconexaoAgendada = null;
const TEMPO_LIMITE_ENVIO_MS = 60000;
const RECONEXAO_FORCADA_MS = 5 * 60 * 1000;

// Mensagens enviadas recentemente: o WhatsApp pede para reenviar quando o destinatário não conseguiu decifrar
// (fica "Aguardando mensagem"). Sem isso o reenvio falha e a resposta nunca aparece.
const mensagensEnviadas = new Map();
function guardarEnviada(r) {
  if (!r?.key?.id || !r.message) return;
  mensagensEnviadas.set(r.key.id, r.message);
  if (mensagensEnviadas.size > 500) mensagensEnviadas.delete(mensagensEnviadas.keys().next().value);
}
const contadorTentativas = new Map();
const msgRetryCounterCache = {
  get: (k) => contadorTentativas.get(k),
  set: (k, v) => {
    contadorTentativas.set(k, v);
    if (contadorTentativas.size > 1000) contadorTentativas.delete(contadorTentativas.keys().next().value);
    return true;
  },
  del: (k) => contadorTentativas.delete(k),
  flushAll: () => contadorTentativas.clear(),
};

// Dados dos grupos (lista de participantes) em memória. Sem isso o Baileys busca o grupo inteiro no WhatsApp
// a cada mensagem enviada, o que atrasa cada /cpf num grupo grande.
const metadadosGrupos = new Map(); // jid -> { meta, em }
const VALIDADE_METADADOS_MS = 10 * 60 * 1000;
async function metadadosDoGrupo(jid) {
  const guardado = metadadosGrupos.get(jid);
  if (guardado && Date.now() - guardado.em < VALIDADE_METADADOS_MS) return guardado.meta;
  try {
    const meta = await sockAtual.groupMetadata(jid);
    metadadosGrupos.set(jid, { meta, em: Date.now() });
    return meta;
  } catch {
    return undefined; // o Baileys busca por conta própria
  }
}

function comTempoLimite(promessa, ms, mensagem) {
  let timer;
  const limite = new Promise((_, rejeitar) => { timer = setTimeout(() => rejeitar(new Error(mensagem)), ms); });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

// Espera o WhatsApp voltar a ficar conectado (após uma queda) antes de enviar.
async function aguardarConexao(ms = 120000) {
  const fim = Date.now() + ms;
  while (!(conectado && sockAtual)) {
    if (Date.now() > fim) throw new Error('WhatsApp desconectado');
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  return sockAtual;
}

// Fila de envio: no máximo 1 mensagem por ~1,2 s e novas tentativas quando o WhatsApp responde "rate-overlimit" (429)
// ou a conexão cai no meio. Cada envio tem tempo limite, para um envio travado não bloquear a fila para sempre.
let filaEnvio = Promise.resolve();
function enviarComEspera(_sock, chatId, conteudo) {
  const tarefa = filaEnvio.then(async () => {
    for (let tentativa = 1; ; tentativa++) {
      try {
        const sock = await aguardarConexao();
        const inicio = Date.now();
        const r = await comTempoLimite(sock.sendMessage(chatId, conteudo), TEMPO_LIMITE_ENVIO_MS, 'Tempo esgotado ao enviar mensagem');
        guardarEnviada(r);
        registrarEnvioConsulta(r, conteudo, inicio);
        await new Promise((ok) => setTimeout(ok, 1200));
        return r;
      } catch (e) {
        const texto = `${e.message} ${e.data}`;
        const limite = /rate-overlimit|429/i.test(texto);
        const queda = /connection (closed|lost)|tempo esgotado|timed out|stream errored|desconectado/i.test(texto);
        if ((!limite && !queda) || tentativa >= 4) throw e;
        const espera = 5000 * tentativa;
        log.warn(`${limite ? 'Limite do WhatsApp' : `Falha de conexão ao enviar (${e.message})`}; nova tentativa em ${espera / 1000}s`);
        await new Promise((ok) => setTimeout(ok, espera));
      }
    }
  });
  filaEnvio = tarefa.catch(() => {});
  return tarefa;
}

function numeroDoJid(jid = '') {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function jidSemDispositivo(jid = '') {
  return jid.replace(/:\d+(?=@)/, '').toLowerCase();
}

async function enviarAvisoInicial(sock) {
  if (avisoInicialEnviado) return;
  const numeroAutorizado = normalizarNumeroWhatsApp(process.env.NUMERO_AUTORIZADO_COMANDOS || '');
  if (!numeroAutorizado) {
    log.warn('Aviso de inicialização não enviado: NUMERO_AUTORIZADO_COMANDOS ausente ou inválido');
    return;
  }

  avisoInicialEnviado = true;
  const localizacao = statusInicializacao.localizacao;
  const lugar = localizacao
    ? [localizacao.cidade, localizacao.regiao, localizacao.pais].filter(Boolean).join(', ')
    : 'indisponível';
  const detalhesLocalizacao = localizacao
    ? [localizacao.provedor, localizacao.fuso].filter(Boolean).join(' · ')
    : '';
  const linhas = [
    '🤖 *BOT EPROC TJTO*',
    '',
    '✅ *Status:* conectado e pronto',
    '',
    '🌐 *Conexão*',
    `• IP de saída: ${statusInicializacao.ip || 'não identificado'}`,
    `• Localização aproximada: ${lugar}`,
  ];
  if (detalhesLocalizacao) linhas.push(`• Provedor / fuso: ${detalhesLocalizacao}`);

  try {
    const grupo = grupoConsultasAtual();
    let idGrupo = grupo.id;
    let falhaLocalizarGrupo = null;
    if (!idGrupo && grupo.convite) {
      try {
        const info = await comTempoLimite(
          sock.groupGetInviteInfo(grupo.convite),
          15000,
          'tempo esgotado ao localizar o grupo de consultas',
        );
        idGrupo = info?.id;
      } catch (erro) {
        falhaLocalizarGrupo = erro.message;
      }
    }
    if (!idGrupo) {
      linhas.push(
        '',
        '👥 *Grupo de consultas*',
        `⚠️ ${falhaLocalizarGrupo ? `Não foi possível localizar: ${falhaLocalizarGrupo}` : 'Não configurado ou não localizado.'}`,
      );
    } else {
      try {
        const meta = await comTempoLimite(
          sock.groupMetadata(idGrupo),
          15000,
          'tempo esgotado ao consultar o grupo de consultas',
        );
        const meusJids = [sock.user?.id, sock.user?.lid].filter(Boolean).map(jidSemDispositivo);
        const meusNumeros = [sock.user?.id, sock.user?.lid]
          .map((jid) => normalizarNumeroWhatsApp(jid || ''))
          .filter(Boolean);
        const eu = meta.participants.find((participante) => {
          const jids = [participante.id, participante.lid].filter(Boolean).map(jidSemDispositivo);
          const numeros = [participante.id, participante.lid, participante.phoneNumber]
            .map((jid) => normalizarNumeroWhatsApp(jid || ''))
            .filter(Boolean);
          return jids.some((jid) => meusJids.includes(jid)) ||
            numeros.some((numero) => meusNumeros.includes(numero));
        });
        const status = !eu ? '❌ Bot não encontrado no grupo' : eu.admin
          ? '✅ Bot está no grupo como administrador'
          : '⚠️ Bot está no grupo como participante (não administrador)';
        linhas.push(
          '',
          '👥 *Grupo de consultas*',
          `• Grupo: ${meta.subject || grupo.nome || idGrupo}`,
          status,
        );
      } catch (erro) {
        linhas.push(
          '',
          '👥 *Grupo de consultas*',
          `⚠️ Não foi possível verificar: ${erro.message}`,
        );
      }
    }

    await enviarComEspera(sock, `${numeroAutorizado}@s.whatsapp.net`, { text: linhas.join('\n') });
    log.success('Aviso de inicialização enviado ao número autorizado');
  } catch (erro) {
    avisoInicialEnviado = false;
    log.error('Falha ao enviar o aviso de inicialização', erro);
  }
}

// Quem mandou o comando: no grupo é o participante; no privado, o próprio chat (ou o bot, se foi ele).
// O WhatsApp identifica a mesma pessoa ora pelo telefone, ora por um id interno (@lid); o telefone vem primeiro
// para que o /oab e o /mais da mesma pessoa caiam na mesma consulta.
function autorDaMensagem(mensagem, sock) {
  const k = mensagem.key;
  return k.participantPn || k.senderPn || k.participant || (k.fromMe ? sock.user?.id : k.remoteJid) || k.remoteJid;
}

// Cada pessoa tem a sua consulta, mesmo no mesmo grupo.
function chaveSessao(chatId, autor) {
  return `${chatId}|${jidSemDispositivo(autor)}`;
}

function ehJidProprio(jid, sock) {
  if (!jid) return false;
  const meusJids = [sock.user?.id, sock.user?.lid].filter(Boolean);
  return meusJids.some((meuJid) => {
    if (jidSemDispositivo(jid) === jidSemDispositivo(meuJid)) return true;
    return jid.endsWith('@s.whatsapp.net') &&
      meuJid.endsWith('@s.whatsapp.net') &&
      numeroDoJid(jid) === numeroDoJid(meuJid);
  });
}

function extrairTexto(mensagem, normalizarConteudo) {
  const conteudo = normalizarConteudo(mensagem.message);
  // Além de texto comum, lê formatos que bots de consulta usam: botões, modelos e mensagens interativas.
  return (
    conteudo?.conversation ||
    conteudo?.extendedTextMessage?.text ||
    conteudo?.imageMessage?.caption ||
    conteudo?.videoMessage?.caption ||
    conteudo?.documentMessage?.caption ||
    conteudo?.buttonsMessage?.contentText ||
    conteudo?.templateMessage?.hydratedTemplate?.hydratedContentText ||
    conteudo?.templateMessage?.hydratedFourRowTemplate?.hydratedContentText ||
    conteudo?.interactiveMessage?.body?.text ||
    conteudo?.listMessage?.description ||
    ''
  ).trim();
}

function descreverOrigem(mensagem) {
  const chat = mensagem.key.remoteJid || '?';
  const autor = mensagem.key.participantPn || mensagem.key.participant || mensagem.key.senderPn || (mensagem.key.fromMe ? 'o próprio bot' : chat);
  return `${numeroDoJid(autor) || autor} em ${chat.endsWith('@g.us') ? `grupo ${chat}` : 'privado'}`;
}

async function processarMensagem(sock, mensagem, normalizarConteudo) {
  const texto = extrairTexto(mensagem, normalizarConteudo);
  // Só comandos entram no log; conversa comum e os /cpf e /cnpj que o próprio bot envia ao grupo são ignorados em silêncio.
  if (!texto.startsWith('/')) return;
  const chatId = mensagem.key.remoteJid;
  if (!chatId || chatId === 'status@broadcast') return;
  const emGrupo = chatId.endsWith('@g.us');
  if (mensagem.key.fromMe && emGrupo && /^\/(cpf|cnpj)\b/i.test(texto)) return;
  // No privado, só o número autorizado (NUMERO_AUTORIZADO_COMANDOS) usa comandos, e pode usar todos;
  // as respostas vão para o próprio privado.
  const autorizadoNoPrivado = !emGrupo && mensagemPodeAtualizarNoPrivado(mensagem, sock);
  if (emGrupo) {
    let permitidoNoGrupo;
    try {
      permitidoNoGrupo = await grupoPodeUsarComandos(sock, chatId);
    } catch (erro) {
      log.error('Falha ao validar o grupo autorizado', erro);
      return;
    }
    if (!permitidoNoGrupo) {
      log.debug(`Comando ignorado: o grupo ${chatId} não é o grupo autorizado (GRUPO_COMANDOS_CONVITE)`);
      return;
    }
  } else if (!autorizadoNoPrivado) {
    log.warn('Comando privado ignorado; no privado só o número autorizado pode usar comandos');
    return;
  }

  const responder = (t) => enviarComEspera(sock, chatId, { text: t });
  log.info(`Comando de ${descreverOrigem(mensagem)}: ${texto.slice(0, 60)}`);

  if (/^\/atualizar$/i.test(texto)) {
    await responder('⏳ Atualizando o repositório com `git pull --ff-only`...');
    try {
      const { stdout } = await executarArquivo(
        'bash',
        ['-lc', 'git pull --ff-only'],
        { cwd: path.join(__dirname, '..'), timeout: 120000, windowsHide: true },
      );
      const resultado = stdout.trim();
      await responder(`✅ Repositório atualizado via Bash.${resultado ? `\n${resultado.slice(0, 2500)}` : ''}\nReiniciando o bot para aplicar as alterações.`);
      process.exit(75);
    } catch (e) {
      log.error('Falha ao atualizar o repositório', e);
      return responder('❌ Não foi possível atualizar o repositório. Verifique se o Bash está instalado, se há conexão com o Git remoto e se não existem alterações locais conflitantes.');
    }
  }

  // /backup: compacta as pastas dados e .baileys_auth e envia o arquivo no privado. Só o número autorizado e só no
  // privado, porque .baileys_auth é a sessão do WhatsApp: quem tiver esse arquivo entra como o bot.
  if (/^\/backup$/i.test(texto)) {
    if (emGrupo || !mensagemPodeAtualizarNoPrivado(mensagem, sock)) return responder('🔒 O /backup só funciona no privado do número autorizado.');
    await responder('⏳ Gerando o backup de dados e .baileys_auth...');
    const raiz = path.join(__dirname, '..');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(),'backup-bot-'));
    const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const nome = `backup-bot-${carimbo}.tar.gz`;
    try {
      // Copia antes de compactar: com o bot ligado os arquivos mudam a todo momento e o tar falharia no meio.
      const pastas = ['dados', '.baileys_auth'].filter((p) => fs.existsSync(path.join(raiz, p)));
      for (const p of pastas) fs.cpSync(path.join(raiz, p), path.join(temp, p), { recursive: true });
      const arquivo = path.join(temp, nome);
      // Caminhos relativos: o tar do Git Bash lê "C:\..." como host remoto.
      await executarArquivo('tar', ['-czf', nome, ...pastas], { cwd: temp, timeout: 120000, windowsHide: true });
      const tamanho = (fs.statSync(arquivo).size / 1024).toFixed(0);
      await enviarComEspera(sock, chatId, {
        document: fs.readFileSync(arquivo),
        mimetype: 'application/gzip',
        fileName: nome,
        caption: `📦 Backup de ${pastas.join(' e ')} (${tamanho} KB).\n⚠️ .baileys_auth é a sessão do WhatsApp: não repasse este arquivo.`,
      });
    } catch (e) {
      log.error('Falha ao gerar o backup', e);
      await responder(`❌ Não consegui gerar o backup: ${e.message}`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
    return;
  }

  // /grupo [link]: mostra ou troca o grupo onde o bot consulta /cpf e /cnpj. Só o número autorizado.
  const g = texto.match(/^\/grupo(?:\s+(.+))?$/i);
  if (g) {
    if (!mensagemPodeAtualizarNoPrivado(mensagem, sock)) return responder('🔒 Somente o número autorizado pode alterar o grupo de consultas.');
    if (/^teste$/i.test(g[1] || '')) {
      await responder('🔧 Testando o grupo de consultas...');
      const linhas = await diagnosticarGrupo(sock);
      return responder(linhas.join('\n'));
    }
    if (!g[1]) {
      const atual = grupoConsultasAtual();
      const nomeAtual = atual.nome ? `*${atual.nome}*` : 'convite padrão';
      return responder(`Grupo de consultas atual: ${nomeAtual} (${atual.convite}).\nPara trocar: */grupo https://chat.whatsapp.com/CODIGO*`);
    }
    try {
      const r = await definirGrupoConsultas(sock, g[1]);
      const nomeGrupo = r.nome ? `: *${r.nome}*` : '';
      const aviso = r.entrou ? '\nO bot entrou no grupo pelo link.' : '';
      return responder(`✅ Grupo de consultas atualizado${nomeGrupo}.${aviso}`);
    } catch (e) {
      log.warn(`Falha ao trocar o grupo de consultas: ${e.message}`);
      return responder(`❌ Não consegui trocar o grupo: ${e.message}`);
    }
  }

  // /sistema [número]: mostra ou troca o número cujas respostas ao /cpf e /cnpj o bot aceita. Só o número autorizado.
  const sis = texto.match(/^\/sistema(?:\s+(.+))?$/i);
  if (sis) {
    if (!mensagemPodeAtualizarNoPrivado(mensagem, sock)) return responder('🔒 Somente o número autorizado pode alterar o número do sistema.');
    if (!sis[1]) return responder(`Número do sistema atual: *${numeroSistema()}*.\nPara trocar: */sistema 5521979245142*`);
    try {
      const novo = definirNumeroSistema(sis[1]);
      return responder(`✅ Número do sistema atualizado: *${novo}*.\nO bot passa a aceitar as respostas de /cpf e /cnpj desse número.`);
    } catch (e) {
      return responder(`❌ ${e.message}`);
    }
  }

  const autor = autorDaMensagem(mensagem, sock);
  const chave = chaveSessao(chatId, autor);

  if (/^\/cancelar$/i.test(texto)) {
    const naFila = filaPuxadas.findIndex((p) => p.chave === chave);
    if (naFila >= 0) {
      filaPuxadas.splice(naFila, 1);
      return responder('✅ Você saiu da fila.');
    }
    if (puxadaAtual?.chave !== chave) return responder('Você não tem consulta em andamento nem na fila.');
    puxadaAtual.cancelamento.abort();
    return responder('⏹️ Cancelamento solicitado. Vou parar assim que a consulta ativa for interrompida.');
  }

  if (/^\/fila$/i.test(texto)) {
    if (!puxadaAtual) return responder('Nenhuma consulta em andamento. A fila está vazia.');
    return responder([
      `▶️ Agora: ${puxadaAtual.descricao} (${puxadaAtual.quem})`,
      ...filaPuxadas.map((p, i) => `${i + 1}. ${p.descricao} (${p.quem})`),
      filaPuxadas.length ? '' : 'Ninguém na fila.',
    ].filter(Boolean).join('\n'));
  }

  // /cookies + curl colado: atualiza cookie e hashes no .env e na memória, sem reiniciar.
  if (/^\/cookies?\b/i.test(texto)) {
    return responder('🔒 O comando */cookies* está desativado no grupo para evitar expor cookies de sessão.');
  }

  const p = texto.match(/^\/pdf(?:\s+(.+))?$/i);
  if (p) {
    const nr = soDigitos(p[1]);
    if (nr.length !== 20) return responder('Informe o número do processo. Exemplo: */pdf 0000412-53.2017.8.27.2702*');
    const achado = localizarProcesso(nr);
    if (!achado) return responder('Processo não encontrado nos dados salvos. Consulte antes a OAB com */oab TO002140*.');
    try {
      await responder('Atualizando os dados e preenchendo o formulário em PDF...');
      // Tenta atualizar valor da causa/requerente; se o link salvo já expirou, usa o que está salvo.
      const novo = (await buscarDetalhes([achado.registro.dados], cfg, achado.oab))[nr];
      if (novo && !novo.erro) {
        achado.registro.detalhes = {
          ...achado.registro.detalhes,
          ...novo,
          advogado: novo.advogado || achado.registro.detalhes?.advogado || null,
        };
      }
      achado.registro.atualizado_em = novo && !novo.erro ? new Date().toISOString() : achado.registro.atualizado_em;
      const arquivo = await gerarFormularioPdf(achado.registro);
      const aviso = novo && !novo.erro ? '' : '\n⚠️ Não consegui atualizar no eproc agora; dados da última consulta salva.';
      await enviarComEspera(sock, chatId, {
        document: fs.readFileSync(arquivo),
        mimetype: 'application/pdf',
        fileName: path.basename(arquivo),
        caption: `Alvara do processo ${formatarCnj(nr)}${aviso}`,
      });
    } catch (e) {
      log.error('Falha ao gerar o PDF', e);
      await responder(`Erro ao gerar o PDF: ${e.message}`);
    }
    return;
  }

  const jaTemPuxada = () => puxadaAtual?.chave === chave || filaPuxadas.some((p) => p.chave === chave);
  const quem = mensagem.pushName || numeroDoJid(autor) || 'alguém';

  // Próximo lote de uma consulta já carregada na memória.
  const continuarLote = (s) => enfileirarPuxada({
    chave, chatId, autor, quem, responder,
    descricao: `/oab ${s.oab} (processos ${s.proximo + 1} a ${Math.min(s.proximo + LOTE_PROCESSOS, s.lista.length)})`,
    executar: (p) => processarLote(p, s),
  });

  // /mais: próximo lote da última consulta desta pessoa.
  if (/^\/mais$/i.test(texto)) {
    if (jaTemPuxada()) return responder('Sua consulta já está em andamento ou na fila. Use */fila* para ver a posição.');
    const s = sessoes.get(chave);
    if (s && s.proximo < s.lista.length) return continuarLote(s);
    // Sem consulta na memória (o bot reiniciou) ou já terminada: retoma a última OAB pendente salva em disco.
    const pendente = ultimaOabPendente(chave);
    if (pendente) {
      return enfileirarPuxada({ chave, chatId, autor, quem, responder, descricao: `/oab ${pendente} (continuação)`, executar: (p) => puxarOab(p, pendente) });
    }
    if (s) return responder(`Esses já eram todos os processos da OAB ${s.oab}. ✅`);
    return responder('Nada para continuar. Faça antes uma consulta com */oab TO002140*.');
  }

  const m = texto.match(/^\/(?:oab|aob)(?:\s+(.+))?$/i);
  if (!m) {
    if (/^\/(ajuda|help|menu)$/i.test(texto)) {
      await responder(`Comandos disponíveis no grupo (e no privado, para o número autorizado):\n*/oab TO002140* – lista os processos da OAB informada (aceita também /oab TO 2140, /oab 2140/TO, /oab 2140); consulta autor e réu no grupo e envia de ${LOTE_PROCESSOS} em ${LOTE_PROCESSOS} processos; avisa se outra pessoa parou no meio dessa OAB; mandar a mesma OAB de novo envia os próximos ${LOTE_PROCESSOS} (*/oab TO002140 reiniciar* volta ao processo 1); se a OAB já estiver no nosso sistema, usa os dados salvos (*/oab TO002140 eproc* busca a lista atual no eproc)\n*/mais* – envia os próximos ${LOTE_PROCESSOS} processos da sua última consulta\n*/fila* – mostra quem está consultando agora e quem está na fila (uma consulta por vez)\n*/cancelar* – interrompe a sua consulta ou tira você da fila\n*/pdf 0000412-53.2017.8.27.2702* – resumo em PDF de um processo já consultado\n*/atualizar* – atualiza o repositório via Bash\n*/grupo https://chat.whatsapp.com/CODIGO* – troca o grupo onde o bot consulta /cpf e /cnpj (só o número autorizado; sem link mostra o atual)\n*/sistema 5521979245142* – troca o número que responde /cpf e /cnpj no grupo (só o número autorizado; sem número mostra o atual)\n*/backup* – envia no privado um .tar.gz com as pastas dados e .baileys_auth (só o número autorizado, só no privado)\n*/cookies* – desativado no grupo para proteger cookies de sessão`);
    }
    return;
  }
  if (jaTemPuxada()) {
    return responder('Você já tem uma consulta em andamento ou na fila. Use */fila* para ver a posição ou */cancelar* para desistir dela.');
  }

  // "/oab TO2140 reiniciar" começa do processo 1; sem isso, a mesma OAB continua de onde a pessoa parou.
  // "/oab TO2140 eproc" ignora a lista salva e busca a lista atual no eproc.
  const reiniciar = /\b(reiniciar|zerar|do\s+zero)\b/i.test(m[1] || '');
  const forcarEproc = /\beproc\b/i.test(m[1] || '');
  const oab = normalizarOab((m[1] || '').replace(/\b(reiniciar|zerar|do\s+zero|eproc)\b/ig, ''));
  if (!oab) {
    return responder('Informe a OAB. Exemplo: */oab TO002140*');
  }
  const s = sessoes.get(chave);
  if (!reiniciar && !forcarEproc && s?.oab === oab && s.proximo < s.lista.length) return continuarLote(s);
  return enfileirarPuxada({
    chave, chatId, autor, quem, responder,
    descricao: `/oab ${oab}`,
    executar: (p) => puxarOab(p, oab, reiniciar, forcarEproc),
  });
}

// Coloca a puxada na fila e, se o bot estiver livre, começa na hora. Senão avisa a posição.
function enfileirarPuxada(puxada) {
  puxada.esperou = Boolean(puxadaAtual);
  filaPuxadas.push(puxada);
  if (puxada.esperou) {
    const posicao = filaPuxadas.indexOf(puxada) + 1;
    puxada.responder(`📝 Anotado: *${puxada.descricao}*. Você é o ${posicao}º da fila; agora está rodando ${puxadaAtual.descricao} (${puxadaAtual.quem}).\nAviso aqui quando for a sua vez. Para sair da fila: */cancelar*`)
      .catch(() => {});
  }
  iniciarProximaPuxada();
}

function iniciarProximaPuxada() {
  if (puxadaAtual || !filaPuxadas.length) return;
  const p = filaPuxadas.shift();
  puxadaAtual = p;
  p.cancelamento = new AbortController();
  (async () => {
    if (p.esperou) {
      // Menciona a pessoa: ela pode ter pedido há muito tempo.
      const usuario = numeroDoJid(p.autor);
      await enviarComEspera(sockAtual, p.chatId, {
        text: `▶️ @${usuario} chegou a sua vez: iniciando *${p.descricao}*.`,
        mentions: [jidSemDispositivo(p.autor)],
      }).catch(() => {});
    }
    await p.executar(p);
  })()
    .catch((e) => {
      log.error(`Falha na consulta ${p.descricao}`, e);
      return p.responder(`Erro na consulta: ${e.message}`).catch(() => {});
    })
    .finally(() => {
      puxadaAtual = null;
      iniciarProximaPuxada();
    });
}

// Busca a lista de processos da OAB (nos dados salvos ou no eproc) e processa o primeiro lote.
async function puxarOab(p, oab, reiniciar = false, forcarEproc = false) {
  const { responder } = p;
  let local = null;
  try { local = await carregarOabLocal(oab); } catch (e) { log.warn(`Não consegui ler os dados salvos da OAB ${oab}: ${e.message}`); }
  let lista;
  if (local?.lista && !forcarEproc) {
    lista = local.lista;
    const quando = local.atualizadoEm ? ` em ${new Date(local.atualizadoEm).toLocaleDateString('pt-BR')}` : '';
    await responder(`📂 OAB ${oab} encontrada no nosso sistema (${local.fonte}${quando}): usando a lista salva, sem consultar o eproc.\nPara buscar a lista atual no eproc: */oab ${oab} eproc*`);
  } else {
    lista = await listaDoEproc(oab, responder);
    if (!lista) return;
  }
  if (!lista.length) return responder(`Nenhum processo encontrado para a OAB ${oab}.`);

  // Guarda a lista completa na memória; os detalhes (valor da causa etc.) vêm dos dados salvos ou são buscados
  // só da página exibida. Continua de onde a pessoa parou nesta OAB (se não terminou e não pediu para reiniciar).
  const salvo = reiniciar ? null : progressoSalvo(p.chave, oab);
  // Lista já recebida inteira: não recomeça sozinho (o progresso só é zerado quando a pessoa pede).
  if (salvo && salvo.proximo >= lista.length) {
    return responder(`✅ Você já recebeu todos os ${lista.length} processos da OAB ${oab}.\nPara receber de novo desde o processo 1: */oab ${oab} reiniciar*`);
  }
  const inicio = salvo ? salvo.proximo : 0;
  const progressoGlobal = progressoGlobalOab(oab);
  if (
    progressoGlobal &&
    progressoGlobal.proximo > 0 &&
    progressoGlobal.proximo < progressoGlobal.total &&
    !mesmoAutor(progressoGlobal, p.autor)
  ) {
    const nomeAnterior = String(progressoGlobal.quem || 'Nome indisponível').replace(/[\r\n]+/g, ' ').slice(0, 80);
    const numeroAnterior = progressoGlobal.numero ? ` (+${progressoGlobal.numero})` : '';
    const quando = new Date(progressoGlobal.em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const processoAnterior = progressoGlobal.processo
      ? `processo ${progressoGlobal.processo} (${progressoGlobal.proximo} de ${progressoGlobal.total})`
      : `${progressoGlobal.proximo} de ${progressoGlobal.total} processos`;
    await responder(
      `⚠️ Outra pessoa já consultou a OAB ${oab} até o ${processoAnterior} e parou.\n` +
      `Quem consultou: *${nomeAnterior}*${numeroAnterior}.\n` +
      `Última atividade: ${quando} (horário de Brasília).\n` +
      `Seu progresso é individual; esta consulta continuará do processo ${inicio + 1}, sem pular os anteriores.`,
    );
  }
  const s = { oab, lista, proximo: inicio, detalhes: { ...(local?.detalhes || {}) }, novos: null };
  try {
    const consulta = salvarConsulta(oab, lista, s.detalhes);
    // "Novos desde a última consulta" só faz sentido quando a lista acabou de vir do eproc.
    s.novos = consulta.primeiraVez || lista === local?.lista ? null : consulta.novos;
  } catch (e) {
    log.error('Falha ao salvar os dados da consulta', e);
  }
  // Mesmo formato da varredura: o próximo /oab desta OAB já sai dos dados salvos, sem consultar o eproc.
  if (lista !== local?.lista || local.fonte !== 'varredura') {
    try { salvarPastaAdvogado(oab, lista, s.detalhes); } catch (e) { log.error('Falha ao salvar a pasta do advogado', e); }
  }
  sessoes.set(p.chave, s);
  const continuacao = inicio > 0
    ? `\n▶️ Continuando do processo ${inicio + 1} (você já recebeu ${inicio}). Para começar do 1: */oab ${oab} reiniciar*`
    : '';
  await responder(`📋 *${lista.length} processo(s)* encontrado(s) para a OAB ${oab}. Vou consultar autor e réu no grupo e enviar de ${LOTE_PROCESSOS} em ${LOTE_PROCESSOS}; para os próximos, envie */oab ${oab}* de novo (ou */mais*).${continuacao}` +
    (s.novos ? (s.novos.length ? `\n🆕 ${s.novos.length} novo(s) desde a última consulta: ${s.novos.join(', ')}` : '\nNenhum processo novo desde a última consulta.') : ''));
  await processarLote(p, s);
}

// Lista de processos da OAB direto do eproc, renovando o login se a sessão caiu. Devolve null se já respondeu com erro.
async function listaDoEproc(oab, responder) {
  await responder(`Consultando processos da OAB ${oab} no eproc TJTO...`);
  let resp;
  try {
    resp = await consultarPorOab(oab, cfg);
  } catch (erro) {
    // 401/403 do eproc: sessão ou hashes inválidos; renova o login e tenta uma vez de novo.
    if (![401, 403].includes(erro.status) || !loginEprocConfigurado()) throw erro;
    log.warn(`eproc respondeu HTTP ${erro.status}; renovando o login`);
    await responder('🔐 O eproc recusou a sessão atual; renovando o login automaticamente...');
    await autenticarEproc(cfg);
    resp = await consultarPorOab(oab, cfg);
  }
  let dados;
  try {
    dados = parseResposta(resp);
  } catch {
    if (sessaoExpirou(resp) && loginEprocConfigurado()) {
      await responder('🔐 Sessão do eproc expirada; renovando o login automaticamente...');
      await autenticarEproc(cfg);
      resp = await consultarPorOab(oab, cfg);
      try {
        dados = parseResposta(resp);
      } catch {
        log.warn('Resposta do eproc inválida após renovar a sessão');
        await responder('Não consegui ler a resposta do eproc mesmo após renovar a sessão.');
        return null;
      }
    } else {
      // Guarda o que o eproc devolveu para diagnóstico (debug-*.txt é ignorado pelo Git).
      log.warn('Resposta do eproc fora do formato esperado');
      try { require('fs').writeFileSync('debug-resposta-oab.txt', resp); } catch {}
      await responder('Não consegui ler a resposta do eproc. A sessão provavelmente expirou: configure o login automático no .env ou atualize EPROC_COOKIE.');
      return null;
    }
  }
  return dados.resultados || [];
}

// Envia até LOTE_PROCESSOS processos a partir de onde a pessoa parou; no fim do lote, pausa e pede /mais.
async function processarLote(p, s) {
  const { responder } = p;
  const cancelada = () => responder('⏹️ Consulta OAB cancelada. Use */mais* para retomar a partir do próximo processo.');
  s.fimLote = Math.min(s.proximo + LOTE_PROCESSOS, s.lista.length);
  s.cancelamento = p.cancelamento;
  const inicio = s.proximo;
  try {
    await responder(`🔎 Consultando telefones e renda dos processos ${inicio + 1} a ${s.fimLote} de ${s.lista.length}...`);
    while (s.proximo < s.fimLote && !s.cancelamento.signal.aborted) {
      await enviarPagina(p.chatId, s, responder, sockAtual);
      salvarProgresso(p.chave, s.oab, s.proximo, s.lista.length, {
        autor: p.autor,
        quem: p.quem,
        processo: s.lista[s.proximo - 1]?.nr_processo,
      });
    }
    if (s.cancelamento.signal.aborted) return cancelada();
    const faltam = s.lista.length - s.proximo;
    if (faltam > 0) {
      await responder(`⏸️ Lote concluído: processos ${inicio + 1} a ${s.proximo} de ${s.lista.length}.\nPara os próximos ${Math.min(LOTE_PROCESSOS, faltam)}, envie */oab ${s.oab}* de novo (ou */mais*). Faltam ${faltam}.`);
    }
  } catch (e) {
    if (e.name === 'AbortError' && s.cancelamento?.signal.aborted) return cancelada();
    throw e;
  } finally {
    s.cancelamento = null;
  }
}

// Processo sem valor da causa (segredo de justiça ou R$ 0,00): não consulta contatos nem é enviado ao grupo.
// Desligue com ENVIAR_SEM_VALOR=1. Se o valor não pôde ser lido (erro ou campo ausente), o processo é mantido.
function semValorDaCausa(det) {
  if (process.env.ENVIAR_SEM_VALOR === '1' || !det || det.erro) return false;
  if (det.semInformacoesAdicionais) return true;
  const numero = String(det.valorCausa || '').replace(/[^\d,]/g, '').replace(',', '.');
  return numero !== '' && Number(numero) === 0;
}

// Autor pessoa jurídica (CNPJ, 14 dígitos): não consulta contatos nem é enviado; só autores com CPF aparecem.
function autorComCnpj(r) {
  return soDigitos(String(r.ident_autor || '')).length === 14;
}

// Mostra a próxima página, consultando autor e réu no grupo para cada processo.
async function enviarPagina(chatId, s, responder, sock) {
  const fatia = s.lista.slice(s.proximo, s.proximo + TAMANHO_PAGINA);
  const verificarCancelamento = () => {
    if (s.cancelamento?.signal.aborted) {
      const erro = new Error('Consulta cancelada');
      erro.name = 'AbortError';
      throw erro;
    }
  };

  // Detalhes primeiro: é o valor da causa que decide se vale consultar o /cpf e enviar o processo.
  // Processos que já têm detalhes salvos (varredura ou consulta anterior) não são abertos de novo no eproc.
  const det = {};
  for (const r of fatia) if (detalheCompleto(s.detalhes[r.nr_processo])) det[r.nr_processo] = s.detalhes[r.nr_processo];
  const faltando = fatia.filter((r) => !det[r.nr_processo]);
  if (faltando.length) {
    Object.assign(det, await buscarDetalhes(faltando, cfg, s.oab));
    verificarCancelamento();
    Object.assign(s.detalhes, det);
    try { salvarConsulta(s.oab, s.lista, s.detalhes); } catch (e) { log.error('Falha ao salvar os dados da consulta', e); }
    try { salvarPastaAdvogado(s.oab, s.lista, det); } catch (e) { log.error('Falha ao salvar a pasta do advogado', e); }
  }

  const comValor = fatia.filter((r) => !semValorDaCausa(det[r.nr_processo]));
  const consultar = comValor.filter((r) => !autorComCnpj(r));
  const ignorados = fatia.length - comValor.length;
  if (ignorados) log.info(`${ignorados} processo(s) sem valor da causa ignorado(s) (não consulta contatos nem envia)`);
  const ignoradosCnpj = comValor.length - consultar.length;
  if (ignoradosCnpj) log.info(`${ignoradosCnpj} processo(s) com autor CNPJ ignorado(s) (não consulta contatos nem envia)`);

  const contatos = {};
  for (const r of consultar) {
    try {
      // Consultas /oab duram horas: se o WhatsApp reconectou no meio, segue com o socket novo.
      contatos[r.nr_processo] = await consultarPartes(sockAtual || sock, enviarComEspera, r, s.cancelamento?.signal);
    } catch (e) {
      if (e.name === 'AbortError' && s.cancelamento?.signal.aborted) throw e;
      log.warn(`Consulta de contatos de um processo falhou: ${e.message}`);
      const falha = [`   ⚠️ Consulta de contatos falhou: ${e.message}`];
      contatos[r.nr_processo] = { autor: falha, reu: falha };
    }
  }
  verificarCancelamento();
  const enviar = consultar.filter((r) => !contatos[r.nr_processo]?.semWhatsApp);
  const semWhatsApp = consultar.length - enviar.length;
  if (semWhatsApp) log.info(`${semWhatsApp} processo(s) sem nenhum número do autor no WhatsApp ignorado(s) (não envia)`);

  const posicaoInicial = s.proximo;
  s.proximo += fatia.length;
  const faltam = s.lista.length - s.proximo;
  const faltamNoLote = (s.fimLote ?? s.lista.length) - s.proximo;
  const fim = faltam === 0
    ? '\n\n✅ Fim da lista.'
    : faltamNoLote > 0 ? `\n\n⏳ A consulta seguirá automaticamente (faltam ${faltamNoLote} neste lote).` : '';
  if (!enviar.length) {
    // Nada a enviar nesta página; só avisa quando a lista termina.
    if (faltam === 0) await responder(fim.trim());
    return;
  }

  // Os contatos entram só na mensagem; não são gravados nos detalhes salvos.
  const detMsg = {};
  for (const r of enviar) detMsg[r.nr_processo] = { ...det[r.nr_processo], contatos: contatos[r.nr_processo] };
  // formatarResposta numera de 1 a N dentro da lista enviada; ajusta para a posição real na lista.
  const posicaoReal = (r) => s.lista.indexOf(r) + 1;
  const texto = formatarResposta({ resultados: enviar }, s.oab, detMsg, 60000)[0]
    .replace(/^📋[^\n]*\n[^\n]*/, `📋 *Processo ${posicaoReal(enviar[0])}${enviar.length > 1 ? ` a ${posicaoReal(enviar[enviar.length - 1])}` : ''} de ${s.lista.length}*`)
    .replace(/\*(\d+)\. PROCESSO/g, (_, n) => `*${posicaoReal(enviar[Number(n) - 1])}. PROCESSO`);
  void posicaoInicial;
  await responder(texto + fim);
}

// ---- Diagnóstico [diag]: mede onde a resposta do /cpf demora (envio, sistema ou entrega ao bot). ----
const enviosConsulta = new Map(); // id do /cpf ou /cnpj enviado -> { comando, em, status }
const chegaramSemConteudo = new Map(); // id -> horário em que a mensagem chegou sem conteúdo (não decifrada)
const segundos = (ms) => `${(ms / 1000).toFixed(1)}s`;
const ESTADOS_ENVIO = { 2: 'servidor do WhatsApp recebeu', 3: 'entregue', 4: 'lida' };

function horarioDaMensagem(mensagem) {
  const t = mensagem.messageTimestamp;
  const s = typeof t === 'object' && t ? (t.toNumber ? t.toNumber() : Number(t.low)) : Number(t);
  return s ? s * 1000 : null;
}

function registrarEnvioConsulta(r, conteudo, inicio) {
  const comando = /^\/(?:cpf|cnpj)\b.*/i.exec(conteudo?.text || '')?.[0];
  if (!comando || !r?.key?.id) return;
  enviosConsulta.set(r.key.id, { comando, em: inicio, status: 0 });
  if (enviosConsulta.size > 50) enviosConsulta.delete(enviosConsulta.keys().next().value);
  log.info(`[diag] ${comando}: sendMessage levou ${segundos(Date.now() - inicio)}`);
}

function diagnosticarStatusEnvio(key, update) {
  const envio = enviosConsulta.get(key?.id);
  const status = update?.status;
  if (!envio || !ESTADOS_ENVIO[status] || status <= envio.status) return;
  envio.status = status;
  log.info(`[diag] ${envio.comando}: ${ESTADOS_ENVIO[status]} ${segundos(Date.now() - envio.em)} após o envio`);
}

// Cada mensagem do grupo de consultas: quando foi enviada (horário do WhatsApp) e quando chegou ao bot.
function diagnosticarRecebida(mensagem, type, texto, normalizarConteudo) {
  const chat = mensagem.key.remoteJid;
  if (!chat?.endsWith('@g.us') || chat !== grupoConsultasAtual().id || mensagem.key.fromMe) return;
  const id = mensagem.key.id;
  const enviadaEm = horarioDaMensagem(mensagem);
  const entrega = enviadaEm ? segundos(Date.now() - enviadaEm) : '?';
  const de = numeroDoJid(mensagem.key.participantPn || mensagem.key.participant || '') || '?';
  const offline = type === 'append' ? ' [entregue como offline]' : '';
  if (!texto && mensagem.messageStubType) {
    chegaramSemConteudo.set(id, Date.now());
    if (chegaramSemConteudo.size > 200) chegaramSemConteudo.delete(chegaramSemConteudo.keys().next().value);
    log.warn(`[diag] Mensagem de ${de} chegou SEM conteúdo (não decifrada: ${mensagem.messageStubParameters?.join(', ') || `stub ${mensagem.messageStubType}`}); aguardando reenvio. Enviada há ${entrega}${offline}`);
    return;
  }
  const reenvio = chegaramSemConteudo.has(id) ? ` · decifrada ${segundos(Date.now() - chegaramSemConteudo.get(id))} depois de chegar sem conteúdo` : '';
  chegaramSemConteudo.delete(id);
  // A resposta do sistema cita o /cpf do bot: dá para separar o tempo do sistema do tempo de entrega.
  const citada = normalizarConteudo(mensagem.message)?.extendedTextMessage?.contextInfo?.stanzaId;
  const envio = enviosConsulta.get(citada);
  const doc = /\b(?:CPF|CNPJ)\s*:\s*([\d.\-\/]{11,18})/i.exec(texto)?.[1];
  if (envio) {
    log.info(`[diag] Resposta ao ${envio.comando} chegou ${segundos(Date.now() - envio.em)} após o envio: o sistema levou ${enviadaEm ? segundos(enviadaEm - envio.em) : '?'} para responder e a entrega ao bot ${entrega}${reenvio}${offline}`);
  } else if (doc || reenvio || offline) {
    log.info(`[diag] ${doc ? `Resposta do documento ${doc}` : 'Mensagem'} de ${de}: enviada há ${entrega}${reenvio}${offline}`);
  } else {
    log.debug(`[diag] Mensagem de ${de} no grupo: enviada há ${entrega}`);
  }
}

// Reconecta com espera crescente (2 s, 4 s, 8 s... até 60 s). Se a reconexão falhar, agenda outra em vez de desistir.
function agendarReconexao() {
  if (reconexaoAgendada || sessaoEncerrada) return;
  const atraso = Math.min(2000 * 2 ** tentativasReconexao, 60000);
  tentativasReconexao++;
  reconexaoAgendada = setTimeout(() => {
    reconexaoAgendada = null;
    conectarWhatsApp().catch((erro) => {
      log.error('Falha ao reconectar o WhatsApp', erro);
      agendarReconexao();
    });
  }, atraso);
}

// Vigia: se o WhatsApp ficar desconectado por 5 min (reconexão travada), força uma conexão nova.
setInterval(() => {
  if (conectado || sessaoEncerrada || Date.now() - desconectadoDesde < RECONEXAO_FORCADA_MS) return;
  log.warn('WhatsApp desconectado há mais de 5 min; forçando nova conexão');
  desconectadoDesde = Date.now();
  if (reconexaoAgendada) { clearTimeout(reconexaoAgendada); reconexaoAgendada = null; }
  try { sockAtual?.end(new Error('reconexão forçada')); } catch {}
  tentativasReconexao = 0;
  agendarReconexao();
}, 60000).unref();

async function conectarWhatsApp() {
  const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    normalizeMessageContent,
    useMultiFileAuthState,
  } = await import('@whiskeysockets/baileys');
  const loggerBaileys = pino({ level: 'silent' });
  const { state, saveCreds } = await useMultiFileAuthState(PASTA_AUTENTICACAO);
  // Versão do WhatsApp Web atual; com uma versão velha o servidor derruba a conexão (erro 405).
  const { version } = await comTempoLimite(fetchLatestBaileysVersion(), 10000, 'tempo esgotado').catch(() => ({}));
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, loggerBaileys) },
    syncFullHistory: false,
    markOnlineOnConnect: false,
    logger: loggerBaileys,
    msgRetryCounterCache,
    getMessage: async (key) => mensagensEnviadas.get(key.id),
    cachedGroupMetadata: metadadosDoGrupo,
  });
  sockAtual = sock;

  sock.ev.on('creds.update', saveCreds);
  // Entrou ou saiu gente, ou o grupo mudou: busca os dados de novo no próximo envio.
  sock.ev.on('group-participants.update', ({ id }) => metadadosGrupos.delete(id));
  sock.ev.on('groups.update', (grupos) => grupos.forEach((g) => metadadosGrupos.delete(g.id)));
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (sock !== sockAtual) return; // evento de um socket antigo, já substituído
    if (qr) {
      log.info('Escaneie o QR code para conectar o WhatsApp');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      conectado = true;
      tentativasReconexao = 0;
      log.success('WhatsApp conectado · bot pronto');
      void enviarAvisoInicial(sock);
    }
    if (connection === 'close') {
      if (conectado) desconectadoDesde = Date.now();
      conectado = false;
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        sessaoEncerrada = true;
        log.error('Sessão do WhatsApp encerrada; é necessário parear novamente');
        return;
      }
      log.warn(`Conexão WhatsApp encerrada (${codigo || lastDisconnect?.error?.message || 'sem código'}); tentando reconectar`);
      agendarReconexao();
    }
  });

  // Alguns bots mandam "consultando..." e depois EDITAM a mensagem com o resultado; o WhatsApp entrega a edição aqui.
  sock.ev.on('messages.update', (atualizacoes) => {
    for (const { key, update } of atualizacoes) {
      diagnosticarStatusEnvio(key, update);
      const editada = update?.message?.editedMessage?.message || update?.message?.protocolMessage?.editedMessage;
      if (!key || !editada) continue;
      tratarMensagemDoGrupo({ key }, extrairTexto({ message: editada }, normalizeMessageContent));
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    log.debug(`[wa] messages.upsert recebido: tipo=${type}, quantidade=${messages.length}`);
    if (type !== 'notify' && type !== 'append') return;
    for (const mensagem of messages) {
      const texto = extrairTexto(mensagem, normalizeMessageContent);
      const tiposConteudo = Object.keys(mensagem.message || {}).join(',') || 'indisponível';
      log.debug(`[wa] mensagem ${mensagem.key.fromMe ? 'enviada pelo bot' : 'recebida'}: conteúdo=${tiposConteudo}, comando=${texto.startsWith('/') ? 'sim' : 'não'}, stub=${mensagem.messageStubType ?? 'nenhum'}`);
      try { diagnosticarRecebida(mensagem, type, texto, normalizeMessageContent); } catch (e) { log.debug(`[diag] falhou: ${e.message}`); }
      // A resposta do sistema pode chegar marcada como offline ("append"), por exemplo depois de uma oscilação
      // da conexão; ela vale do mesmo jeito.
      if (!mensagem.key.fromMe && mensagem.key.id && !mensagensProcessadas.has(mensagem.key.id) &&
          tratarMensagemDoGrupo(mensagem, texto)) {
        mensagensProcessadas.add(mensagem.key.id);
        continue;
      }
      // Mensagem sem conteúdo (não decifrada): não marca como processada, para aceitar o reenvio com o mesmo id.
      if (!texto && mensagem.messageStubType) continue;
      if (type === 'append') {
        const enviadoParaMim = mensagem.key.fromMe &&
          (ehJidProprio(mensagem.key.remoteJid, sock) || mensagem.key.remoteJid?.endsWith('@g.us'));
        const recente = Math.abs(Date.now() / 1000 - Number(mensagem.messageTimestamp)) < 120;
        if (!enviadoParaMim || !recente) {
          if (extrairTexto(mensagem, normalizeMessageContent).startsWith('/')) {
            log.debug('Comando próprio ignorado: origem não confirmada');
          }
          continue;
        }
      }
      const id = mensagem.key.id;
      if (!id || mensagensProcessadas.has(id)) continue;
      mensagensProcessadas.add(id);
      if (mensagensProcessadas.size > 1000) {
        mensagensProcessadas.delete(mensagensProcessadas.values().next().value);
      }
      try {
        await processarMensagem(sock, mensagem, normalizeMessageContent);
      } catch (erro) {
        log.error('Falha ao processar uma mensagem', erro);
      }
    }
  });
}

async function iniciar() {
  log.faixa();
  log.info('Iniciando serviços');
  try {
    const ipSaida = await capturarIpSaidaInicial();
    statusInicializacao.ip = ipSaida;
    log.info(`IP público de saída detectado na inicialização: ${ipSaida}`);
    try {
      const localizacao = await localizarIpPublico(ipSaida);
      statusInicializacao.localizacao = localizacao;
      const lugar = [localizacao.cidade, localizacao.regiao, localizacao.pais].filter(Boolean).join(', ');
      const detalhes = [localizacao.provedor, localizacao.fuso].filter(Boolean).join(' · ');
      log.info(`Localização aproximada do IP: ${lugar || 'indisponível'}${detalhes ? ` (${detalhes})` : ''}`);
    } catch (erroGeo) {
      log.warn(`${erroGeo.message} O bot continuará usando o IP detectado.`);
    }
  } catch (erro) {
    if (erro.code !== 'EPROC_EGRESS_BLOCKED') throw erro;
    log.warn(`${erro.message} O WhatsApp será iniciado, mas consultas ao eproc ficarão indisponíveis.`);
  }
  if (loginEprocConfigurado()) {
    try {
      const sessaoSalva = await reutilizarSessaoEproc(cfg);
      if (sessaoSalva.valida) {
        log.success('Sessão salva do eproc reutilizada');
      } else {
        log.warn(`Sessão salva indisponível (${sessaoSalva.motivo}); tentando novo login`);
        await autenticarEproc(cfg);
        log.success('Sessão do eproc atualizada');
      }
    } catch (erro) {
      if (erro.code !== 'EPROC_EGRESS_BLOCKED') throw erro;
      log.warn(`${erro.message} O WhatsApp será iniciado; consultas ao eproc ficarão indisponíveis.`);
    }
  }
  await conectarWhatsApp();
}

iniciar().catch((erro) => {
  log.error('Não foi possível iniciar o bot', erro);
  process.exitCode = 1;
});
