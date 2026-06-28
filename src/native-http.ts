import type { Page } from "playwright";
import { log, salvarDebug, aleatorio } from "./utils";
import { raswebUrl, USER_AGENTS, DELEGACIA_PREFERIDAS, DELEGACIA_MAX } from "./config";
import { aguardarFrameCentral } from "./auth";
import type { CachedFormState, AsmxParams } from "./types";

export class NativeHttpSession {
  private cookies  = "";
  private pageUrl  = "";
  private formState: CachedFormState | null = null;

  get isReady(): boolean { return !!this.formState && !!this.cookies; }

  async updateCookies(page: Page): Promise<void> {
    const c = await page.context().cookies();
    this.cookies = c.map(ck => `${ck.name}=${ck.value}`).join("; ");
    this.pageUrl  = page.url();
    const nomes = c.map(ck => ck.name).join(", ");
    await log("info", `Cookies atualizados (${c.length}): ${nomes}`);
  }

  async callAsmx(params: AsmxParams): Promise<{ datas: string; status: number }> {
    if (!this.cookies) return { datas: "", status: 0 };
    try {
      const base = raswebUrl.replace(/\/$/, "");
      const res  = await fetch(`${base}/handler/usercontrolsservice.asmx/GetUserControl`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cookie": this.cookies,
          "User-Agent": USER_AGENTS[aleatorio(0, USER_AGENTS.length - 1)],
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          "Referer": this.pageUrl || raswebUrl,
          "Origin": base,
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        },
        body: JSON.stringify({
          anomesref: params.anomesref,
          depoid: params.depoid,
          usuaid: params.usuaid,
          hdtipoperfilvaga: params.hdtipoperfilvaga,
          tela: "R"
        }),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) return { datas: "", status: res.status };
      const json = await res.json() as { d?: string };
      return { datas: ((json.d ?? "") as string).replace(/"/g, "").trim(), status: res.status };
    } catch (err) {
      await log("warn", `callAsmx falhou: ${(err as Error).message}`);
      return { datas: "", status: 0 };
    }
  }

  async precacheFormState(page: Page): Promise<void> {
    const frame = await aguardarFrameCentral(page);
    const state = await frame.evaluate(() => {
      const form = document.getElementById("aspnetForm") as HTMLFormElement | null;
      if (!form) return null;
      const extra: Record<string, string> = {};
      for (const el of Array.from(form.elements)) {
        const inp = el as HTMLInputElement;
        if (inp.name && inp.type !== "submit" && inp.type !== "button") {
          extra[inp.name] = inp.value ?? "";
        }
      }
      const updPanel = document.querySelector('[id$="upd_tela_resultado"]');
      const btnInvoca = document.querySelector('[id$="btninvocadetalhe"]');
      const hdsel     = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
      const hdusuaid  = document.querySelector('[id$="hdusuaid"]') as HTMLInputElement | null;
      const smEl      = document.querySelector('[id*="ScriptManager"]');
      return {
        pageUrl: window.location.href,
        viewstate: (document.getElementById("__VIEWSTATE") as HTMLInputElement | null)?.value ?? "",
        viewstateGenerator: (document.getElementById("__VIEWSTATEGENERATOR") as HTMLInputElement | null)?.value ?? "",
        eventValidation: (document.getElementById("__EVENTVALIDATION") as HTMLInputElement | null)?.value ?? "",
        scriptManagerId: smEl?.id.replace(/_/g, "$") ?? "ctl00$ScriptManager1",
        updPanelId: updPanel?.id.replace(/_/g, "$") ?? "",
        btnInvocaId: btnInvoca?.id.replace(/_/g, "$") ?? "",
        hddiaselecionadoName: hdsel?.name ?? hdsel?.id.replace(/_/g, "$") ?? "",
        hdusuaidName: hdusuaid?.name ?? "",
        extraCampos: extra,
      };
    });
    if (state) {
      this.formState = state;
      this.pageUrl   = state.pageUrl;
      await log("info", `Form state pré-cacheado — updPanel: ${state.updPanelId} btnInvoca: ${state.btnInvocaId}`);
    } else {
      await log("warn", "precacheFormState: aspnetForm não encontrado");
    }
  }

  parseDelta(delta: string): { panels: Record<string, string>; fields: Record<string, string> } {
    const panels: Record<string, string> = {};
    const fields: Record<string, string> = {};
    let i = 0;
    while (i < delta.length) {
      const pL = delta.indexOf("|", i); if (pL === -1) break;
      const len = parseInt(delta.slice(i, pL), 10); if (isNaN(len)) break;
      i = pL + 1;
      const pT = delta.indexOf("|", i); if (pT === -1) break;
      const type = delta.slice(i, pT); i = pT + 1;
      const pI = delta.indexOf("|", i); if (pI === -1) break;
      const id = delta.slice(i, pI); i = pI + 1;
      const content = delta.slice(i, i + len); i += len + 1;
      if (type === "updatePanel") panels[id] = content;
      else if (type === "hiddenField") fields[id] = content;
    }
    return { panels, fields };
  }

  extractConfirmButton(
    html: string,
    preferidas: number[],
    max: number
  ): { name: string; id: string; delegacia: number | null } | null {
    type Par = { delegacia: number | null; name: string; id: string };
    const pares: Par[] = [];

    const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let trM: RegExpExecArray | null;
    while ((trM = trRegex.exec(html)) !== null) {
      const tr   = trM[1];
      const numM = tr.match(/(\d+)[°o]?\s*(?:DP|Delegacia)/i);
      const num  = numM ? parseInt(numM[1], 10) : null;
      if (num !== null && num > max) continue;

      const btnM = tr.match(/<input[^>]+type=["']submit["'][^>]*>/i);
      if (!btnM) continue;
      const tag  = btnM[0];
      const valM = tag.match(/value=["']([^"']*)["']/i);
      if (!valM || !valM[1].toLowerCase().includes("confirmar")) continue;
      const nameM = tag.match(/name=["']([^"']*)["']/i);
      const idM   = tag.match(/\bid=["']([^"']*)["']/i);
      if (!nameM) continue;
      pares.push({ delegacia: num, name: nameM[1], id: idM?.[1] ?? "" });
    }

    if (pares.length === 0) return null;
    for (const pref of preferidas) {
      const found = pares.find(p => p.delegacia === pref);
      if (found) return found;
    }
    return pares[0] ?? null;
  }

  async confirmar(dataFormatada: string): Promise<boolean> {
    if (!this.formState || !this.cookies) return false;
    const fs2  = this.formState;
    const base = raswebUrl.replace(/\/$/, "");

    try {
      // Etapa 1: PostBack do popup via HTTP nativo
      const c1: Record<string, string> = { ...fs2.extraCampos };
      c1["__VIEWSTATE"]          = fs2.viewstate;
      c1["__VIEWSTATEGENERATOR"] = fs2.viewstateGenerator;
      c1["__EVENTVALIDATION"]    = fs2.eventValidation;
      c1["__EVENTTARGET"]        = "";
      c1["__EVENTARGUMENT"]      = "";
      c1["ctl00$ScriptManager1"] = `${fs2.updPanelId}|${fs2.btnInvocaId}`;
      if (fs2.hddiaselecionadoName) c1[fs2.hddiaselecionadoName] = dataFormatada;

      const body1 = Object.entries(c1)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

      const t0 = Date.now();
      const r1  = await fetch(fs2.pageUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "Cookie": this.cookies,
          "X-Requested-With": "XMLHttpRequest",
          "X-MicrosoftAjax": "Delta=true",
          "Cache-Control": "no-cache",
          "User-Agent": USER_AGENTS[aleatorio(0, USER_AGENTS.length - 1)],
          "Referer": fs2.pageUrl,
          "Origin": base,
          "Accept": "text/javascript, */*; q=0.01",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        },
        body: body1,
        signal: AbortSignal.timeout(20000),
      });

      if (!r1.ok) {
        await log("warn", `HTTP nativo: popup PostBack retornou ${r1.status}`);
        return false;
      }

      const delta1 = await r1.text();
      await log("info", `HTTP nativo: popup obtido em ${Date.now() - t0}ms (${delta1.length} chars)`);
      salvarDebug(`http-popup-delta-${dataFormatada.replace(/\//g, "-")}`, delta1);

      const { panels: p1, fields: f1 } = this.parseDelta(delta1);
      const newVS = f1["__VIEWSTATE"]       ?? fs2.viewstate;
      const newVE = f1["__EVENTVALIDATION"] ?? fs2.eventValidation;

      const popupHtml = Object.entries(p1).find(([k]) => k.includes("upd_tela_resultado"))?.[1] ?? "";
      if (!popupHtml) {
        await log("warn", "HTTP nativo: popup HTML não encontrado no Delta");
        return false;
      }

      const btn = this.extractConfirmButton(popupHtml, DELEGACIA_PREFERIDAS, DELEGACIA_MAX);
      if (!btn) {
        await log("warn", "HTTP nativo: botão Confirmar não encontrado no popup HTML");
        salvarDebug(`http-popup-sem-btn-${dataFormatada.replace(/\//g, "-")}`, popupHtml);
        return false;
      }

      await log("info", `HTTP nativo: botão encontrado — delegacia ${btn.delegacia} name="${btn.name}"`);

      // Etapa 2: PostBack de confirmação via HTTP nativo
      const c2: Record<string, string> = { ...fs2.extraCampos };
      c2["__VIEWSTATE"]          = newVS;
      c2["__VIEWSTATEGENERATOR"] = fs2.viewstateGenerator;
      c2["__EVENTVALIDATION"]    = newVE;
      c2["__EVENTTARGET"]        = btn.name.replace(/\$/g, "_");
      c2["__EVENTARGUMENT"]      = "";
      if (fs2.hddiaselecionadoName) c2[fs2.hddiaselecionadoName] = dataFormatada;
      c2[btn.name] = "Confirmar Reserva";
      if (fs2.hdusuaidName) c2[fs2.hdusuaidName] = fs2.extraCampos[fs2.hdusuaidName] ?? "";

      const body2 = Object.entries(c2)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");

      const t1 = Date.now();
      const r2  = await fetch(fs2.pageUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          "Cookie": this.cookies,
          "User-Agent": USER_AGENTS[aleatorio(0, USER_AGENTS.length - 1)],
          "Referer": fs2.pageUrl,
          "Origin": base,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Dest": "document",
        },
        body: body2,
        signal: AbortSignal.timeout(25000),
      });

      const texto2 = await r2.text();
      await log("info", `HTTP nativo: confirmação respondeu em ${Date.now() - t1}ms (HTTP ${r2.status})`);
      salvarDebug(`http-confirmacao-resp-${dataFormatada.replace(/\//g, "-")}`, texto2);

      const tl2    = texto2.toLowerCase();
      const sucesso = tl2.includes("sucesso") || tl2.includes("confirmad") ||
                      tl2.includes("reservad") || tl2.includes("vaga reservada") ||
                      tl2.includes("registr");
      if (sucesso) {
        await log("info", `✅ HTTP nativo: RESERVA CONFIRMADA para ${dataFormatada}`);
        return true;
      }
      const erro = tl2.includes("erro") || tl2.includes("nenhuma vaga") || tl2.includes("indispon") ||
                   tl2.includes("inválid") || tl2.includes("invalid");
      if (erro) {
        await log("warn", `HTTP nativo: erro detectado na resposta de confirmação para ${dataFormatada}`);
      } else {
        await log("warn", `HTTP nativo: confirmação inconclusiva — verifique http-confirmacao-resp-*.txt`);
      }
      return false;
    } catch (err) {
      await log("warn", `HTTP nativo: exceção — ${(err as Error).message}`);
      return false;
    }
  }
}
