/* eslint-disable quotes, max-len, indent, operator-linebreak, object-curly-spacing, comma-dangle, quote-props */
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

async function verifyFirebaseIdToken(req) {
  const auth = req.headers?.authorization || req.headers?.Authorization || "";
  const m = typeof auth === "string" ? auth.match(/^Bearer (.+)$/i) : null;
  if (!m) {
    const hasKey = !!req.headers?.["x-api-key"];
    throw Object.assign(new Error("missing_authorization_bearer"), { status: 401, hasKey });
  }
  const idToken = m[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    return decoded; // { uid, ... }
  } catch (e) {
    throw Object.assign(new Error("invalid_id_token"), { status: 401, details: e?.message });
  }
}

// Firestore helpers
const db = () => admin.firestore();

async function getUserTokens(uid) {
  const snap = await db().collection("users").doc(uid).get();
  if (!snap.exists) return [];
  const arr = Array.isArray(snap.get("fcmTokens")) ? snap.get("fcmTokens") : [];
  const single = snap.get("fcmToken");
  const tokens = [...arr];
  if (single && !tokens.includes(single)) tokens.push(single);
  return tokens.filter(t => typeof t === "string" && t.trim().length > 0);
}

async function removeInvalidTokens(uid, invalidTokens) {
  if (!invalidTokens.length) return;
  const userRef = db().collection("users").doc(uid);
  await db().runTransaction(async (tx) => {
    const doc = await tx.get(userRef);
    if (!doc.exists) return;
    const arr = Array.isArray(doc.get("fcmTokens")) ? doc.get("fcmTokens") : [];
    const single = doc.get("fcmToken");
    const newArray = arr.filter(t => !invalidTokens.includes(t));
    const update = { fcmTokens: newArray };
    if (single && invalidTokens.includes(single)) {
      update.fcmToken = admin.firestore.FieldValue.delete();
    }
    tx.set(userRef, update, { merge: true });
  });
}

async function shouldSkipPushIfViewingChat(toUid, fromUid) {
  const snap = await db().collection("chatPresence").doc(toUid).get();
  if (!snap.exists) return false;
  return snap.get("viewingChatWith") === fromUid;
}

function safeChatId(input) {
  return String(input || "chat").replace(/[<>]/g, "");
}

async function computeUnreadCountForRecipient(chatId, fromUid, toUid) {
  // On compte les messages envoyés par fromUid non lus par toUid
  // Limite: on scanne les N derniers (500) et on filtre localement readBy !contains toUid
  const ref = db().collection("chats").doc(chatId).collection("messages");
  const qs = await ref
    .where("senderId", "==", fromUid)
    .orderBy("timestamp", "desc")
    .limit(500)
    .get();

  let count = 0;
  qs.docs.forEach(doc => {
    const data = doc.data() || {};
    if (data.deleted === true) return;
    const readBy = Array.isArray(data.readBy) ? data.readBy : [];
    if (!readBy.includes(toUid)) count++;
  });
  return count;
}

module.exports = async (req, res) => {
  try {
    ensureAdmin();
  } catch (e) {
    console.error("❌ init error:", e);
    return res.status(500).json({ error: "Init failed", details: { message: e.message, stack: e.stack } });
  }

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, hint: "Use POST with JSON body and Authorization: Bearer <ID token>." });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Auth via Firebase ID token
  let authUser;
  try {
    authUser = await verifyFirebaseIdToken(req);
  } catch (e) {
    const status = e.status || 401;
    return res.status(status).json({ error: e.message, details: e.details, hasXApiKey: e.hasKey });
  }

  try {
    // Body parsing fallback si jamais req.body est une string
    let bodyObj = req.body;
    if (typeof bodyObj === "string") {
      try { bodyObj = JSON.parse(bodyObj); } catch {}
    }

    // Entrées attendues (parité avec ta Function): partnerId, chatId, kind, text?, notificationTitle?, apns?
    const {
      partnerId,
      chatId,
      kind,
      text,
      notificationTitle,
      apns
    } = bodyObj || {};

    if (!partnerId || !chatId || !kind) {
      return res.status(400).json({ error: "Missing required fields", required: ["partnerId", "chatId", "kind"] });
    }

    // Option: skip si le destinataire regarde déjà ce chat
    const skip = await shouldSkipPushIfViewingChat(partnerId, authUser.uid);
    if (skip) {
      return res.status(200).json({ skipped: true, reason: "recipient_viewing_chat" });
    }

    // Résolution des tokens
    const tokens = await getUserTokens(partnerId);
    if (!tokens.length) {
      return res.status(200).json({ skipped: true, reason: "no_tokens" });
    }

    // Corps lisible selon le type (parité)
    const body =
      kind === "image" ? "📷 Photo" :
      kind === "location" ? "📍 Localisation" :
      (typeof text === "string" && text.trim().length > 0 ? text : "Nouveau message");

    const title = typeof notificationTitle === "string" && notificationTitle.trim().length > 0
      ? notificationTitle
      : "Nouveau message";

    const safeId = safeChatId(chatId);
    
    let unreadCount = 0;
    try {
      unreadCount = await computeUnreadCountForRecipient(safeId, authUser.uid, partnerId);
    } catch (e) {
      console.warn("Failed to compute unreadCount:", e?.message || e);
    }
    
    // Multicast payload
    const payload = {
      tokens,
      notification: { title, body },
      data: {
        type: "new_message",
        partnerId: authUser.uid || "",
        chatId: safeId
      },
      apns: {
        headers: {
          "apns-collapse-id": safeId,
          ...(apns?.headers || {})
        },
        payload: {
          aps: {
            alert: { title, body },
            sound: "default",
            "thread-id": safeId,
            badge: unreadCount, // 👈 badge absolu
            ...(apns?.payload?.aps || {})
          },
          ...(apns?.payload ? { ...apns.payload, aps: undefined } : {})
        }
      }
    };

    // Envoi multicast
    const resp = await admin.messaging().sendEachForMulticast(payload);

    // Tokens invalides à nettoyer
    const invalidTokens = [];
    resp.responses.forEach((r, idx) => {
      if (!r.success && r.error) {
        const code = r.error.code || "";
        if (
          /registration-token-not-registered/i.test(code) ||
          /invalid-registration-token/i.test(code) ||
          /unregistered/i.test(code)
        ) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    if (invalidTokens.length) {
      try {
        await removeInvalidTokens(partnerId, invalidTokens);
      } catch (cleanErr) {
        console.warn("Failed to clean invalid tokens:", cleanErr);
      }
    }

    return res.status(200).json({
      ok: true,
      successCount: resp.successCount,
      failureCount: resp.failureCount,
      invalidatedTokens: invalidTokens,
      results: resp.responses.map((r, idx) => ({
        token: tokens[idx],
        success: r.success,
        error: r.error ? { code: r.error.code, message: r.error.message } : undefined
      }))
    });
  } catch (e) {
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
