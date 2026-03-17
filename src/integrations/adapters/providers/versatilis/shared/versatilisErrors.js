export class VersatilisError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "VersatilisError";

    this.code = options.code || "VERSATILIS_ERROR";
    this.httpStatus = options.httpStatus || null;

    this.endpoint = options.endpoint || null;
    this.rid = options.rid || null;

    this.isRetryable = Boolean(options.isRetryable);

    this.meta = options.meta || null;
  }
}

export class VersatilisAuthError extends VersatilisError {
  constructor(message = "Versatilis authentication failed", options = {}) {
    super(message, {
      ...options,
      code: "VERSATILIS_AUTH_ERROR",
      httpStatus: options.httpStatus || 401,
      isRetryable: false,
    });
  }
}

export class VersatilisNetworkError extends VersatilisError {
  constructor(message = "Versatilis network failure", options = {}) {
    super(message, {
      ...options,
      code: "VERSATILIS_NETWORK_ERROR",
      isRetryable: true,
    });
  }
}

export class VersatilisTimeoutError extends VersatilisError {
  constructor(message = "Versatilis request timeout", options = {}) {
    super(message, {
      ...options,
      code: "VERSATILIS_TIMEOUT",
      isRetryable: true,
    });
  }
}

export class VersatilisBadResponseError extends VersatilisError {
  constructor(message = "Versatilis returned invalid response", options = {}) {
    super(message, {
      ...options,
      code: "VERSATILIS_BAD_RESPONSE",
      isRetryable: false,
    });
  }
}

export function normalizeVersatilisError(err, context = {}) {
  if (err instanceof VersatilisError) {
    return err;
  }

  const message = err?.message || "Unknown Versatilis error";

  return new VersatilisError(message, {
    endpoint: context.endpoint,
    rid: context.rid,
    meta: {
      originalName: err?.name,
    },
  });
}
