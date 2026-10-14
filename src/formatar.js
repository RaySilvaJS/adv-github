// A resposta do eproc pode trazer quebras de linha cruas dentro das strings (após <br>), o que invalida o JSON.
function parseResposta(texto) {
  return JSON.parse(texto.replace(/[\r\n]+/g, ' '));
}

function limpar(s) {
  return (s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// 00096372220268272722 -> 0009637-22.2026.8.27.2722
function formatarCnj(n) {
  const m = /^(\d{7})(\d{2})(\d{4})(\d)(\d{2})(\d{4})$/.exec(n || '');
  return m ? `${m[1]}-${m[2]}.${m[3]}.${m[4]}.${m[5]}.${m[6]}` : n;
}

function formatarDoc(d) {
  const n = (d || '').replace(/\D/g, '');
  if (n.length === 11) return n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (n.length === 14) return n.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return d || '';
}

function formatarAssuntos(assuntos) {
  return limpar(assuntos)
    .split(/\s*,\s*/)
    .filter((assunto) => assunto && !/^DIREITO\b/i.test(assunto))
    .slice(0, 4)
    .join(', ');
}

function formatarProcesso(r, i, det = {}) {
  const sigilo = r.id_sigilo === '1' ? ' 🔒 SIGILOSO' : '';
  const l = ['━━━━━━━━━━━━━━━━━━', `*${i}. PROCESSO ${formatarCnj(r.nr_processo)}*${sigilo}`];
  const add = (rotulo, valor) => { if (valor) l.push(`${rotulo} ${valor}`); };

  add('💰 *Valor da causa:*', det.erro ? 'falha ao consultar' : det.semInformacoesAdicionais ? 'R$ 0,00' : det.valorCausa || 'não informado');
  if (det.requerente) {
    const q = det.requerente;
    l.push(`👤 *${q.nome}*${q.doc ? ` (${q.doc})` : ''}${q.tipo ? ` - ${q.tipo}` : ''}`);
    if (q.papel) l.push(`   ${q.papel}`);
  }
  if (det.contatos?.autor) {
    l.push(...det.contatos.autor.map((linha) => linha.replace(/^   /, '')));
  }

  // l.push('');
  add('', "‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎‎");
  add('📅 *Autuação:*', r.autuacao);
  add('⚖️ *Situação:*', limpar(r.des_situacao));
  const nomeAutor = limpar(det.contatos?.nomes?.autor || r.autor);
  if (nomeAutor) l.push(`👤 *${nomeAutor}*`);
  add('📌 *Assuntos:*', formatarAssuntos(r.des_assuntos));
  if (det.advogado?.nome) l.push(`🧑‍⚖️ *Advogado:* ${det.advogado.nome}${det.advogado.oab ? ` (${det.advogado.oab})` : ''}`);
  l.push('');
  add('👥 *Réu:*', limpar(det.contatos?.nomes?.reu || r.reu));
  l.push('');
  add('🔔 *Último evento:*', limpar(r.ultimo_evento));
  return l.join('\n');
}

// Retorna lista de mensagens (cada uma até ~limite caracteres) para o WhatsApp.
function formatarResposta(dados, oab, detalhes = {}, limite = 3500) {
  const res = dados.resultados || [];
  if (!res.length) return [`Nenhum processo encontrado para a OAB ${oab}.`];

  const blocos = res.map((r, i) => formatarProcesso(r, i + 1, detalhes[r.nr_processo]));
  const msgs = [];
  let atual = `📋 *${res.length} processo(s) – OAB ${oab}*\n(mais recentes primeiro, resumo)`;
  for (const b of blocos) {
    if ((atual + '\n\n' + b).length > limite) {
      msgs.push(atual);
      atual = b;
    } else {
      atual += '\n\n' + b;
    }
  }
  msgs.push(atual);
  return msgs;
}

module.exports = { formatarResposta, parseResposta, limpar, formatarCnj, formatarDoc };
