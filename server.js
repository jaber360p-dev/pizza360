const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

const {
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
  RELAY_SECRET,
  FIREBASE_SERVICE_ACCOUNT,
  PORT = 3000,
} = process.env;

// 1. تهيئة Firebase Admin SDK
if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    console.log("✅ Firebase Admin initialized successfully.");
  } catch (err) {
    console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT JSON:", err);
  }
} else {
  console.warn("⚠️ FIREBASE_SERVICE_ACCOUNT environment variable is missing!");
}

const db = admin.apps.length ? admin.firestore() : null;

// 2. دالة مرجعية موحدة لإرسال الإشعارات عبر OneSignal
async function sendPush({ uid, title, body, type = "order", orderId = "" }) {
  if (!uid || !title || !body) {
    throw new Error("uid, title and body are required");
  }

  const response = await fetch("https://api.onesignal.com/notifications?c=push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
    },
    body: JSON.stringify({
      app_id: ONESIGNAL_APP_ID,
      target_channel: "push",
      include_aliases: { external_id: [uid] },
      headings: { en: title, ar: title },
      contents: { en: body, ar: body },
      data: { type, orderId },
      priority: 10,
    }),
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    console.error("❌ OneSignal API Error:", response.status, JSON.stringify(json));
    throw new Error(JSON.stringify(json));
  }

  console.log("✅ Notification sent successfully:", json.id);
  return json;
}

// 3. التوثيق الخاص بطلبات HTTP
function auth(req, res, next) {
  if (req.header("x-relay-secret") !== RELAY_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (_, res) => res.send("ok"));

// 4. مسار POST للإرسال اليدوي
app.post("/notify", auth, async (req, res) => {
  const { uid, title, body, type = "order", orderId } = req.body || {};

  try {
    const result = await sendPush({ uid, title, body, type, orderId });
    res.json({ ok: true, id: result.id });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// 5. المراقبة التلقائية للتغيرات في Firestore
if (db) {
  console.log("📡 Listening for Firestore order updates...");
  
  db.collection("orders").onSnapshot((snapshot) => {
    snapshot.docChanges().forEach(async (change) => {
      // نتحقق فقط من الوثائق التي تم تعديل حالتها
      if (change.type === "modified") {
        const order = change.doc.data();
        const status = order.status;
        const clientUid = order.client?.uID;

        if (!clientUid) return;

        let title = "";
        let body = "";

        // تحديد نص الإشعار بناءً على حالة الطلب
        switch (status) {
          case "Cook":
            title = "تم بدء التحضير 🍳";
            body = "طلبك قيد التحضير الان في المطبخ.";
            break;
          case "Delivery":
            title = "الطلب في الطريق 🛵";
            body = "طلبك خرج مع المندوب وهو في طريقه إليك.";
            break;
          case "Finish":
            title = "اكتمل الطلب 🍔";
            body = "تم توصيل طلبك بنجاح. بالهناء والشفاء!";
            break;
          default:
            return; // تجاهل الحالات الأخرى مثل waiting أو Cancelled
        }

        try {
          console.log(`🔔 Sending push for order ${change.doc.id} (Status: ${status}) to user: ${clientUid}`);
          await sendPush({
            uid: clientUid,
            title: title,
            body: body,
            type: "order",
            orderId: change.doc.id,
          });
        } catch (err) {
          console.error("❌ Error sending automatic notification:", err.message);
        }
      }
    });
  }, (err) => {
    console.error("❌ Firestore listener error:", err);
  });
}

app.listen(PORT, () => console.log(`relay listening on ${PORT}`));
