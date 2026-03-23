export function getPromptByWizardState(state, MSG) {
  switch (state) {
    case "WZ_NOME":
      return MSG.ASK_NOME;
    case "WZ_DTNASC":
      return MSG.ASK_DTNASC;
    case "WZ_EMAIL":
      return MSG.ASK_EMAIL;
    case "WZ_CEP":
      return MSG.ASK_CEP;
    case "WZ_ENDERECO":
      return MSG.ASK_ENDERECO;
    case "WZ_NUMERO":
      return MSG.ASK_NUMERO;
    case "WZ_COMPLEMENTO":
      return MSG.ASK_COMPLEMENTO;
    case "WZ_BAIRRO":
      return MSG.ASK_BAIRRO;
    case "WZ_CIDADE":
      return MSG.ASK_CIDADE;
    case "WZ_UF":
      return MSG.ASK_UF;
    default:
      return MSG.ASK_NOME;
  }
}
