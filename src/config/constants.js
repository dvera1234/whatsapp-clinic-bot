import { hashText } from "../utils/crypto.js";
import {
  FLOW_RESET_CODE,
  SESSION_TTL_SECONDS,
} from "./env.js";

const INACTIVITY_WARN_MS = 14 * 60 * 1000 + 50 * 1000;
const MIN_LEAD_HOURS = 12;
const TZ_OFFSET = "-03:00";

const PLAN_KEYS = {
  PARTICULAR: "PARTICULAR",
  MEDSENIOR_SP: "MEDSENIOR_SP",
};

function resolvePlanIdFromRuntime(planKey, runtime) {
  if (!runtime?.plans) return null;

  return planKey === PLAN_KEYS.MEDSENIOR_SP
    ? runtime.plans.insuredPlanId
    : runtime.plans.privatePlanId;
}

const MSG = {
  ASK_CPF_PORTAL: `Para prosseguir com o agendamento, preciso confirmar seu cadastro.\n\nEnvie seu CPF (somente números).`,
  CPF_INVALIDO: `⚠️ CPF inválido. Envie 11 dígitos (somente números).`,
  PLAN_DIVERGENCIA: `Notei uma divergência no convênio do seu cadastro.\n\nPor gentileza, qual convênio você quer usar nesta consulta?`,
  BTN_PLAN_PART: "Particular",
  BTN_PLAN_MED: "MedSênior SP",
  PORTAL_NEED_DATA: (faltas) =>
    `Para prosseguir, preciso completar seu cadastro do Portal do Paciente.\n\nFaltam:\n${faltas}\n\nVamos continuar.`,
  PORTAL_EXISTENTE_INCOMPLETO_BLOQUEIO: (faltas) =>
    `Encontrei seu cadastro ✅, porém ele está incompleto no Portal do Paciente.\n\nPor segurança, o agendamento por aqui fica bloqueado neste caso.\n\nFaltam:\n${faltas}\n\n✅  Precisaria entrar em contato com um atendente para regularizar seu cadastro.`,
  BTN_FALAR_ATENDENTE: `Falar com atendente`,
  ASK_NOME: `Informe seu nome completo:`,
  ASK_DTNASC: `Informe sua data de nascimento (DD/MM/AAAA):`,
  ASK_SEXO: `Selecione seu sexo:`,
  ASK_EMAIL: `Informe seu e-mail:`,
  ASK_CEP: `Informe seu CEP (somente números):`,
  ASK_ENDERECO: `Informe seu endereço (logradouro):`,
  ASK_NUMERO: `Número:`,
  ASK_COMPLEMENTO: `Complemento (se não tiver, envie apenas 0):`,
  ASK_BAIRRO: `Bairro:`,
  ASK_CIDADE: `Cidade:`,
  ASK_UF: `Estado (UF), ex.: SP:`,
  ENCERRAMENTO: `✅ Atendimento encerrado por inatividade.\n\n🤝 Caso precise de algo mais, ficamos à disposição!\n🙏 Agradecemos sua atenção!\n\n📲 Siga-nos também no Instagram:\nhttps://www.instagram.com/dr.david_vera/`,
  MENU: `👋 Olá! Sou a Cláudia, assistente virtual do Dr. David E. Vera.\n\nPara começar, escolha uma opção abaixo.\n\n📌 Responda apenas com o número da opção desejada:\n\n1️⃣ Agendamento particular  \n2️⃣ Agendamento convênio  \n3️⃣ Acompanhamento pós-operatório  \n4️⃣ Falar com um atendente`,
  LGPD_CONSENT: `🔒 Proteção de dados (LGPD)\n\nPara realizar o agendamento, precisamos coletar alguns dados pessoais, como CPF e informações de contato, utilizados exclusivamente para identificação do paciente e gestão do atendimento pelo Dr. David E. Vera e sua clínica.\n\nEsses dados são tratados conforme a Lei Geral de Proteção de Dados (Lei nº 13.709/2018) e poderão integrar o prontuário médico quando necessário para fins assistenciais e cumprimento de obrigações legais.\n\nPara continuar, informe se concorda com o tratamento desses dados para fins de agendamento.\n\n📌 Responda apenas com o número da opção desejada:\n\n1) Concordo e desejo continuar\n2) Não concordo`,
  LGPD_RECUSA: `Não é possível realizar o agendamento sem o consentimento para tratamento dos dados necessários ao atendimento.\n\nCaso deseje agendar no futuro, basta iniciar novamente o atendimento.\n\nAtenciosamente.`,
  PARTICULAR: `Agendamento particular\n\n💰 Valor da consulta: R$ 350,00\n\nOnde será a consulta\n📍 Consultório Livance – Campinas\nAvenida Orosimbo Maia, 360\n6º andar – Vila Itapura\nCampinas – SP | CEP 13010-211\n\nAo chegar, realize o check-in no totem localizado na recepção da unidade.\n\nFormas de pagamento\n• Pix\n• Débito\n• Cartão de crédito\n\nOs pagamentos são realizados no totem de atendimento no momento da chegada, antes da consulta.\n\nAgendamento\nEscolha uma opção (responda com o número):\n1) Agendar minha consulta\n0) Voltar ao menu inicial`,
  CONVENIOS: `Selecione o seu convênio (responda com o número):\n\n1) GoCare\n2) Samaritano\n3) Salusmed\n4) Proasa\n5) MedSênior\n\nℹ️ O atendimento por convênio é realizado apenas pelos planos de saúde listados acima.\n\n0) Voltar ao menu inicial`,
  CONVENIO_GOCARE: `GoCare\n\nO agendamento é feito pelo paciente diretamente na Clínica Santé.\n\n📞 (19) 3995-0382\n\nSe preferir, você também pode realizar a consulta de forma particular,\ncom agendamento rápido e direto por aqui.\n\nEscolha uma opção (responda com o número):\n9) Agendamento particular\n0) Voltar ao menu inicial`,
  CONVENIO_SAMARITANO: `Samaritano\n\nO agendamento é feito pelo paciente diretamente nas unidades disponíveis:\n\nHospital Samaritano de Campinas – Unidade 2\n\n📞 (19) 3738-8100\n\nClínica Pró-Consulta de Sumaré\n\n📞 (19) 3883-1314\n\nSe preferir, você também pode realizar a consulta de forma particular,\ncom agendamento rápido e direto por aqui.\n\nEscolha uma opção (responda com o número):\n9) Agendamento particular\n0) Voltar ao menu inicial`,
  CONVENIO_SALUSMED: `Salusmed\n\nO agendamento é feito pelo paciente na Clínica Matuda\n\n📞 (19) 3733-1111\n\nSe preferir, você também pode realizar a consulta de forma particular,\ncom agendamento rápido e direto por aqui.\n\nEscolha uma opção (responda com o número):\n9) Agendamento particular\n0) Voltar ao menu inicial`,
  CONVENIO_PROASA: `Proasa\n\nO agendamento é feito pelo paciente no Centro Médico do CEVISA\n\n📞 (19) 3858-5918\n\nSe preferir, você também pode realizar a consulta de forma particular,\ncom agendamento rápido e direto por aqui.\n\nEscolha uma opção (responda com o número):\n9) Agendamento particular\n0) Voltar ao menu inicial`,
  MEDSENIOR: `MedSênior\n\nPara pacientes MedSênior, o agendamento é realizado diretamente por aqui.\n\n📍 Consultório Livance – Campinas\nAvenida Orosimbo Maia, 360\n6º andar – Vila Itapura\n\nEscolha uma opção (responda com o número):\n1) Agendar minha consulta\n0) Voltar ao menu inicial`,
  POS_MENU: `Acompanhamento pós-operatório\n\nEste canal é destinado a pacientes operados pelo Dr. David E. Vera.\n\nEscolha uma opção (responda com o número):\n1) Pós-operatório recente (até 30 dias)\n2) Pós-operatório tardio (mais de 30 dias)\n0) Voltar ao menu inicial`,
  POS_RECENTE: `Pós-operatório recente\n👉 Acesse o canal dedicado:\nhttps://wa.me/5519933005596\n\nObservação:\nSolicitações administrativas (atestados, laudos, relatórios)\ndevem ser realizadas em consulta.\n\n0) Voltar ao menu inicial`,
  POS_TARDIO: `Pós-operatório tardio\n\nPara pós-operatório tardio, orientamos que as demandas não urgentes\nsejam avaliadas em consulta.\n\nSolicitações administrativas (atestados, laudos, relatórios) devem ser realizadas em consulta.\n\nEscolha uma opção (responda com o número):\n1) Agendamento particular\n2) Agendamento convênio\n0) Voltar ao menu inicial`,
  ATENDENTE: `Falar com um atendente\n\nEste canal está disponível para apoio, dúvidas gerais\ne auxílio no uso dos serviços da clínica.\n\nPara solicitações médicas, como atestados, laudos,\norçamentos, relatórios ou orientações clínicas,\né necessária avaliação em consulta.\n\nDescreva abaixo como podemos te ajudar.\n\n0) Voltar ao menu inicial`,
  AJUDA_PERGUNTA: `Certo — me diga qual foi a dificuldade no agendamento (o que aconteceu).`,
  REDIS_UNAVAILABLE: `⚠️ Ocorreu uma instabilidade temporária no atendimento.\n\nPor favor, envie novamente sua mensagem em instantes para reiniciar o fluxo com segurança.`,
};

const LGPD_TEXT_VERSION = "LGPD_v1";
const LGPD_TEXT_HASH = hashText(MSG.LGPD_CONSENT);

export {
  INACTIVITY_WARN_MS,
  MIN_LEAD_HOURS,
  TZ_OFFSET,
  PLAN_KEYS,
  resolvePlanIdFromRuntime,
  MSG,
  LGPD_TEXT_VERSION,
  LGPD_TEXT_HASH,
  FLOW_RESET_CODE,
  SESSION_TTL_SECONDS,
};
