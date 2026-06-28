import dotenv from "dotenv";
import path from "path";
import fs from "fs";
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: false });

import { chromium } from "playwright";
import { log, screenshot, salvarDebug, logFilePath, aleatorio } from "./utils";
import {
  raswebUrl, raswebUsername, raswebPassword,
  MODO_DIAGNOSTICO, MODO_TESTE_RESERVA, MODO_TESTE_COMPLETO,
  MODO_CAPTURAR_POPUP, MODO_TESTE_ROTACAO, FORCAR_EXECUCAO,
  USER_AGENTS,
} from "./config";
import { loginToRasweb, logoutRasweb, aguardarIntervencaoManual } from "./auth";
import { detectarModalidade, navegarParaReservarVagas } from "./navigation";
import { NativeHttpSession } from "./native-http";
import { carregarCalendario } from "./calendar";
import { selecionarEReservarTodosOsDias } from "./reservation";
import {
  diagnosticarSite,
  capturarPopupReal,
  testarFluxoReserva,
  testarFluxoCompleto,
  testarRotacaoDelegacias,
} from "./diagnostics";

async function runAutomation() {
  await log("info", "Automation Worker iniciado");

  if (!raswebUsername || !raswebPassword) {
    await log("warn", "Credenciais RASWEB não configuradas.");
    return;
  }

  const modoForcado      = MODO_DIAGNOSTICO || MODO_TESTE_RESERVA || MODO_TESTE_COMPLETO || MODO_CAPTURAR_POPUP || MODO_TESTE_ROTACAO || FORCAR_EXECUCAO;
  const modalidadeDetect = detectarModalidade();
  const modalidadeFallback = (process.env.DIAGNOSTICO_MODALIDADE === "presente") ? "presente" as const : "extensao" as const;
  const modalidade       = modalidadeDetect ?? modalidadeFallback;

  if (!modalidadeDetect && !modoForcado) {
    const dia = new Date().getDate();
    await log("info", `Dia ${dia} — sem modalidade ativa (RAS Presente: 5,20,25,26 | RAS Extensão: 21). Encerrando.`);
    return;
  }
  if (!modalidadeDetect && modoForcado) {
    await log("info", `Modo forçado — modalidade: ${modalidade === "presente" ? "RAS Presente" : "RAS Extensão"}`);
  } else {
    await log("info", `Modalidade: ${modalidade === "presente" ? "RAS Presente" : "RAS Extensão"} (dia ${new Date().getDate()})`);
  }

  const headless      = process.env.PLAYWRIGHT_HEADLESS !== "false";
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser  = await chromium.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
    args: ["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-infobars", "--disable-dev-shm-usage"],
  });

  let page: import("playwright").Page | undefined;
  try {
    const userAgent = USER_AGENTS[aleatorio(0, USER_AGENTS.length - 1)];
    const context   = await browser.newContext({
      userAgent,
      locale: "pt-BR",
      extraHTTPHeaders: {
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      },
    });
    page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      (window as unknown as Record<string, unknown>).chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
      Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt"] });
    });

    process.once("SIGINT", async () => {
      await log("info", "SIGINT — fazendo logout...");
      if (page) await logoutRasweb(page);
      await browser.close();
      process.exit(0);
    });

    await page.goto(raswebUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const frameLogin = await loginToRasweb(page, raswebUsername, raswebPassword);
    await log("info", `Login OK — frame: ${frameLogin.url()}`);
    await screenshot(page, "01-pos-login");
    salvarDebug("01-pos-login", await frameLogin.evaluate(() => document.documentElement.outerHTML).catch(() => ""));

    if (MODO_DIAGNOSTICO) {
      await diagnosticarSite(page);
      await logoutRasweb(page);
      await browser.close();
      return;
    }

    await navegarParaReservarVagas(page, modalidade);
    await screenshot(page, "02-pagina-reserva");

    if (MODO_CAPTURAR_POPUP) {
      const session = new NativeHttpSession();
      await capturarPopupReal(page, session);
      await logoutRasweb(page);
      await browser.close();
      return;
    }

    if (MODO_TESTE_ROTACAO) {
      await testarRotacaoDelegacias(page);
    } else if (MODO_TESTE_COMPLETO) {
      await testarFluxoCompleto(page);
    } else if (MODO_TESTE_RESERVA) {
      await testarFluxoReserva(page);
    } else {
      const session = new NativeHttpSession();
      await carregarCalendario(page, session);
      await selecionarEReservarTodosOsDias(page, session);
    }

    await browser.close();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const stack   = error instanceof Error ? (error.stack ?? "") : "";
    await log("error", `EXCEÇÃO: ${message}`);
    if (stack) { try { fs.appendFileSync(logFilePath, stack + "\n", "utf8"); } catch { /* */ } }
    if (page) {
      await screenshot(page, "erro-inesperado").catch(() => undefined);
      try {
        for (let i = 0; i < page.frames().length; i++) {
          const html = await page.frames()[i].evaluate(() => document.documentElement.outerHTML).catch(() => "");
          if (html) salvarDebug(`erro-frame-${i}`, html);
        }
      } catch { /* */ }
      await aguardarIntervencaoManual(page, `Erro inesperado: ${message}`);
    }
    await browser.close();
    process.exitCode = 1;
  }
}

void runAutomation();
