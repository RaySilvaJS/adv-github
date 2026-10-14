const fs = require('fs');
const path = require('path');

const ARQUIVO_ENV = path.join(__dirname, '..', '.env');

// Lê um curl colado (bash ou cmd do Chrome) e devolve os dados que o .env precisa.
// Só preenche o que encontrar; o resto fica ausente.
function parseCurl(texto) {
  let t = String(texto || '').replace(/\r/g, '');
  if (/\^"/.test(t)) t = t.replace(/\^\n/g, ' ').replace(/\^(.)/g, '$1'); // curl "cmd" do Chrome
  t = t.replace(/\\\n/g, ' ').replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

  const argumentos = [...t.matchAll(/(-H|--header|-b|--cookie)\s+(?:'([^']*)'|"((?:[^"\\]|\\.)*)")/g)]
    .map((m) => ({ flag: m[1], valor: m[2] ?? m[3] }));

  const cabecalho = (nome) => {
    const re = new RegExp(`^${nome}\\s*:\\s*(.*)$`, 'i');
    for (const a of argumentos) {
      if (a.flag !== '-H' && a.flag !== '--header') continue;
      const m = re.exec(a.valor.trim());
      if (m) return m[1].trim();
    }
    return null;
  };

  const cookie = cabecalho('cookie') || (argumentos.find((a) => a.flag === '-b' || a.flag === '--cookie') || {}).valor || null;
  const referer = cabecalho('referer');
  const ajax = /processos_consulta_por_oab(?:&amp;|&)hash=([0-9a-f]{32})/i.exec(t);
  const refHash = referer && /hash=([0-9a-f]{32})/i.exec(referer);
  // Se o curl for da própria página de busca, o hash dela está na URL.
  const paginaBusca = /acao=pesquisa_processo_por_num_oab(?:&amp;|&)hash=([0-9a-f]{32})/i.exec(t);

  const r = {};
  if (cookie) r.EPROC_COOKIE = cookie.trim();
  if (ajax) r.EPROC_AJAX_HASH = ajax[1];
  if (refHash) r.EPROC_REFERER_HASH = refHash[1];
  else if (paginaBusca) r.EPROC_REFERER_HASH = paginaBusca[1];
  const ua = cabecalho('user-agent');
  if (ua) r.EPROC_USER_AGENT = ua;
  return r;
}

// Atualiza ou acrescenta as chaves no .env, preservando o resto do arquivo.
function atualizarEnv(valores, arquivo = ARQUIVO_ENV) {
  const linhas = fs.existsSync(arquivo) ? fs.readFileSync(arquivo, 'utf8').split(/\r?\n/) : [];
  for (const [chave, valor] of Object.entries(valores)) {
    const i = linhas.findIndex((l) => l.startsWith(`${chave}=`));
    const conteudo = String(valor);
    const serializado = /[\s#"'\\]/.test(conteudo) ? JSON.stringify(conteudo) : conteudo;
    const nova = `${chave}=${serializado}`;
    if (i >= 0) linhas[i] = nova;
    else linhas.push(nova);
  }
  fs.writeFileSync(arquivo, linhas.join('\n').replace(/\n*$/, '\n'), 'utf8');
}

module.exports = { parseCurl, atualizarEnv };
