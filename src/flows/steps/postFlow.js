import { debugLog } from "../../observability/audit.js";

/**
 * POST FLOW STEP
 *
 * Papel arquitetural:
 * - Placeholder formal para fluxos pós-atendimento
 * - Não possui comportamento ativo nesta fase do sistema
 *
 * Regras:
 * - Não altera sessão
 * - Não envia mensagens
 * - Não intercepta estados
 * - Não executa lógica de negócio
 *
 * Uso futuro previsto (fora do escopo atual):
 * - pós-consulta
 * - pós-procedimento
 * - acompanhamento administrativo
 * - fluxos operacionais assíncronos
 *
 * Comportamento atual:
 * - Sempre retorna false (não consome o fluxo)
 */
export async function handlePostFlowStep(flowCtx) {
  // Debug opcional para rastreabilidade de pipeline
  debugLog("POST_FLOW_STEP_SKIPPED", {
    tenantId: flowCtx?.tenantId,
    state: flowCtx?.state || null,
  });

  return false;
}
