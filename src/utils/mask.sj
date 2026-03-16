function maskPhone(p) {
  const s = String(p || "").replace(/\D+/g, "");
  if (!s) return "***";
  return s.length > 6 ? s.slice(0, 4) + "****" + s.slice(-2) : "***";
}

function maskCpf(cpf) {
  const s = String(cpf || "").replace(/\D+/g, "");
  if (s.length !== 11) return "***";
  return `***.${s.slice(3, 6)}.${s.slice(6, 9)}-**`;
}

function maskIp(ip) {
  const s = String(ip || "").trim();
  if (!s) return null;

  if (s.includes(":")) {
    const parts = s.split(":").filter(Boolean);
    if (!parts.length) return "***";
    return `${parts.slice(0, 3).join(":")}:***`;
  }

  const parts = s.split(".");
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.***.***`;
  }

  return "***";
}

function maskKey(k) {
  const s = String(k || "");
  if (!s) return "***";
  return s.length > 12 ? s.slice(0, 8) + "***" : "***";
}

function maskUrl(u) {
  const s = String(u || "");
  if (!s) return "";
  try {
    const url = new URL(s);
    const parts = url.pathname.split("/").filter(Boolean);
    const keep = parts.slice(0, 1).join("/");
    return `${url.origin}/${keep}/***`;
  } catch {
    return "***";
  }
}

function maskToken(t) {
  if (!t || typeof t !== "string") return "***";
  return t.length > 16 ? `${t.slice(0, 6)}...${t.slice(-4)}` : "***";
}

function maskLoginValue(v) {
  const s = String(v || "").trim();
  if (!s) return "";

  if (s.includes("@")) {
    const [user, domain] = s.split("@");
    const u = user.length <= 2 ? "***" : `${user.slice(0, 2)}***`;
    return `${u}@${domain || "***"}`;
  }

  const digits = s.replace(/\D+/g, "");
  if (digits.length >= 6) {
    return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
  }

  return "***";
}

export {
  maskPhone,
  maskCpf,
  maskIp,
  maskKey,
  maskUrl,
  maskToken,
  maskLoginValue,
};
