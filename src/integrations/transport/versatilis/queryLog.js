function sanitizeQueryForLog(queryObj) {
  if (!queryObj || typeof queryObj !== "object") return null;

  const out = {};

  for (const [k, v] of Object.entries(queryObj)) {
    const key = String(k || "").toLowerCase();

    if (key === "login") {
      const s = String(v || "").trim();

      if (!s) {
        out[k] = "";
      } else if (s.includes("@")) {
        const [user, domain] = s.split("@");
        const u = user.length <= 2 ? "***" : `${user.slice(0, 2)}***`;
        out[k] = `${u}@${domain || "***"}`;
      } else {
        const digits = s.replace(/\D+/g, "");
        out[k] =
          digits.length >= 6
            ? `${digits.slice(0, 2)}***${digits.slice(-2)}`
            : "***";
      }

      continue;
    }

    if (
      key === "dtnasc" ||
      key === "datanascimento" ||
      key === "usercpf" ||
      key === "cpf" ||
      key === "email"
    ) {
      out[k] = "***";
      continue;
    }

    out[k] = v;
  }

  return out;
}

export { sanitizeQueryForLog };
