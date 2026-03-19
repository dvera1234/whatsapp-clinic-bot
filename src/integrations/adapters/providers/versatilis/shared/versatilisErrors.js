export class ProviderIntegrationError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "ProviderIntegrationError";
    this.code = options.code || "PROVIDER_INTEGRATION_ERROR";
    this.httpStatus = options.httpStatus || null;
    this.endpoint = options.endpoint || null;
    this.rid = options.rid || null;
    this.isRetryable = Boolean(options.isRetryable);
    this.meta = options.meta || null;
  }
}

export class ProviderAuthError extends ProviderIntegrationError {
  constructor(message = "Provider authentication failed", options = {}) {
    super(message, {
      ...options,
      code: "PROVIDER_AUTH_ERROR",
      httpStatus: options.httpStatus || 401,
      isRetryable: false,
    });
  }
}

export class ProviderNetworkError extends ProviderIntegrationError {
  constructor(message = "Provider network failure", options = {}) {
    super(message, {
      ...options,
      code: "PROVIDER_NETWORK_ERROR",
      isRetryable: true,
    });
  }
}

export class ProviderTimeoutError extends ProviderIntegrationError {
  constructor(message = "Provider request timeout", options = {}) {
    super(message, {
      ...options,
      code: "PROVIDER_TIMEOUT",
      isRetryable: true,
    });
  }
}

export class ProviderBadResponseError extends ProviderIntegrationError {
  constructor(message = "Provider returned invalid response", options = {}) {
    super(message, {
      ...options,
      code: "PROVIDER_BAD_RESPONSE",
      isRetryable: false,
    });
  }
}

export function normalizeProviderError(err, context = {}) {
  if (err instanceof ProviderIntegrationError) {
    return err;
  }

  const message = err?.message || "Unknown provider integration error";

  return new ProviderIntegrationError(message, {
    endpoint: context.endpoint,
    rid: context.rid,
    meta: {
      originalName: err?.name,
    },
  });
}
