// api/push.js
const admin = require("firebase-admin");

function ensureAdmin() {
  if (!admin.apps.length) {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!svc) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svc)) });
  }
}

module.exports = async (req, res) => {
  try {
    ensureAdmin();
  } catch (e) {
    console.error("init error:", e);
    return res.status(500).json({ error: "Init failed: " + String(e) });
  }

  if (req.method === "GET") {
    // Réponse simple pour vérifier que la fonction est vivante
    return res.status(200).json({ ok: true, hint: "Use POST with JSON body." });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = req.headers["x-api-key"];
  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { toToken, body, partnerId, chatId } = req.body || {};
    if (!toToken || !body) return res.status(400).json({ error: "Missing toToken/body" });

    const payload = {
      token: toToken,
      notification: { title: "Nouveau message", body },
      data: { type: "new_message", partnerId: partnerId || "", chatId: chatId || "" },
      apns: {
        headers: { "apns-collapse-id": chatId || "chat" },
        payload: {
          aps: {
            alert: { title: "Nouveau message", body },
            sound: "default",
            "thread-id": chatId || "chat",
          },
        },
      },
    };

    const id = await admin.messaging().send(payload);
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    console.error("push error:", e);
    return res.status(500).json({ error: String(e) });
  }
};
