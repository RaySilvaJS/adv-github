// Testa como o eproc responde a diferentes formas de escrever uma OAB (principalmente as com letra).
// Uso: node scripts/testar-oab.js TO06830B TO006830B TO6830B TO04873A TO004873A
// Para cada texto mostra quantos processos o eproc devolveu. Usa a sessão salva pelo bot; não faz login.

require('dotenv').config();
const { ARQUIVO_CREDENCIAIS } = require('../src/loginEproc');
require('dotenv').config({ path: ARQUIVO_CREDENCIAIS, override: true });
const { consultarPorOab } = require('../src/eproc');
const { parseResposta } = require('../src/formatar');

const cfg = {
  cookie: process.env.EPROC_COOKIE,
  ajaxHash: process.env.EPROC_AJAX_HASH,
  refererHash: process.env.EPROC_REFERER_HASH,
  userAgent: process.env.EPROC_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
};

async function main() {
  const entradas = process.argv.slice(2);
  if (!entradas.length) throw new Error('Informe ao menos uma OAB. Ex.: node scripts/testar-oab.js TO06830B TO006830B');
  if (!cfg.cookie || !cfg.refererHash) throw new Error('Sem sessão do eproc salva. Faça login pelo bot primeiro.');

  for (const oab of entradas) {
    try {
      // Limite de 60 s: se o eproc não responder, segue para a próxima em vez de ficar parado.
      const limite = new Promise((_, rejeitar) => setTimeout(() => rejeitar(new Error('o eproc não respondeu em 60 s')), 60000).unref());
      const dados = parseResposta(await Promise.race([consultarPorOab(oab, cfg), limite]));
      const lista = dados.resultados || [];
      console.log(`${oab.padEnd(14)} -> ${String(lista.length).padStart(4)} processo(s)${lista[0] ? `  (ex.: ${lista[0].nr_processo})` : ''}`);
    } catch (erro) {
      console.log(`${oab.padEnd(14)} -> erro: ${erro.message}`);
    }
    await new Promise((ok) => setTimeout(ok, 3000));
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
