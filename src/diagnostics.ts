import type { Page } from "playwright";
import { log, screenshot, salvarDebug, debugDir } from "./utils";
import { raswebUrl, DELEGACIA_PREFERIDAS, DELEGACIA_MAX } from "./config";
import { aguardarFrameCentral } from "./auth";
import { NativeHttpSession } from "./native-http";
import { carregarCalendario, carregarCalendarioPresente } from "./calendar";
import { selecionarEConfirmarVagas } from "./popup";
import { selecionarEReservarTodosOsDias } from "./reservation";

export async function diagnosticarSite(page: Page): Promise<void> {
  await log("info", "=== MODO DIAGNÓSTICO ATIVO ===");

  const frame = await aguardarFrameCentral(page);
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

  const paginaDiag = process.env.DIAGNOSTICO_MODALIDADE === "presente"
    ? "FRMRESERVAPRESENTE.ASPX"
    : "FRMRESERVARVAGASERVIDOR.ASPX";
  await log("info", `Navegando para ${paginaDiag}...`);
  try {
    const linkSel   = `a[href*="${paginaDiag}" i]`;
    const parentDiag = process.env.DIAGNOSTICO_MODALIDADE === "presente" ? "RAS Presente" : "RAS Extensão";
    await frame.locator(`a:has-text("${parentDiag}")`).first().hover().catch(() => undefined);
    await page.waitForTimeout(400);
    await Promise.all([
      frame.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => undefined),
      frame.locator(linkSel).first().click({ force: true }).catch(() => undefined),
    ]);
    await page.waitForTimeout(1500);
    await screenshot(page, "02-reservar-vagas");

    const textoReserva = await frame.evaluate(() => document.body?.innerText ?? "");
    salvarDebug("02-texto-reservar-vagas", textoReserva);
    await log("info", `Tela Reservar Vagas:\n${textoReserva.slice(0, 1000)}`);

    const htmlReserva = await frame.content();
    salvarDebug("03-html-reservar-vagas", htmlReserva);

    const jsCalendario = await page.evaluate(async () => {
      try {
        const res = await fetch("../usercontrol/ReservarVagaServidor.ascx.js", { credentials: "include" });
        return await res.text();
      } catch {
        return "Não foi possível carregar o JS";
      }
    });
    salvarDebug("07-reservavagaservidor-js", jsCalendario);
    await log("info", `JS do calendário salvo (${jsCalendario.length} chars)`);

    const elementos = await frame.evaluate(() =>
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

export async function capturarPopupReal(page: Page, session: NativeHttpSession): Promise<void> {
  await log("info", "=== MODO CAPTURAR POPUP — aguardando vagas reais (SEM confirmar) ===");
  await carregarCalendario(page, session);

  const frame     = await aguardarFrameCentral(page);
  const hddiasRaw = await frame.evaluate(() =>
    (document.querySelector('[id$="hddias"]') as HTMLInputElement | null)?.value?.replace(/"/g, "").trim() ?? ""
  );

  if (!hddiasRaw || hddiasRaw.length < 3) {
    await log("warn", "hddias vazio após polling — nenhuma vaga disponível para capturar.");
    await screenshot(page, "captura-sem-vagas");
    return;
  }

  await log("info", `Vagas disponíveis: ${hddiasRaw}`);

  const partes = hddiasRaw.split(",")[0].trim().split("-");
  const [ano, mes, dia] = partes;
  const dataFormatada   = `${dia.padStart(2, "0")}/${mes.padStart(2, "0")}/${ano}`;
  await log("info", `Abrindo popup para ${dataFormatada} (SEM confirmar)...`);

  await frame.evaluate((dateStr) => {
    const hdsel = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
    if (hdsel) hdsel.value = dateStr;
    const btn   = document.querySelector('[id$="btninvocadetalhe"]') as HTMLElement | null;
    if (btn) btn.click();
  }, dataFormatada);

  const abriu = await frame.waitForFunction(
    () => {
      const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
      if (!div) return false;
      return div.style.display === "block" ||
             (div.offsetParent !== null && div.getBoundingClientRect().height > 0);
    },
    { timeout: 20000 }
  ).then(() => true).catch(() => false);

  if (!abriu) {
    await log("warn", "Popup não abriu em 20s. Tentando via __doPostBack...");
    await frame.evaluate((dateStr) => {
      const hdsel = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
      if (hdsel) hdsel.value = dateStr;
      const win    = window as unknown as { __doPostBack?: (t: string, a: string) => void };
      const btn    = document.querySelector('[id$="btninvocadetalhe"]');
      const target = btn?.id.replace(/_/g, "$") ?? "";
      if (win.__doPostBack) win.__doPostBack(target, "");
    }, dataFormatada);
    await page.waitForTimeout(5000);
  }

  await screenshot(page, "captura-popup-real");

  const htmlPopup = await frame.evaluate(() =>
    (document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null)?.outerHTML ?? "não encontrado"
  );
  salvarDebug("captura-popup-real-html", htmlPopup);

  const botoes = await frame.evaluate(() => {
    const c = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (!c) return [];
    return [...c.querySelectorAll("a, input, button")].map(b => ({
      tag: b.tagName,
      id: b.id,
      name: (b as HTMLInputElement).name,
      type: (b as HTMLInputElement).type,
      value: (b as HTMLInputElement).value,
      text: (b as HTMLElement).textContent?.trim().slice(0, 60),
      onclick: b.getAttribute("onclick"),
      href: (b as HTMLAnchorElement).href,
    }));
  });
  salvarDebug("captura-popup-botoes", JSON.stringify(botoes, null, 2));

  await log("info", `Botões no popup real:`);
  for (const b of botoes) {
    await log("info", `  [${b.tag}] id="${b.id}" name="${b.name}" type="${b.type}" value="${b.value}" text="${b.text}" onclick="${b.onclick}"`);
  }

  await log("info", `HTML do popup salvo em ${debugDir}/captura-popup-real-html.txt`);
  await log("info", "=== CAPTURA CONCLUÍDA — popup NÃO foi confirmado ===");
}

export async function testarFluxoReserva(page: Page): Promise<void> {
  await log("info", "=== MODO TESTE DE RESERVA ===");
  const frame = await aguardarFrameCentral(page);

  await frame.waitForFunction(
    () => {
      const gif = document.querySelector('[id$="gif_load"]') as HTMLElement | null;
      return !gif || gif.style.display === "none" || gif.offsetParent === null;
    },
    { timeout: 8000 }
  ).catch(() => undefined);

  const hoje     = new Date();
  const ano      = hoje.getFullYear();
  const mes      = hoje.getMonth() + 1;
  const mesProximo = mes === 12 ? 1 : mes + 1;
  const anoProximo = mes === 12 ? ano + 1 : ano;
  const dataFake   = `${anoProximo}-${mesProximo}-5,${anoProximo}-${mesProximo}-20`;

  const injetou = await frame.evaluate((datas) => {
    const hddias   = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    const txtVagas = document.querySelector('[id$="txt_vagas_disp"]') as HTMLInputElement | null;
    if (!hddias) return { ok: false, motivo: "hddias não encontrado no DOM" };
    hddias.value = `"${datas}"`;
    if (txtVagas) txtVagas.value = "10";
    return { ok: true, valorLido: hddias.value };
  }, dataFake);

  await screenshot(page, "teste-01-hddias-injetado");

  if (!injetou.ok) {
    await log("error", `Injeção falhou: ${injetou.motivo}. Listando elementos disponíveis...`);
    const elementos = await frame.evaluate(() =>
      [...document.querySelectorAll("input[type='hidden']")].map(e => e.id).filter(Boolean).join(", ")
    );
    await log("info", `Hidden inputs no DOM: ${elementos}`);
    return;
  }

  await log("info", `hddias injetado OK. Valor confirmado: ${injetou.valorLido}`);
  await selecionarEReservarTodosOsDias(page, null, frame);
  await log("info", "=== TESTE CONCLUÍDO — verifique debug-screenshots/ ===");
}

export async function testarFluxoCompleto(page: Page): Promise<void> {
  const frame = await aguardarFrameCentral(page);

  await frame.waitForFunction(
    () => {
      const gif = document.querySelector('[id$="gif_load"]') as HTMLElement | null;
      return !gif || gif.style.display === "none" || gif.offsetParent === null;
    },
    { timeout: 8000 }
  ).catch(() => undefined);

  await frame.waitForFunction(
    () => !!document.querySelector('[id$="hddias"]'),
    { timeout: 15000 }
  ).catch(() => undefined);

  const frameUrl       = frame.url();
  const isExtensao     = frameUrl.includes("SERVID") || frameUrl.includes("EXTENSAO");
  const labelModalidade = isExtensao ? "RAS Extensão" : "RAS Presente";
  const diaFake        = isExtensao ? 21 : 20;
  const paginaFallback = isExtensao ? "FRMRESERVARVAGASERVIDOR.ASPX" : "FRMRESERVAPRESENTE.ASPX";

  await log("info", `=== MODO TESTE COMPLETO (dia ${diaFake} / ${labelModalidade}) ===`);

  const hoje       = new Date();
  const mesProximo = hoje.getMonth() + 1 === 12 ? 1 : hoje.getMonth() + 2;
  const anoProximo = hoje.getMonth() + 1 === 12 ? hoje.getFullYear() + 1 : hoje.getFullYear();
  const dataFake   = `${anoProximo}-${mesProximo}-${diaFake}`;
  const dataFormatada = `${String(diaFake).padStart(2, "0")}/${String(mesProximo).padStart(2, "0")}/${anoProximo}`;

  let hddiasPresente = await frame.evaluate(() =>
    !!document.querySelector('[id$="hddias"]')
  ).catch(() => false);

  if (!hddiasPresente) {
    await log("warn", `Etapa 1 — hddias não encontrado, navegando diretamente para ${labelModalidade} via JS...`);
    const urlDireta  = raswebUrl.replace(/\/$/, "") + "/" + paginaFallback;
    const frameCentral = page.frame({ name: "central" }) ?? frame;
    await frameCentral.evaluate((u) => { window.location.href = u; }, urlDireta).catch(() => undefined);
    await page.waitForTimeout(5000).catch(() => undefined);
    await screenshot(page, "tc-00-navegacao-direta");

    const frameApos = page.frame({ name: "central" }) ?? frame;
    hddiasPresente  = await frameApos.evaluate(() =>
      !!document.querySelector('[id$="hddias"]')
    ).catch(() => false);

    if (!hddiasPresente) {
      await log("error", "Etapa 1 FALHOU: hddias não encontrado mesmo após navegação direta. Verifique se o login foi bem-sucedido.");
      await screenshot(page, "tc-01-FALHA-pagina-errada");
      return;
    }
  }

  const frameAtual = page.frame({ name: "central" }) ?? frame;
  const injetou    = await frameAtual.evaluate((datas) => {
    const hddias   = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    const txtVagas = document.querySelector('[id$="txt_vagas_disp"]') as HTMLInputElement | null;
    if (!hddias) return { ok: false, motivo: "hddias sumiu após navegação" };
    hddias.value = `"${datas}"`;
    if (txtVagas) txtVagas.value = "10";
    return { ok: true, valorLido: hddias.value };
  }, dataFake);

  if (!injetou.ok) {
    await log("error", `Etapa 1 FALHOU: ${injetou.motivo}`);
    return;
  }
  await log("info", `Etapa 1 OK — hddias injetado: ${injetou.valorLido}`);
  await screenshot(page, "tc-01-hddias-injetado");

  page.on("dialog", async (d) => {
    if (d.type() === "confirm") await d.accept().catch(() => undefined);
    else await d.dismiss().catch(() => undefined);
  });

  await frameAtual.evaluate((dateStr) => {
    const hdsel  = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
    if (hdsel) hdsel.value = dateStr;
    const win    = window as unknown as { __doPostBack?: (t: string, a: string) => void };
    const btnEl  = document.querySelector('[id$="btninvocadetalhe"]');
    const updEl  = document.querySelector('[id$="upd_tela_resultado"]');
    const fallbackId = updEl?.id.includes("ucReservaPresente")
      ? "ctl00$CPC$ucReservaPresente$btninvocadetalhe"
      : "ctl00$CPC$dps$btninvocadetalhe";
    const btnTarget = btnEl?.id.replace(/_/g, "$") ?? fallbackId;
    if (win.__doPostBack) win.__doPostBack(btnTarget, "");
  }, dataFormatada).catch(() => undefined);

  await page.waitForTimeout(3000).catch(() => undefined);
  await screenshot(page, "tc-02-apos-click-popup");
  await log("info", `Etapa 2 — popup disparado para ${dataFormatada}`);

  const htmlCompleto = await frameAtual.evaluate(() => document.documentElement.outerHTML).catch(() => "");
  salvarDebug(`tc-html-completo-${isExtensao ? "rasExtensao" : "rasPresente"}`, htmlCompleto);
  await log("info", `Etapa 3a — HTML completo salvo (${htmlCompleto.length} chars)`);

  const htmlVagasFake = isExtensao
    ? `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr>
          <td style="padding:4px">RAS EXTENSÃO - 2ª QUINZENA</td>
          <td style="padding:4px">${dataFormatada}</td>
          <td style="padding:4px"><input type="button" id="btn_confirmar_extensao" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td>
        </tr>
      </table>`
    : `<table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr style="background:#e8f0fe">
          <td style="padding:4px">73°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td style="padding:4px">073a.Delegacia de Policia</td>
          <td style="padding:4px">GIP DLEGAL 1</td>
          <td style="padding:4px"><input type="button" id="btn_confirmar_73" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td>
        </tr>
        <tr>
          <td style="padding:4px">55°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td style="padding:4px">055a.Delegacia de Policia</td>
          <td style="padding:4px">GIP DLEGAL 1</td>
          <td style="padding:4px"><input type="button" id="btn_confirmar_55" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td>
        </tr>
        <tr style="background:#e8f0fe">
          <td style="padding:4px">37°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td style="padding:4px">037a.Delegacia de Policia</td>
          <td style="padding:4px">GIP DLEGAL 1</td>
          <td style="padding:4px"><input type="button" id="btn_confirmar_37" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td>
        </tr>
        <tr>
          <td style="padding:4px">34°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td style="padding:4px">034a.Delegacia de Policia</td>
          <td style="padding:4px">GIP DLEGAL 1</td>
          <td style="padding:4px"><input type="button" id="btn_confirmar_34" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td>
        </tr>
        <tr style="background:#e8f0fe">
          <td style="padding:4px">93°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td style="padding:4px">093a.Delegacia de Policia</td>
          <td style="padding:4px">GIP DLEGAL 1</td>
          <td style="padding:4px"><input type="button" id="btn_confirmar_93" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td>
        </tr>
      </table>
      <div style="text-align:center;margin-top:8px">
        <input type="button" value="Voltar" id="btn_voltar_fake" style="color:black;width:100px">
      </div>`;

  const injetouVagas = await frameAtual.evaluate((html) => {
    const divResult = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (divResult) divResult.style.display = "block";
    const painel    = document.querySelector('[id*="pnl_dias"]') as HTMLElement | null;
    if (!painel) return { ok: false, motivo: "pnl_dias não encontrado" };
    painel.innerHTML = html;
    return { ok: true, elementos: painel.querySelectorAll("input[type='button']").length };
  }, htmlVagasFake);

  if (!injetouVagas.ok) {
    await log("error", `Etapa 3 FALHOU: ${injetouVagas.motivo}`);
    await screenshot(page, "tc-03-FALHA-injecao-vagas");
    return;
  }
  const descricaoInjecao = isExtensao
    ? `${injetouVagas.elementos} botão(ões) injetados (popup simples sem delegacia)`
    : `${injetouVagas.elementos} linha(s) com "Confirmar Reserva" injetadas (73°DP fora do limite, 37°DP preferida)`;
  await log("info", `Etapa 3 OK — ${descricaoInjecao}`);
  await screenshot(page, "tc-03-popup-com-vagas");

  const descEtapa4 = isExtensao
    ? "Etapa 4 — executando confirmação (Extensão: popup sem delegacia)"
    : `Etapa 4 — executando seleção com DELEGACIA_PREFERIDAS=${DELEGACIA_PREFERIDAS.join(",")}, DELEGACIA_MAX=${DELEGACIA_MAX}`;
  await log("info", descEtapa4);
  await screenshot(page, "tc-04-antes-confirmar");

  const confirmou = await selecionarEConfirmarVagas(page, frameAtual, dataFormatada);

  if (!confirmou) {
    await log("error", "Etapa 4 FALHOU — nenhum botão confirmado");
    await screenshot(page, "tc-04-FALHA-confirmar");
    return;
  }

  await screenshot(page, "tc-04-apos-confirmar");
  await log("info", "Etapa 4 OK — confirmação executada");

  await log("info", `=== TESTE COMPLETO APROVADO — fluxo dia ${diaFake} (${labelModalidade}) validado ===`);
  await log("info", `Evidências salvas em: ${debugDir}/`);
}

export async function testarRotacaoDelegacias(page: Page): Promise<void> {
  await log("info", "=== MODO TESTE ROTAÇÃO DELEGACIAS (RAS Presente) ===");

  const frameCentral = page.frame({ name: "central" }) ?? await aguardarFrameCentral(page);
  const urlPresente  = raswebUrl.replace(/\/$/, "") + "/FRMRESERVAPRESENTE.ASPX";
  await frameCentral.evaluate((u) => { window.location.href = u; }, urlPresente).catch(() => undefined);
  await page.waitForTimeout(4000);

  const frame = await aguardarFrameCentral(page);
  await frame.waitForFunction(
    () => { const g = document.querySelector('[id$="gif_load"]') as HTMLElement | null; return !g || g.style.display === "none" || g.offsetParent === null; },
    { timeout: 8000 }
  ).catch(() => undefined);
  await screenshot(page, "tr-00-pagina-presente");

  const hoje    = new Date();
  const mesProx = hoje.getMonth() + 1 === 12 ? 1 : hoje.getMonth() + 2;
  const anoProx = hoje.getMonth() + 1 === 12 ? hoje.getFullYear() + 1 : hoje.getFullYear();
  const dataFakeStr      = `${anoProx}-${mesProx}-5,${anoProx}-${mesProx}-20`;
  const dataFakeFormatada = `05/${String(mesProx).padStart(2, "0")}/${anoProx}`;

  await frame.evaluate(() => {
    const sel = document.querySelector('[id$="drp_selecione_delegacia"]') as HTMLSelectElement | null;
    if (!sel) { console.warn("[TEST] dropdown não encontrado"); return; }
    sel.innerHTML = [
      '<option value="">-- Selecione --</option>',
      '<option value="100">037a.Delegacia de Policia - 37 DP</option>',
      '<option value="200">041a.Delegacia de Policia - 41 DP</option>',
      '<option value="300">012a.Delegacia de Policia - 12 DP</option>',
    ].join("");
    console.log("[TEST] Dropdown populado com 3 DPs falsas: 37, 41, 12");
  });

  const hddiasBase = `"${dataFakeStr}"`;
  await frame.evaluate((hdBase) => {
    const btn = document.querySelector('[id$="btnFiltrar"]') as HTMLElement | null;
    if (!btn) { console.warn("[TEST] btnFiltrar não encontrado"); return; }

    const clone = btn.cloneNode(true) as HTMLElement;
    btn.parentNode?.replaceChild(clone, btn);

    let tentativa = 0;
    clone.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      tentativa++;

      const sel    = document.querySelector('[id$="drp_selecione_delegacia"]') as HTMLSelectElement | null;
      const dpLabel = sel?.options[sel.selectedIndex]?.text?.match(/(\d+)\s*DP/i)?.[1] ?? "?";
      const hddias  = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;

      if (tentativa >= 3) {
        if (hddias) hddias.value = hdBase;
        console.log(`[TEST] Filtrar #${tentativa} (${dpLabel}DP) → VAGAS INJETADAS: ${hdBase}`);
      } else {
        if (hddias) hddias.value = "";
        console.log(`[TEST] Filtrar #${tentativa} (${dpLabel}DP) → sem vagas (simulado)`);
      }
    }, true);

    console.log("[TEST] btnFiltrar interceptado com sucesso");
  }, hddiasBase);

  await log("info", "Setup: 37DP (sem vagas) → 41DP (sem vagas) → 12DP (COM vagas) [3ª tentativa]");
  await screenshot(page, "tr-01-setup-pronto");

  const session = new NativeHttpSession();
  await log("info", "▶ Iniciando carregarCalendarioPresente...");
  await carregarCalendarioPresente(page, session);
  await log("info", "◀ carregarCalendarioPresente concluído — verificando hddias...");

  const frameApos  = await aguardarFrameCentral(page);
  const hddiasLido = await frameApos.evaluate(() => {
    const el = document.querySelector('[id$="hddias"]') as HTMLInputElement | null;
    return el?.value?.replace(/"/g, "").trim() ?? "";
  }).catch(() => "");

  if (!hddiasLido || hddiasLido.length < 3) {
    await log("error", "❌ TESTE FALHOU: hddias vazio após rotação — verifique screenshots");
    return;
  }
  await log("info", `✅ hddias confirmado: ${hddiasLido}`);
  await screenshot(page, "tr-02-hddias-ok");

  page.on("dialog", async (d) => {
    if (d.type() === "confirm") await d.accept().catch(() => undefined);
    else await d.dismiss().catch(() => undefined);
  });

  await frameApos.evaluate((dateStr) => {
    const hdsel  = document.querySelector('[id$="hddiaselecionado"]') as HTMLInputElement | null;
    if (hdsel) hdsel.value = dateStr;
    const win    = window as unknown as { __doPostBack?: (t: string, a: string) => void };
    const btnEl  = document.querySelector('[id$="btninvocadetalhe"]');
    const updEl  = document.querySelector('[id$="upd_tela_resultado"]');
    const fallbackId = updEl?.id.includes("ucReservaPresente")
      ? "ctl00$CPC$ucReservaPresente$btninvocadetalhe"
      : "ctl00$CPC$dps$btninvocadetalhe";
    const btnTarget = btnEl?.id.replace(/_/g, "$") ?? fallbackId;
    if (win.__doPostBack) win.__doPostBack(btnTarget, "");
  }, dataFakeFormatada).catch(() => undefined);

  await page.waitForTimeout(3000).catch(() => undefined);
  await screenshot(page, "tr-03-popup-disparado");

  const htmlPopup = `
    <table style="width:100%;border-collapse:collapse;font-size:12px">
      <tr><td style="padding:4px">73°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td><input type="button" id="btn_confirmar_73" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td></tr>
      <tr><td style="padding:4px">37°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td><input type="button" id="btn_confirmar_37" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td></tr>
      <tr><td style="padding:4px">12°DP SEG PRESENTE - 2ª QUINZENA</td>
          <td><input type="button" id="btn_confirmar_12" value="Confirmar Reserva" style="background:#1A2B61;color:white;padding:4px 10px;cursor:pointer"></td></tr>
    </table>`;

  await frameApos.evaluate((html) => {
    const div = document.querySelector('[id$="div_tela_resultado"]') as HTMLElement | null;
    if (div) { div.style.display = "block"; div.innerHTML = html; }
    const upd = document.querySelector('[id$="upd_tela_resultado"]') as HTMLElement | null;
    if (upd) upd.style.display = "block";
  }, htmlPopup);

  await log("info", `Etapa 4 — popup injetado para ${dataFakeFormatada} com 3 DPs (73 fora do limite, 37 preferida, 12)`);
  await screenshot(page, "tr-04-popup-injetado");

  await log("info", "Etapa 5 — executando seleção com DELEGACIA_PREFERIDAS=" + DELEGACIA_PREFERIDAS.join(",") + ", DELEGACIA_MAX=" + DELEGACIA_MAX);
  await selecionarEReservarTodosOsDias(page, null, frameApos);

  await log("info", "=== TESTE ROTAÇÃO DELEGACIAS COMPLETO ===");
  await log("info", "Verifique os logs acima:");
  await log("info", "  • 'Dropdown com 3 delegacias. Ordem: 37DP → 41DP → 12DP'");
  await log("info", "  • '37DP sem vagas — tentando próxima...'");
  await log("info", "  • '41DP sem vagas — tentando próxima...'");
  await log("info", "  • '✅ 12DP TEM VAGAS!'");
  await log("info", "  • Confirmação na 37°DP (preferida disponível no popup)");
}

