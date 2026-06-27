import path from "path";
import fs from "fs";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import type { WASocket } from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

const DATA_DIR = process.env.VERIFY_DATA_DIR ?? path.resolve(__dirname, "../../..");
const AUTH_DIR = path.join(DATA_DIR, "baileys-auth");

async function conectar(): Promise<WASocket> {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    browser: ["RASWEB Bot", "Chrome", "1.0"],
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 30000,
  });

  sock.ev.on("creds.update", saveCreds);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout aguardando conexão WhatsApp (60s)")), 60000);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        clearTimeout(timeout);
        resolve(sock);
        return;
      }

      if (connection === "close") {
        clearTimeout(timeout);
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (!shouldReconnect) {
          // Sessão encerrada pelo usuário — limpa auth para forçar novo QR
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        }
        reject(new Error(`Conexão encerrada — código ${statusCode}`));
      }
    });
  });
}

export async function enviarRelatorioWhatsApp(
  numero: string,
  linhas: string[]
): Promise<{ ok: boolean; erro?: string }> {
  if (!numero) return { ok: false, erro: "WHATSAPP_NUMERO_DESTINO não configurado" };

  let sock: WASocket | undefined;

  try {
    console.log("[WhatsApp] Conectando...");
    sock = await conectar();

    // Formata número: remove não-dígitos, garante DDI 55
    const digits = numero.replace(/\D/g, "");
    const jid = `${digits}@s.whatsapp.net`;

    const texto = formatarMensagem(linhas);

    // Aguarda socket estabilizar antes de enviar
    await new Promise(r => setTimeout(r, 2000));

    await sock.sendMessage(jid, { text: texto });
    console.log(`[WhatsApp] Mensagem enviada para ${digits}`);

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WhatsApp] Erro: ${msg}`);
    return { ok: false, erro: msg };
  } finally {
    if (sock) {
      // Fecha a conexão graciosamente
      await new Promise(r => setTimeout(r, 1000));
      sock.end(undefined);
    }
  }
}

function formatarMensagem(linhas: string[]): string {
  // Remove separadores visuais do relatório CLI e converte para WhatsApp markdown
  const hoje = new Date();
  const dataStr = [
    String(hoje.getDate()).padStart(2, "0"),
    String(hoje.getMonth() + 1).padStart(2, "0"),
    hoje.getFullYear(),
  ].join("/");
  const horaStr = [
    String(hoje.getHours()).padStart(2, "0"),
    String(hoje.getMinutes()).padStart(2, "0"),
  ].join(":");

  const corpo = linhas
    .filter(l => !l.startsWith("════") && l.trim() !== "")
    .map(l => {
      // Converte icones e seções para formato WhatsApp
      if (l.startsWith("─── ")) return `\n*${l.replace(/─+/g, "").trim()}*`;
      if (l.includes("APROVADO")) return l.replace("✅ RESULTADO:", "✅ *RESULTADO:*");
      if (l.includes("REPROVADO")) return l.replace("❌ RESULTADO:", "❌ *RESULTADO:*");
      return l;
    })
    .join("\n");

  return `🤖 *RASWEB — Relatório Pré-Voo*\n📅 ${dataStr} às ${horaStr}\n${corpo}`;
}
