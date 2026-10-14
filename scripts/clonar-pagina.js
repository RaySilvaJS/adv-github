// Copia a página inicial de um site para uma pasta, deixando-a independente do site original.
// Uso: node scripts/clonar-pagina.js <url> [pasta] [--manter-js]
//   Sai em <pasta>/index.html + <pasta>/assets/ (CSS, fontes, imagens), com os caminhos já trocados por locais.
//   Por padrão tira os <script>: a página fica fiel ao visual (um "retrato"), sem menus/carrosséis dinâmicos.
//   --manter-js  mantém e baixa os scripts (pode quebrar em sites feitos com React/Vue, que dependem do servidor).
// Só aceita os sites da lista PERMITIDOS (os seus). Para outro endereço seu: --confirmo-que-o-site-e-meu.
// No final confere a cópia: abre index.html e lista qualquer pedido que ainda saia para a internet.

const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PERMITIDOS = ['jessiphones.com', 'localhost', '127.0.0.1'];
const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith('--')));
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const URL_SITE = args[0];
const SAIDA = path.resolve(args[1] || 'copia-site');
const MANTER_JS = flags.has('--manter-js');

const EXTENSAO = {
  'text/css': '.css', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'image/gif': '.gif', 'image/avif': '.avif', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
  'application/font-woff2': '.woff2', 'application/font-woff': '.woff', 'application/x-font-ttf': '.ttf',
  'application/javascript': '.js', 'text/javascript': '.js', 'video/mp4': '.mp4',
};

const semHash = (u) => { const x = new URL(u); x.hash = ''; return x.href; };
const ehCss = (u, tipo) => tipo === 'text/css' || /\.css(\?|$)/i.test(u);

function nomeLocal(url, tipo) {
  const u = new URL(url);
  let base = path.basename(u.pathname).replace(/[^\w.\-]/g, '_') || 'arquivo';
  let ext = path.extname(base);
  if (!ext) ext = EXTENSAO[tipo] || '';
  const miolo = base.slice(0, base.length - path.extname(base).length).slice(-50) || 'arquivo';
  return `${crypto.createHash('sha1').update(url).digest('hex').slice(0, 8)}-${miolo}${ext}`;
}

async function main() {
  if (!URL_SITE) throw new Error('Informe o endereço. Ex.: node scripts/clonar-pagina.js https://jessiphones.com');
  const host = new URL(URL_SITE).hostname;
  if (!flags.has('--confirmo-que-o-site-e-meu') && !PERMITIDOS.some((p) => host === p || host.endsWith(`.${p}`))) {
    throw new Error(`"${host}" não está na lista de sites permitidos (${PERMITIDOS.join(', ')}). Se o site é seu, rode de novo com --confirmo-que-o-site-e-meu.`);
  }

  // Usa o navegador do Playwright; se não estiver instalado, o Chrome ou o Edge já presentes na máquina.
  let navegador;
  for (const opcoes of [{}, { channel: 'chrome' }, { channel: 'msedge' }]) {
    try { navegador = await chromium.launch(opcoes); break; } catch { /* tenta o próximo */ }
  }
  if (!navegador) throw new Error('Nenhum navegador encontrado. Instale o Chrome ou rode: npx playwright install chromium');
  const contexto = await navegador.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await contexto.newPage();
  const capturados = new Map(); // url -> { corpo, tipo }
  const falhas = [];

  page.on('response', async (r) => {
    try {
      if (r.status() >= 400 || r.request().method() !== 'GET') return;
      capturados.set(semHash(r.url()), { corpo: await r.body(), tipo: (r.headers()['content-type'] || '').split(';')[0].trim().toLowerCase() });
    } catch { /* resposta sem corpo (redirecionamento) */ }
  });

  async function garantir(url) {
    if (capturados.has(url)) return true;
    try {
      const r = await contexto.request.get(url, { timeout: 25000 });
      if (!r.ok()) { falhas.push(`${r.status()} ${url}`); return false; }
      capturados.set(url, { corpo: await r.body(), tipo: (r.headers()['content-type'] || '').split(';')[0].trim().toLowerCase() });
      return true;
    } catch (e) {
      falhas.push(`erro ${url} (${e.message.split('\n')[0]})`);
      return false;
    }
  }

  console.log(`Abrindo ${URL_SITE} ...`);
  await page.goto(URL_SITE, { waitUntil: 'networkidle', timeout: 90000 });
  // Rola até o fim para disparar imagens que só carregam ao aparecer na tela (lazy load), e volta ao topo.
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 500) {
      window.scrollTo(0, y);
      await new Promise((ok) => setTimeout(ok, 150));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(2500);
  const baseDocumento = await page.evaluate(() => document.baseURI);
  await page.screenshot({ path: path.join(path.dirname(SAIDA), `${path.basename(SAIDA)}-original.png`), fullPage: true }).catch(() => {});

  // 1) Todos os endereços de recursos citados pela página (atributos, estilos embutidos, srcset, lazy load).
  const referencias = await page.evaluate((manterJs) => {
    const urls = new Set();
    const add = (v) => {
      if (!v) return;
      try {
        const u = new URL(v.trim(), document.baseURI);
        if (/^https?:$/.test(u.protocol)) { u.hash = ''; urls.add(u.href); }
      } catch { /* endereço inválido */ }
    };
    const dosEstilos = (t) => { for (const m of (t || '').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) add(m[1]); };
    for (const el of document.querySelectorAll('*')) {
      if (el.tagName === 'A' || el.tagName === 'IFRAME') continue;
      if (el.tagName === 'SCRIPT' && !manterJs) continue;
      for (const a of ['src', 'poster', 'data-src']) add(el.getAttribute(a));
      if (el.tagName === 'LINK') add(el.getAttribute('href'));
      for (const a of ['srcset', 'data-srcset']) (el.getAttribute(a) || '').split(',').forEach((p) => add(p.trim().split(/\s+/)[0]));
      dosEstilos(el.getAttribute('style'));
    }
    document.querySelectorAll('style').forEach((s) => dosEstilos(s.textContent));
    return [...urls];
  }, MANTER_JS);

  // 2) Baixa o que faltou e segue pelos CSS (url(...) e @import dentro deles), até não haver novidades.
  const usados = new Set();
  const fila = [...referencias];
  const referenciasDoCss = (texto, base) => {
    const achadas = [];
    for (const m of texto.matchAll(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?/g)) achadas.push(m[1]);
    for (const m of texto.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) achadas.push(m[1]);
    return achadas.filter((r) => !/^(data:|#|about:)/i.test(r.trim())).map((r) => { try { return semHash(new URL(r.trim(), base).href); } catch { return null; } }).filter(Boolean);
  };
  while (fila.length) {
    const url = fila.shift();
    if (usados.has(url)) continue;
    usados.add(url);
    if (!(await garantir(url))) { usados.delete(url); continue; }
    const { corpo, tipo } = capturados.get(url);
    if (ehCss(url, tipo)) fila.push(...referenciasDoCss(corpo.toString('utf8'), url));
  }

  // 3) Nome local de cada arquivo e CSS reescritos para apontar para a própria pasta assets.
  const mapa = {};
  for (const url of usados) mapa[url] = nomeLocal(url, capturados.get(url).tipo);
  const local = (ref, base) => {
    try { return mapa[semHash(new URL(ref.trim(), base).href)] || null; } catch { return null; }
  };
  const reescreverCss = (texto, base) => texto
    .replace(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?/g, (m, ref) => { const l = local(ref, base); return l ? `@import "./${l}"` : m; })
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, ref) => { if (/^(data:|#)/i.test(ref.trim())) return m; const l = local(ref, base); return l ? `url("./${l}")` : m; });

  fs.rmSync(SAIDA, { recursive: true, force: true });
  fs.mkdirSync(path.join(SAIDA, 'assets'), { recursive: true });
  for (const [url, nome] of Object.entries(mapa)) {
    const { corpo, tipo } = capturados.get(url);
    const destino = path.join(SAIDA, 'assets', nome);
    if (ehCss(url, tipo)) fs.writeFileSync(destino, reescreverCss(corpo.toString('utf8'), url), 'utf8');
    else fs.writeFileSync(destino, corpo);
  }

  // 4) HTML: troca os endereços pelos locais, tira o que prende ao servidor e salva.
  await page.evaluate(({ mapa: m, manterJs }) => {
    const loc = (v) => {
      if (!v) return null;
      try { const u = new URL(v.trim(), document.baseURI); u.hash = ''; return m[u.href] ? `assets/${m[u.href]}` : null; } catch { return null; }
    };
    const css = (t) => (t || '').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (x, q, ref) => { const l = loc(ref); return l ? `url("${l}")` : x; });
    for (const el of document.querySelectorAll('*')) {
      for (const a of ['src', 'poster']) { const l = loc(el.getAttribute(a)); if (l) el.setAttribute(a, l); }
      if (el.tagName === 'IMG' && el.getAttribute('data-src')) { const l = loc(el.getAttribute('data-src')); if (l) el.setAttribute('src', l); }
      if (el.tagName === 'LINK') { const l = loc(el.getAttribute('href')); if (l) el.setAttribute('href', l); }
      for (const a of ['srcset', 'data-srcset']) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const novo = v.split(',').map((p) => { const [u, ...resto] = p.trim().split(/\s+/); return [loc(u) || u, ...resto].join(' '); }).join(', ');
        el.setAttribute(a === 'data-srcset' ? 'srcset' : a, novo);
      }
      if (el.getAttribute('style')) el.setAttribute('style', css(el.getAttribute('style')));
    }
    document.querySelectorAll('style').forEach((s) => { s.textContent = css(s.textContent); });
    document.querySelectorAll('base, link[rel=preload], link[rel=prefetch], link[rel=dns-prefetch], link[rel=preconnect], link[rel=modulepreload]').forEach((e) => e.remove());
    document.querySelectorAll('[integrity], [crossorigin]').forEach((e) => { e.removeAttribute('integrity'); e.removeAttribute('crossorigin'); });
    if (!manterJs) document.querySelectorAll('script, noscript').forEach((e) => e.remove());
  }, { mapa, manterJs: MANTER_JS });
  fs.writeFileSync(path.join(SAIDA, 'index.html'), await page.content(), 'utf8');
  await page.close();

  console.log(`Baixados ${Object.keys(mapa).length} arquivos para ${path.join(SAIDA, 'assets')}.`);
  if (falhas.length) console.log(`Não consegui baixar ${falhas.length}:\n  ${falhas.join('\n  ')}`);

  // 5) Conferência: abre a cópia e lista qualquer coisa que ainda busque na internet.
  const copia = await contexto.newPage();
  await copia.setViewportSize({ width: 1366, height: 900 });
  const externos = [];
  const quebrados = [];
  copia.on('request', (r) => { if (!/^(file:|data:|blob:|about:)/.test(r.url())) externos.push(r.url()); });
  copia.on('requestfailed', (r) => { if (/^file:/.test(r.url())) quebrados.push(r.url()); });
  await copia.goto(`file:///${path.join(SAIDA, 'index.html').replace(/\\/g, '/')}`, { waitUntil: 'load' });
  await copia.waitForTimeout(1500);
  const fontes = await copia.evaluate(async () => { await document.fonts.ready; return [...document.fonts].map((f) => `${f.family}:${f.status}`); });
  await copia.screenshot({ path: path.join(path.dirname(SAIDA), `${path.basename(SAIDA)}-copia.png`), fullPage: true }).catch(() => {});
  await navegador.close();

  console.log('\nConferência da cópia:');
  console.log(externos.length ? `  ⚠ ainda depende da internet (${externos.length}):\n    ${[...new Set(externos)].slice(0, 10).join('\n    ')}` : '  ✔ nenhum pedido sai para a internet (independente do site original)');
  console.log(quebrados.length ? `  ⚠ arquivos locais que não carregaram:\n    ${quebrados.slice(0, 10).join('\n    ')}` : '  ✔ todos os arquivos locais carregaram');
  if (fontes.length) console.log(`  Fontes: ${fontes.join(', ')}`);
  console.log(`\nAbra ${path.join(SAIDA, 'index.html')}. Compare os prints ${path.basename(SAIDA)}-original.png e ${path.basename(SAIDA)}-copia.png.`);
  void baseDocumento;
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
