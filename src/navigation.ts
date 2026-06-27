import type { Page } from "playwright";
import { log, screenshot } from "./utils";
import { raswebUrl, DIAS_RAS_PRESENTE, DIA_RAS_EXTENSAO, URL_MODALIDADE } from "./config";
import type { Modalidade } from "./config";
import { aguardarFrameCentral } from "./auth";

export function detectarModalidade(): Modalidade | null {
  const diaMes = new Date().getDate();
  if (DIAS_RAS_PRESENTE.includes(diaMes)) return "presente";
  if (diaMes === DIA_RAS_EXTENSAO) return "extensao";
  return null;
}

export async function navegarParaReservarVagas(page: Page, modalidade: Modalidade): Promise<void> {
  const paginaUrl = URL_MODALIDADE[modalidade];
  const label     = modalidade === "presente" ? "RAS Presente" : "RAS Extensão";
  await log("info", `Navegando para ${label} (${paginaUrl})...`);

  const urlDireta = raswebUrl.replace(/\/$/, "") + "/" + paginaUrl;
  let frame = await aguardarFrameCentral(page);
  await frame.evaluate((u) => { window.location.href = u; }, urlDireta).catch(() => undefined);
  await log("info", `Navegação para ${paginaUrl} disparada — aguardando carregamento...`);
  await page.waitForTimeout(3000).catch(() => undefined);

  for (let i = 0; i < 5; i++) {
    frame = await aguardarFrameCentral(page);
    if (frame.url().toLowerCase().includes(paginaUrl.toLowerCase())) break;
    await page.waitForTimeout(1000).catch(() => undefined);
  }

  if (!frame.url().toLowerCase().includes(paginaUrl.toLowerCase())) {
    await log("warn", `Frame em URL inesperada: ${frame.url()} — tentando segunda navegação direta...`);
    await frame.evaluate((u) => { window.location.href = u; }, urlDireta).catch(() => undefined);
    await page.waitForTimeout(3000).catch(() => undefined);
    frame = await aguardarFrameCentral(page);
  }

  await log("info", "Aguardando página terminar de carregar (gif_load)...");
  await frame.waitForFunction(
    () => {
      const gif = document.querySelector('[id$="gif_load"]') as HTMLElement | null;
      if (!gif) return true;
      return gif.style.display === "none" || gif.offsetParent === null;
    },
    { timeout: 10000 }
  ).catch(() => undefined);

  await page.waitForTimeout(300);
  await log("info", `URL do frame após navegação: ${frame.url()}`);

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

  void screenshot; // suppress unused warning
}
