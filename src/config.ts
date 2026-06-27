export const raswebUrl      = process.env.RASWEB_URL      ?? "https://rasweb.pcivil.rj.gov.br/";
export const raswebUsername = process.env.RASWEB_USERNAME;
export const raswebPassword = process.env.RASWEB_PASSWORD;

export const MODO_DIAGNOSTICO    = process.env.MODO_DIAGNOSTICO    === "true";
export const MODO_TESTE_RESERVA  = process.env.MODO_TESTE_RESERVA  === "true";
export const MODO_TESTE_COMPLETO = process.env.MODO_TESTE_COMPLETO === "true";
export const MODO_CAPTURAR_POPUP = process.env.MODO_CAPTURAR_POPUP === "true";
export const MODO_TESTE_ROTACAO  = process.env.MODO_TESTE_ROTACAO  === "true";
export const FORCAR_EXECUCAO     = process.env.FORCAR_EXECUCAO     === "true";

export const INTERVALO_MIN_MS    = parseInt(process.env.INTERVALO_MIN_MS    ?? "45000");
export const INTERVALO_MAX_MS    = parseInt(process.env.INTERVALO_MAX_MS    ?? "90000");
export const TIMEOUT_VAGAS_MS    = parseInt(process.env.TIMEOUT_VAGAS_MS    ?? "300000");
export const POLLING_ASMX_MS     = parseInt(process.env.POLLING_ASMX_MS     ?? "100");
export const POLLING_TURBO_MS    = parseInt(process.env.POLLING_TURBO_MS    ?? "50");
export const SEGUNDOS_TURBO      = parseInt(process.env.SEGUNDOS_TURBO      ?? "30");
export const MINUTOS_ANTECIPACAO = parseInt(process.env.MINUTOS_ANTECIPACAO ?? "3");
export const DELEGACIA_MAX       = parseInt(process.env.DELEGACIA_MAX        ?? "66");

export const DELEGACIA_PREFERIDAS: number[] = (process.env.DELEGACIA_PREFERIDAS ?? "37,41")
  .split(",")
  .map(s => parseInt(s.trim(), 10))
  .filter(n => !isNaN(n));

export const HORARIO_ABERTURA_FIXO = process.env.HORARIO_ABERTURA ?? "";

export const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.120 Safari/537.36",
];

export type Modalidade = "extensao" | "presente";
export const DIAS_RAS_PRESENTE = [5, 20, 25, 26];
export const DIA_RAS_EXTENSAO  = 21;
export const URL_MODALIDADE: Record<Modalidade, string> = {
  presente: "FRMRESERVAPRESENTE.ASPX",
  extensao: "FRMRESERVARVAGASERVIDOR.ASPX",
};
