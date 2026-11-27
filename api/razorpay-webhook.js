const crypto = require("crypto");

module.exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!base || !serviceKey || !webhookSecret) return res.status(503).json({ error: "Webhook is not configured." });

  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers["x-razorpay-signature"];
    if (typeof signature !== "string" || !/^[a-f0-9]{64}$/i.test(signature)) {
      return res.status(400).json({ error: "Missing or invalid webhook signature." });
    }
    const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest();
    const received = Buffer.from(signature, "hex");
    if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) {
      return res.status(400).json({ error: "Webhook signature verification failed." });
    }

    const event = JSON.parse(rawBody.toString("utf8"));
    const eventType = event.event;
    if (!["payment.captured", "payment.failed"].includes(eventType)) {
      return res.status(200).json({ received: true, ignored: true });
    }

    const payment = event.payload && event.payload.payment && event.payload.payment.entity;
    if (!payment || !payment.id || !payment.order_id) return res.status(400).json({ error: "Payment entity is missing." });

    const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
    const rest = (path, options = {}) => fetch(base + "/rest/v1/" + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });

    const recordResp = await rest("payments?select=id,booking_id,amount,payment_status,provider_payment_id&provider_order_id=eq." + encodeURIComponent(payment.order_id) + "&provider=eq.razorpay&limit=1");
    if (!recordResp.ok) throw new Error("Could not find the local payment order.");
    const record = (await recordResp.json())[0];
    if (!record) return res.status(404).json({ error: "Local payment order not found." });

    if (eventType === "payment.failed" || payment.status === "failed") {
      if (record.payment_status !== "captured") {
        const failed = await rest("payments?id=eq." + record.id + "&payment_status=neq.captured", {
          method: "PATCH", headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ provider_payment_id: payment.id, payment_status: "failed" })
        });
        if (!failed.ok) throw new Error("Could not update failed payment.");
      }
      return res.status(200).json({ received: true, payment_status: "failed" });
    }

    if (payment.status !== "captured" || payment.currency !== "INR" || Number(payment.amount) !== Math.round(Number(record.amount) * 100)) {
      return res.status(400).json({ error: "Captured payment does not match the stored order amount." });
    }

    const captured = await rest("payments?id=eq." + record.id, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ provider_payment_id: payment.id, payment_status: "captured" })
    });
    if (!captured.ok) throw new Error("Could not record captured payment.");

    const bookingResp = await rest("bookings?select=id,booking_code,total_amount,booking_status,payment_status,created_at&id=eq." + record.booking_id + "&limit=1");
    if (!bookingResp.ok) throw new Error("Could not load the linked booking.");
    const booking = (await bookingResp.json())[0];
    if (!booking) return res.status(200).json({ received: true, payment_status: "captured", booking_action: "manual_review_required" });

    if (booking.booking_status === "confirmed" && booking.payment_status === "paid") {
      return res.status(200).json({ received: true, payment_status: "captured", booking_action: "already_confirmed" });
    }

    const createdAt = Date.parse(booking.created_at);
    const holdValid = booking.booking_status === "pending" && booking.payment_status === "pending" &&
      Number.isFinite(createdAt) && Date.now() - createdAt <= 10 * 60 * 1000;
    if (!holdValid) {
      return res.status(200).json({ received: true, payment_status: "captured", booking_action: "manual_review_required" });
    }

    const roomResp = await rest("booking_rooms?select=id&booking_id=eq." + booking.id + "&limit=1");
    if (!roomResp.ok) throw new Error("Could not verify the room hold.");
    if (!(await roomResp.json()).length) {
      return res.status(200).json({ received: true, payment_status: "captured", booking_action: "manual_review_required" });
    }

    const confirm = await rest("bookings?id=eq." + booking.id + "&booking_status=eq.pending&payment_status=eq.pending", {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ payment_status: "paid", booking_status: "confirmed" })
    });
    if (!confirm.ok) throw new Error("Could not confirm the booking.");
    const rows = await confirm.json();
    return res.status(200).json({ received: true, payment_status: "captured", booking_action: rows.length ? "confirmed" : "manual_review_required" });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Webhook processing failed." });
  }
};
