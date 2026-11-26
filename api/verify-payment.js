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
    const bookingResp = await rest("bookings?select=id,booking_code,total_amount,booking_status,payment_status&booking_code=eq." + encodeURIComponent(booking_code) + "&limit=1");
    if (!bookingResp.ok) throw new Error("Could not load booking.");
    const booking = (await bookingResp.json())[0];
    if (!booking) return res.status(404).json({ error: "Booking not found." });

    const paymentResp = await rest("payments?select=id,amount,payment_status&booking_id=eq." + booking.id + "&provider_order_id=eq." + encodeURIComponent(razorpay_order_id) + "&limit=1");
    if (!paymentResp.ok) throw new Error("Could not load payment record.");
    const payment = (await paymentResp.json())[0];
    if (!payment) return res.status(404).json({ error: "Payment order does not match this booking." });

    const auth = Buffer.from(keyId + ":" + keySecret).toString("base64");
    const razorResp = await fetch("https://api.razorpay.com/v1/payments/" + encodeURIComponent(razorpay_payment_id), { headers: { Authorization: "Basic " + auth } });
    const razorPayment = await razorResp.json();
    if (!razorResp.ok) return res.status(502).json({ error: "Could not confirm payment status with Razorpay." });
    if (razorPayment.order_id !== razorpay_order_id || Number(razorPayment.amount) !== Math.round(Number(booking.total_amount) * 100) || razorPayment.currency !== "INR") {
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
    const updateBooking = await rest("bookings?id=eq." + booking.id, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ payment_status: "paid", booking_status: "confirmed" })
    });
    if (!updateBooking.ok) throw new Error("Payment was received but booking confirmation needs hotel assistance. Contact the hotel with code " + booking_code + ".");
    return res.status(200).json({ success: true, booking_code, message: "Payment successful. Your booking is confirmed." });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Could not verify payment." });
  }
};
