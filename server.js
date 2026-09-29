const express = require("express");

const app = express();
app.use(express.json());

const {
  ONESIGNAL_APP_ID,
  ONESIGNAL_REST_API_KEY,
  RELAY_SECRET,
  PORT = 3000,
} = process.env;

// Simple shared-secret check so only your owner app can call the server
function auth(req, res, next) {
  if (req.header("x-relay-secret") !== RELAY_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (_, res) => res.send("ok"));

// POST /notify
// { "uid": "<customer uid>", "title": "...", "body": "...", "type": "order" | "chat", "orderId": "..." }
app.post("/notify", auth, async (req, res) => {
  const { uid, title, body, type = "order", orderId } = req.body || {};
  if (!uid || !title || !body) {
    return res.status(400).json({ error: "uid, title and body are required" });
  }

  try {
    const r = await fetch("https://api.onesignal.com/notifications", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Key ${ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: ONESIGNAL_APP_ID,
        target_channel: "push",
        include_aliases: { external_id: [uid] },
        headings: { en: title },
        contents: { en: body },
        data: { type, orderId },
        priority: 10,
      }),
    });
    const json = await r.json();
    if (!r.ok) return res.status(502).json({ error: json });
    res.json({ ok: true, id: json.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "send failed" });
  }
});

app.listen(PORT, () => console.log(`relay listening on ${PORT}`));