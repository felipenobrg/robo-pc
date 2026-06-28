import type { Frame, Page } from "playwright";
import { log, screenshot, salvarDebug } from "./utils";
import { aguardarFrameCentral, logoutRasweb, aguardarIntervencaoManual } from "./auth";
import { NativeHttpSession } from "./native-http";
import { abrirPopup, selecionarEConfirmarVagas } from "./popup";

export async function reservarData(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  await frame.evaluate(() => {
    const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (!div) return;
    if (div.style.display === "block" || div.getBoundingClientRect().height > 0) {
      div.style.display = "none";
    }
  }).catch(() => undefined);

  await screenshot(page, `antes-popup-${data.replace(/\//g, "-")}`);

  const popupAbriu = await abrirPopup(page, frame, data);

  if (!popupAbriu) {
    await screenshot(page, `popup-falhou-${data.replace(/\//g, "-")}`);
    await log("error", `Todas as tentativas de abrir popup falharam para ${data}. Pulando.`);
    return false;
  }

  await screenshot(page, `popup-${data.replace(/\//g, "-")}`);
  return await selecionarEConfirmarVagas(page, frame, data);
}

export async function selecionarEReservarTodosOsDias(
  page: Page,
  session: NativeHttpSession | null,
  framePreAdquirido?: Page | Frame
): Promise<{ reservadas: number; total: number }> {
  const frame = framePreAdquirido ?? await aguardarFrameCentral(page);

  const hddiasRaw = await frame.evaluate(() => {
    const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    return el?.value?.replace(/"/g, "").trim() ?? "";
  });

  salvarDebug("05-hddias-valor", hddiasRaw);
  await log("info", `hddias: "${hddiasRaw}"`);

  if (!hddiasRaw || hddiasRaw.length < 3) {
    await screenshot(page, "sem-vagas");
    await log("warn", "hddias vazio — nenhuma vaga disponível.");
    await logoutRasweb(page);
    return { reservadas: 0, total: 0 };
  }

  const datas = hddiasRaw.split(",").map(d => {
    const partes = d.trim().split("-");
    if (partes.length !== 3) return null;
    const [ano, mes, dia] = partes;
    return `${dia.padStart(2, "0")}/${mes.padStart(2, "0")}/${ano}`;
  }).filter((d): d is string => d !== null && d.length === 10);

  const datasUnicas = [...new Set(datas)];
  const dupMsg      = datas.length !== datasUnicas.length ? ` (${datas.length - datasUnicas.length} duplicata(s) removida(s))` : "";
  await log("info", `Datas a reservar: ${datasUnicas.join(", ")}${dupMsg}`);

  let datasReservadas = 0;
  for (const data of datasUnicas) {
    await log("info", `Reservando data: ${data}`);

    const httpPromise = (session?.isReady)
      ? session.confirmar(data).catch(() => false)
      : Promise.resolve(false);

    const playwrightPromise = reservarData(page, frame, data).catch(() => false);

    const [httpResult, playwrightResult] = await Promise.allSettled([httpPromise, playwrightPromise]);

    const httpOk       = httpResult.status === "fulfilled" && httpResult.value === true;
    const playwrightOk = playwrightResult.status === "fulfilled" && playwrightResult.value === true;

    const ok = httpOk || playwrightOk;
    await log("info", `Data ${data}: HTTP=${httpOk} Playwright=${playwrightOk}`);
    if (ok) datasReservadas++;
  }

  const textoFinal = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  await log("info", `Estado final: ${textoFinal.slice(0, 300)}`);

  if (datasReservadas === 0) {
    await log("warn", `Nenhuma data foi reservada pelo robô (${datasUnicas.length} tentada(s)).`);
    await aguardarIntervencaoManual(page, "Nenhuma reserva confirmada — reserve manualmente no Chrome.");
    return { reservadas: 0, total: datasUnicas.length };
  }

  await log("info", `${datasReservadas} de ${datasUnicas.length} data(s) reservada(s) com sucesso.`);

  try {
    const clicouRelatorio = await frame.evaluate(() => {
      const btn = document.querySelector('[id*="btnRelatorioVagaReservada"]') as HTMLElement | null;
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clicouRelatorio) {
      await page.waitForTimeout(2000);
      await screenshot(page, "vagas-reservadas-evidencia");
      await log("info", "Screenshot de vagas reservadas salvo como evidência.");
    }
  } catch {
    // não crítico
  }

  await logoutRasweb(page);
  await log("info", "Processo de reserva concluído. Sessão encerrada.");
  return { reservadas: datasReservadas, total: datasUnicas.length };
}
