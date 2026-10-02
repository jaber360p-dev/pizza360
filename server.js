const express = require("express");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

const {
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
  RELAY_SECRET,
  FIREBASE_SERVICE_ACCOUNT,
  OWNER_UID,
  PORT = 3000,
} = process.env;

// يقبل أكثر من مالك مفصولين بفاصلة
const OWNER_UIDS = (OWNER_UID || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const [name, value] of Object.entries({
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
  RELAY_SECRET,
  OWNER_UID,
})) {
  if (!value) console.warn(`⚠️ Missing env var: ${name}`);
}

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

// 2. دالة موحدة لإرسال الإشعارات عبر OneSignal
async function sendPush({
  uid,
  title,
  body,
  type = "order",
  orderId = "",
  extra = {},
}) {
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
      include_aliases: { external_id: ["cmazqPXZGodQ1WSdxmkjIi7Xm1s2"] },
      headings: { en: title, ar: title },
      contents: { en: body, ar: body },
      data: { type, orderId, ...extra },
      priority: 10,
    }),
  });

  const json = await response.json();
  if (!response.ok || json.errors) {
    console.error("❌ OneSignal API Error:", response.status, JSON.stringify(json));
    throw new Error(JSON.stringify(json));
  }

  console.log(`✅ Notification sent to ${uid}:`, json.id);
  return json;
}

// إرسال لكل المالكين مع عدم إيقاف الباقي إن فشل أحدهم
async function notifyOwners(payload) {
  if (!OWNER_UIDS.length) {
    console.warn("⚠️ OWNER_UID is not set: owner notification skipped");
    return;
  }
  for (const uid of OWNER_UIDS) {
    try {
      await sendPush({ uid, ...payload });
    } catch (err) {
      console.error(`❌ Error notifying owner ${uid}:`, err.message);
    }
  }
}

// 3. التوثيق: يرفض دائمًا إذا لم يُضبط RELAY_SECRET
function auth(req, res, next) {
  if (!RELAY_SECRET || req.header("x-relay-secret") !== RELAY_SECRET) {
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

// 5. نصوص إشعار الزبون حسب حالة الطلب
const STATUS_MESSAGES = {
  Cook: {
    title: "تم بدء التحضير 🍳",
    body: "طلبك قيد التحضير الان في المطبخ.",
  },
  Delivery: {
    title: "الطلب في الطريق 🛵",
    body: "طلبك خرج مع المندوب وهو في طريقه إليك.",
  },
  Finish: {
    title: "اكتمل الطلب 🍔",
    body: "تم توصيل طلبك بنجاح. بالهناء والشفاء!",
  },
  Cancelled: {
    title: "تم رفض طلبك 😔",
    body: "عذرًا، لم نتمكن من قبول طلبك هذه المرة.",
  },
};

// 6. المراقبة التلقائية للتغيرات في Firestore
if (db) {
  // ---- الطلبات ----
  const lastStatus = new Map(); // آخر حالة معروفة لكل طلب
  let ordersReady = false;

  console.log("📡 Listening for Firestore order updates...");
  db.collection("orders").onSnapshot(
    (snapshot) => {
      const isInitial = !ordersReady; // أول لقطة = تحميل أولي فقط
      ordersReady = true;

      snapshot.docChanges().forEach(async (change) => {
        const id = change.doc.id;

        if (change.type === "removed") {
          lastStatus.delete(id);
          return;
        }

        const order = change.doc.data();
        const status = order.status;
        const previous = lastStatus.get(id);
        lastStatus.set(id, status);

        if (isInitial) return;

        // طلب جديد: إشعار للمالك
        if (change.type === "added") {
          if (status === "waiting") {
            console.log(`🆕 New order ${id} from ${order.client?.name}`);
            await notifyOwners({
              title: "طلب جديد 🍕",
              body: `${order.client?.name || "زبون"} - ${order.totalOrderPrice ?? 0} Da`,
              type: "order",
              orderId: id,
            });
          }
          return;
        }

        // تغيّر الحالة: إشعار للزبون
        if (change.type !== "modified" || previous === status) return;

        const message = STATUS_MESSAGES[status];
        const clientUid = order.client?.uID;
        if (!message || !clientUid) return;

        try {
          console.log(`🔔 Order ${id}: ${previous} -> ${status}, notifying ${clientUid}`);
          await sendPush({
            uid: clientUid,
            title: message.title,
            body: message.body,
            type: "order",
            orderId: id,
          });
        } catch (err) {
          console.error("❌ Error sending order notification:", err.message);
        }
      });
    },
    (err) => console.error("❌ Firestore orders listener error:", err)
  );

  // ---- الدردشات: في الاتجاهين ----
  const lastChatAt = new Map();
  let chatsReady = false;

  console.log("📡 Listening for Firestore chat updates...");
  db.collection("chats").onSnapshot(
    (snapshot) => {
      const isInitial = !chatsReady;
      chatsReady = true;

      snapshot.docChanges().forEach(async (change) => {
        const id = change.doc.id; // معرّف المحادثة = uid الزبون

        if (change.type === "removed") {
          lastChatAt.delete(id);
          return;
        }

        const chat = change.doc.data();
        const stamp = chat.lastMessageAt?.toMillis?.() ?? 0;
        const previous = lastChatAt.get(id);
        lastChatAt.set(id, stamp);

        if (isInitial || change.type !== "modified") return;
        // تعديل لا يتعلق برسالة جديدة (مثل تحديد "مقروء")
        if (stamp === 0 || stamp === previous) return;

        const preview = chat.lastMessage || "📷 صورة";

        if (chat.unreadByOwner) {
          // رسالة جديدة من الزبون -> المالك
          console.log(`💬 Chat ${id}: client -> owner`);
          await notifyOwners({
            title: chat.clientName || "رسالة جديدة",
            body: preview,
            type: "chat",
            extra: { chatId: id },
          });
        } else if (chat.unreadByClient) {
          // رد المالك -> الزبون
          console.log(`💬 Chat ${id}: owner -> client`);
          try {
            await sendPush({
              uid: id,
              title: "رسالة جديدة من المطعم",
              body: preview,
              type: "chat",
              extra: { chatId: id },
            });
          } catch (err) {
            console.error("❌ Error notifying client (chat):", err.message);
          }
        }
      });
    },
    (err) => console.error("❌ Firestore chats listener error:", err)
  );
}

app.listen(PORT, () => console.log(`relay listening on ${PORT}`));
