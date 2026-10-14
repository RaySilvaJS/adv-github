const fs = require('fs');
const path = require('path');
const log = require('./logger');

const PASTA = path.join(__dirname, '..', 'dados');
const CONVITE_PADRAO = process.env.GRUPO_CONVITE || 'FtYiEyTes9MCuCEDZ2dSlV';
const ARQUIVO_CONFIG_GRUPO = path.join(PASTA, 'config-grupo.json');
const NUMERO_SISTEMA_PADRAO = (process.env.NUMERO_SISTEMA || '5521979245142').replace(/\D/g, '');
// O sistema responde na hora um CPF que já consultou, mas um CPF novo pode levar alguns minutos.
const TIMEOUT_RESPOSTA_MS = Number(process.env.TIMEOUT_RESPOSTA_MS) || 180000;
// Respostas guardadas por documento: o mesmo CPF aparece em vários processos, e uma resposta que chega depois do
// tempo limite não se perde. Validade em dias: CACHE_CONSULTA_DIAS (padrão 30).
const PASTA_CACHE = path.join(PASTA, 'respostas-sistema');
const VALIDADE_CACHE_MS = (Number(process.env.CACHE_CONSULTA_DIAS) || 30) * 86400000;
// Intervalo mínimo entre dois envios de /cpf ou /cnpj ao grupo (o sistema bloqueia consulta rápida demais).
const INTERVALO_MS = Number(process.env.INTERVALO_CONSULTA_MS) || 30000;

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
function criarErroCancelamento() {
  const erro = new Error('Consulta cancelada');
  erro.name = 'AbortError';
  return erro;
}

function verificarCancelamento(signal) {
  if (signal?.aborted) throw criarErroCancelamento();
}

function esperar(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(criarErroCancelamento());
    const timer = setTimeout(finalizar, ms);
    function finalizar() {
      signal?.removeEventListener('abort', cancelar);
      resolve();
    }
    function cancelar() {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancelar);
      reject(criarErroCancelamento());
    }
    signal?.addEventListener('abort', cancelar, { once: true });
  });
}

// Extrai de uma resposta do sistema todos os telefones da seção "NÚMEROS" e o valor de "RENDA".
function parseRespostaSistema(texto) {
  const t = String(texto || '');
  const telefones = [];
  const secao = /N[ÚU]MEROS[^\n]*\n([\s\S]*)/i.exec(t);
  if (secao) {
    for (const linha of secao[1].split('\n')) {
      if (!linha.trim()) continue;
      const m = /\(?(\d{2})\)?\s*(\d{4,5})-?(\d{4})\b(.*)$/.exec(linha);
      if (!m) break; // fim da lista de números
      const resto = m[4].replace(/[\\*_]/g, '');
      const [, operadora] = /-\s*([^-\n]+?)\s*(?:-|$)/.exec(resto) || [];
      telefones.push({
        numero: `(${m[1]})${m[2]}-${m[3]}`,
        operadora: operadora ? operadora.trim() : null,
        whatsapp: /whatsapp/i.test(resto),
      });
    }
  }
  // Formato "lista": sem seção NÚMEROS, cada telefone vem em "Tel: ..." (às vezes sem DDD e repetido), sem marca de WhatsApp.
  const formato = secao ? 'whatsapp' : 'lista';
  if (!secao) {
    const porDigitos = new Map();
    const semDdd = [];
    for (const linha of t.split(/\r?\n/)) {
      const m = /\bTel(?:efone)?\s*:\s*(.+)$/i.exec(linha);
      if (!m) continue;
      const resto = m[1].trim();
      const c = /^\(?(\d{2})\)?\s*(\d{4,5})-?(\d{4})\b\s*(.*)$/.exec(resto);
      if (c) {
        const digitos = `${c[1]}${c[2]}${c[3]}`;
        const detalhe = c[4].replace(/[\\*_]/g, '').trim() || null;
        const atual = porDigitos.get(digitos);
        if (!atual) porDigitos.set(digitos, { numero: `(${c[1]})${c[2]}-${c[3]}`, operadora: null, whatsapp: /whatsapp/i.test(c[4]), detalhe });
        else if (!atual.detalhe && detalhe) atual.detalhe = detalhe;
      } else {
        const s = /^(\d{4,5})-?(\d{4})\b/.exec(resto);
        if (s) semDdd.push(`${s[1]}${s[2]}`);
      }
    }
    telefones.push(...porDigitos.values());
    // Número sem DDD que repete os últimos 8 dígitos de um já listado é descartado.
    const finais = new Set(telefones.map((x) => x.numero.replace(/\D/g, '').slice(-8)));
    for (const d of new Set(semDdd)) {
      if (finais.has(d.slice(-8))) continue;
      finais.add(d.slice(-8));
      const numero = d.length === 9 ? `${d.slice(0, 5)}-${d.slice(5)}` : `${d.slice(0, 4)}-${d.slice(4)}`;
      telefones.push({ numero, operadora: null, whatsapp: false, detalhe: null });
    }
  }
  const renda = (/RENDA\s*:?\s*\**\s*(R\$\s*[\d.]+(?:,\d{2})?)/i.exec(t) || [])[1] || null;
  const nome = (/\bNOME\s*:\s*([^\r\n]+)/i.exec(t) || [])[1]
    ?.replace(/[\u200B-\u200F\uFEFF]/g, '')
    .replace(/[*_~]/g, '')
    .trim() || null;
  const nascimento = (/\bNASCIMENTO\s*:\s*([^\r\n]+)/i.exec(t) || [])[1]
    ?.replace(/[\u200B-\u200F\uFEFF*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
  // Resposta de /cnpj: no lugar da renda, vêm CAPITAL SOCIAL e FATURAMENTO.
  const valorRS = (rotulo) => (new RegExp(`${rotulo}\\s*:?\\s*\\**\\s*(R\\$\\s*[\\d.]+(?:,\\d{2})?)`, 'i').exec(t) || [])[1] || null;
  const capitalSocial = valorRS('CAPITAL\\s+SOCIAL');
  const faturamento = valorRS('FATURAMENTO');
  // Resposta curta do sistema quando o documento não existe na base: "Dados não encontrados para o CPF: ...".
  const naoEncontrado = /Dados\s+n[ãa]o\s+encontrad/i.test(t);
  return { telefones, renda, nome, nascimento, formato, capitalSocial, faturamento, naoEncontrado };
}

// Chave de comparação de telefone: 55 + DDD + últimos 8 dígitos (ignora o 9º dígito, que o cadastro do WhatsApp pode não ter).
const chaveTelefone = (jid) => {
  const d = String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
  return `${d.slice(0, 4)}${d.slice(-8)}`;
};

// Confere no próprio WhatsApp (Baileys onWhatsApp) quais telefones têm conta, para os que a resposta não marcou.
async function marcarWhatsApp(sock, analisado) {
  const alvos = analisado.telefones.filter((t) => !t.whatsapp && /^\(\d{2}\)/.test(t.numero));
  if (!alvos.length) return;
  if (typeof sock?.onWhatsApp !== 'function') {
    analisado.whatsappNaoVerificado = true;
    return;
  }
  try {
    const completos = alvos.map((t) => `55${t.numero.replace(/\D/g, '')}`);
    const resultados = await sock.onWhatsApp(...completos);
    const existentes = new Set((resultados || []).filter((x) => x.exists !== false).map((x) => chaveTelefone(x.jid)));
    for (const t of alvos) {
      if (existentes.has(chaveTelefone(`55${t.numero.replace(/\D/g, '')}`))) t.whatsapp = true;
    }
  } catch (e) {
    log.warn(`Não consegui verificar os telefones no WhatsApp: ${e.message}`);
    analisado.whatsappNaoVerificado = true;
  }
}

// Documento -> comando: 11 dígitos = /cpf, 14 = /cnpj.
function comandoParaDoc(doc) {
  const d = soDigitos(doc);
  if (d.length === 11) return `/cpf ${d}`;
  if (d.length === 14) return `/cnpj ${d}`;
  return null;
}

// Espera a próxima resposta do número do sistema no grupo. Uma consulta por vez.
const esperando = { resolve: null, chatId: null, doc: null, vistas: [] };
let filaConsultas = Promise.resolve();
let ultimaConsultaEm = 0;
let grupoDasConsultas = null;
const enviadosRecentes = new Map(); // documento -> horário em que o /cpf ou /cnpj foi enviado

function lerCache(doc) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(PASTA_CACHE, `${doc}.json`), 'utf8'));
    return Date.now() - Date.parse(c.recebido_em) < VALIDADE_CACHE_MS ? c.texto : null;
  } catch {
    return null;
  }
}

function salvarCache(doc, texto) {
  try {
    fs.mkdirSync(PASTA_CACHE, { recursive: true });
    fs.writeFileSync(path.join(PASTA_CACHE, `${doc}.json`), JSON.stringify({ doc, recebido_em: new Date().toISOString(), texto }), 'utf8');
  } catch (e) {
    log.warn(`Não consegui guardar a resposta do documento ${doc}: ${e.message}`);
  }
}

function tratarMensagemDoGrupo(mensagem, textoBruto) {
  const aguardando = Boolean(esperando.resolve);
  // Fora de uma espera, ainda escuta o grupo de consultas: uma resposta atrasada é guardada para a próxima vez.
  const grupo = aguardando ? esperando.chatId : grupoDasConsultas;
  if (!grupo || mensagem.key.remoteJid !== grupo || mensagem.key.fromMe) return false;
  // Remove caracteres invisíveis (marcas de direção, espaço de largura zero) que quebram "CPF: 000.000.000-00".
  const textoExtraido = String(textoBruto || '').replace(/\p{Cf}/gu, '');
  // Guarda o que chegou ao grupo durante a espera, para explicar um "sem resposta" (ver consultarDoc).
  const remetente = soDigitos(String(mensagem.key.participantPn || mensagem.key.senderPn || mensagem.key.participant || '').split('@')[0].split(':')[0]);
  const ignorar = (motivo) => {
    if (aguardando) esperando.vistas.push(`${remetente || '?'}: "${textoExtraido.replace(/\s+/g, ' ').slice(0, 40)}" (${motivo})`);
    return false;
  };
  if (!textoExtraido) {
    // Mensagem que o WhatsApp entregou sem conteúdo: falha ao decifrar (o WhatsApp pede o reenvio) ou tipo sem texto.
    const tipos = Object.keys(mensagem.message || {}).join(',') || 'sem conteúdo';
    return ignorar(mensagem.messageStubType ? `não decifrada (stub ${mensagem.messageStubType}), aguardando reenvio` : `sem texto (${tipos})`);
  }
  // Ignora avisos de "consultando..."; aceita também bloqueios por excesso de consultas.
  if (!/N[ÚU]MEROS|CONTATOS|\bTel\s*:|RENDA|\bNOME\s*:|\bCPF\s*:|\bCNPJ\s*:|n[ãa]o\s+encontrad|sem\s+resultado|nenhum|consultando\s+muito\s+r[aá]pido/i.test(textoExtraido)) return ignorar('não parece uma resposta');
  // A resposta é reconhecida pelo documento que o bot consultou: o primeiro "CPF:" ou "CNPJ:" dela é o documento
  // consultado, e no grupo o sistema também responde a outras pessoas. Vale de qualquer remetente, porque o
  // sistema nem sempre aparece com o número configurado em /sistema.
  const documentoDaResposta = /\b(?:CPF|CNPJ)\s*:\s*([\d.\-\/]{11,18})/i.exec(textoExtraido)?.[1];
  if (documentoDaResposta) {
    const doc = soDigitos(documentoDaResposta);
    if (aguardando && doc === esperando.doc) {
      salvarCache(doc, textoExtraido);
      enviadosRecentes.delete(doc);
    } else if (enviadosRecentes.has(doc)) {
      // Resposta a uma consulta que já tinha estourado o tempo: guarda para quando o documento aparecer de novo.
      const atraso = Math.round((Date.now() - enviadosRecentes.get(doc)) / 1000);
      enviadosRecentes.delete(doc);
      salvarCache(doc, textoExtraido);
      log.info(`Resposta atrasada do documento ${doc} chegou ${atraso}s depois do envio; guardada para as próximas consultas`);
      if (aguardando) esperando.vistas.push(`${remetente || '?'}: resposta atrasada de ${documentoDaResposta} (guardada)`);
      return true;
    } else {
      return ignorar(`é de outro documento: ${documentoDaResposta}`);
    }
  } else if (!aguardando) {
    return false;
  } else {
    // Respostas sem documento (ex.: "não encontrado", bloqueio por frequência) só valem vindas do número do sistema.
    const remetentes = [mensagem.key.participantPn, mensagem.key.senderPn, mensagem.key.participant].filter(Boolean);
    if (!remetentes.some((jid) => soDigitos(jid.split('@')[0].split(':')[0]) === numeroSistema())) return ignorar(`sem documento e o remetente não é o do /sistema (${numeroSistema()})`);
  }
  const resolve = esperando.resolve;
  esperando.resolve = null;
  esperando.doc = null;
  resolve(textoExtraido);
  return true;
}

function consultarDoc(sock, enviar, chatId, doc, signal) {
  const tarefa = filaConsultas.then(async () => {
    verificarCancelamento(signal);
    const comando = comandoParaDoc(doc);
    if (!comando) return { doc, erro: 'documento ausente ou inválido' };
    grupoDasConsultas = chatId;
    // Documento já respondido antes (outro processo ou resposta atrasada): usa a resposta guardada, sem enviar nem esperar.
    const guardada = lerCache(soDigitos(doc));
    if (guardada) {
      log.info(`${comando}: usando a resposta guardada (sem enviar ao grupo)`);
      return analisarResposta(sock, comando, doc, guardada);
    }
    // Espera só o que falta para completar o intervalo desde o último envio (não o intervalo inteiro de novo).
    const falta = INTERVALO_MS - (Date.now() - ultimaConsultaEm);
    if (falta > 0) await esperar(falta, signal);
    verificarCancelamento(signal);
    let timer;
    let cancelar;
    const resposta = new Promise((resolve, reject) => {
      timer = setTimeout(() => resolve(null), TIMEOUT_RESPOSTA_MS);
      cancelar = () => reject(criarErroCancelamento());
      signal?.addEventListener('abort', cancelar, { once: true });
      esperando.chatId = chatId;
      esperando.doc = soDigitos(doc);
      esperando.vistas = [];
      esperando.resolve = resolve;
    });
    const inicioEnvio = Date.now();
    try {
      await enviar(sock, chatId, { text: comando });
    } catch (e) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelar);
      esperando.resolve = null;
      if (e?.name === 'AbortError') throw e;
      throw new Error(`o WhatsApp recusou o envio de ${comando.split(' ')[0]} ao grupo (${e.message}); confira se o bot pode enviar mensagens nesse grupo`);
    }
    ultimaConsultaEm = Date.now();
    enviadosRecentes.set(soDigitos(doc), ultimaConsultaEm);
    for (const [d, em] of enviadosRecentes) if (ultimaConsultaEm - em > 3600000) enviadosRecentes.delete(d);
    // Envio lento num grupo grande aparece aqui (inclui a espera na fila de envio do bot).
    const duracaoEnvio = Math.round((Date.now() - inicioEnvio) / 1000);
    log.info(`${comando} enviado ao grupo${lerConfigGrupo()?.nome ? ` "${lerConfigGrupo().nome}"` : ''}${duracaoEnvio >= 5 ? ` (o envio levou ${duracaoEnvio}s)` : ''}; aguardando a resposta`);
    let texto;
    try {
      texto = await resposta;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancelar);
      esperando.resolve = null;
    }
    if (texto === null) {
      const vistas = esperando.vistas;
      log.warn(`Sem resposta a ${comando} em ${TIMEOUT_RESPOSTA_MS / 1000}s. Mensagens que o bot viu no grupo nesse tempo: ${vistas.length ? vistas.slice(0, 5).join(' | ') : 'nenhuma'}`);
      return { doc, erro: `sem resposta em ${TIMEOUT_RESPOSTA_MS / 1000}s` };
    }
    if (/consultando\s+muito\s+r[aá]pido/i.test(texto)) {
      return { doc, erro: 'o sistema limitou a consulta por frequência' };
    }
    return analisarResposta(sock, comando, doc, texto);
  });
  filaConsultas = tarefa.catch(() => {});
  return tarefa;
}

async function analisarResposta(sock, comando, doc, texto) {
  const analisado = parseRespostaSistema(texto);
  await marcarWhatsApp(sock, analisado);
  log.info(`Resposta do sistema para ${comando.split(' ')[0]}: ${analisado.telefones.length} telefone(s), ${analisado.telefones.filter((t) => t.whatsapp).length} com WhatsApp`);
  const titulos = texto.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => /^[•▪●◆➤➜]/.test(l) || /N[ÚU]MEROS|TELEFONE|CELULAR|FONE/i.test(l));
  log.debug(`Seções da resposta: ${titulos.join(' | ').slice(0, 600) || '(nenhuma)'} · ${texto.length} caracteres`);
  log.debug(`Resposta bruta do sistema: ${JSON.stringify(texto.slice(0, 1500))}`);
  return { doc, ...analisado, bruto: texto.slice(0, 3000) };
}

// Linhas de telefones e renda de uma parte, para entrar logo abaixo dela na mensagem do processo.
function linhasContato(r) {
  if (!r) return [];
  // Sem documento (processo sigiloso, por exemplo) não houve consulta: não há o que avisar.
  if (r.erro === 'documento ausente ou inválido') return [];
  if (r.erro) return [`   ⚠️ Consulta de contatos: ${r.erro}`];
  if (r.naoEncontrado) return ['   Dados não encontrados no sistema para este documento'];
  const l = [];
  if (r.nascimento) l.push(`   Nascimento: ${r.nascimento}`);
  if (r.capitalSocial || r.faturamento) {
    l.push(`   Capital social: ${r.capitalSocial || 'não informado'}`);
    l.push(`   Faturamento: ${r.faturamento || 'não informado'}`);
  } else {
    l.push(`   Renda: ${r.renda || 'não informada'}`);
  }
  if (r.formato === 'lista') {
    // Este formato não informa quem tem WhatsApp: mostra só os que a conferência no WhatsApp marcou.
    const MAX = 10;
    const comWhatsApp = r.telefones.filter((t) => t.whatsapp);
    if (comWhatsApp.length === 0) l.push('   Telefones com WhatsApp: nenhum encontrado');
    else {
      for (const t of comWhatsApp.slice(0, MAX)) l.push(`   ${t.numero}${t.detalhe ? ` ${t.detalhe}` : ''} - WhatsApp`);
      if (comWhatsApp.length > MAX) l.push(`   ... e mais ${comWhatsApp.length - MAX}`);
    }
    return l;
  }
  if (r.whatsappNaoVerificado) {
    // Não deu para conferir no WhatsApp: mostra todos, sem afirmar quais têm conta.
    l.push(`   Telefones (${r.telefones.length}, WhatsApp não verificado):`);
    for (const t of r.telefones.slice(0, 10)) l.push(`   • ${t.numero}`);
    return l;
  }
  const telefonesWhatsApp = r.telefones.filter((telefone) => telefone.whatsapp);
  if (telefonesWhatsApp.length === 0) l.push('   Telefones com WhatsApp: nenhum encontrado');
  else for (const t of telefonesWhatsApp) l.push(`   ${t.numero}${t.operadora ? ` - ${t.operadora}` : ''} - WhatsApp`);
  return l;
}

// Grupo de consultas escolhido pelo comando /grupo (dados/config-grupo.json); sem ele, usa o convite padrão do .env.
function lerConfigGrupo() {
  try { return JSON.parse(fs.readFileSync(ARQUIVO_CONFIG_GRUPO, 'utf8')); } catch { return null; }
}

function extrairCodigoConvite(entrada) {
  const valor = String(entrada || '').trim();
  const codigo = /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i.exec(valor)?.[1] || valor;
  if (!/^[A-Za-z0-9_-]{10,}$/.test(codigo)) throw new Error('Link ou código de convite inválido. Exemplo: https://chat.whatsapp.com/ABCdef123...');
  return codigo;
}

async function resolverGrupo(sock) {
  const config = lerConfigGrupo();
  if (config?.id) return config.id;
  const info = await sock.groupGetInviteInfo(CONVITE_PADRAO);
  return info.id;
}

// Define o grupo para onde o bot envia /cpf e /cnpj. Valida o convite e garante que o bot participa do grupo.
async function definirGrupoConsultas(sock, entrada) {
  const convite = extrairCodigoConvite(entrada);
  const info = await sock.groupGetInviteInfo(convite).catch(() => {
    throw new Error('O WhatsApp não reconheceu esse convite (link redefinido ou inválido).');
  });
  if (!info?.id?.endsWith('@g.us')) throw new Error('O convite não retornou um grupo válido.');

  let entrou = false;
  try {
    await sock.groupMetadata(info.id);
  } catch {
    try {
      await sock.groupAcceptInvite(convite);
      entrou = true;
    } catch {
      throw new Error('O bot não participa desse grupo e não conseguiu entrar pelo link (pode exigir aprovação de um administrador).');
    }
  }

  fs.mkdirSync(PASTA, { recursive: true });
  salvarConfigGrupo({ convite, id: info.id, nome: info.subject || null, atualizado_em: new Date().toISOString() });
  return { id: info.id, nome: info.subject || null, entrou };
}

// Diagnóstico do grupo de consultas: mostra como o WhatsApp enxerga o bot no grupo e tenta enviar uma mensagem de teste.
async function diagnosticarGrupo(sock) {
  const config = lerConfigGrupo();
  const id = config?.id || await sock.groupGetInviteInfo(CONVITE_PADRAO).then((info) => info.id).catch(() => null);
  if (!id) return ['❌ Não há grupo salvo e o convite padrão não foi reconhecido. Use /grupo com o link atual.'];

  const linhas = [`Grupo: ${config?.nome || '(convite padrão)'} (${id})`];
  const numeroDe = (jid = '') => String(jid).split('@')[0].split(':')[0].replace(/\D/g, '');
  const idsDe = (p) => [p.id, p.lid, p.phoneNumber].filter(Boolean).map(numeroDe);
  try {
    const meta = await sock.groupMetadata(id);
    const meus = [sock.user?.id, sock.user?.lid].filter(Boolean).map(numeroDe);
    const eu = meta.participants.find((p) => idsDe(p).some((n) => meus.includes(n)));
    linhas.push(`Participantes: ${meta.participants.length}`);
    linhas.push(`Bot na lista do grupo: ${eu ? (eu.admin ? 'sim, administrador' : 'sim, participante comum') : 'NÃO aparece'}`);
    linhas.push(`Só administradores enviam mensagens: ${meta.announce ? 'SIM' : 'não'}`);
    linhas.push(`Aprovação de administrador para entrar: ${meta.joinApprovalMode ? 'sim' : 'não'}`);
    const sistema = meta.participants.some((p) => idsDe(p).includes(numeroSistema()));
    linhas.push(`Número do sistema (${numeroSistema()}) no grupo: ${sistema ? 'sim' : 'não encontrado'}`);
  } catch (e) {
    linhas.push(`Não consegui ler os dados do grupo (${e.message}).`);
  }
  try {
    await sock.sendMessage(id, { text: '🔧 Teste do bot (pode ignorar).' });
    linhas.push('Envio de teste: OK ✅');
  } catch (e) {
    linhas.push(`Envio de teste: FALHOU (${e.message}${e.data ? ` / ${e.data}` : ''}) ❌`);
  }
  return linhas;
}

// A configuração guarda o grupo (/grupo) e o número do sistema (/sistema); cada comando preserva o que o outro salvou.
function salvarConfigGrupo(parcial) {
  fs.mkdirSync(PASTA, { recursive: true });
  fs.writeFileSync(ARQUIVO_CONFIG_GRUPO, JSON.stringify({ ...(lerConfigGrupo() || {}), ...parcial }, null, 2), 'utf8');
}

// Número cujas respostas ao /cpf e /cnpj o bot aceita: o definido por /sistema, ou o do .env, ou o padrão.
function numeroSistema() {
  return lerConfigGrupo()?.numero_sistema || NUMERO_SISTEMA_PADRAO;
}

function definirNumeroSistema(entrada) {
  const numero = soDigitos(entrada);
  if (numero.length < 10 || numero.length > 15) {
    throw new Error('Número inválido. Informe com DDI e DDD, só dígitos. Exemplo: 5521979245142');
  }
  salvarConfigGrupo({ numero_sistema: numero });
  return numero;
}

function grupoConsultasAtual() {
  const config = lerConfigGrupo();
  return config?.id ? { convite: config.convite, nome: config.nome, id: config.id } : { convite: CONVITE_PADRAO, nome: null, id: null, padrao: true };
}

// Consulta no grupo o documento do autor e depois o do réu de um processo (r = dados da lista do eproc).
// Devolve { autor: [linhas], reu: [linhas] } para entrar na mensagem do processo.
async function consultarPartes(sock, enviar, r, signal) {
  verificarCancelamento(signal);
  const chatId = await resolverGrupo(sock).catch((e) => {
    throw new Error(`não consegui localizar o grupo de consultas (${e.message}); use /grupo com o link atual`);
  });
  verificarCancelamento(signal);
  const autor = await consultarDoc(sock, enviar, chatId, r.ident_autor, signal);
  fs.mkdirSync(PASTA, { recursive: true });
  fs.writeFileSync(path.join(PASTA, `teste-grupo-${r.nr_processo}.json`), JSON.stringify({ autor }, null, 2), 'utf8');
  return {
    autor: linhasContato(autor),
    reu: [],
    nomes: { autor: autor.nome },
    // Consulta respondida e conferida no WhatsApp, sem nenhum número com conta: o processo não é enviado.
    semWhatsApp: !autor.erro && !autor.whatsappNaoVerificado && !(autor.telefones || []).some((t) => t.whatsapp),
  };
}

module.exports = { linhasContato, definirNumeroSistema, numeroSistema, diagnosticarGrupo, definirGrupoConsultas, grupoConsultasAtual, consultarPartes, tratarMensagemDoGrupo, parseRespostaSistema, comandoParaDoc };
