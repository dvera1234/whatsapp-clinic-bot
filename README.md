# WhatsApp Multi-Tenant Clinic Platform

## Visão Geral

Plataforma SaaS multi-tenant para automação administrativa de clínicas médicas via WhatsApp.

Arquitetura projetada para:

- múltiplas clínicas (tenant)
- múltiplos médicos (practitioners)
- múltiplos planos (plan)
- múltiplos providers (ex: Versatilis, Google Calendar)
- isolamento total por tenant
- runtime como fonte única da verdade

---

## Arquitetura

### Core (neutro)
- não conhece clínica
- não conhece provider
- não conhece planos humanos
- apenas interpreta runtime

### Runtime
Gerado por:
- banco (Postgres)
- JSON do tenant
- integrações

Estrutura:
runtime = {
tenantId,
providers,
integrations,
content,
practitioners,
plans,
support,
portal,
channels
}

---

## Camadas

### flows/
Máquina de estado determinística

### adapters/
Isolam providers externos

### transport/
Comunicação HTTP com providers

### session/
Estado transitório (Redis)

### observability/
Logs estruturados e auditoria

---

## Fluxo de Execução
Webhook → resolveTenant → load config → build runtime
→ handleInbound → dispatch → handler → adapter → provider

---

## ENV obrigatórias
VERIFY_TOKEN
APP_SECRET
DATABASE_URL
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
SESSION_TTL_SECONDS
FLOW_RESET_CODE

---

## Execução

### Produção
npm start

### Desenvolvimento
(requer nodemon)
npm run dev

---

## Dependências externas

- WhatsApp Cloud API
- Redis (Upstash)
- Postgres (Neon)
- Provider (ex: Versatilis)

---

## Princípios obrigatórios

- core neutro
- runtime = única fonte de verdade
- zero hardcode de clínica
- zero hardcode de plano
- adapters isolam providers
- multi-tenant real
- auditoria obrigatória
