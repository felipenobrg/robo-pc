// Shared types for the automation bot and verify script

export interface CachedFormState {
  pageUrl: string;
  viewstate: string;
  viewstateGenerator: string;
  eventValidation: string;
  scriptManagerId: string;
  updPanelId: string;
  btnInvocaId: string;
  hddiaselecionadoName: string;
  hdusuaidName: string;
  extraCampos: Record<string, string>;
}

export type AsmxParams = {
  anomesref: string;
  depoid: string;
  usuaid: string;
  hdtipoperfilvaga: string;
};

// verify.ts types
export type Status = "OK" | "ALERTA" | "CRITICO";
export interface CheckResult { nome: string; status: Status; detalhe: string; }
export interface ModalidadeBaseline {
  elementoIds: Record<string, string>;
  jsArquivos: Record<string, number>;
  asmxStatus: number;
}
export interface Baseline {
  versao: string;
  data: string;
  versaoSistema: string;
  dataCompilacao: string;
  presente: ModalidadeBaseline;
  extensao: ModalidadeBaseline;
}
