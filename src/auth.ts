import type { Frame, Page } from "playwright";
import { log, aleatorio } from "./utils";
import { raswebUrl, MODO_TESTE_COMPLETO, MODO_TESTE_RESERVA } from "./config";

export async function aguardarFrameCentral(page: Page): Promise<Page | Frame> {
  for (let i = 0; i < 60; i++) {
    const frame = page.frame({ name: "central" }) ??
      page.frames().find(f =>
        f.url().includes("rasweb") &&
        !f.url().includes("p_login.aspx")
      );
    if (frame) return frame;
    await page.waitForTimeout(500).catch(() => undefined);
  }
  return page;
}

export async function resolveLoginFrame(page: Page): Promise<Page | Frame> {
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

export async function clickVirtualPassword(page: Page, frame: Page | Frame, password: string): Promise<void> {
  const chars = [...password].map(c => c.toUpperCase());
  await log("info", `Digitando senha virtual (${chars.length} caracteres)...`);
  for (const character of chars) {
    await frame.evaluate((ch) => {
      const keys = document.querySelectorAll("#teclas a");
      for (const key of Array.from(keys)) {
        const title = key.getAttribute("title") ?? "";
        const opts = title.split("-").map(v => v.trim().toUpperCase()).filter(Boolean);
        if (opts.includes(ch)) { (key as HTMLElement).click(); break; }
      }
    }, character).catch(() => undefined);
    await page.waitForTimeout(aleatorio(80, 150)).catch(() => undefined);
  }
  await log("info", "Senha virtual digitada com sucesso.");
}

export async function loginToRasweb(page: Page, username: string, password: string): Promise<Page | Frame> {
  const loginFrame = await resolveLoginFrame(page);

  await loginFrame.locator("#txtusuario").waitFor({ state: "visible", timeout: 20000 });
  await loginFrame.locator("#txtusuario").fill(username);
  await clickVirtualPassword(page, loginFrame, password);
  await loginFrame.locator("#entrar").click().catch(() => undefined);

  let sessaoDuplicadaTratada = false;
  for (let i = 0; i < 600; i++) {  // 300s (600 × 500ms)
    await page.waitForTimeout(500).catch(() => undefined);
    const pageAlive = !page.isClosed();

    if (!pageAlive) {
      await log("warn", "Playwright page fechou — aguardando nova página no contexto...");
      await new Promise(r => setTimeout(r, 3000));
      const activePages = page.context().pages().filter(p => !p.isClosed());
      let recoveryPage = activePages.at(-1);
      if (!recoveryPage) {
        await log("warn", "Nenhuma página ativa — abrindo nova aba no contexto para recuperar sessão...");
        recoveryPage = await page.context().newPage();
        await recoveryPage.goto(raswebUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        await new Promise(r => setTimeout(r, 3000));
      }
      const authFrame = recoveryPage.frames().find(f => {
        const u = f.url();
        return u && u.includes("rasweb") && !u.includes("p_login") && !u.includes("Encerra");
      }) ?? recoveryPage.mainFrame();
      await log("info", `Recuperado via nova página — frame: ${authFrame.url()}`);
      return authFrame;
    }

    const loginFrameHasForm = await loginFrame.evaluate(
      () => !!document.getElementById("txtusuario")
    ).catch(() => false);

    if (!loginFrameHasForm) {
      const central = page.frame({ name: "central" });
      if (central) {
        const u = central.url();
        if (u && u.includes("rasweb") && !u.includes("p_login") && !u.includes("Encerra")) {
          return central;
        }
      }
      const authFrame = page.frames().find(f => {
        const u = f.url();
        return u && u.includes("rasweb") && !u.includes("p_login") && !u.includes("Encerra");
      });
      if (authFrame) return authFrame;
    }

    if (!sessaoDuplicadaTratada) {
      const central = page.frame({ name: "central" });
      if (central) {
        const texto = await central.evaluate(() => document.body?.innerText ?? "").catch(() => "");
        const tl = texto.toLowerCase();
        if (tl.includes("outra conexão") || tl.includes("outra maquina") || tl.includes("acesso negado")) {
          sessaoDuplicadaTratada = true;
          await log("warn", "Sessão duplicada — forçando encerramento via __doPostBack('entrar2','')");
          await central.evaluate(() => {
            (window as unknown as { __doPostBack: (t: string, a: string) => void }).__doPostBack("entrar2", "");
          }).catch(() => undefined);
          continue;
        }
      }
    }

    if (i === 0 || i % 20 === 19) {
      const urls = page.frames().map(f => f.url()).filter(Boolean).join(" | ");
      await log("info", `Aguardando login... (~${Math.round((i * 500) / 1000)}s) — frames: [${urls}]`);
    }
  }

  throw new Error("Login falhou após 300s — verifique credenciais e senha virtual.");
}

export async function logoutRasweb(page: Page): Promise<void> {
  try {
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

    await page.goto(new URL("Encerra.aspx", raswebUrl).toString(), { timeout: 5000 }).catch(() => undefined);
    await log("info", "Logout via fallback Encerra.aspx.");
  } catch (err) {
    await log("warn", `Erro no logout: ${(err as Error).message}`);
  }
}

export async function aguardarIntervencaoManual(page: Page, motivo: string): Promise<void> {
  if (MODO_TESTE_COMPLETO || MODO_TESTE_RESERVA) return;

  await log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  await log("warn", `⚠ INTERVENÇÃO MANUAL NECESSÁRIA`);
  await log("warn", `Motivo: ${motivo}`);
  await log("warn", "Chrome mantido aberto. Faça a reserva manualmente.");
  await log("warn", "Pressione Ctrl+C neste terminal quando terminar.");
  await log("warn", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  process.removeAllListeners("SIGINT");
  await new Promise<void>(resolve => {
    process.once("SIGINT", () => {
      log("info", "Ctrl+C recebido. Encerrando.").finally(resolve);
    });
  });
}
