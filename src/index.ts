import dotenv from "dotenv";
import path from "path";
import fs from "fs";
// Standalone: .env na pasta raiz do projeto (um nível acima de dist/)
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });
import { chromium } from "playwright";
import type { Frame, Page } from "playwright";

const apiUrl = process.env.API_URL ?? "http://localhost:3001";
const raswebUrl = process.env.RASWEB_URL ?? "https://rasweb.pcivil.rj.gov.br/";
const raswebUsername = process.env.RASWEB_USERNAME;
const raswebPassword = process.env.RASWEB_PASSWORD;

// Pasta de logs organizada por execução — cada run gera uma subpasta com timestamp
const runId = new Date().toISOString().slice(0, 19).replace("T", "_").replace(/:/g, "-");
const runDir = path.resolve(__dirname, "../logs", runId);
fs.mkdirSync(runDir, { recursive: true });

// Mantém debugDir apontando para runDir para compatibilidade com diagnóstico
const debugDir = runDir;

const MODO_DIAGNOSTICO = process.env.MODO_DIAGNOSTICO === "true";
const MODO_TESTE_RESERVA = process.env.MODO_TESTE_RESERVA === "true";
const FORCAR_EXECUCAO = process.env.FORCAR_EXECUCAO === "true";

const INTERVALO_MIN_MS = parseInt(process.env.INTERVALO_MIN_MS ?? "45000");
const INTERVALO_MAX_MS = parseInt(process.env.INTERVALO_MAX_MS ?? "90000");
const TIMEOUT_VAGAS_MS = parseInt(process.env.TIMEOUT_VAGAS_MS ?? "300000");
const POLLING_ASMX_MS = parseInt(process.env.POLLING_ASMX_MS ?? "1000");
// Quantos minutos antes do horário de abertura o robô entra em modo de disparo (polling agressivo)
const MINUTOS_ANTECIPACAO = parseInt(process.env.MINUTOS_ANTECIPACAO ?? "3");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.120 Safari/537.36",
];

function aleatorio(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}


function salvarDebug(nome: string, conteudo: string) {
  try {
    fs.writeFileSync(path.join(runDir, `${nome}.txt`), conteudo, "utf8");
  } catch { /* ignora */ }
}

async function screenshot(page: Page, nome: string) {
  try {
    // timeout de 6s — evita bloquear o fluxo se a página estiver carregando lentamente
    await page.screenshot({ path: path.join(runDir, `${nome}.png`), fullPage: true, timeout: 6000 });
  } catch { /* ignora */ }
}

// Captura o HTML completo de um frame e salva em runDir com extensão .html.
// Usa Promise.race com 5s de timeout — frame.content() pode travar indefinidamente
// se o frame estiver em estado de loading/redirect após login ou navegação.
async function capturarHtml(frameOrPage: Page | Frame, nome: string) {
  try {
    const timeoutPromise = new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("capturarHtml timeout")), 5000)
    );
    const html = await Promise.race([
      (frameOrPage as Page).content(),
      timeoutPromise
    ]).catch(() => "");
    if (html) fs.writeFileSync(path.join(runDir, `${nome}.html`), html, "utf8");
  } catch { /* ignora */ }
}

function escreverLog(linha: string) {
  try {
    fs.appendFileSync(path.join(runDir, "execucao.log"), linha + "\n", "utf8");
  } catch { /* ignora — nunca travar a execução por causa do log */ }
}

async function log(level: "info" | "warn" | "error", message: string) {
  const ts = new Date().toLocaleString("pt-BR", { hour12: false });
  const linha = `[${ts}] [${level.toUpperCase()}] ${message}`;
  console.log(linha);
  escreverLog(linha);
  const workerKey = process.env.WORKER_API_KEY;
  if (!workerKey) return;
  try {
    await fetch(`${apiUrl}/logs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-worker-key": workerKey
      },
      body: JSON.stringify({ level, message })
    });
  } catch { /* API offline */ }
}

// ─── SELEÇÃO DE MODALIDADE POR DIA DO MÊS ────────────────────────────────────

type Modalidade = "extensao" | "presente";

const DIAS_RAS_PRESENTE = [5, 20];
const DIA_RAS_EXTENSAO = 21;

// URL de cada modalidade
const URL_MODALIDADE: Record<Modalidade, string> = {
  presente: "FRMRESERVAPRESENTE.ASPX",
  extensao: "FRMRESERVARVAGASERVIDOR.ASPX"
};

function detectarModalidade(): Modalidade | null {
  const diaMes = new Date().getDate();
  if (DIAS_RAS_PRESENTE.includes(diaMes)) return "presente";
  if (diaMes === DIA_RAS_EXTENSAO) return "extensao";
  return null;
}

// ─── ENTRY POINT ──────────────────────────────────────────────────────────────

async function runAutomation() {
  await log("info", "Automation Worker iniciado");
  await log("info", `Logs desta execução: ${runDir}`);


  if (!raswebUsername || !raswebPassword) {
    await log("warn", "Credenciais RASWEB nao configuradas");
    return;
  }

  // MODO_DIAGNOSTICO, MODO_TESTE_RESERVA e FORCAR_EXECUCAO ignoram a checagem de dia
  const modoForcado = MODO_DIAGNOSTICO || MODO_TESTE_RESERVA || FORCAR_EXECUCAO;
  const modalidadeDetectada = detectarModalidade();
  const modalidadeForcada: Modalidade = (process.env.DIAGNOSTICO_MODALIDADE === "presente") ? "presente" : "extensao";
  const modalidade: Modalidade = modalidadeDetectada ?? modalidadeForcada;

  if (!modalidadeDetectada && !modoForcado) {
    const diaMes = new Date().getDate();
    await log("info", `Dia ${diaMes} — nenhuma modalidade ativa hoje (RAS Presente: dias 5 e 20 | RAS Extensão: dia 21). Encerrando.`);
    return;
  }

  if (!modalidadeDetectada && modoForcado) {
    await log("info", `Modo forçado ativo — usando modalidade: ${modalidade === "presente" ? "RAS Presente" : "RAS Extensão"}`);
  } else {
    await log("info", `Modalidade detectada: ${modalidade === "presente" ? "RAS Presente" : "RAS Extensão"} (dia ${new Date().getDate()})`);
  }

  const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
  const proxyUrl = process.env.PROXY_URL;
  if (proxyUrl) {
    await log("info", `Proxy configurado: ${proxyUrl.replace(/:([^:@]+)@/, ":***@")}`);
  }
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await chromium.launch({
    headless,
    ...(proxyUrl ? { proxy: { server: proxyUrl } } : {}),
    ...(executablePath ? { executablePath } : {}),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-infobars",
      "--disable-dev-shm-usage"
    ]
  });

  try {
    const userAgent = USER_AGENTS[aleatorio(0, USER_AGENTS.length - 1)];
    const context = await browser.newContext({
      userAgent,
      locale: "pt-BR",
      extraHTTPHeaders: {
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt"] });
    });

    await page.goto(raswebUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await loginToRasweb(page, raswebUsername, raswebPassword);
    await log("info", "Login RASWEB executado.");

    // Captura HTML pós-login para diagnóstico
    const framePosLogin = page.frame({ name: "central" }) ?? page;
    await capturarHtml(framePosLogin, "01_pos-login");
    await screenshot(page, "01_pos-login");

    process.once("SIGINT", async () => {
      await log("info", "Encerrando — fazendo logout...");
      const fSigint = page.frame({ name: "central" }) ?? page;
      await capturarHtml(fSigint, "SIGINT_estado-ao-encerrar");
      await logoutRasweb(page);
      await browser.close();
      process.exit(0);
    });

    if (MODO_DIAGNOSTICO) {
      await diagnosticarSite(page);
      await logoutRasweb(page);
      await browser.close();
      return;
    }

    const navegou = await navegarParaReservarVagas(page, modalidade);
    if (!navegou) {
      await log("error", "Falha crítica de navegação — encerrando sessão.");
      await logoutRasweb(page);
      await browser.close();
      return;
    }

    // Captura HTML da tela de reserva após navegação
    const frameTela = page.frame({ name: "central" }) ?? page;
    await capturarHtml(frameTela, "02_tela-reserva");
    await screenshot(page, "02_tela-reserva");

    let fecharBrowser: boolean;
    if (MODO_TESTE_RESERVA) {
      fecharBrowser = await testarFluxoReserva(page);
    } else {
      await carregarCalendario(page, modalidade);
      // Captura HTML no momento em que as vagas foram detectadas
      const frameVagas = page.frame({ name: "central" }) ?? page;
      await capturarHtml(frameVagas, "03_vagas-detectadas");
      fecharBrowser = await selecionarDPEReservar(page);
    }

    await log("info", `Logs salvos em: ${runDir}`);

    if (fecharBrowser) {
      await browser.close();
    } else {
      await log("info", "Browser mantido aberto. Feche a janela manualmente quando terminar, ou pressione Ctrl+C.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro desconhecido";
    // "Target page, context or browser has been closed" é erro de navegação de frame (não fatal).
    // Só tratamos como fatal erros que impedem completamente o browser de funcionar.
    const erroFatal = message.includes("browserType.launch") ||
                      message === "Target closed" ||
                      message.startsWith("Browser closed");
    await log("error", `Erro inesperado: ${message}`);
    // Captura o estado da página no momento do erro para diagnóstico
    try {
      const frameErro = browser.contexts()[0]?.pages()[0]?.frame({ name: "central" })
                     ?? browser.contexts()[0]?.pages()[0];
      if (frameErro) await capturarHtml(frameErro, "ERRO_pagina-no-momento-do-erro");
    } catch { /* ignora */ }
    await log("info", `Logs salvos em: ${runDir}`);
    if (erroFatal) {
      await browser.close().catch(() => undefined);
      process.exitCode = 1;
    } else {
      await log("warn", "Browser mantido aberto para operação manual. Feche a janela ou pressione Ctrl+C.");
    }
  }
}

void runAutomation();

// ─── DIAGNÓSTICO ──────────────────────────────────────────────────────────────

async function diagnosticarSite(page: Page) {
  await log("info", "=== MODO DIAGNÓSTICO ATIVO ===");

  // Loga todos os frames disponíveis para entender a estrutura do site
  await page.waitForTimeout(1500);
  const todosFrames = page.frames().map(f => `  [${f.name() || "(sem-nome)"}] ${f.url()}`).join("\n");
  await log("info", `Frames disponíveis:\n${todosFrames}`);
  salvarDebug("00-frames", todosFrames);

  const frame = await aguardarFrameCentral(page);
  const frameUrl = (frame as { url?: () => string }).url?.() ?? "(page)";
  await log("info", `Frame central selecionado: ${frameUrl}`);
  await screenshot(page, "01-pos-login");

  const textoInicial = await frame.evaluate(() => document.body?.innerText ?? "");
  salvarDebug("01-texto-pos-login", textoInicial);
  await log("info", `Texto pós-login:\n${textoInicial.slice(0, 800)}`);

  const links = await frame.evaluate(() =>
    [...document.querySelectorAll("a")].map(a => ({
      id: a.id,
      text: a.textContent?.trim(),
      href: (a as HTMLAnchorElement).href,
      onclick: a.getAttribute("onclick")
    })).filter(l => l.text)
  );
  salvarDebug("02-links-menu", JSON.stringify(links, null, 2));
  await log("info", `Links encontrados: ${links.map(l => `"${l.text}"`).join(", ")}`);

  // Navega para a tela de reserva e captura HTML + JS do calendário
  const paginaDiag = process.env.DIAGNOSTICO_MODALIDADE === "presente"
    ? "FRMRESERVAPRESENTE.ASPX"
    : "FRMRESERVARVAGASERVIDOR.ASPX";
  await log("info", `Navegando para ${paginaDiag}...`);
  try {
    // Navega via window.location.href no frame — bypassa o WAF (403 afeta frame.goto() do Playwright)
    // "RAS Presente"/"RAS Extensão" são <span class="AspNet-Menu-NonLink">, não <a>, então
    // hover em a:has-text não funciona. JS navigation é a abordagem mais confiável.
    const linkSel = `a[href*="${paginaDiag}" i]`;
    const linkHref = await frame.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLAnchorElement | null;
      return el?.href ?? null;
    }, linkSel);
    if (linkHref) {
      await frame.evaluate((href) => { window.location.href = href; }, linkHref);
    }
    await page.waitForTimeout(3000).catch(() => undefined);
    const frameApos = page.frame({ name: "central" });
    await log("info", `URL do frame após navegação: ${frameApos?.url() ?? "(não encontrado)"}`);
    await screenshot(page, "02-reservar-vagas");

    // Usa o frame atualizado (pós-navegação) para capturar conteúdo da tela de reserva
    const frameReserva = frameApos ?? frame;
    const textoReserva = await frameReserva.evaluate(() => document.body?.innerText ?? "");
    salvarDebug("02-texto-reservar-vagas", textoReserva);
    await log("info", `Tela Reservar Vagas:\n${textoReserva.slice(0, 1000)}`);

    const htmlReserva = await frameReserva.content();
    salvarDebug("03-html-reservar-vagas", htmlReserva);

    // Busca e salva o JS do calendário para entender os handlers onclick dos dias
    const jsCalendario = await frameReserva.evaluate(async () => {
      try {
        const res = await fetch("usercontrol/ReservarVagaServidor.ascx.js", { credentials: "include" });
        return await res.text();
      } catch {
        return "Não foi possível carregar o JS";
      }
    });
    salvarDebug("07-reservavagaservidor-js", jsCalendario);
    await log("info", `JS do calendário salvo (${jsCalendario.length} chars)`);

    const elementos = await frameReserva.evaluate(() =>
      [...document.querySelectorAll("td, a, input, select, button, span[onclick]")].map(el => ({
        tag: el.tagName,
        id: el.id,
        class: el.className,
        text: el.textContent?.trim().slice(0, 60),
        href: (el as HTMLAnchorElement).href,
        onclick: el.getAttribute("onclick"),
        disabled: (el as HTMLInputElement).disabled,
        style: (el as HTMLElement).getAttribute("style")
      })).filter(e => e.text || e.onclick || e.href)
    );
    salvarDebug("04-elementos-calendario", JSON.stringify(elementos, null, 2));
    await log("info", `Elementos mapeados: ${elementos.length}`);
    await log("info", `Amostra: ${JSON.stringify(elementos.slice(0, 10), null, 2)}`);
  } catch (e) {
    await log("error", `Erro ao acessar Reservar Vagas: ${(e as Error).message}`);
  }

  await log("info", `Arquivos salvos em ${debugDir}/`);
  await log("info", "=== DIAGNÓSTICO CONCLUÍDO ===");
}

// ─── MODO TESTE — simula hddias com datas disponíveis para validar o fluxo ───

async function testarFluxoReserva(page: Page): Promise<boolean> {
  await log("info", "=== MODO TESTE DE RESERVA ===");
  const frame = await aguardarFrameCentral(page);

  // Aguarda o AJAX do pageLoad() terminar antes de injetar (gif_load some quando o AJAX conclui)
  await frame.waitForFunction(
    () => {
      const gif = document.querySelector('[id$="gif_load"]') as HTMLElement | null;
      return !gif || gif.style.display === "none" || gif.offsetParent === null;
    },
    { timeout: 8000 }
  ).catch(() => undefined);

  // Tenta selecionar delegacia real; se não houver, injeta uma fake para testar o fluxo completo
  const opcoesTeste = await obterOpcoesDelegacia(frame);
  if (opcoesTeste.length > 0) {
    await log("info", `[TESTE] Selecionando delegacia real: ${opcoesTeste[0].text}`);
    await selecionarDelegaciaEAguardarDias(page, frame, opcoesTeste[0].value);
  } else {
    await log("info", "[TESTE] Nenhuma delegacia no dropdown (dia não-reserva) — popup será testado com vaga fake.");
  }

  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth() + 1;
  // Usa próximo mês para garantir datas futuras — o RASWEB não exibe vagas para datas passadas
  const mesProximo = mes === 12 ? 1 : mes + 1;
  const anoProximo = mes === 12 ? ano + 1 : ano;
  const dataFake = `${anoProximo}-${mesProximo}-5,${anoProximo}-${mesProximo}-20`;

  // Injeta e verifica se o elemento existe
  const injetou = await frame.evaluate((datas) => {
    const hddias = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    const txtVagas = document.querySelector('[id$="txt_vagas_disp"]') as HTMLInputElement | null;
    if (!hddias) return { ok: false, motivo: "hddias não encontrado no DOM" };
    hddias.value = `"${datas}"`;
    if (txtVagas) txtVagas.value = "10";
    // Lê de volta para confirmar
    return { ok: true, valorLido: hddias.value };
  }, dataFake);

  await screenshot(page, "teste-01-hddias-injetado");

  if (!injetou.ok) {
    await log("error", `Injeção falhou: ${injetou.motivo}. Listando elementos disponíveis...`);
    const elementos = await frame.evaluate(() =>
      [...document.querySelectorAll("input[type='hidden']")].map(e => e.id).filter(Boolean).join(", ")
    );
    await log("info", `Hidden inputs no DOM: ${elementos}`);
    return false; // manter browser aberto para diagnóstico manual
  }

  await log("info", `hddias injetado OK. Valor confirmado: ${injetou.valorLido}`);

  // Passa o frame já adquirido para evitar re-aquisição e inconsistência
  const fechar = await selecionarEReservarTodosOsDias(page, frame);
  await log("info", "=== TESTE CONCLUÍDO — verifique debug-screenshots/ ===");
  return fechar;
}

// ─── NAVEGAÇÃO ────────────────────────────────────────────────────────────────

async function navegarParaReservarVagas(page: Page, modalidade: Modalidade): Promise<boolean> {
  const paginaUrl = URL_MODALIDADE[modalidade];
  const label = modalidade === "presente" ? "RAS Presente" : "RAS Extensão";
  await log("info", `Navegando para ${label} (${paginaUrl})...`);

  // Estrutura do menu RASWEB: itens pai são <span class="AspNet-Menu-NonLink">, sublinks ficam em
  // <ul> com display:none. Force click em display:none vai para coords (0,0) e não navega.
  // Solução confiável: disparar window.location.href no frame — o browser faz a requisição com
  // headers normais (não aciona o bloqueio 403 do WAF que afeta o frame.goto() do Playwright).
  const linkSel = `a[href*="${paginaUrl}" i]`;

  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const frame = await aguardarFrameCentral(page);

    // Aguarda o link aparecer no DOM — o frame pode ainda estar carregando após login/sessão duplicada
    const linkFound = await frame.locator(linkSel).waitFor({ state: "attached", timeout: 8000 })
      .then(() => true).catch(() => false);

    if (!linkFound) {
      const frameUrl = (frame as { url?: () => string }).url?.() ?? "(page)";
      await log("warn", `Link "${paginaUrl}" não encontrado no frame (tentativa ${tentativa}) — URL: ${frameUrl}`);
      await capturarHtml(frame as Page, `AVISO_link-nao-encontrado-tentativa${tentativa}`);
      if (tentativa === 3) {
        // Fallback: navegação direta ao URL conhecido via JS no frame central.
        // aguardarFrameCentral pode ter retornado `page` como fallback — sempre usar o frame
        // pelo nome aqui para garantir que a navegação ocorre dentro do iframe correto.
        await log("warn", `Menu sem link — tentando navegação direta para ${paginaUrl}...`);
        const urlDireta = raswebUrl.replace(/\/$/, "") + "/" + paginaUrl;
        const frameCentral = page.frame({ name: "central" }) ?? frame;
        await frameCentral.evaluate((u) => { window.location.href = u; }, urlDireta).catch(() => undefined);
        await page.waitForTimeout(5000).catch(() => undefined);
        const framePos = page.frame({ name: "central" });
        const urlPos = framePos?.url() ?? "";
        if (urlPos.toUpperCase().includes(paginaUrl.toUpperCase())) {
          await log("info", `Navegação direta para ${label} confirmada.`);
          break;
        }
        await log("error", `Falha ao navegar para ${label} — URL: ${urlPos}`);
        return false;
      }
      await page.waitForTimeout(aleatorio(1500, 2500)).catch(() => undefined);
      continue;
    }

    // Pega o href absoluto do link
    const linkHref = await frame.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLAnchorElement | null;
      return el?.href ?? null;
    }, linkSel);

    if (!linkHref) {
      await log("warn", `Link encontrado mas href vazio (tentativa ${tentativa}).`);
      await page.waitForTimeout(aleatorio(1000, 2000)).catch(() => undefined);
      continue;
    }

    // Navega via JS no contexto do frame — bypassa o bloqueio WAF do Playwright frame.goto()
    // O evaluate pode falhar se o frame estiver em transição (sessão duplicada recém-resolvida)
    await frame.evaluate((href) => { window.location.href = href; }, linkHref).catch(() => undefined);

    // Aguarda a navegação completar — frame vai de p_login.aspx para FRMRESERVAPRESENTE.ASPX
    await page.waitForTimeout(3000).catch(() => undefined);

    // Verifica URL do frame após navegação
    const novoFrame = page.frame({ name: "central" });
    const novaUrl = novoFrame?.url() ?? "";
    await log("info", `URL do frame após navegação: ${novaUrl}`);

    if (novaUrl.toUpperCase().includes(paginaUrl.toUpperCase())) {
      await log("info", `Navegação para ${label} confirmada.`);
      break;
    }

    // Fallback: hover no span pai + click no link (sem force — aguarda o hover do ASP.NET mostrar o link)
    await log("warn", `URL não mudou (${novaUrl}) — tentando via hover+click (tentativa ${tentativa})...`);
    const parentSpanSel = `span.AspNet-Menu-NonLink:has-text("${label}")`;
    await frame.locator(parentSpanSel).first().hover({ force: true }).catch(() => undefined);
    await page.waitForTimeout(600).catch(() => undefined);
    await frame.locator(linkSel).first().click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(3000).catch(() => undefined);

    const frameAposHover = page.frame({ name: "central" });
    const urlAposHover = frameAposHover?.url() ?? "";
    await log("info", `URL após hover+click: ${urlAposHover}`);
    if (urlAposHover.toUpperCase().includes(paginaUrl.toUpperCase())) {
      await log("info", `Navegação para ${label} confirmada via hover+click.`);
      break;
    }

    if (tentativa === 3) {
      await log("error", `Falha ao navegar para ${label} após 3 tentativas.`);
      return false;
    }
    await page.waitForTimeout(aleatorio(1000, 2000)).catch(() => undefined);
  }

  const frame = await aguardarFrameCentral(page);
  await frame.waitForFunction(
    () => {
      const gif = document.querySelector('[id$="gif_load"]') as HTMLElement | null;
      if (!gif) return true;
      return gif.style.display === "none" || gif.offsetParent === null;
    },
    { timeout: 10000 }
  ).catch(() => undefined);

  await page.waitForTimeout(300);

  // Verifica se a tela de reserva carregou corretamente
  const textoVerify = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const carregouCorreto = textoVerify.toLowerCase().includes("reservar") ||
                          textoVerify.toLowerCase().includes("reserva") ||
                          textoVerify.includes("Mês de referência") ||
                          textoVerify.includes("vagas");
  if (carregouCorreto) {
    await log("info", `${label} carregada e verificada.`);
  } else {
    await log("warn", `${label}: página pode não ter carregado corretamente. Texto: "${textoVerify.slice(0, 150)}"`);
  }
  return true;
}

// ─── MONITORAMENTO E RESERVA ──────────────────────────────────────────────────

type AsmxParams = {
  anomesref: string;
  depoid: string;
  usuaid: string;
  hdtipoperfilvaga: string;
};

async function extrairParamsAsmx(page: Page): Promise<AsmxParams | null> {
  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const frame = await aguardarFrameCentral(page);
    const params = await frame.evaluate(() => {
      // Usar seletor de sufixo — compatível com RAS Extensão (ctl00_CPC_dps_) e RAS Presente (ctl00_CPC_ucReservaPresente_)
      const val = (suffix: string) =>
        (document.querySelector(`[id$="${suffix}"]`) as HTMLInputElement | null)?.value?.trim() ?? "";
      return {
        anomesref:        val("hdanomesref"),
        depoid:           val("hddepoid") || "0",
        usuaid:           val("hdusuaid"),
        hdtipoperfilvaga: val("hdtipoperfilvaga")
      };
    }).catch(() => null);
    if (params?.usuaid && params?.anomesref) return params;
    await page.waitForTimeout(500).catch(() => new Promise(r => setTimeout(r, 500)));
  }
  return null;
}

async function chamarAsmx(page: Page, params: AsmxParams): Promise<{ datas: string; status: number; erro?: string }> {
  const frame = await aguardarFrameCentral(page);
  return frame.evaluate(async (p) => {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      let res: Response;
      try {
        res = await fetch("handler/usercontrolsservice.asmx/GetUserControl", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          credentials: "include",
          signal: controller.signal,
          body: JSON.stringify({
            anomesref: p.anomesref,
            depoid: p.depoid,
            usuaid: p.usuaid,
            hdtipoperfilvaga: p.hdtipoperfilvaga,
            tela: "R"
          })
        });
      } finally {
        clearTimeout(timer);
      }
      if (!res.ok) return { datas: "", status: res.status };
      const json = await res.json() as { d?: string };
      return { datas: (json.d ?? "").replace(/"/g, "").trim(), status: res.status };
    } catch (e) {
      return { datas: "", status: 0, erro: String(e) };
    }
  }, params);
}

async function detectarHorarioAbertura(page: Page): Promise<Date | null> {
  const frame = await aguardarFrameCentral(page);
  const horario = await frame.evaluate(() => {
    const padrao = /(?:Etapa\s+dispon[íi]vel|abre?|abertura|disponibiliz)[^0-9]*(\d{2}):(\d{2})/i;
    // 1. Busca em scripts
    for (const s of Array.from(document.querySelectorAll("script"))) {
      const m = s.textContent?.match(padrao);
      if (m) return `${m[1]}:${m[2]}`;
    }
    // 2. Busca no texto visível da página
    const bodyText = document.body?.innerText ?? "";
    const m2 = bodyText.match(padrao);
    if (m2) return `${m2[1]}:${m2[2]}`;
    // 3. Fallback: qualquer HH:MM entre 07:00 e 12:00 no texto da página
    const m3 = bodyText.match(/\b(0[7-9]|1[0-2]):([0-5]\d)\b/);
    if (m3) return `${m3[1]}:${m3[2]}`;
    return null;
  });
  if (!horario) return null;
  const [h, m] = horario.split(":").map(Number);
  const abertura = new Date();
  abertura.setHours(h, m, 0, 0);
  return abertura;
}

async function carregarCalendario(page: Page, modalidade: Modalidade) {
  await log("info", "Iniciando modo de disparo — polling direto no ASMX sem recarregar página...");

  // Descarta todos os dialogs automaticamente para não travar o browser no dia de pico
  // dismiss PRIMEIRO — log HTTP depois (evita timeout se API estiver lenta)
  page.on("dialog", async (dialog) => {
    const msg = dialog.message().slice(0, 120);
    await dialog.dismiss().catch(() => undefined);
    await log("info", `Dialog descartado: "${msg}"`);
  });

  const params = await extrairParamsAsmx(page);
  if (!params) {
    await log("warn", "Parâmetros ASMX não encontrados. Usando fallback com reload de página.");
    return carregarCalendarioFallback(page, modalidade);
  }

  await log("info", `ASMX pronto: anomesref=${params.anomesref} usuaid=${params.usuaid} depoid=${params.depoid}`);

  // Verifica se o dropdown de delegacias já tem opções disponíveis antes de entrar no polling
  const framePrePoll = await aguardarFrameCentral(page);
  const opcoesPrePoll = await obterOpcoesDelegacia(framePrePoll);
  if (opcoesPrePoll.length > 0) {
    await log("info", `Delegacias já disponíveis antes do polling: ${opcoesPrePoll.map(o => o.text).join(", ")}`);
    for (const opcao of opcoesPrePoll) {
      const hddias = await selecionarDelegaciaEAguardarDias(page, framePrePoll, opcao.value);
      if (hddias && hddias.length > 2) {
        await log("info", `DP "${opcao.text}" selecionada com vagas: ${hddias}. Polling ASMX dispensado.`);
        return;
      }
    }
  }

  // Aguarda próximo ao horário de abertura antes de disparar o polling
  const horarioAbertura = await detectarHorarioAbertura(page);
  if (horarioAbertura) {
    const msParaDisparo = horarioAbertura.getTime() - Date.now() - MINUTOS_ANTECIPACAO * 60_000;
    if (msParaDisparo > 0) {
      await log("info", `Sistema abre às ${horarioAbertura.toLocaleTimeString("pt-BR")} — aguardando, entrando em disparo ${MINUTOS_ANTECIPACAO} min antes.`);
      // Keepalive a cada 5 minutos — evita expiração de sessão durante espera longa
      const KEEPALIVE_MS = 5 * 60 * 1000;
      let restante = msParaDisparo;
      while (restante > 0) {
        const fatia = Math.min(restante, KEEPALIVE_MS);
        await page.waitForTimeout(fatia);
        restante -= fatia;
        if (restante > 0) {
          // Chamada ASMX leve para manter sessão ativa no servidor
          const ka = await chamarAsmx(page, params).catch(() => null);
          const minRestantes = Math.round(restante / 60000);
          await log("info", `Keepalive OK (HTTP ${ka?.status ?? "?"}) — disparo em ${minRestantes} min.`);
        }
      }
    }
    await log("info", "MODO DE DISPARO ATIVADO — polling ASMX a cada 1 segundo!");
  }

  const inicio = Date.now();
  let tentativa = 0;
  let ultimoStatusHttp = 200;

  while (true) {
    tentativa++;

    const resultado = await chamarAsmx(page, params).catch((e: unknown) => ({ datas: "", status: 0, erro: String(e) }));

    if (resultado.status === 0 && resultado.erro) {
      await log("warn", `ASMX erro de rede na tentativa #${tentativa}: ${resultado.erro}`);
    } else if (resultado.status === 401 || resultado.status === 403) {
      await log("error", `SESSÃO EXPIRADA (HTTP ${resultado.status}) na tentativa #${tentativa} — Mac pode ter dormido. Reinicie o robô.`);
      await screenshot(page, "ERRO_sessao-expirada");
      return;
    } else if (resultado.status !== 200 && resultado.status !== ultimoStatusHttp) {
      await log("warn", `ASMX retornou HTTP ${resultado.status} na tentativa #${tentativa}`);
      ultimoStatusHttp = resultado.status;
    } else if (resultado.status === 200 && ultimoStatusHttp !== 200) {
      await log("info", "ASMX respondendo normalmente novamente.");
      ultimoStatusHttp = 200;
    }

    const hddias = resultado.datas;

    if (hddias && hddias.length > 2) {
      const frame = await aguardarFrameCentral(page);
      await frame.evaluate((datas) => {
        const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
        if (el) el.value = `"${datas}"`;
      }, hddias);
      await log("info", `VAGAS ABERTAS na tentativa #${tentativa}! Datas: ${hddias}`);
      return;
    }

    if (Date.now() - inicio > TIMEOUT_VAGAS_MS) {
      await log("warn", `TIMEOUT após ${tentativa} tentativas sem vagas. Navegador mantido aberto — operador pode reservar manualmente.`);
      return;
    }

    if (tentativa % 30 === 0) {
      await log("info", `Tentativa #${tentativa} — vagas ainda fechadas. Polling a cada ${POLLING_ASMX_MS}ms.`);
      // A cada 30 ticks também checa o dropdown de DPs (pode aparecer antes do ASMX retornar datas)
      const framePoll = await aguardarFrameCentral(page);
      const opcoesPoll = await obterOpcoesDelegacia(framePoll);
      if (opcoesPoll.length > 0) {
        await log("info", `Delegacias apareceram no dropdown durante polling: ${opcoesPoll.map(o => o.text).join(", ")}`);
        for (const opcao of opcoesPoll) {
          const hddiasDP = await selecionarDelegaciaEAguardarDias(page, framePoll, opcao.value);
          if (hddiasDP && hddiasDP.length > 2) {
            await log("info", `DP "${opcao.text}" com vagas detectada via dropdown. Encerrando polling ASMX.`);
            return;
          }
        }
      }
    }

    // Jitter de 0–200ms para não bater exato com outros robôs no servidor
    await page.waitForTimeout(POLLING_ASMX_MS + aleatorio(0, 200));
  }
}

async function carregarCalendarioFallback(page: Page, modalidadeAtual: Modalidade) {
  const inicio = Date.now();
  let reloads = 0;

  while (true) {
    const frame = await aguardarFrameCentral(page);
    await frame.waitForFunction(
      () => {
        const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
        return (el?.value?.replace(/"/g, "").trim() ?? "").length > 2;
      },
      { timeout: 5000 }
    ).catch(() => undefined);

    const hddias = await frame.evaluate(() => {
      const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
      return el?.value?.replace(/"/g, "").trim() ?? "";
    }).catch(() => "");

    if (hddias.length > 2) {
      await log("info", `Vagas detectadas (fallback): ${hddias}`);
      return;
    }

    if (Date.now() - inicio > TIMEOUT_VAGAS_MS) {
      await log("warn", "TIMEOUT no fallback sem vagas. Navegador mantido aberto — operador pode reservar manualmente.");
      return;
    }

    if (++reloads > 10) {
      await log("warn", "Máximo de reloads atingido. Navegador mantido aberto — operador pode reservar manualmente.");
      return;
    }

    const espera = aleatorio(INTERVALO_MIN_MS, INTERVALO_MAX_MS);
    await log("info", `Vagas fechadas — recarregando em ${Math.round(espera / 1000)}s... (reload ${reloads}/10)`);
    await page.waitForTimeout(espera);
    await page.goto(page.url(), { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined);
    await page.waitForTimeout(aleatorio(800, 1500));
    await navegarParaReservarVagas(page, modalidadeAtual);
  }
}

// ─── ABERTURA DO POPUP ────────────────────────────────────────────────────────

async function abrirPopup(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  // Camada 1: click normal no botão + waitForFunction
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    await frame.evaluate((dateStr) => {
      const hdsel = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
      if (hdsel) hdsel.value = dateStr;
      const btn = document.querySelector('[id$="btninvocadetalhe"]') as HTMLInputElement | null;
      if (btn) btn.click();
    }, data);

    const abriu = await frame.waitForFunction(
      () => {
        const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
        if (!div) return false;
        return div.style.display === "block" ||
               div.style.visibility === "visible" ||
               (div.offsetParent !== null && div.getBoundingClientRect().height > 0);
      },
      { timeout: 15000 }
    ).then(() => true).catch(() => false);

    if (abriu) {
      await log("info", `Popup abriu via UI (tentativa ${tentativa}).`);
      return true;
    }
    await log("warn", `Tentativa ${tentativa}/3 via UI falhou para ${data}.`);
    await page.waitForTimeout(2000);
  }

  // Camada 2: __doPostBack direto via JS (ignora UpdatePanel JS do ASP.NET)
  await log("warn", `Tentando __doPostBack direto para ${data}...`);
  await frame.evaluate((dateStr) => {
    const hdsel = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
    if (hdsel) hdsel.value = dateStr;
    const win = window as unknown as { __doPostBack?: (t: string, a: string) => void };
    const btnEl = document.querySelector('[id$="btninvocadetalhe"]');
    const btnTarget = btnEl?.id.replace(/_/g, "$") ?? "ctl00$CPC$dps$btninvocadetalhe";
    if (win.__doPostBack) win.__doPostBack(btnTarget, "");
  }, data);

  const abriuPostBack = await frame.waitForFunction(
    () => (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.style.display === "block",
    { timeout: 20000 }
  ).then(() => true).catch(() => false);

  if (abriuPostBack) {
    await log("info", `Popup abriu via __doPostBack.`);
    return true;
  }

  // Camada 3: PostBack HTTP direto — bypassa a UI completamente
  await log("warn", `Tentando PostBack HTTP direto para ${data}...`);
  return abrirPopupViaHttpPostBack(page, frame, data);
}

async function abrirPopupViaHttpPostBack(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  const resultado = await frame.evaluate(async (dateStr) => {
    try {
      // Coleta todos os campos do formulário
      const form = document.getElementById("aspnetForm") as HTMLFormElement | null;
      if (!form) return { ok: false, html: "" };

      const campos: Record<string, string> = {};
      for (const el of Array.from(form.elements)) {
        const inp = el as HTMLInputElement;
        if (inp.name) campos[inp.name] = inp.value ?? "";
      }

      // Descobre os IDs reais do UpdatePanel e do botão (compatível com RAS Extensão e RAS Presente)
      const updPanel = document.querySelector('[id$="upd_tela_resultado"]') as HTMLElement | null;
      const btnInvoca = document.querySelector('[id$="btninvocadetalhe"]');
      const hdsel = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
      const updName = updPanel?.id.replace(/_/g, "$") ?? "";
      const btnName = btnInvoca?.id.replace(/_/g, "$") ?? "";
      const hdselName = hdsel?.name ?? hdsel?.id.replace(/_/g, "$") ?? "";

      // Campos obrigatórios para o PostBack parcial do UpdatePanel
      campos["ctl00$ScriptManager1"] = `${updName}|${btnName}`;
      campos["__EVENTTARGET"] = "";
      campos["__EVENTARGUMENT"] = "";
      if (hdselName) campos[hdselName] = dateStr;

      const body = Object.entries(campos)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join("&");

      const res = await fetch(window.location.href, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "X-Requested-With": "XMLHttpRequest",
          "X-MicrosoftAjax": "Delta=true",
          "Cache-Control": "no-cache"
        },
        body
      });

      const delta = await res.text();
      salvarDelta(delta); // salva para diagnóstico

      // Formato Delta ASP.NET: "length|updatePanel|id|html|..."
      // O ID do UpdatePanel varia: ctl00_CPC_dps_upd_tela_resultado (Extensão) ou ctl00_CPC_ucReservaPresente_upd_tela_resultado (Presente)
      const match = delta.match(/\d+\|updatePanel\|[^|]*upd_tela_resultado\|([\s\S]*?)\|\d+\|(?:updatePanel|pageRedirect|error|endOfMessage)/);
      if (!match) return { ok: false, html: delta.slice(0, 500) };

      const htmlPanel = match[1];

      // Injeta o HTML no UpdatePanel e torna o popup visível
      const panel = document.querySelector('[id$="upd_tela_resultado"]') as HTMLElement | null;
      if (!panel) return { ok: false, html: "UpdatePanel não encontrado no DOM" };
      panel.innerHTML = htmlPanel;

      // Atualiza __VIEWSTATE se vier no Delta
      const vsMatch = delta.match(/\d+\|hiddenField\|__VIEWSTATE\|([^|]*)\|/);
      if (vsMatch) {
        const vs = document.getElementById("__VIEWSTATE") as HTMLInputElement | null;
        if (vs) vs.value = vsMatch[1];
      }
      const veMatch = delta.match(/\d+\|hiddenField\|__EVENTVALIDATION\|([^|]*)\|/);
      if (veMatch) {
        const ve = document.getElementById("__EVENTVALIDATION") as HTMLInputElement | null;
        if (ve) ve.value = veMatch[1];
      }

      const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
      if (div) div.style.display = "block";

      return { ok: true, html: htmlPanel };
    } catch (e) {
      return { ok: false, html: String(e) };
    }

    function salvarDelta(texto: string) {
      // expõe no window para o Playwright capturar via evaluate
      (window as unknown as Record<string, unknown>)["__raswebDelta"] = texto;
    }
  }, data);

  // Salva o Delta para diagnóstico
  const delta = await frame.evaluate(() =>
    (window as unknown as Record<string, unknown>)["__raswebDelta"] as string ?? ""
  ).catch(() => "");
  if (delta) salvarDebug(`postback-delta-${data.replace(/\//g, "-")}`, delta);

  if (!resultado.ok) {
    await log("error", `PostBack HTTP falhou para ${data}: ${resultado.html.slice(0, 200)}`);
    return false;
  }

  await log("info", `Popup injetado via PostBack HTTP para ${data}.`);
  return true;
}

// ─── SELEÇÃO E CONFIRMAÇÃO DE VAGAS ──────────────────────────────────────────

async function selecionarEConfirmarVagas(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  // RAS Extensão: id termina em "data_reserva_pnl_dias"
  // RAS Presente: id termina em "data_reserva2_pnl_dias" (com "2" — seletor $= não casa)
  // Solução: seletor de substring [id*="pnl_dias"] que cobre ambos os casos
  const textoPopup = await frame.evaluate(() =>
    (document.querySelector('[id*="pnl_dias"]') as HTMLElement | null)?.innerText ?? ""
  );

  const htmlPopup = await frame.evaluate(() =>
    (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.innerHTML ?? ""
  );
  const nomePopup = `popup_${data.replace(/\//g, "-")}`;
  salvarDebug(nomePopup, htmlPopup);
  await capturarHtml(frame as Page, `${nomePopup}_frame-completo`);
  await log("info", `Popup conteúdo para ${data}: "${textoPopup.slice(0, 300)}"`);

  if (!textoPopup.trim()) {
    if (MODO_TESTE_RESERVA) {
      // Em modo teste injeta vaga fake no popup para validar o fluxo completo de seleção + confirmação
      await log("info", `[TESTE] Popup vazio para ${data} — injetando vaga fake para testar seleção e confirmação.`);
      await frame.evaluate(() => {
        const painel = document.querySelector('[id*="pnl_dias"]') as HTMLElement | null;
        if (painel) {
          painel.innerHTML = `
            <div style="padding:10px">
              <label><input type="checkbox" id="fake_vaga_0" value="VAGA_TESTE"> Plantão Teste 08:00–20:00 (FAKE)</label>
            </div>`;
        }
        const container = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
        if (container && !container.querySelector('[id*="btn_reservar"],[id*="btn_confirmar"],[id="fake_btn_confirmar"]')) {
          const btn = document.createElement("input");
          btn.type = "button";
          btn.id = "fake_btn_confirmar";
          btn.value = "Reservar";
          btn.style.cssText = "position:absolute;left:240px;top:473px;width:120px;cursor:pointer";
          btn.onclick = () => { if (container) container.style.display = "none"; };
          container.appendChild(btn);
        }
      }).catch(() => undefined);
    } else {
      await log("warn", `Popup vazio para ${data} — sem vagas nesta data.`);
      // Fecha o popup via CSS direto para evitar PostBack
      await frame.evaluate(() => {
        const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
        if (div) div.style.display = "none";
      }).catch(() => undefined);
      return false;
    }
  }

  // Seleciona TODOS os checkboxes/radios não-disabled (todas as vagas disponíveis)
  const selecionados = await frame.evaluate(() => {
    const painel = document.querySelector('[id*="pnl_dias"]') as HTMLElement | null;
    if (!painel) return 0;
    const inputs = [...painel.querySelectorAll("input[type='checkbox'], input[type='radio']")] as HTMLInputElement[];
    inputs.forEach(inp => {
      if (!inp.disabled) {
        inp.checked = true;
        inp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
    return inputs.filter(i => !i.disabled).length;
  });

  await log("info", `${selecionados} vaga(s) selecionada(s) para ${data}.`);

  if (selecionados === 0) {
    await log("warn", `Popup sem vagas selecionáveis para ${data} — fechando popup.`);
    await frame.evaluate(() => {
      const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
      if (div) div.style.display = "none";
    }).catch(() => undefined);
    return false;
  }

  // Loga todos os botões disponíveis no popup para diagnóstico em produção
  const botoesList = await frame.evaluate(() => {
    const c = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (!c) return "container não encontrado";
    return [...c.querySelectorAll("a, input, button")].map(b =>
      `[${b.tagName}] id="${b.id}" text="${(b as HTMLElement).textContent?.trim().slice(0, 30)}" val="${(b as HTMLInputElement).value ?? ""}"`
    ).join(" | ");
  }).catch(() => "erro ao listar");
  await log("info", `Botões no popup (${data}): ${botoesList}`);

  // Clica no botão de confirmar (ignora Voltar)
  const confirmou = await frame.evaluate(() => {
    const container = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (!container) return false;
    const botoes = [...container.querySelectorAll("a, input[type='submit'], button, input[type='button']")] as HTMLElement[];
    for (const btn of botoes) {
      const txt = btn.textContent?.trim().toLowerCase() ?? "";
      const val = (btn as HTMLInputElement).value?.toLowerCase() ?? "";
      const id = btn.id?.toLowerCase() ?? "";
      if (txt === "voltar" || val === "voltar" || id.includes("voltar")) continue;
      if (["reservar", "confirmar", "ok", "salvar"].some(k => txt.includes(k) || val.includes(k))) {
        btn.click();
        return true;
      }
    }
    // Fallback: primeiro submit que não seja Voltar
    for (const btn of botoes) {
      const val = (btn as HTMLInputElement).value?.toLowerCase() ?? "";
      const id = btn.id?.toLowerCase() ?? "";
      if ((btn as HTMLInputElement).type === "submit" && !val.includes("voltar") && !id.includes("voltar")) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  await frame.waitForFunction(
    () => (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.style.display !== "block",
    { timeout: 20000 }
  ).catch(() => undefined);

  await screenshot(page, `confirmado-${data.replace(/\//g, "-")}`);
  if (confirmou) {
    await log("info", `✓ Data ${data} reservada.`);
  } else {
    await log("error", `Botão confirmar não encontrado para ${data} — vaga NÃO reservada.`);
    await screenshot(page, `erro-sem-botao-confirmar-${data.replace(/\//g, "-")}`);
  }
  return confirmou;
}

async function reservarData(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  // Garante que popup de reserva anterior não ficou aberto
  await frame.evaluate(() => {
    const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (!div) return;
    if (div.style.display === "block" || div.getBoundingClientRect().height > 0) {
      const voltar = document.querySelector('[id$="data_reserva_btn_Voltar"]') as HTMLElement | null;
      if (voltar) voltar.click();
      else div.style.display = "none";
    }
  }).catch(() => undefined);
  await page.waitForTimeout(300);

  await screenshot(page, `antes-popup-${data.replace(/\//g, "-")}`);

  const popupAbriu = await abrirPopup(page, frame, data);

  if (!popupAbriu) {
    await screenshot(page, `popup-falhou-${data.replace(/\//g, "-")}`);
    await log("error", `Todas as tentativas de abrir popup falharam para ${data}. Pulando.`);
    return false;
  }

  await screenshot(page, `popup-${data.replace(/\//g, "-")}`);
  return selecionarEConfirmarVagas(page, frame, data);
}

// ─── SELEÇÃO DE DELEGACIA ─────────────────────────────────────────────────────

async function obterOpcoesDelegacia(frame: Page | Frame): Promise<{ value: string; text: string }[]> {
  return frame.evaluate(() => {
    const sel = document.querySelector('[id$="drp_selecione_delegacia"]') as HTMLSelectElement | null;
    if (!sel) return [];
    return [...sel.options]
      .filter(o => o.value && o.value !== "-1" && o.value !== "")
      .map(o => ({ value: o.value, text: o.text.trim() }));
  }).catch(() => []);
}

async function selecionarDelegaciaEAguardarDias(
  page: Page,
  frame: Page | Frame,
  depoid: string
): Promise<string> {
  // Captura o hddias atual para detectar quando o AJAX atualizar
  const hddiasAntes = await frame.evaluate(() => {
    const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    return el?.value ?? "";
  }).catch(() => "");

  // Seta o valor no select e dispara change (aciona o onchange="__doPostBack(...)" do ASP.NET)
  await frame.evaluate((id) => {
    const sel = document.querySelector('[id$="drp_selecione_delegacia"]') as HTMLSelectElement | null;
    if (!sel) return;
    sel.value = id;
    // Dispara change nativo — aciona o atributo onchange do ASP.NET AutoPostBack
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    // Fallback: chama __doPostBack diretamente com o target correto
    const win = window as unknown as { __doPostBack?: (t: string, a: string) => void };
    if (win.__doPostBack) {
      const target = sel.name.replace(/\$/g, "$");
      try { win.__doPostBack(target, ""); } catch { /* ignora */ }
    }
  }, depoid).catch(() => undefined);

  // Aguarda o gif_load aparecer (AJAX disparou) ou hddias mudar — timeout 3s para aparecer
  await frame.waitForFunction(
    () => {
      const gif = document.querySelector('[id$="gif_load"]') as HTMLElement | null;
      return gif && gif.style.display !== "none" && gif.offsetParent !== null;
    },
    { timeout: 3000 }
  ).catch(() => undefined);

  // Aguarda o gif_load sumir (AJAX concluiu) — timeout 15s
  await frame.waitForFunction(
    () => {
      const gif = document.querySelector('[id$="gif_load"]') as HTMLElement | null;
      return !gif || gif.style.display === "none" || gif.offsetParent === null;
    },
    { timeout: 15000 }
  ).catch(() => undefined);

  // Fallback: se hddias não mudou após o gif sumir, aguarda mais 2s
  const hddiasPos = await frame.evaluate(() => {
    const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    return el?.value ?? "";
  }).catch(() => "");

  if (hddiasPos === hddiasAntes) {
    await page.waitForTimeout(2000);
  }

  return frame.evaluate(() => {
    const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    return el?.value?.replace(/"/g, "").trim() ?? "";
  }).catch(() => "");
}

async function selecionarDPEReservar(page: Page, frameInicial?: Page | Frame): Promise<boolean> {
  const frame = frameInicial ?? await aguardarFrameCentral(page);
  const opcoes = await obterOpcoesDelegacia(frame);

  if (opcoes.length === 0) {
    await log("info", "Dropdown de delegacias ausente ou vazio — tentando reserva direta.");
    return selecionarEReservarTodosOsDias(page, frame);
  }

  await log("info", `Delegacias a tentar: ${opcoes.map(o => o.text).join(" | ")}`);

  for (const opcao of opcoes) {
    await log("info", `Selecionando delegacia: "${opcao.text}" (id=${opcao.value})`);
    const hddias = await selecionarDelegaciaEAguardarDias(page, frame, opcao.value);
    if (!hddias || hddias.length < 3) {
      await log("info", `Delegacia "${opcao.text}" sem vagas — próxima...`);
      continue;
    }
    await log("info", `Vagas para "${opcao.text}": ${hddias}`);
    await screenshot(page, `dp-selecionada-${opcao.value}`);
    const reservou = await selecionarEReservarTodosOsDias(page, frame);
    if (reservou) return true;
    await log("info", `Sem confirmação para "${opcao.text}" — tentando próxima delegacia...`);
  }

  await log("warn", "Todas as delegacias testadas sem sucesso. Navegador mantido aberto para operação manual.");
  return false;
}

async function selecionarEReservarTodosOsDias(page: Page, framePreAdquirido?: Page | Frame): Promise<boolean> {
  const frame = framePreAdquirido ?? await aguardarFrameCentral(page);

  // Lê as datas disponíveis do campo hddias
  // Formato real do RASWEB: "YYYY-M-D,YYYY-M-D" (ex: "2026-7-5,2026-7-20")
  const hddiasRaw = await frame.evaluate(() => {
    const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    return el?.value?.replace(/"/g, "").trim() ?? "";
  });

  salvarDebug("05-hddias-valor", hddiasRaw);
  await log("info", `hddias: "${hddiasRaw}"`);

  if (!hddiasRaw || hddiasRaw.length < 3) {
    await screenshot(page, "sem-vagas");
    await capturarHtml(frame as Page, "AVISO_sem-vagas-hddias-vazio");
    await log("warn", "hddias vazio — nenhuma vaga disponível. Navegador mantido aberto para operação manual.");
    return false;
  }

  // Converte "YYYY-M-D" → "DD/MM/YYYY" (formato esperado pelo hddiaselecionado)
  const datas = hddiasRaw.split(",").map(d => {
    const partes = d.trim().split("-");
    if (partes.length !== 3) return null;
    const [ano, mes, dia] = partes;
    return `${dia.padStart(2, "0")}/${mes.padStart(2, "0")}/${ano}`;
  }).filter((d): d is string => d !== null && d.length === 10);

  await log("info", `Datas a reservar: ${datas.join(", ")}`);

  let confirmadas = 0;
  for (const data of datas) {
    await log("info", `Reservando data: ${data}`);
    const ok = await reservarData(page, frame, data);
    if (ok) confirmadas++;
    await page.waitForTimeout(aleatorio(400, 800)).catch(() => undefined);
  }

  const textoFinal = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  await log("info", `Estado final: ${textoFinal.slice(0, 300)}`);
  await capturarHtml(frame as Page, "99_estado-final");
  await screenshot(page, "99_estado-final");

  if (confirmadas > 0) {
    await log("info", `${confirmadas} data(s) reservada(s) com sucesso. Encerrando sessão.`);
    await logoutRasweb(page);
    await log("info", "Sessão encerrada.");
    return true; // fechar browser
  } else {
    await log("warn", "Nenhuma data foi reservada pelo robô. Navegador mantido aberto — operador pode reservar manualmente.");
    return false; // manter browser aberto
  }
}

// ─── UTILITÁRIOS ──────────────────────────────────────────────────────────────

async function aguardarFrameCentral(page: Page): Promise<Page | Frame> {
  // O RASWEB mantém o frame "central" em p_login.aspx mesmo após login (a URL não muda).
  // A diferença é: pré-login tem #txtusuario no DOM; pós-login não tem.
  for (let i = 0; i < 60; i++) {
    const central = page.frame({ name: "central" });
    if (central) {
      const naLoginPage = await central.evaluate(
        () => !!document.getElementById("txtusuario")
      ).catch(() => true);
      if (!naLoginPage) return central;
    }
    // Usa setTimeout nativo como fallback — page.waitForTimeout pode falhar
    // se o frame estiver navegando e o contexto do Playwright estiver em transição
    await page.waitForTimeout(500).catch(() => new Promise(r => setTimeout(r, 500)));
  }
  return page;
}

async function loginToRasweb(page: Page, username: string, password: string) {
  const loginFrame = await resolveLoginFrame(page);

  await loginFrame.locator("#txtusuario").waitFor({ state: "visible", timeout: 20000 });
  await loginFrame.locator("#txtusuario").fill(username);
  await clickVirtualPassword(page, loginFrame, password);

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined),
    loginFrame.locator("#entrar").click()
  ]);

  await page.waitForTimeout(800);
  await handleSessaoDuplicada(page);
}

async function handleSessaoDuplicada(page: Page) {
  const loginFrame = page.frame({ name: "central" }) ??
    page.frames().find(f => f.url().includes("p_login.aspx"));

  if (!loginFrame) return;

  const frameTexto = await loginFrame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const textoLower = frameTexto.toLowerCase();
  const temErro = textoLower.includes("acesso negado") ||
    textoLower.includes("outra conexão") || textoLower.includes("outra maquina");

  if (!temErro) {
    await log("info", "Login sem conflito de sessão.");
    return;
  }

  await log("warn", "Sessão duplicada — forçando encerramento via __doPostBack('entrar2','')");

  try {
    await loginFrame.evaluate(() => {
      (window as unknown as { __doPostBack: (t: string, a: string) => void }).__doPostBack("entrar2", "");
    });
  } catch { /* frame navega — normal */ }

  await page.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => undefined);
  await page.waitForTimeout(600);

  const novoFrame = page.frames().find(f => !f.url().includes("p_login.aspx")) ??
    page.frame({ name: "central" });
  const textoPos = novoFrame
    ? await novoFrame.evaluate(() => document.body?.innerText ?? "").catch(() => "")
    : "";

  if (textoPos.toLowerCase().includes("acesso negado")) {
    await log("error", "Ainda com acesso negado após forçar login.");
    return;
  }

  await log("info", "Sessão anterior encerrada. Login OK.");

  // Recarrega o frameset principal para restaurar o menu autenticado.
  // Após __doPostBack("entrar2"), o frame central pode ficar preso em p_login.aspx ou
  // Abertura.aspx sem o menu. A navegação de volta à URL raiz força o frameset a recarregar
  // com o contexto autenticado e o menu lateral disponível.
  await page.goto(raswebUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(2000);
  await log("info", "Frameset recarregado — menu autenticado restaurado.");
}

async function logoutRasweb(page: Page) {
  try {
    // Busca a URL de logout (Encerra.aspx?uso_pk=...) em todos os frames
    let urlLogout: string | null = null;

    for (const frame of [page, ...page.frames()]) {
      try {
        const url = await frame.evaluate(() => {
          const links = [...document.querySelectorAll("a")];
          const sair = links.find(a =>
            a.textContent?.trim().toLowerCase() === "sair" ||
            (a as HTMLAnchorElement).href.toLowerCase().includes("encerra")
          );
          return (sair as HTMLAnchorElement)?.href ?? null;
        });
        if (url) { urlLogout = url; break; }
      } catch { /* tenta próximo */ }
    }

    if (urlLogout) {
      await log("info", `Logout via: ${urlLogout}`);
      await page.goto(urlLogout, { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(800);
      await log("info", "Logout concluído.");
      return;
    }

    // Fallback
    await page.goto(new URL("Encerra.aspx", raswebUrl).toString(), { timeout: 5000 }).catch(() => undefined);
    await log("info", "Logout via fallback Encerra.aspx.");
  } catch (err) {
    await log("warn", `Erro no logout: ${(err as Error).message}`);
  }
}

async function resolveLoginFrame(page: Page): Promise<Page | Frame> {
  const directLogin = page.locator("#txtusuario");
  if ((await directLogin.count()) > 0) return page;

  const central = page.frame({ name: "central" }) ??
    page.frames().find(f => f.url().includes("p_login.aspx"));
  if (central) return central;

  const iframe = page.locator("iframe[name='central']");
  if ((await iframe.count()) > 0) {
    await iframe.waitFor({ state: "attached", timeout: 20000 });
    const element = await iframe.elementHandle();
    const frame = await element?.contentFrame();
    if (frame) return frame;
  }

  await page.goto(new URL("p_login.aspx", raswebUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  if ((await page.locator("#txtusuario").count()) > 0) return page;
  throw new Error("Tela de login do RASWEB nao foi carregada");
}

async function clickVirtualPassword(page: Page, frame: Page | Frame, password: string) {
  const chars = [...password].map(c => c.toUpperCase());
  for (const character of chars) {
    await frame.evaluate((ch) => {
      const keys = document.querySelectorAll("#teclas a");
      for (const key of Array.from(keys)) {
        const title = key.getAttribute("title") ?? "";
        const opts = title.split("-").map(v => v.trim().toUpperCase()).filter(Boolean);
        if (opts.includes(ch)) { (key as HTMLElement).click(); break; }
      }
    }, character);
    // Pausa entre teclas para o handler JS do teclado virtual processar cada clique
    await page.waitForTimeout(aleatorio(80, 150));
  }
}
