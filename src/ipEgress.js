const { isIP } = require('node:net');

const URL_IP_PUBLICO = 'https://api.ipify.org';
const URL_GEOLOCALIZACAO_IP = 'https://ipwho.is';
const VALIDADE_CACHE_MS = 5000;
let ipPublicoEmCache = null;
let cacheExpiraEm = 0;
let ipPermitidoNaInicializacao = null;
let inicializacaoTentada = false;

function erroIpSaida(mensagem, causa) {
  const erro = new Error(mensagem, causa ? { cause } : undefined);
  erro.code = 'EPROC_EGRESS_BLOCKED';
  return erro;
}

async function obterIpPublico() {
  if (ipPublicoEmCache && Date.now() < cacheExpiraEm) return ipPublicoEmCache;

  let ip;
  try {
    const resposta = await fetch(URL_IP_PUBLICO, { signal: AbortSignal.timeout(10000) });
    if (!resposta.ok) {
      throw new Error(`HTTP ${resposta.status}`);
    }
    ip = (await resposta.text()).trim();
  } catch (erro) {
    throw erroIpSaida('Não foi possível verificar o IP de saída; consulta ao eproc bloqueada.', erro);
  }
  if (isIP(ip) !== 4) {
    throw erroIpSaida('O serviço de verificação não retornou um IPv4 público válido; consulta ao eproc bloqueada.');
  }

  ipPublicoEmCache = ip;
  cacheExpiraEm = Date.now() + VALIDADE_CACHE_MS;
  return ip;
}

async function capturarIpSaidaInicial() {
  inicializacaoTentada = true;
  ipPermitidoNaInicializacao = null;
  ipPermitidoNaInicializacao = await obterIpPublico();
  return ipPermitidoNaInicializacao;
}

async function localizarIpPublico(ip) {
  let dados;
  try {
    const resposta = await fetch(`${URL_GEOLOCALIZACAO_IP}/${encodeURIComponent(ip)}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
    dados = await resposta.json();
  } catch (erro) {
    throw new Error('Não foi possível consultar a localização aproximada do IP em ipwho.is.', { cause: erro });
  }

  if (!dados.success || dados.ip !== ip) {
    throw new Error(`ipwho.is não retornou localização para o IP ${ip}: ${dados.message || 'resposta inválida'}.`);
  }

  return {
    cidade: dados.city,
    regiao: dados.region,
    pais: dados.country,
    provedor: dados.connection?.isp || dados.connection?.org,
    fuso: dados.timezone?.id,
  };
}

async function verificarIpSaidaEproc() {
  if (!ipPermitidoNaInicializacao) {
    const motivo = inicializacaoTentada
      ? 'Não foi possível identificar o IP de saída na inicialização; reinicie o bot com a VPN conectada.'
      : 'O IP de saída ainda não foi identificado na inicialização.';
    throw erroIpSaida(`${motivo} Consulta ao eproc bloqueada.`);
  }

  const atual = await obterIpPublico();
  if (atual !== ipPermitidoNaInicializacao) {
    throw erroIpSaida(
      `IP de saída mudou de ${ipPermitidoNaInicializacao} para ${atual}; consulta ao eproc bloqueada.`,
    );
  }
}

module.exports = { capturarIpSaidaInicial, localizarIpPublico, verificarIpSaidaEproc };
