import {
  versaFindCodUsuarioByCPF,
  versaFindCodUsuarioByDadosCPF,
  versaGetDadosUsuarioPorCodigo,
  versaHadAppointmentLast30Days,
  validatePortalCompleteness,
  versaCreatePortalCompleto,
  // etc...
} from "../versatilis/helpers.js";

export function createVersatilisAdapter({ tenantConfig }) {
  return {
    async buscarPacientePorCpf({ cpf, traceMeta }) {
      return await versaFindCodUsuarioByCPF({ cpf, traceMeta });
    },

    async buscarCodUsuarioPorCpf({ cpf, traceMeta }) {
      return await versaFindCodUsuarioByDadosCPF({ cpf, traceMeta });
    },

    async buscarPerfilPaciente({ codUsuario, traceMeta }) {
      return await versaGetDadosUsuarioPorCodigo({ codUsuario, traceMeta });
    },

    async validarCadastroCompleto({ perfil }) {
      return validatePortalCompleteness(perfil);
    },

    async verificarRetorno30Dias({ codUsuario, traceMeta }) {
      return versaHadAppointmentLast30Days({ codUsuario, traceMeta });
    },

    async criarUsuarioPortal({ dados, traceMeta }) {
      return versaCreatePortalCompleto({ dados, traceMeta });
    },

    // 👇 você vai expandir depois
    async confirmarAgendamento(payload) {
      throw new Error("confirmarAgendamento não implementado ainda");
    },

    async buscarDatasDisponiveis(payload) {
      throw new Error("buscarDatasDisponiveis não implementado ainda");
    },

    async buscarHorariosDoDia(payload) {
      throw new Error("buscarHorariosDoDia não implementado ainda");
    },
  };
}
