import type { Frame, Page } from "playwright";
import { log, screenshot, salvarDebug, getUltimoDialogMsg, setUltimoDialogMsg } from "./utils";
import { DELEGACIA_MAX, DELEGACIA_PREFERIDAS } from "./config";

export async function abrirPopup(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    const frameAtual = (page.frame({ name: "central" }) as import("playwright").Frame | null) ?? frame;
    await frameAtual.evaluate((dateStr) => {
      const hdsel = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
      if (hdsel) hdsel.value = dateStr;
      const win    = window as unknown as { __doPostBack?: (t: string, a: string) => void };
      const btnEl  = document.querySelector('[id$="btninvocadetalhe"]');
      const updEl  = document.querySelector('[id$="upd_tela_resultado"]');
      const fallbackId = updEl?.id.includes("ucReservaPresente")
        ? "ctl00$CPC$ucReservaPresente$btninvocadetalhe"
        : "ctl00$CPC$dps$btninvocadetalhe";
      const btnTarget = btnEl?.id.replace(/_/g, "$") ?? fallbackId;
      if (win.__doPostBack) win.__doPostBack(btnTarget, "");
    }, data).catch(() => undefined);

    const abriu = await frameAtual.waitForFunction(
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
      await log("info", `Popup abriu via __doPostBack (tentativa ${tentativa}).`);
      return true;
    }
    await log("warn", `Tentativa ${tentativa}/3 via __doPostBack falhou para ${data}.`);
    await page.waitForTimeout(2000).catch(() => undefined);
  }

  await log("warn", `Tentando __doPostBack com re-aquisição de frame para ${data}...`);
  const frameC2 = (page.frame({ name: "central" }) as import("playwright").Frame | null) ?? frame;
  await frameC2.evaluate((dateStr) => {
    const hdsel = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
    if (hdsel) hdsel.value = dateStr;
    const win    = window as unknown as { __doPostBack?: (t: string, a: string) => void };
    const btnEl  = document.querySelector('[id$="btninvocadetalhe"]');
    const updEl  = document.querySelector('[id$="upd_tela_resultado"]');
    const fallbackId = updEl?.id.includes("ucReservaPresente")
      ? "ctl00$CPC$ucReservaPresente$btninvocadetalhe"
      : "ctl00$CPC$dps$btninvocadetalhe";
    const btnTarget = btnEl?.id.replace(/_/g, "$") ?? fallbackId;
    if (win.__doPostBack) win.__doPostBack(btnTarget, "");
  }, data).catch(() => undefined);

  const abriuPostBack = await frameC2.waitForFunction(
    () => (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.style.display === "block",
    { timeout: 20000 }
  ).then(() => true).catch(() => false);

  if (abriuPostBack) {
    await log("info", `Popup abriu via __doPostBack (camada 2).`);
    return true;
  }

  await log("warn", `Tentando PostBack HTTP direto para ${data}...`);
  const frameC3 = (page.frame({ name: "central" }) as import("playwright").Frame | null) ?? frame;
  return abrirPopupViaHttpPostBack(page, frameC3, data);
}

export async function abrirPopupViaHttpPostBack(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  const resultado = await frame.evaluate(async (dateStr) => {
    try {
      const form = document.getElementById("aspnetForm") as HTMLFormElement | null;
      if (!form) return { ok: false, html: "" };

      const campos: Record<string, string> = {};
      for (const el of Array.from(form.elements)) {
        const inp = el as HTMLInputElement;
        if (inp.name) campos[inp.name] = inp.value ?? "";
      }

      const updPanel = document.querySelector('[id$="upd_tela_resultado"]') as HTMLElement | null;
      const btnInvoca = document.querySelector('[id$="btninvocadetalhe"]');
      const hdsel2    = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
      const updName   = updPanel?.id.replace(/_/g, "$") ?? "";
      const btnName   = btnInvoca?.id.replace(/_/g, "$") ?? "";
      const hdselName = hdsel2?.name ?? hdsel2?.id.replace(/_/g, "$") ?? "";

      campos["ctl00$ScriptManager1"] = `${updName}|${btnName}`;
      campos["__EVENTTARGET"]        = "";
      campos["__EVENTARGUMENT"]      = "";
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
      salvarDelta(delta);

      const match = delta.match(/\d+\|updatePanel\|[^|]*upd_tela_resultado\|([\s\S]*?)\|\d+\|(?:updatePanel|pageRedirect|error|endOfMessage)/);
      if (!match) return { ok: false, html: delta.slice(0, 500) };

      const htmlPanel = match[1];
      const panel = document.querySelector('[id$="upd_tela_resultado"]') as HTMLElement | null;
      if (panel) panel.innerHTML = htmlPanel;

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
      (window as unknown as Record<string, unknown>)["__raswebDelta"] = texto;
    }
  }, data);

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

export async function selecionarEConfirmarVagas(page: Page, frame: Page | Frame, data: string): Promise<boolean> {
  const textoPopup = await frame.evaluate(() =>
    (document.querySelector('[id*="pnl_dias"]') as HTMLElement | null)?.innerText ?? ""
  );

  const htmlPopup = await frame.evaluate(() =>
    (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.innerHTML ?? ""
  );
  salvarDebug(`popup-html-${data.replace(/\//g, "-")}`, htmlPopup);
  await log("info", `Popup conteúdo para ${data}: "${textoPopup.slice(0, 300)}"`);

  if (!textoPopup.trim()) {
    await log("warn", `Popup vazio para ${data} — sem vagas nesta data.`);
    await frame.evaluate(() => {
      const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
      if (div) div.style.display = "none";
    });
    await frame.waitForFunction(
      () => (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.style.display !== "block",
      { timeout: 10000 }
    ).catch(() => undefined);
    return false;
  }

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

  const botoesList = await frame.evaluate(() => {
    const c = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (!c) return "container não encontrado";
    return [...c.querySelectorAll("a, input, button")].map(b =>
      `[${b.tagName}] id="${b.id}" text="${(b as HTMLElement).textContent?.trim().slice(0, 30)}" val="${(b as HTMLInputElement).value ?? ""}"`
    ).join(" | ");
  }).catch(() => "erro ao listar");
  await log("info", `Botões no popup (${data}): ${botoesList}`);

  const confirmou = await frame.evaluate((params: { maxDelegacia: number; preferidas: number[] }) => {
    const { maxDelegacia, preferidas } = params;
    const container = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (!container) return { ok: false, motivo: "container não encontrado", btnId: "" };

    function numeroDelegacia(texto: string): number | null {
      const m = texto.match(/(\d+)[°oa]?\.?\s*Delegacia/i) ?? texto.match(/(\d+)\s*°\s*DP/i);
      return m ? parseInt(m[1], 10) : null;
    }

    function botaoConfirmarNaLinha(linha: HTMLElement): HTMLElement | null {
      const btns = [...linha.querySelectorAll("a, input[type='submit'], button, input[type='button']")] as HTMLElement[];
      for (const btn of btns) {
        const txt = btn.textContent?.trim().toLowerCase() ?? "";
        const val = (btn as HTMLInputElement).value?.toLowerCase() ?? "";
        if (txt === "voltar" || val === "voltar") continue;
        if (["reservar", "confirmar", "ok", "salvar"].some(k => txt.includes(k) || val.includes(k))) return btn;
      }
      return null;
    }

    const linhas = [...container.querySelectorAll("tr")] as HTMLElement[];

    for (const preferida of preferidas) {
      for (const linha of linhas) {
        const num = numeroDelegacia(linha.innerText ?? "");
        if (num !== preferida) continue;
        const btn = botaoConfirmarNaLinha(linha);
        if (btn) { btn.click(); return { ok: true, motivo: `${preferida}°DP (preferida)`, btnId: btn.id }; }
      }
    }

    for (const linha of linhas) {
      const num = numeroDelegacia(linha.innerText ?? "");
      if (num !== null && num > maxDelegacia) continue;
      const btn = botaoConfirmarNaLinha(linha);
      if (btn) { btn.click(); return { ok: true, motivo: `delegacia ${num ?? "?"} (alternativa)`, btnId: btn.id }; }
    }

    const botoes = [...container.querySelectorAll("a, input[type='submit'], button, input[type='button']")] as HTMLElement[];
    for (const preferida of preferidas) {
      for (const btn of botoes) {
        const txt = btn.textContent?.trim().toLowerCase() ?? "";
        const val = (btn as HTMLInputElement).value?.toLowerCase() ?? "";
        if (txt === "voltar" || val === "voltar") continue;
        if (!["reservar", "confirmar", "ok", "salvar"].some(k => txt.includes(k) || val.includes(k))) continue;
        let el: HTMLElement | null = btn.parentElement;
        let numCtx: number | null = null;
        for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
          numCtx = numeroDelegacia(el.innerText ?? "");
          if (numCtx !== null) break;
        }
        if (numCtx === preferida) { btn.click(); return { ok: true, motivo: `${preferida}°DP (preferida fallback)`, btnId: btn.id }; }
      }
    }
    for (const btn of botoes) {
      const txt = btn.textContent?.trim().toLowerCase() ?? "";
      const val = (btn as HTMLInputElement).value?.toLowerCase() ?? "";
      if (txt === "voltar" || val === "voltar") continue;
      if (!["reservar", "confirmar", "ok", "salvar"].some(k => txt.includes(k) || val.includes(k))) continue;
      let el: HTMLElement | null = btn.parentElement;
      let numCtx: number | null = null;
      for (let i = 0; i < 5 && el; i++, el = el.parentElement) {
        numCtx = numeroDelegacia(el.innerText ?? "");
        if (numCtx !== null) break;
      }
      if (numCtx !== null && numCtx > maxDelegacia) continue;
      btn.click();
      return { ok: true, motivo: `delegacia ${numCtx ?? "?"} (alternativa fallback)`, btnId: btn.id };
    }

    return { ok: false, motivo: `nenhuma delegacia preferida disponível e nenhuma ≤ ${maxDelegacia} encontrada`, btnId: "" };
  }, { maxDelegacia: DELEGACIA_MAX, preferidas: DELEGACIA_PREFERIDAS });

  await log("info", confirmou.ok
    ? `✓ DOM click disparado — ${confirmou.motivo}`
    : `⚠ ${confirmou.motivo}`);

  if (!confirmou.ok) {
    await screenshot(page, `confirmado-${data.replace(/\//g, "-")}`);
    return false;
  }

  setUltimoDialogMsg("");
  screenshot(page, `04-antes-confirmar-${data.replace(/\//g, "-")}`).catch(() => {});
  salvarDebug(`04-popup-completo-${data.replace(/\//g, "-")}`, htmlPopup);

  const fechouRapido = await frame.waitForFunction(
    () => (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.style.display !== "block",
    { timeout: 5000 }
  ).then(() => true).catch(() => false);

  if (!fechouRapido && confirmou.btnId) {
    await log("info", `Popup ainda aberto após 5s — tentando Playwright click em #${confirmou.btnId}...`);
    await frame.locator(`#${confirmou.btnId}`).click({ timeout: 5000 }).catch(() => undefined);
  }

  await frame.waitForFunction(
    () => (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.style.display !== "block",
    { timeout: 15000 }
  ).catch(() => undefined);

  const dialogLower = getUltimoDialogMsg().toLowerCase();
  if (dialogLower.includes("sucesso") || dialogLower.includes("reservad") || dialogLower.includes("confirmad")) {
    await log("info", `✅ CONFIRMADO via dialog — "${getUltimoDialogMsg()}"`);
    await screenshot(page, `05-confirmado-${data.replace(/\//g, "-")}`);
    salvarDebug(`05-pos-confirmacao-${data.replace(/\//g, "-")}`, await frame.evaluate(() => document.documentElement.outerHTML).catch(() => "sem html"));
    return true;
  }
  if (dialogLower.includes("nenhuma vaga") || dialogLower.includes("não foi possível") || dialogLower.includes("indispon")) {
    await log("error", `✗ ERRO via dialog — "${getUltimoDialogMsg()}"`);
    await screenshot(page, `erro-confirmacao-${data.replace(/\//g, "-")}`);
    return false;
  }

  await page.waitForTimeout(500).catch(() => undefined);

  const textoFinal = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
  const textoLower = textoFinal.toLowerCase();
  const reservaConfirmada = textoLower.includes("confirmad") || textoLower.includes("sucesso") ||
                            textoLower.includes("reserva efetuada") || textoLower.includes("salvo") ||
                            textoLower.includes("registr") || textoLower.includes("agend") ||
                            textoLower.includes("vaga reservada") || textoLower.includes("reserva realizada");
  const erroDetectado = textoLower.includes("erro") || textoLower.includes("falha") ||
                        textoLower.includes("não foi possível") || textoLower.includes("indisponível");

  if (reservaConfirmada) {
    await log("info", `✅ CONFIRMADO — reserva registrada para ${data}.`);
  } else if (erroDetectado) {
    await log("error", `✗ ERRO DETECTADO na tela após confirmação de ${data} — reserva provavelmente NÃO registrada.`);
    await screenshot(page, `erro-confirmacao-${data.replace(/\//g, "-")}`);
    salvarDebug(`erro-confirmacao-${data.replace(/\//g, "-")}`, await frame.evaluate(() => document.documentElement.outerHTML).catch(() => "sem html"));
    return false;
  } else {
    await log("warn", `⚠ Clique executado para ${data} mas confirmação não detectada no texto — verifique screenshot.`);
  }

  await screenshot(page, `05-confirmado-${data.replace(/\//g, "-")}`);
  salvarDebug(`05-pos-confirmacao-${data.replace(/\//g, "-")}`, await frame.evaluate(() => document.documentElement.outerHTML).catch(() => "sem html"));
  return true;
}
