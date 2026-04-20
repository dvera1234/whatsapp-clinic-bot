function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureAdapterObject(adapter, adapterName) {
  if (!isPlainObject(adapter)) {
    throw new Error(`${adapterName}: adapter must be an object`);
  }
}

function assertMethodGroup(adapter, adapterName, methods, { required }) {
  for (const methodName of methods) {
    const method = adapter[methodName];

    if (required) {
      if (typeof method !== "function") {
        throw new Error(`${adapterName}: ${methodName} is required`);
      }
      continue;
    }

    if (method != null && typeof method !== "function") {
      throw new Error(`${adapterName}: ${methodName} must be a function if provided`);
    }
  }
}

function isContractResultShape(value) {
  if (!isPlainObject(value)) {
    return false;
  }

  if (typeof value.ok !== "boolean") {
    return false;
  }

  const allowedNullableNumber = (field) =>
    value[field] == null || Number.isFinite(Number(value[field]));
  const allowedNullableString = (field) =>
    value[field] == null || typeof value[field] === "string";

  return (
    allowedNullableNumber("status") &&
    allowedNullableString("rid") &&
    allowedNullableString("errorCode")
  );
}

function wrapMethod(adapter, adapterName, methodName) {
  const originalMethod = adapter[methodName];

  if (typeof originalMethod !== "function") {
    return undefined;
  }

  return async function wrappedContractMethod(...args) {
    const result = await originalMethod.apply(adapter, args);

    if (!isContractResultShape(result)) {
      throw new Error(
        `${adapterName}: ${methodName} must return { ok, data, status, rid, errorCode }`
      );
    }

    return result;
  };
}

function buildWrappedAdapter(adapter, requiredMethods, optionalMethods, adapterName) {
  const wrappedAdapter = Object.create(null);

  for (const key of Object.keys(adapter)) {
    if (![...requiredMethods, ...optionalMethods].includes(key)) {
      wrappedAdapter[key] = adapter[key];
    }
  }

  for (const methodName of requiredMethods) {
    wrappedAdapter[methodName] = wrapMethod(adapter, adapterName, methodName);
  }

  for (const methodName of optionalMethods) {
    if (typeof adapter[methodName] === "function") {
      wrappedAdapter[methodName] = wrapMethod(adapter, adapterName, methodName);
    }
  }

  return wrappedAdapter;
}

function assertPortalAdapter(adapter) {
  const adapterName = "Invalid portal adapter";

  ensureAdapterObject(adapter, adapterName);

  const requiredMethods = [
    "validateRegistrationData",
    "createPatientRegistration",
  ];

  const optionalMethods = [
    "resetPassword",
    "sendAccessLink",
    "checkPortalAccess",
  ];

  assertMethodGroup(adapter, adapterName, requiredMethods, { required: true });
  assertMethodGroup(adapter, adapterName, optionalMethods, { required: false });

  return buildWrappedAdapter(
    adapter,
    requiredMethods,
    optionalMethods,
    adapterName
  );
}

export { assertPortalAdapter };
