import path from "path";
import fs from "fs";
import type { Page } from "playwright";

// Session folder — path computed at import time but files created lazily on first use
const _inicio = new Date();
const _tag = [
  String(_inicio.getDate()).padStart(2, "0"),
  String(_inicio.getMonth() + 1).padStart(2, "0"),
  _inicio.getFullYear(),
  String(_inicio.getHours()).padStart(2, "0") + "h" + String(_inicio.getMinutes()).padStart(2, "0"),
].join("-");

export const debugDir    = path.resolve(__dirname, "../../../debug-screenshots", `sessao-${_tag}`);
export const logFilePath = path.join(debugDir, "execucao.log");

let _sessionInitialized = false;
function ensureSession() {
  if (_sessionInitialized) return;
  _sessionInitialized = true;
  fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFileSync(logFilePath, `=== SESSÃO ${_tag} ===\n`, "utf8");
}

// Shared dialog message — set by calendar polling, read by popup confirmation
let _ultimoDialogMsg = "";
export function getUltimoDialogMsg(): string { return _ultimoDialogMsg; }
export function setUltimoDialogMsg(msg: string): void { _ultimoDialogMsg = msg; }

export function aleatorio(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export async function pausaHumana(minMs = 300, maxMs = 900): Promise<void> {
  await new Promise(r => setTimeout(r, aleatorio(minMs, maxMs)));
}

export function salvarDebug(nome: string, conteudo: string): void {
  ensureSession();
  fs.mkdirSync(debugDir, { recursive: true });
  fs.writeFile(path.join(debugDir, `${nome}.txt`), conteudo, "utf8", () => {});
}

export async function screenshot(page: Page, nome: string): Promise<void> {
  ensureSession();
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    await page.screenshot({ path: path.join(debugDir, `${nome}.png`), fullPage: true });
  } catch { /* ignora */ }
}

export async function log(level: "info" | "warn" | "error", message: string): Promise<void> {
  ensureSession();
  const ts    = new Date().toISOString();
  const linha = `[${ts}] [${level.toUpperCase().padEnd(5)}] ${message}`;
  console.log(linha);
  try { fs.appendFileSync(logFilePath, linha + "\n", "utf8"); } catch { /* ignora */ }
}
