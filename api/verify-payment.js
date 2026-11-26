const crypto = require("crypto");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const base = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!base || !serviceKey || !keyId || !keySecret) return res.status(503).json({ error: "Payment verification is not configured." });

  const { booking_code, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (![booking_code, razorpay_order_id, razorpay_payment_id, razorpay_signature].every(v => typeof v === "string" && v.trim())) {
    return res.status(400).json({ error: "Payment verification details are incomplete." });
  }
  const expected = crypto.createHmac("sha256", keySecret).update(razorpay_order_id + "|" + razorpay_payment_id).digest();
  let received;
  try { received = Buffer.from(razorpay_signature, "hex"); } catch (_) { received = Buffer.alloc(0); }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return res.status(400).json({ error: "Payment signature could not be verified." });

  const headers = { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" };
  const rest = (path, options = {}) => fetch(base + "/rest/v1/" + path, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  try {
    const bookingResp = await rest("bookings?select=id,booking_code,total_amount,booking_status,payment_status,created_at&booking_code=eq." + encodeURIComponent(booking_code) + "&limit=1");
    if (!bookingResp.ok) throw new Error("Could not load booking.");
    const booking = (await bookingResp.json())[0];
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const paymentResp = await rest("payments?select=id,amount,payment_status&booking_id=eq." + booking.id + "&provider_order_id=eq." + encodeURIComponent(razorpay_order_id) + "&limit=1");
    if (!paymentResp.ok) throw new Error("Could not load payment record.");
    const payment = (await paymentResp.json())[0];
    if (!payment) return res.status(404).json({ error: "Payment order does not match this booking." });

    if (booking.booking_status === "confirmed" && booking.payment_status === "paid" && payment.payment_status === "captured") {
      return res.status(200).json({ success: true, booking_code, advance_paid: Number(payment.amount), balance_due: Math.round((Number(booking.total_amount) - Number(payment.amount)) * 100) / 100, message: "Booking is already confirmed." });
    }
    if (booking.booking_status !== "pending" || booking.payment_status !== "pending") {
      return res.status(409).json({ error: "This booking hold is no longer active. If payment was deducted, contact the hotel with your booking code." });
    }
    const createdAt = Date.parse(booking.created_at);
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 10 * 60 * 1000) {
      return res.status(410).json({ error: "The 10-minute room hold has expired. If payment was deducted, contact the hotel with your booking code." });
    }
    const roomResp = await rest("booking_rooms?select=id&booking_id=eq." + booking.id + "&limit=1");
    if (!roomResp.ok) throw new Error("Could not verify the room hold.");
    if (!(await roomResp.json()).length) return res.status(409).json({ error: "The room hold is no longer active. If payment was deducted, contact the hotel with your booking code." });

    const auth = Buffer.from(keyId + ":" + keySecret).toString("base64");
    const razorResp = await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(razorpay_payment_id), { headers: { Authorization: "Basic " + auth } });
    const razorPayment = await razorResp.json();
    if (!razorResp.ok) return res.status(502).json({ error: "Could not confirm payment status with Razorpay." });
    if (razorPayment.order_id !== razorpay_order_id || Number(razorPayment.amount) !== Math.round(Number(payment.amount) * 100) || Math.abs(Number(payment.amount) - Number(booking.total_amount) * 0.25) > 0.01 || razorPayment.currency !== "INR") {
      return res.status(400).json({ error: "Payment details do not match the booking amount." });
    }
    if (razorPayment.status !== "captured") {
      return res.status(202).json({ success: false, payment_status: razorPayment.status, message: "Payment is not captured yet. The booking is not confirmed; please contact the hotel if money was deducted." });
    }

    const updatePayment = await rest("payments?provider_order_id=eq." + encodeURIComponent(razorpay_order_id), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ provider_payment_id: razorpay_payment_id, payment_status: "captured" })
    });
    if (!updatePayment.ok) throw new Error("Payment was received but the payment record could not be updated. Contact the hotel.");
    const updateBooking = await rest("bookings?id=eq." + booking.id + "&booking_status=eq.pending&payment_status=eq.pending", {
      method: "PATCH", headers: { Prefer: "return=representation" },
      body: JSON.stringify({ payment_status: "paid", booking_status: "confirmed" })
    });
    if (!updateBooking.ok) throw new Error("Payment was received but booking confirmation needs hotel assistance. Contact the hotel with code " + booking_code + ".");
    const updatedRows = await updateBooking.json();
    if (!updatedRows.length) throw new Error("Payment was received, but the room hold changed before confirmation. Contact the hotel with code " + booking_code + ".");
    return res.status(200).json({ success: true, booking_code, advance_paid: Number(payment.amount), balance_due: Math.round((Number(booking.total_amount) - Number(payment.amount)) * 100) / 100, message: "25% advance payment successful. Your booking is confirmed." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not verify payment." });
  }
};
