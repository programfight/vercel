// api/push.js (Vercel)
import admin from "firebase-admin";

const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(svc)),
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Sécurité simple: clé partagée (tu peux aussi vérifier un ID token Firebase)
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
      data: {
        type: "new_message",
        partnerId: partnerId || "",
        chatId: chatId || "",
      },
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

    const resp = await admin.messaging().send(payload);
    return res.status(200).json({ ok: true, id: resp });
  } catch (e) {
    console.error("push error:", e);
    return res.status(500).json({ error: String(e) });
  }
}
