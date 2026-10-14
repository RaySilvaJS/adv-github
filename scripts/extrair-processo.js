// Extrai da página de detalhes do processo (eproc) os campos que o bot não usa:
// competência, órgão julgador, juiz, processos relacionados, assuntos, partes com advogados e eventos.
// Tudo é opcional: o que não for encontrado fica null/[] e não derruba a coleta.

const entidades = { '&amp;': '&', '&nbsp;': ' ', '&#160;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function texto(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(?:amp|nbsp|#160|lt|gt|quot|#39);/g, (e) => entidades[e])
    .replace(/\s+/g, ' ')
    .trim();
}

function primeiro(regex, html) {
  const m = regex.exec(html);
  return m ? texto(m[1]) || null : null;
}

// Primeiro <span ... tabindex="0">valor</span> depois do rótulo (lblClasse, lblCompetencia...).
function valorDoRotulo(html, idRotulo) {
  return primeiro(new RegExp(`id="${idRotulo}"[\\s\\S]{0,1500}?<span[^>]*tabindex="0"[^>]*>([^<]+)</span>`, 'i'), html);
}

function extrairOrgaoJulgador(html) {
  const i = html.search(/id="lblOrgaoJulgador"/i);
  if (i < 0) return null;
  const trecho = html.slice(i, i + 3000);
  const nome = primeiro(/tabindex="0">\s*([^<]+)<\/span>/i, trecho);
  const fone = primeiro(/Fone:\s*([^<'"]+)/i, trecho);
  const email = primeiro(/Email:\s*([^<'"\s]+)/i, trecho);
  return nome ? { nome, fone, email } : null;
}

function extrairRelacionados(html) {
  const tab = /id="tableRelacionado"[\s\S]*?<\/table>/i.exec(html);
  if (!tab) return [];
  return [...tab[0].matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((linha) => {
    const celulas = [...linha[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => texto(c[1])).filter((c) => c && c !== '|');
    const [numero, tipo, classe, orgao] = celulas;
    return { numero: numero || null, tipo: tipo || null, classe: classe || null, orgao: orgao || null };
  }).filter((r) => r.numero);
}

function extrairAssuntos(html) {
  return [...html.matchAll(/<tr[^>]*data-assunto-principal="(true|false)"[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => {
    const c = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => texto(x[1]));
    return { codigo: c[0] || null, descricao: c[1] || null, principal: m[1] === 'true' };
  });
}

function extrairPartes(html) {
  const tab = /id="tblPartesERepresentantes"[\s\S]*?<\/table>/i.exec(html);
  if (!tab) return [];
  const polos = [...tab[0].matchAll(/<th[^>]*>\s*([^<]+?)\s*<\/th>/gi)].map((m) => texto(m[1]));
  const partes = [];
  for (const linha of tab[0].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    [...linha[1].matchAll(/<td\b[^>]*class=['"][^'"]*\bautorReu\b[^'"]*['"][^>]*>([\s\S]*?)<\/td>/gi)].forEach((celula, coluna) => {
      const c = celula[1];
      const nome = primeiro(/class=['"]infraNomeParte['"][^>]*>\s*(?:<span[^>]*>)?\s*([^<]+)/i, c)
        || primeiro(/class=['"]infraNomeParte['"][^>]*>([^<]+)/i, c);
      if (!nome) return;
      const advogados = [...c.matchAll(/([^<>]*?)<a\b[^>]*>\s*([A-Z]{2}\s*\d{3,8}(?:\s*-?\s*[A-Z])?)\s*<\/a>\s*(?:&nbsp;|&#160;|\s)*<div\b[^>]*class=['"][^'"]*\bsr-only\b[^'"]*['"][^>]*>\s*Tipo de Usuário:\s*([^<]+?)\s*<\/div>/gi)]
        .map((a) => ({ nome: texto(a[1]), oab: a[2].replace(/\s+/g, ''), tipo: texto(a[3]) }))
        .filter((a) => a.nome);
      partes.push({
        polo: polos[coluna] || null,
        nome,
        documento: primeiro(/id="spnCpfParte\w*"[^>]*>\s*([\d.\/-]+)\s*<\/span>/i, c),
        tipo_pessoa: primeiro(/<\/span>\)(?:&nbsp;|\s)*<span[^>]*>\s*-\s*([^<]+)</i, c),
        situacao_citacao: /Citado e sem Procurador/i.test(c) ? 'Citado e sem Procurador' : null,
        advogados,
        ha_mais_partes: /carregarPartes\(/i.test(c),
      });
    });
  }
  return partes;
}

// Só o primeiro bloco de eventos, que já vem na página; os demais o eproc carrega por requisições à parte.
function extrairEventos(html) {
  return [...html.matchAll(/<tr\s+id="trEvento(\d+)"[^>]*?(?:data-parte="([^"]*)")?[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => {
    const c = [...m[3].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => x[1]);
    const usuario = /<span class="sr-only">([\s\S]*?)<\/span>/i.exec(c[3] || '');
    return {
      numero: Number(m[1]),
      data: texto(c[1]) || null,
      descricao: texto(c[2]) || null,
      usuario: usuario ? texto(usuario[1].replace(/<br\s*\/?>/gi, ' - ')).replace(/ - $/, '') : texto(c[3]) || null,
      origem: m[2] || null,
      documentos: texto(c[4]) || null,
    };
  });
}

function extrairExtras(html) {
  return {
    competencia: valorDoRotulo(html, 'lblCompetencia'),
    orgao_julgador: extrairOrgaoJulgador(html),
    juiz: primeiro(/id="txtMagistrado"[^>]*>([^<]*)</i, html),
    relacionados: extrairRelacionados(html),
    assuntos: extrairAssuntos(html),
    partes: extrairPartes(html),
    eventos: extrairEventos(html),
  };
}

module.exports = { extrairExtras };
