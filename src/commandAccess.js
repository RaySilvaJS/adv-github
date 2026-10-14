function extrairCodigoConvite(convite) {
  const valor = String(convite || '').trim();
  if (!valor) {
    throw new Error('Defina GRUPO_COMANDOS_CONVITE no ambiente do bot.');
  }
  const codigo = /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/i.exec(valor)?.[1] || valor;
  if (!/^[A-Za-z0-9_-]+$/.test(codigo)) {
    throw new Error('GRUPO_COMANDOS_CONVITE não contém um link/código de convite válido.');
  }
  return codigo;
}

function normalizarNumeroWhatsApp(valor) {
  if (typeof valor !== 'string' || /@(?:lid|g\.us)$/i.test(valor)) return '';
  const numeroJid = /@(?:s\.whatsapp\.net|c\.us)$/i.test(valor);
  if (valor.includes('@') && !numeroJid) return '';
  return (numeroJid ? valor.split('@')[0].split(':')[0] : valor).replace(/\D/g, '');
}

function mensagemPodeAtualizarNoPrivado(
  mensagem,
  sock,
  numeroAutorizado = process.env.NUMERO_AUTORIZADO_COMANDOS,
) {
  const numeroEsperado = normalizarNumeroWhatsApp(numeroAutorizado || '');
  if (!numeroEsperado) return false;

  const remetentes = [
    mensagem.key?.remoteJid,
    mensagem.key?.participantPn,
    mensagem.key?.senderPn,
    mensagem.key?.participant,
    ...(mensagem.key?.fromMe ? [sock.user?.id, sock.user?.lid] : []),
  ];
  return remetentes.some((jid) => normalizarNumeroWhatsApp(jid || '') === numeroEsperado);
}

function criarVerificadorGrupo(sock, convite = process.env.GRUPO_COMANDOS_CONVITE) {
  const codigoConvite = extrairCodigoConvite(convite);
  let idGrupoAutorizado;
  let buscaGrupo;

  return async function grupoPodeUsarComandos(chatId) {
    if (!chatId || !chatId.endsWith('@g.us')) return false;
    if (!idGrupoAutorizado) {
      if (!buscaGrupo) {
        buscaGrupo = sock.groupGetInviteInfo(codigoConvite)
          .then((info) => {
            if (!info?.id || !info.id.endsWith('@g.us')) {
              throw new Error('O convite do grupo autorizado não retornou um identificador de grupo válido.');
            }
            idGrupoAutorizado = info.id;
            return idGrupoAutorizado;
          })
          .catch((erro) => {
            buscaGrupo = null;
            throw erro;
          });
      }
      await buscaGrupo;
    }
    return chatId === idGrupoAutorizado;
  };
}

module.exports = {
  criarVerificadorGrupo,
  extrairCodigoConvite,
  mensagemPodeAtualizarNoPrivado,
  normalizarNumeroWhatsApp,
};
