const DEFAULT_TO = "5511976374369";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://www.shipsburguer.com.br",
  "https://shipsburguer.com.br",
  "https://ships-burguer-site.vercel.app",
  "http://127.0.0.1:4173",
  "http://localhost:4173"
];
const requestLog = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

function cleanText(value, maxLength = 900) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) chunks.push(chunk);
  for (const chunk of chunks) size += chunk.length;
  if (size > 4096) {
    const error = new Error("request_too_large");
    error.statusCode = 413;
    throw error;
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function getAllowedOrigins() {
  const configuredOrigins = String(process.env.SITE_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configuredOrigins]);
}

function isAllowedOrigin(origin) {
  if (!origin) return process.env.VERCEL_ENV !== "production";
  return getAllowedOrigins().has(origin);
}

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || DEFAULT_ALLOWED_ORIGINS[0]);
  }
}

function getClientIp(req) {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim();
}

function isRateLimited(clientIp) {
  const now = Date.now();
  const previous = requestLog.get(clientIp) || [];
  const recent = previous.filter((timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS);

  if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
    requestLog.set(clientIp, recent);
    return true;
  }

  recent.push(now);
  requestLog.set(clientIp, recent);
  return false;
}

function buildMessage({ question, page }) {
  const lines = [
    "Nova pergunta sem resposta no chatbot da Ship's:",
    "",
    `"${question}"`,
    "",
    "Por favor, adicionar essa resposta na base de conhecimento."
  ];

  if (page) {
    lines.push("", `Pagina: ${page}`);
  }

  return lines.join("\n");
}

async function sendViaMeta({ to, message }) {
  const token = process.env.WHATSAPP_API_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const version = process.env.WHATSAPP_GRAPH_VERSION || "v20.0";

  if (!token || !phoneNumberId) return { configured: false };

  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    })
  });

  return { configured: true, ok: response.ok, status: response.status, body: await response.text() };
}

async function sendViaEvolution({ to, message }) {
  const baseUrl = process.env.WHATSAPP_API_URL;
  const instance = process.env.WHATSAPP_INSTANCE;
  const token = process.env.WHATSAPP_API_TOKEN;

  if (!baseUrl || !instance || !token) return { configured: false };

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/message/sendText/${instance}`, {
    method: "POST",
    headers: {
      apikey: token,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      number: to,
      text: message
    })
  });

  return { configured: true, ok: response.ok, status: response.status, body: await response.text() };
}

async function sendViaZApi({ to, message }) {
  const url = process.env.WHATSAPP_API_URL;
  const clientToken = process.env.WHATSAPP_CLIENT_TOKEN;

  if (!url) return { configured: false };

  const headers = { "Content-Type": "application/json" };
  if (clientToken) headers["Client-Token"] = clientToken;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      phone: to,
      message
    })
  });

  return { configured: true, ok: response.ok, status: response.status, body: await response.text() };
}

async function sendViaCallMeBot({ to, message }) {
  const apiKey = process.env.CALLMEBOT_API_KEY || process.env.WHATSAPP_API_TOKEN;

  if (!apiKey) return { configured: false };

  const params = new URLSearchParams({
    phone: `+${to}`,
    text: message,
    apikey: apiKey
  });

  const response = await fetch(`https://api.callmebot.com/whatsapp.php?${params.toString()}`);
  const body = await response.text();
  const ok = response.ok && !/error|invalid|wrong|incorrect/i.test(body);

  return { configured: true, ok, status: response.status, body };
}

async function sendViaCustom({ to, message, question, page }) {
  const url = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_API_TOKEN;
  const authHeader = process.env.WHATSAPP_AUTH_HEADER || "Authorization";
  const authPrefix = process.env.WHATSAPP_AUTH_PREFIX || "Bearer";

  if (!url) return { configured: false };

  const headers = { "Content-Type": "application/json" };
  if (token) headers[authHeader] = authPrefix ? `${authPrefix} ${token}` : token;

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      to,
      message,
      question,
      page,
      source: "ships-chatbot"
    })
  });

  return { configured: true, ok: response.ok, status: response.status, body: await response.text() };
}

async function sendWhatsAppMessage(payload) {
  const provider = (process.env.WHATSAPP_API_PROVIDER || "custom").toLowerCase();

  if (provider === "meta") return sendViaMeta(payload);
  if (provider === "evolution") return sendViaEvolution(payload);
  if (provider === "zapi") return sendViaZApi(payload);
  if (provider === "callmebot") return sendViaCallMeBot(payload);
  return sendViaCustom(payload);
}

module.exports = async function handler(req, res) {
  setCorsHeaders(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = isAllowedOrigin(req.headers.origin) ? 204 : 403;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method_not_allowed" });
    return;
  }

  try {
    if (!isAllowedOrigin(req.headers.origin)) {
      json(res, 403, { ok: false, error: "origin_not_allowed" });
      return;
    }

    if (isRateLimited(getClientIp(req))) {
      json(res, 429, { ok: false, error: "too_many_requests" });
      return;
    }

    const body = await readBody(req);
    const question = cleanText(body.question);
    const page = cleanText(body.page, 300);
    const to = cleanText(process.env.WHATSAPP_NOTIFY_TO || DEFAULT_TO, 32).replace(/\D/g, "");

    if (!question) {
      json(res, 400, { ok: false, error: "missing_question" });
      return;
    }

    const message = buildMessage({ question, page });
    const result = await sendWhatsAppMessage({ to, message, question, page });

    if (!result.configured) {
      json(res, 501, { ok: false, error: "whatsapp_api_not_configured" });
      return;
    }

    if (!result.ok) {
      json(res, 502, { ok: false, error: "whatsapp_api_failed", status: result.status });
      return;
    }

    json(res, 202, { ok: true });
  } catch (error) {
    json(res, error.statusCode || 500, { ok: false, error: error.message === "request_too_large" ? "request_too_large" : "internal_error" });
  }
};
