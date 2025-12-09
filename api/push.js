// api/push.js
const admin = require("firebase-admin");

function ensureAdmin() {
  if (!admin.apps.length) {
    const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!svc) throw new Error("FIREBASE_SERVICE_ACCOUNT missing");
    // ATTENTION: private_key doit contenir les \n échappés dans l'env (remplacés par \\n)
    const creds = JSON.parse(svc);
    admin.initializeApp({ credential: admin.credential.cert(creds) });
    console.log("✅ Admin initialized for project:", admin.app().options.projectId || creds.project_id);
  }
}

module.exports = async (req, res) => {
  try {
    ensureAdmin();
  } catch (e) {
    console.error("❌ init error:", e);
    return res.status(500).json({ error: "Init failed", details: { message: e.message, stack: e.stack } });
  }

  if (req.method === "GET") {
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
    // Body parsing fallback si jamais req.body est une string
    let bodyObj = req.body;
    if (typeof bodyObj === "string") {
      try { bodyObj = JSON.parse(bodyObj); } catch {}
    }

    const { toToken, body, partnerId, chatId } = bodyObj || {};
    if (!toToken || !body) {
      return res.status(400).json({ error: "Missing toToken/body" });
    }

    // Eviter les chevrons dans chatId
    const safeChatId = (chatId || "chat").replace(/[<>]/g, "");

    const payload = {
      token: toToken,
      notification: { title: "Nouveau message", body },
      data: {
        type: "new_message",
        partnerId: partnerId || "",
        chatId: safeChatId,
      },
      apns: {
        headers: {
          "apns-collapse-id": safeChatId,
          "apns-push-type": "alert",
          "apns-priority": "10"
        },
        payload: {
          aps: {
            alert: { title: "Nouveau message", body },
            sound: "default",
            "thread-id": safeChatId
          }
        }
      }
    };

    // Option: dry run pour valider côté FCM sans envoyer
    // const id = await admin.messaging().send(payload, true);

    const id = await admin.messaging().send(payload);
    console.log("✅ FCM sent:", id);
    return res.status(200).json({ ok: true, id });
  } catch (e) {
    // Erreurs Messaging typiques: e.code = 'messaging/registration-token-not-registered', etc.
    const err = {
      code: e.code,
      message: e.message,
      errorInfo: e.errorInfo,
      stack: e.stack
    };
    console.error("❌ push error:", err);
    return res.status(500).json({ error: "Push failed", ...err });
  }
};
