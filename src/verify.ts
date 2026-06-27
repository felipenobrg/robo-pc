import dotenv from "dotenv";
import path from "path";
import fs from "fs";
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: false });

import { chromium } from "playwright";
import type { Frame, Page } from "playwright";
import { enviarRelatorioWhatsApp } from "./whatsapp";

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const raswebUrl    = process.env.RASWEB_URL      ?? "https://rasweb.pcivil.rj.gov.br/";
const username     = process.env.RASWEB_USERNAME ?? "";
const password     = process.env.RASWEB_PASSWORD ?? "";
const WA_NUMERO    = process.env.WHATSAPP_NUMERO_DESTINO ?? "";

// DATA_DIR: volume persistente no Railway (/data) ou pasta local do projeto
const DATA_DIR     = process.env.VERIFY_DATA_DIR ?? path.resolve(__dirname, "../../..");
const baselineFile = path.join(DATA_DIR, "baseline-verificacao.json");
const reportDir    = path.join(DATA_DIR, "debug-screenshots");
fs.mkdirSync(reportDir, { recursive: true });

// Dias em que o bot roda (RAS Presente: 5,20,25,26 | RAS Extensão: 21)
const DIAS_EXECUCAO = [5, 20, 21, 25, 26];

const dataHoje = new Date();
const tagData  = [
  String(dataHoje.getDate()).padStart(2, "0"),
  String(dataHoje.getMonth() + 1).padStart(2, "0"),
  dataHoje.getFullYear(),
].join("-");
const horaExecucao = dataHoje.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const reportPath = path.join(reportDir, `verificacao-${tagData}.txt`);

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type Status = "OK" | "ALERTA" | "CRITICO";
interface CheckResult { nome: string; status: Status; detalhe: string; }
interface ModalidadeBaseline {
  elementoIds: Record<string, string>;
  jsArquivos: Record<string, number>;
  asmxStatus: number;
}
interface Baseline {
  versao: string;
  data: string;
  versaoSistema: string;
  dataCompilacao: string;
  presente: ModalidadeBaseline;
  extensao: ModalidadeBaseline;
}

// ─── ELEMENTOS CRÍTICOS ───────────────────────────────────────────────────────

const ELEMENTOS_PRESENTE = [
  { sufixo: "drpTipoPerfil",           descricao: "Seletor tipo de perfil (Plantão)" },
  { sufixo: "drp_selecione_delegacia", descricao: "Dropdown de delegacias" },
  { sufixo: "btnFiltrar",              descricao: "Botão Filtrar" },
  { sufixo: "hdanomesref",             descricao: "Campo mês de referência" },
  { sufixo: "hdtipoperfilvaga",        descricao: "Campo tipo perfil vaga" },
  { sufixo: "hddepoid",                descricao: "Campo ID da delegacia" },
  { sufixo: "hdusuaid",                descricao: "Campo ID do usuário" },
  { sufixo: "hddiaselecionado",        descricao: "Campo data selecionada" },
  { sufixo: "btninvocadetalhe",        descricao: "Botão abrir popup de vagas" },
  { sufixo: "upd_tela_resultado",      descricao: "UpdatePanel do popup" },
  { sufixo: "div_tela_resultado",      descricao: "Container do popup" },
];

const ELEMENTOS_EXTENSAO = [
  { sufixo: "hdanomesref",        descricao: "Campo mês de referência" },
  { sufixo: "hdtipoperfilvaga",   descricao: "Campo tipo perfil vaga" },
  { sufixo: "hddepoid",           descricao: "Campo ID da delegacia" },
  { sufixo: "hdusuaid",           descricao: "Campo ID do usuário" },
  { sufixo: "hddias",             descricao: "Campo datas disponíveis" },
  { sufixo: "hddiaselecionado",   descricao: "Campo data selecionada" },
  { sufixo: "btninvocadetalhe",   descricao: "Botão abrir popup de vagas" },
  { sufixo: "upd_tela_resultado", descricao: "UpdatePanel do popup" },
  { sufixo: "div_tela_resultado", descricao: "Container do popup" },
];

const JS_ARQUIVOS = ["js/funcoes.js", "js/funcoes4.js"];

// ─── UTILS ────────────────────────────────────────────────────────────────────

const linhas: string[] = [];
function log(linha: string) { console.log(linha); linhas.push(linha); }
function icone(s: Status) { return s === "OK" ? "✅" : s === "ALERTA" ? "⚠️ " : "❌"; }
function salvarRelatorio() { fs.writeFileSync(reportPath, linhas.join("\n") + "\n", "utf8"); }

function proximaExecucao(): string {
  const hoje = new Date();
  const ano = hoje.getFullYear();
  const mes = hoje.getMonth(); // 0-based
  const dia = hoje.getDate();

  // Próximo dia de execução neste mês
  const proximo = DIAS_EXECUCAO.find(d => d > dia);
  if (proximo) {
    return `${String(proximo).padStart(2,"0")}/${String(mes+1).padStart(2,"0")}/${ano}`;
  }
  // Primeiro dia de execução do próximo mês
  const proxMes = mes === 11 ? 0 : mes + 1;
  const proxAno = mes === 11 ? ano + 1 : ano;
  return `${String(DIAS_EXECUCAO[0]).padStart(2,"0")}/${String(proxMes+1).padStart(2,"0")}/${proxAno}`;
}

function carregarBaseline(): Baseline | null {
  try { return fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, "utf8")) as Baseline : null; }
  catch { return null; }
}
function salvarBaseline(b: Baseline) { fs.writeFileSync(baselineFile, JSON.stringify(b, null, 2), "utf8"); }

// ─── EXTRAIR VERSÃO DO SISTEMA ────────────────────────────────────────────────

async function extrairVersaoSistema(frame: Page | Frame): Promise<{ versaoSistema: string; dataCompilacao: string }> {
  return frame.evaluate(() => {
    const el = document.querySelector('[id$="LBLversao"]') as HTMLElement | null;
    const txt = el?.innerText ?? el?.textContent ?? "";
    const mVersao = txt.match(/Vers[aã]o\s+([\d.]+)/i);
    const mData   = txt.match(/Compilado em\s+([\d/]+\s+[\d:]+)/i);
    return {
      versaoSistema: mVersao?.[1] ?? "",
      dataCompilacao: mData?.[1] ?? "",
    };
  }).catch(() => ({ versaoSistema: "", dataCompilacao: "" }));
}

// ─── LOGIN ────────────────────────────────────────────────────────────────────

async function resolveLoginFrame(page: Page): Promise<Page | Frame> {
  if ((await page.locator("#txtusuario").count()) > 0) return page;
  const central = page.frame({ name: "central" }) ??
    page.frames().find(f => f.url().includes("p_login.aspx"));
  if (central) return central;
  const iframe = page.locator("iframe[name='central']");
  if ((await iframe.count()) > 0) {
    await iframe.waitFor({ state: "attached", timeout: 20000 });
    const el = await iframe.elementHandle();
    const cf = await el?.contentFrame();
    if (cf) return cf;
  }
  await page.goto(new URL("p_login.aspx", raswebUrl).toString(), { waitUntil: "domcontentloaded", timeout: 30000 });
  if ((await page.locator("#txtusuario").count()) > 0) return page;
  throw new Error("Tela de login não carregou");
}

async function clickVirtualPassword(page: Page, frame: Page | Frame, pwd: string) {
  for (const ch of [...pwd].map(c => c.toUpperCase())) {
    await frame.evaluate((c) => {
      for (const key of Array.from(document.querySelectorAll("#teclas a"))) {
        const opts = (key.getAttribute("title") ?? "").split("-").map(v => v.trim().toUpperCase()).filter(Boolean);
        if (opts.includes(c)) { (key as HTMLElement).click(); break; }
      }
    }, ch);
    await page.waitForTimeout(80);
  }
}

async function fazerLogin(page: Page): Promise<{ ok: boolean; detalhe: string; page: Page; versaoSistema: string; dataCompilacao: string }> {
  try {
    await page.goto(raswebUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    const loginFrame = await resolveLoginFrame(page);
    await loginFrame.locator("#txtusuario").waitFor({ state: "visible", timeout: 15000 });

    // Captura versão ANTES de submeter (login page sempre tem o LBLversao)
    const versaoAntes = await extrairVersaoSistema(loginFrame);

    await loginFrame.locator("#txtusuario").fill(username);
    await clickVirtualPassword(page, loginFrame, password);
    await loginFrame.locator("#entrar").click().catch(() => undefined);

    // Loop pós-login: sucesso, sessão duplicada, erro
    let pAtual = page;
    let sessaoDuplicadaTratada = false;
    for (let i = 0; i < 80; i++) {
      const alive = await pAtual.waitForTimeout(500).then(() => true).catch(() => false);

      if (!alive) {
        await new Promise(r => setTimeout(r, 3000));
        const ativas = pAtual.context().pages().filter(p => !p.isClosed());
        let recovery = ativas.at(-1);
        if (!recovery) {
          recovery = await pAtual.context().newPage();
          await recovery.goto(raswebUrl, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
          await new Promise(r => setTimeout(r, 3000));
        }
        const authFrame = recovery.frames().find(f => {
          const u = f.url();
          return u && u.includes("rasweb") && !u.includes("p_login") && !u.includes("Encerra");
        });
        if (authFrame) return { ok: true, detalhe: `Recuperado — ${authFrame.url()}`, page: recovery, ...versaoAntes };
        pAtual = recovery;
        continue;
      }

      const central = pAtual.frame({ name: "central" });
      if (!central) continue;

      // Autenticado: #txtusuario sumiu (ASP.NET POST na mesma URL)
      const temForm = await central.evaluate(() => !!document.getElementById("txtusuario")).catch(() => false);
      if (!temForm) {
        await pAtual.waitForTimeout(300);
        return { ok: true, detalhe: `Autenticado — ${central.url()}`, page: pAtual, ...versaoAntes };
      }

      // Checar conteúdo após 1.5s (evita falso positivo durante carregamento)
      if (i >= 3) {
        const txt = await central.evaluate(() => document.body?.innerText?.toLowerCase() ?? "").catch(() => "");

        // Sessão duplicada: re-digita senha e submete com entrar2
        if (!sessaoDuplicadaTratada && (txt.includes("outra conexão") || txt.includes("outra maquina") || txt.includes("já está conectado") || txt.includes("acesso negado"))) {
          sessaoDuplicadaTratada = true;
          await clickVirtualPassword(pAtual, central, password);
          await pAtual.waitForTimeout(200);
          await central.evaluate(() => {
            (window as unknown as { __doPostBack: (t: string, a: string) => void }).__doPostBack("entrar2", "");
          }).catch(() => undefined);
          continue;
        }

        if (txt.includes("senha inválida") || txt.includes("usuário inválido")) {
          return { ok: false, detalhe: "Credenciais inválidas — verifique o .env", page: pAtual, versaoSistema: "", dataCompilacao: "" };
        }
      }
    }
    return { ok: false, detalhe: "Timeout aguardando login (40s)", page: pAtual, versaoSistema: "", dataCompilacao: "" };
  } catch (e) {
    return { ok: false, detalhe: `Exceção: ${(e as Error).message}`, page, versaoSistema: "", dataCompilacao: "" };
  }
}

// ─── VERIFICAR MODALIDADE ─────────────────────────────────────────────────────

async function verificarModalidade(
  page: Page,
  modalidade: "presente" | "extensao",
  baseline: ModalidadeBaseline | null,
): Promise<{ resultados: CheckResult[]; capturado: ModalidadeBaseline; versaoSistema: string; dataCompilacao: string }> {
  const resultados: CheckResult[] = [];
  const pageUrl   = modalidade === "presente" ? "FRMRESERVAPRESENTE.ASPX" : "FRMRESERVARVAGASERVIDOR.ASPX";
  const label     = modalidade === "presente" ? "RAS Presente" : "RAS Extensão";
  const elementos = modalidade === "presente" ? ELEMENTOS_PRESENTE : ELEMENTOS_EXTENSAO;

  const urlDireta = raswebUrl.replace(/\/$/, "") + "/" + pageUrl;
  let frame: Page | Frame = page;
  const central0 = page.frame({ name: "central" }) ?? page.frames().find(f => f.url().includes("rasweb") && !f.url().includes("p_login"));
  if (central0) frame = central0;

  await frame.evaluate((u) => { window.location.href = u; }, urlDireta).catch(() => undefined);
  await page.waitForTimeout(3500);

  for (let i = 0; i < 10; i++) {
    const f = page.frame({ name: "central" }) ?? page.frames().find(f => f.url().toLowerCase().includes(pageUrl.toLowerCase()));
    if (f) { frame = f; break; }
    await page.waitForTimeout(500);
  }

  const frameUrl = frame.url().toLowerCase();
  if (!frameUrl.includes(pageUrl.toLowerCase())) {
    resultados.push({ nome: `Navegação ${label}`, status: "CRITICO", detalhe: `Redirecionado para: ${frame.url()}` });
    return { resultados, capturado: { elementoIds: {}, jsArquivos: {}, asmxStatus: 0 }, versaoSistema: "", dataCompilacao: "" };
  }

  await frame.waitForFunction(
    () => { const g = document.querySelector('[id$="gif_load"]') as HTMLElement | null; return !g || g.style.display === "none" || g.offsetParent === null; },
    { timeout: 8000 }
  ).catch(() => undefined);

  resultados.push({ nome: `Navegação ${label}`, status: "OK", detalhe: frame.url() });

  // Versão do sistema nesta página
  const versaoFrame = await extrairVersaoSistema(frame);

  // Elementos críticos
  const elementoIds: Record<string, string> = {};
  const encontrados = await frame.evaluate((sufixos: string[]) => {
    const r: Record<string, string | null> = {};
    for (const s of sufixos) { const el = document.querySelector(`[id$="${s}"]`); r[s] = el?.id ?? null; }
    return r;
  }, elementos.map(e => e.sufixo));

  for (const el of elementos) {
    const idReal = encontrados[el.sufixo];
    if (!idReal) {
      resultados.push({ nome: el.descricao, status: "CRITICO", detalhe: `[id$="${el.sufixo}"] NÃO ENCONTRADO na página` });
      continue;
    }
    elementoIds[el.sufixo] = idReal;
    const idBase = baseline?.elementoIds[el.sufixo];
    if (idBase && idBase !== idReal) {
      resultados.push({ nome: el.descricao, status: "ALERTA", detalhe: `ID mudou: era "${idBase}", agora "${idReal}"` });
    } else {
      resultados.push({ nome: el.descricao, status: "OK", detalhe: `id="${idReal}"` });
    }
  }

  // Usuário autenticado
  const valores = await frame.evaluate(() => {
    const v = (s: string) => (document.querySelector(`[id$="${s}"]`) as HTMLInputElement | null)?.value ?? null;
    return { hdusuaid: v("hdusuaid"), hdtipoperfilvaga: v("hdtipoperfilvaga") };
  }).catch(() => ({ hdusuaid: null, hdtipoperfilvaga: null }));

  if (!valores.hdusuaid) {
    resultados.push({ nome: "Usuário autenticado (hdusuaid)", status: "CRITICO", detalhe: "hdusuaid vazio — sessão inválida" });
  } else {
    resultados.push({ nome: "Usuário autenticado (hdusuaid)", status: "OK", detalhe: `usuaid=${valores.hdusuaid}` });
  }
  if (valores.hdtipoperfilvaga && valores.hdtipoperfilvaga !== "2") {
    resultados.push({ nome: "Tipo de perfil vaga", status: "ALERTA", detalhe: `Esperado "2" (Plantão), encontrado "${valores.hdtipoperfilvaga}"` });
  } else if (valores.hdtipoperfilvaga === "2") {
    resultados.push({ nome: "Tipo de perfil vaga", status: "OK", detalhe: "Plantão (valor=2)" });
  }

  // ASMX endpoint — mede tempo de resposta
  const asmxRes = await frame.evaluate(async () => {
    const t0 = Date.now();
    try {
      const r = await fetch("handler/usercontrolsservice.asmx/GetUserControl", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ anomesref: "202607", depoid: "0", usuaid: "0", hdtipoperfilvaga: "2", tela: "R" }),
      });
      return { status: r.status, ms: Date.now() - t0 };
    } catch { return { status: 0, ms: Date.now() - t0 }; }
  }).catch(() => ({ status: 0, ms: 0 }));

  const { status: asmxStatus, ms: asmxMs } = asmxRes;
  if (asmxStatus === 0) {
    resultados.push({ nome: "Endpoint ASMX", status: "CRITICO", detalhe: `Sem resposta (timeout ou rede) — ${asmxMs}ms` });
  } else if (asmxStatus === 404) {
    resultados.push({ nome: "Endpoint ASMX", status: "CRITICO", detalhe: `HTTP ${asmxStatus} — endpoint mudou de URL (${asmxMs}ms)` });
  } else {
    const mudou = baseline && baseline.asmxStatus !== 0 && baseline.asmxStatus !== asmxStatus;
    resultados.push({
      nome: "Endpoint ASMX",
      status: mudou ? "ALERTA" : (asmxStatus === 200 || asmxStatus === 401 || asmxStatus === 403 ? "OK" : "ALERTA"),
      detalhe: `HTTP ${asmxStatus} — ${asmxMs}ms${mudou ? ` (era ${baseline!.asmxStatus})` : ""}`,
    });
  }

  // Arquivos JS — tamanho em bytes
  const jsArquivos: Record<string, number> = {};
  for (const jsPath of JS_ARQUIVOS) {
    const size = await frame.evaluate(async (p) => {
      try { const r = await fetch(`../${p}`, { credentials: "include" }); return (await r.text()).length; }
      catch { return 0; }
    }, jsPath).catch(() => 0);
    jsArquivos[jsPath] = size;
    const sizeBase = baseline?.jsArquivos[jsPath];
    const diff = sizeBase ? size - sizeBase : 0;
    if (size === 0) {
      resultados.push({ nome: `JS: ${jsPath}`, status: "ALERTA", detalhe: "Não carregou (0 bytes)" });
    } else if (sizeBase && Math.abs(diff) > 50) {
      resultados.push({ nome: `JS: ${jsPath}`, status: "ALERTA", detalhe: `Tamanho mudou: ${sizeBase} → ${size} bytes (${diff > 0 ? "+" : ""}${diff})` });
    } else {
      resultados.push({ nome: `JS: ${jsPath}`, status: "OK", detalhe: `${size} bytes${sizeBase ? ` (baseline: ${sizeBase})` : " (primeira medição)"}` });
    }
  }

  return { resultados, capturado: { elementoIds, jsArquivos, asmxStatus }, versaoSistema: versaoFrame.versaoSistema, dataCompilacao: versaoFrame.dataCompilacao };
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const baseline = carregarBaseline();
  const novoBaseline: Partial<Baseline> = { versao: "2", data: new Date().toISOString() };
  let totalCritico = 0, totalAlerta = 0;

  log("════════════════════════════════════════════════════════");
  log("  VERIFICADOR PRÉ-VOO — RASWEB AUTOMAÇÃO POLÍCIA RJ");
  log(`  Data: ${tagData}  |  Hora: ${horaExecucao}`);
  log(`  Próxima execução do bot: ${proximaExecucao()}`);
  if (baseline) log(`  Baseline anterior: ${baseline.data.slice(0, 10)}`);
  else          log("  Baseline: PRIMEIRA EXECUÇÃO (referência será criada agora)");
  log("════════════════════════════════════════════════════════");
  log("");

  if (!username || !password) {
    log("❌ ERRO CRÍTICO: Credenciais não configuradas no .env");
    salvarRelatorio(); process.exit(1);
  }

  const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";
  const browser = await chromium.launch({
    headless,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
  });

  try {
    const context = await browser.newContext({ locale: "pt-BR" });
    const page    = await context.newPage();

    // Login
    log("─── LOGIN ───────────────────────────────────────────────");
    const loginRes = await fazerLogin(page);
    let pag = loginRes.page;
    log(`${icone(loginRes.ok ? "OK" : "CRITICO")} Login: ${loginRes.ok ? "OK" : "FALHOU"} — ${loginRes.detalhe}`);
    if (!loginRes.ok) {
      log(""); log("❌ Login falhou — abortando verificação.");
      salvarRelatorio(); await browser.close(); process.exit(1);
    }
    log("");

    // Sistema — versão e data de compilação
    log("─── SISTEMA ─────────────────────────────────────────────");
    let versaoSistema = loginRes.versaoSistema;
    let dataCompilacao = loginRes.dataCompilacao;

    // Se não capturou na login page, tenta depois (fallback — será preenchido pelo primeiro verificarModalidade)
    if (!versaoSistema) {
      log("   (versão será lida nas páginas de reserva)");
    } else {
      // Comparar com baseline
      if (versaoSistema) {
        const versaoBase = baseline?.versaoSistema;
        if (versaoBase && versaoBase !== versaoSistema) {
          log(`⚠️  Versão do sistema: ${versaoSistema}  (era: ${versaoBase} — ATUALIZAÇÃO DETECTADA)`);
          totalAlerta++;
        } else {
          log(`✅ Versão do sistema: ${versaoSistema}`);
        }
      }
      if (dataCompilacao) {
        const dataBase = baseline?.dataCompilacao;
        if (dataBase && dataBase !== dataCompilacao) {
          log(`⚠️  Compilado em: ${dataCompilacao}  (era: ${dataBase} — DEPLOY DETECTADO — revisar mudanças!)`);
          totalAlerta++;
        } else {
          log(`✅ Compilado em: ${dataCompilacao}${dataBase ? "" : "  (primeira medição)"}`);
        }
      }
    }
    log("");

    // RAS Presente
    log("─── RAS PRESENTE (FRMRESERVAPRESENTE.ASPX) ─────────────");
    const { resultados: resP, capturado: capP, versaoSistema: vP, dataCompilacao: dP } = await verificarModalidade(pag, "presente", baseline?.presente ?? null);
    for (const r of resP) { log(`${icone(r.status)} ${r.nome}: ${r.detalhe}`); if (r.status === "CRITICO") totalCritico++; if (r.status === "ALERTA") totalAlerta++; }
    novoBaseline.presente = capP;
    // Preenche versão se não veio do login
    if (!versaoSistema && vP) { versaoSistema = vP; dataCompilacao = dP; }
    log("");

    // RAS Extensão
    log("─── RAS EXTENSÃO (FRMRESERVARVAGASERVIDOR.ASPX) ─────────");
    const { resultados: resE, capturado: capE, versaoSistema: vE, dataCompilacao: dE } = await verificarModalidade(pag, "extensao", baseline?.extensao ?? null);
    for (const r of resE) { log(`${icone(r.status)} ${r.nome}: ${r.detalhe}`); if (r.status === "CRITICO") totalCritico++; if (r.status === "ALERTA") totalAlerta++; }
    novoBaseline.extensao = capE;
    if (!versaoSistema && vE) { versaoSistema = vE; dataCompilacao = dE; }
    log("");

    // Se versão não estava na login page, mostra agora (após carregar reservas)
    if (!loginRes.versaoSistema && versaoSistema) {
      // Re-exibe seção sistema com dados completos (já logados antes como fallback)
      const versaoBase = baseline?.versaoSistema;
      const dataBase   = baseline?.dataCompilacao;
      if (versaoBase && versaoBase !== versaoSistema) {
        log(`⚠️  [SISTEMA] Versão mudou: ${versaoBase} → ${versaoSistema}`); totalAlerta++;
      }
      if (dataBase && dataBase !== dataCompilacao) {
        log(`⚠️  [SISTEMA] Deploy detectado: era ${dataBase}, agora ${dataCompilacao}`); totalAlerta++;
      }
      if (!versaoBase) {
        log(`ℹ️  [SISTEMA] Versão: ${versaoSistema}  |  Compilado: ${dataCompilacao}  (primeira medição)`);
      }
    }

    // Salva versão no baseline
    novoBaseline.versaoSistema  = versaoSistema;
    novoBaseline.dataCompilacao = dataCompilacao;

    // Resultado final
    log("════════════════════════════════════════════════════════");
    const statusFinal: Status = totalCritico > 0 ? "CRITICO" : totalAlerta > 0 ? "ALERTA" : "OK";
    log(`${icone(statusFinal)} RESULTADO: ${statusFinal === "OK" ? "APROVADO" : statusFinal}`);
    log(`   Críticos: ${totalCritico}  |  Alertas: ${totalAlerta}`);
    if (statusFinal === "OK")          log("   Bot preparado — nenhuma mudança detectada.");
    else if (statusFinal === "ALERTA") log("   Mudanças detectadas — revisar itens com ⚠️  antes da execução.");
    else                               log("   PROBLEMAS CRÍTICOS — bot PODE FALHAR. Ação necessária!");
    log(`   Versão sistema: ${versaoSistema || "não detectada"}  |  Compilado: ${dataCompilacao || "não detectado"}`);
    log(`   Próxima execução: ${proximaExecucao()} às 08:00`);
    log(`   Relatório salvo: ${reportPath}`);
    log("════════════════════════════════════════════════════════");

    salvarBaseline(novoBaseline as Baseline);
    await pag.goto(new URL("Encerra.aspx", raswebUrl).toString(), { timeout: 8000 }).catch(() => undefined);
    await browser.close();
    salvarRelatorio();

    if (WA_NUMERO) {
      const waResult = await enviarRelatorioWhatsApp(WA_NUMERO, linhas).catch(e => ({ ok: false, erro: String(e) }));
      if (waResult.ok) console.log("[WhatsApp] Relatório enviado com sucesso.");
      else             console.warn(`[WhatsApp] Falha ao enviar: ${waResult.erro}`);
    }

    process.exit(totalCritico > 0 ? 1 : 0);

  } catch (e) {
    log(`❌ EXCEÇÃO FATAL: ${(e as Error).message}`);
    salvarRelatorio(); await browser.close(); process.exit(1);
  }
}

void main();
