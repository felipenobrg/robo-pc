/**
 * Roda UMA VEZ para vincular o WhatsApp ao bot via QR Code.
 * Após escanear, a sessão fica salva em baileys-auth/ e o verify
 * envia mensagens automaticamente sem precisar escanear de novo.
 *
 * Como usar:
 *   npx tsx src/whatsapp-setup.ts
 */
import dotenv from "dotenv";
import path from "path";
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: false });

import fs from "fs";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";
import pino from "pino";

const DATA_DIR = process.env.VERIFY_DATA_DIR ?? path.resolve(__dirname, "../../..");
const AUTH_DIR = path.join(DATA_DIR, "baileys-auth");
const NUMERO   = process.env.WHATSAPP_NUMERO_DESTINO ?? "";

async function setup() {
  if (!NUMERO) {
    console.error("❌ Configure WHATSAPP_NUMERO_DESTINO no .env antes de rodar o setup.");
    console.error("   Exemplo: WHATSAPP_NUMERO_DESTINO=5521999999999");
    process.exit(1);
  }

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "silent" });

  console.log("════════════════════════════════════════════════");
  console.log("  SETUP WHATSAPP — RASWEB Bot");
  console.log("════════════════════════════════════════════════");
  console.log("Aguardando QR Code... Escaneie com o WhatsApp do");
  console.log("número que vai ENVIAR as mensagens.");
  console.log("(WhatsApp → Dispositivos conectados → Conectar dispositivo)");
  console.log("════════════════════════════════════════════════\n");

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    printQRInTerminal: true,
    browser: ["RASWEB Bot", "Chrome", "1.0"],
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("\n✅ WhatsApp vinculado com sucesso!");
      console.log(`   Sessão salva em: ${AUTH_DIR}`);

      // Envia mensagem de teste para confirmar
      const digits = NUMERO.replace(/\D/g, "");
      const jid    = `${digits}@s.whatsapp.net`;
      await new Promise(r => setTimeout(r, 2000));

      try {
        await sock.sendMessage(jid, {
          text: "✅ *RASWEB Bot* vinculado com sucesso!\n\nVocê receberá o relatório pré-voo aqui sempre que o `verify` rodar.",
        });
        console.log(`   Mensagem de teste enviada para ${digits}`);
      } catch (e) {
        console.warn(`   Aviso: não foi possível enviar mensagem de teste — ${e}`);
      }

      await new Promise(r => setTimeout(r, 1000));
      sock.end(undefined);
      console.log("\nSetup concluído. O verify enviará mensagens automaticamente agora.");
      process.exit(0);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut) {
        console.error("❌ Sessão encerrada (logout). Rode o setup novamente.");
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      } else {
        console.error(`❌ Conexão perdida (${statusCode}). Tente novamente.`);
      }
      process.exit(1);
    }
  });
}

void setup();
