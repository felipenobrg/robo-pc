import type { Page } from "playwright";
import { log, screenshot, salvarDebug, aleatorio, setUltimoDialogMsg } from "./utils";
import {
  HORARIO_ABERTURA_FIXO, POLLING_TURBO_MS, POLLING_ASMX_MS, TIMEOUT_VAGAS_MS,
  SEGUNDOS_TURBO, MINUTOS_ANTECIPACAO, DELEGACIA_PREFERIDAS, DELEGACIA_MAX,
  INTERVALO_MIN_MS, INTERVALO_MAX_MS,
} from "./config";
import type { AsmxParams } from "./types";
import { aguardarFrameCentral, aguardarIntervencaoManual } from "./auth";
import { NativeHttpSession } from "./native-http";
import { navegarParaReservarVagas } from "./navigation";

export async function extrairParamsAsmx(page: Page): Promise<AsmxParams | null> {
  for (let tentativa = 0; tentativa < 15; tentativa++) {
    const frame  = await aguardarFrameCentral(page);
    const params = await frame.evaluate(() => {
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
    await page.waitForTimeout(500);
  }
  return null;
}

export async function chamarAsmx(page: Page, params: AsmxParams): Promise<{ datas: string; status: number }> {
  const frame = await aguardarFrameCentral(page);
  return frame.evaluate(async (p) => {
    try {
      const res = await fetch("handler/usercontrolsservice.asmx/GetUserControl", {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        credentials: "include",
        body: JSON.stringify({
          anomesref: p.anomesref,
          depoid: p.depoid,
          usuaid: p.usuaid,
          hdtipoperfilvaga: p.hdtipoperfilvaga,
          tela: "R"
        })
      });
      if (!res.ok) return { datas: "", status: res.status };
      const json = await res.json() as { d?: string };
      return { datas: (json.d ?? "").replace(/"/g, "").trim(), status: res.status };
    } catch {
      return { datas: "", status: 0 };
    }
  }, params);
}

export async function detectarHorarioAbertura(page: Page): Promise<Date | null> {
  if (HORARIO_ABERTURA_FIXO && /^\d{2}:\d{2}$/.test(HORARIO_ABERTURA_FIXO)) {
    const [h, m] = HORARIO_ABERTURA_FIXO.split(":").map(Number);
    const abertura = new Date();
    abertura.setHours(h, m, 0, 0);
    await log("info", `Horário de abertura fixo (env): ${HORARIO_ABERTURA_FIXO}`);
    return abertura;
  }
  const frame   = await aguardarFrameCentral(page);
  const horario = await frame.evaluate(() => {
    const padrao = /(?:Etapa\s+dispon[íi]vel|abre?|abertura|disponibiliz)[^0-9]*(\d{2}):(\d{2})/i;
    for (const s of Array.from(document.querySelectorAll("script"))) {
      const m = s.textContent?.match(padrao);
      if (m) return `${m[1]}:${m[2]}`;
    }
    const bodyText = document.body?.innerText ?? "";
    const m2 = bodyText.match(padrao);
    if (m2) return `${m2[1]}:${m2[2]}`;
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

export async function carregarCalendario(page: Page, session: NativeHttpSession): Promise<void> {
  await log("info", "Iniciando modo de disparo — polling nativo Node.js (sem IPC Playwright)...");

  page.on("dialog", async (dialog) => {
    const msg = dialog.message().slice(0, 120);
    setUltimoDialogMsg(msg);
    await dialog.accept().catch(() => undefined);
    if (dialog.type() === "confirm") {
      await log("info", `Dialog confirm() ACEITO: "${msg}"`);
    } else {
      await log("info", `Dialog ${dialog.type()}: "${msg}"`);
    }
  });

  const params = await extrairParamsAsmx(page);
  if (!params) {
    await log("warn", "Parâmetros ASMX não encontrados. Usando fallback com reload de página.");
    return carregarCalendarioFallback(page);
  }

  await log("info", `ASMX pronto: anomesref=${params.anomesref} usuaid=${params.usuaid} depoid=${params.depoid}`);
  await session.updateCookies(page);

  const horarioAbertura = await detectarHorarioAbertura(page);
  if (horarioAbertura) {
    const msParaDisparo = horarioAbertura.getTime() - Date.now() - MINUTOS_ANTECIPACAO * 60_000;
    if (msParaDisparo > 0) {
      await log("info", `Sistema abre às ${horarioAbertura.toLocaleTimeString("pt-BR")} — aguardando, entrando em disparo ${MINUTOS_ANTECIPACAO} min antes.`);
      let restante = msParaDisparo;
      while (restante > 0) {
        const fatia = Math.min(restante, 60_000);
        await page.waitForTimeout(fatia).catch(() => undefined);
        restante -= fatia;
        if (restante > 5000) {
          const ping = await session.callAsmx(params).catch(() => ({ datas: "", status: 0 }));
          if (ping.datas && ping.datas.length > 2) {
            await log("info", `Vagas detectadas no ping de keep-alive! Datas: ${ping.datas} — disparo imediato.`);
            const frame = await aguardarFrameCentral(page);
            await frame.evaluate((datas) => {
              const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
              if (el) el.value = `"${datas}"`;
            }, ping.datas);
            return;
          }
          await session.updateCookies(page);
          const minRestantes = Math.round(restante / 60_000);
          await log("info", `Sessão mantida. Faltam ~${minRestantes} min para o disparo.`);
        }
      }
    }

    await log("info", "Pré-cacheando formulário para path HTTP nativo...");
    await session.precacheFormState(page);
    await session.updateCookies(page);

    const msParaTurbo = horarioAbertura.getTime() - Date.now() - SEGUNDOS_TURBO * 1000;
    if (msParaTurbo > 0) {
      await page.waitForTimeout(msParaTurbo).catch(() => undefined);
    }
    await log("info", `MODO TURBO ATIVADO — polling nativo a cada ${POLLING_TURBO_MS}ms nos últimos ${SEGUNDOS_TURBO}s!`);
  }

  {
    const _fUrl = (await aguardarFrameCentral(page)).url().toLowerCase();
    if (_fUrl.includes("frmreservapresente")) {
      await carregarCalendarioPresente(page, session);
      return;
    }
  }

  const inicio = Date.now();
  let tentativa = 0;
  let ultimoStatusHttp = 200;

  while (true) {
    tentativa++;
    const resultado = await session.callAsmx(params).catch(() => ({ datas: "", status: 0 }));

    if (resultado.status !== 200 && resultado.status !== 0 && resultado.status !== ultimoStatusHttp) {
      await log("warn", `ASMX nativo retornou HTTP ${resultado.status} na tentativa #${tentativa}`);
      ultimoStatusHttp = resultado.status;
    } else if (resultado.status === 200 && ultimoStatusHttp !== 200 && ultimoStatusHttp !== 0) {
      await log("info", "ASMX respondendo normalmente novamente.");
      ultimoStatusHttp = resultado.status;
    }

    const hddias = resultado.datas;

    if (hddias && hddias.length > 2) {
      const tDeteccao = new Date().toISOString();
      await log("info", `⚡ VAGAS ABERTAS na tentativa #${tentativa} [${tDeteccao}]! Datas: ${hddias}`);
      salvarDebug("03-asmx-vagas-abertas", JSON.stringify({ tentativa, hddias, ts: tDeteccao }, null, 2));
      const frame = await aguardarFrameCentral(page);
      await frame.evaluate((datas) => {
        const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
        if (el) el.value = `"${datas}"`;
      }, hddias);
      screenshot(page, "03-vagas-abertas").catch(() => {});
      return;
    }

    if (Date.now() - inicio > TIMEOUT_VAGAS_MS) {
      await log("error", `TIMEOUT após ${tentativa} tentativas — vagas não abriram no tempo limite.`);
      await screenshot(page, "timeout-vagas");
      await aguardarIntervencaoManual(page, "Vagas não abriram em 30 min — reserve manualmente no Chrome.");
      return;
    }

    if (tentativa % 60 === 0) {
      const decorrido = Math.round((Date.now() - inicio) / 1000);
      const intervalo = horarioAbertura ? POLLING_TURBO_MS : POLLING_ASMX_MS;
      await log("info", `Polling #${tentativa} (~${decorrido}s) — vagas ainda fechadas. Intervalo: ${intervalo}ms.`);
    }

    const intervaloAtual = horarioAbertura ? POLLING_TURBO_MS : POLLING_ASMX_MS;
    await new Promise(r => setTimeout(r, intervaloAtual));
  }
}

export async function carregarCalendarioPresente(page: Page, session: NativeHttpSession): Promise<void> {
  const inicio = Date.now();
  let tentativa = 0;
  await log("info", "RAS Presente — monitorando dropdown de delegacias a cada 50ms...");

  let listaOrdenada: { value: string; num: number; label: string }[] = [];
  let idxAtual = 0;

  while (true) {
    tentativa++;
    const frame = await aguardarFrameCentral(page);

    if (listaOrdenada.length === 0) {
      const opts = await frame.evaluate(() => {
        const sel = document.querySelector('[id$="drp_selecione_delegacia"]') as HTMLSelectElement | null;
        if (!sel) return [] as { value: string; num: number; label: string }[];
        return [...sel.options]
          .filter(o => !isNaN(parseInt(o.value)) && parseInt(o.value) > 0)
          .map(o => {
            const m = (o.text || o.label).match(/(\d+)/);
            return { value: o.value, num: m ? parseInt(m[1]) : 999, label: o.text || o.label };
          });
      }).catch(() => [] as { value: string; num: number; label: string }[]);

      if (opts.length === 0) {
        if (tentativa % 60 === 0) {
          const decorrido = Math.round((Date.now() - inicio) / 1000);
          await log("info", `Tentativa #${tentativa} (~${decorrido}s) — dropdown ainda vazio.`);
        }
        if (tentativa % 600 === 0 && tentativa > 0) {
          await session.updateCookies(page);
          await log("info", `Keep-alive: cookies renovados na tentativa #${tentativa}`);
        }
        await new Promise(r => setTimeout(r, POLLING_TURBO_MS));
        continue;
      }

      const preferidas   = opts.filter(o => DELEGACIA_PREFERIDAS.includes(o.num))
        .sort((a, b) => DELEGACIA_PREFERIDAS.indexOf(a.num) - DELEGACIA_PREFERIDAS.indexOf(b.num));
      const alternativas = opts.filter(o => !DELEGACIA_PREFERIDAS.includes(o.num) && o.num <= DELEGACIA_MAX)
        .sort((a, b) => a.num - b.num);
      const resto        = opts.filter(o => !DELEGACIA_PREFERIDAS.includes(o.num) && o.num > DELEGACIA_MAX)
        .sort((a, b) => a.num - b.num);
      listaOrdenada = [...preferidas, ...alternativas, ...resto];

      await log("info", `⚡ Dropdown com ${listaOrdenada.length} delegacia(s). Ordem de tentativa: ${listaOrdenada.map(d => `${d.num}DP`).join(" → ")}`);
      idxAtual = 0;
    }

    const dp   = listaOrdenada[idxAtual];
    const tipo = DELEGACIA_PREFERIDAS.includes(dp.num) ? "preferida" : dp.num <= DELEGACIA_MAX ? "alternativa" : "extra";
    await log("info", `🔄 Tentando ${dp.num}°DP [${tipo}] (${idxAtual + 1}/${listaOrdenada.length})...`);
    screenshot(page, `03-tentativa-${dp.num}dp`).catch(() => {});

    await frame.evaluate((val: string) => {
      const sel = document.querySelector('[id$="drp_selecione_delegacia"]') as HTMLSelectElement | null;
      if (sel) { sel.value = val; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    }, dp.value).catch(() => undefined);

    await frame.evaluate(() => {
      const btn = document.querySelector('[id$="btnFiltrar"]') as HTMLElement | null;
      if (btn) btn.click();
    }).catch(() => undefined);

    await page.waitForTimeout(2500).catch(() => undefined);

    const frameApos = await aguardarFrameCentral(page);
    const hddias    = await frameApos.evaluate(() => {
      const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
      return el?.value?.replace(/"/g, "").trim() ?? "";
    }).catch(() => "");

    if (hddias.length > 2) {
      await log("info", `✅ ${dp.num}°DP TEM VAGAS! hddias: ${hddias}`);
      await session.updateCookies(page);
      await session.precacheFormState(page);
      screenshot(page, "03-pos-filtrar").catch(() => {});
      return;
    }

    await log("warn", `${dp.num}°DP sem vagas — tentando próxima...`);
    screenshot(page, `03-sem-vagas-${dp.num}dp`).catch(() => {});
    idxAtual = (idxAtual + 1) % listaOrdenada.length;

    if (Date.now() - inicio > TIMEOUT_VAGAS_MS) {
      await log("error", `TIMEOUT após ${tentativa} tentativas — vagas não detectadas em nenhuma delegacia.`);
      await screenshot(page, "timeout-dropdown");
      await aguardarIntervencaoManual(page, "Vagas não abriram — selecione a delegacia manualmente no Chrome.");
      return;
    }
  }
}

export async function carregarCalendarioFallback(page: Page): Promise<void> {
  const inicio = Date.now();
  const url    = page.url();
  const modalidadeAtual = url.includes("PRESENTE") ? "presente" as const : "extensao" as const;
  let reloads  = 0;

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
      await log("error", "TIMEOUT no fallback — vagas não abriram no tempo limite.");
      await screenshot(page, "timeout-vagas-fallback");
      await aguardarIntervencaoManual(page, "Vagas não abriram em 5 min — reserve manualmente no Chrome.");
      return;
    }

    if (++reloads > 10) {
      await log("error", "Máximo de reloads atingido no fallback.");
      await screenshot(page, "max-reloads");
      await aguardarIntervencaoManual(page, "Máximo de recarregamentos atingido — reserve manualmente no Chrome.");
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
